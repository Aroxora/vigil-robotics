/**
 * RemoteTrigger — Claude-Code-parity webhook ingest.
 *
 * The agent calls RemoteTriggerCreate to register a deliverable
 * trigger; the user (or any external caller) can POST to the
 * portal-relayed URL with a JSON body, which lands in
 * <workingDir>/.vigil/triggers/<id>.json. RemoteTriggerWait blocks
 * the agent until the file appears (or a timeout is hit). Used for
 * "page me when this CI finishes" / "wake me when the user clicks".
 *
 * The actual external-facing URL is provisioned by AWS Lambda; the
 * CLI's role is to register the trigger id + description and to
 * watch the local drop file. Synthetic local-only triggers (for
 * tests and offline use) just rely on a file write.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';
import { callLambda, readCliAuth } from '../utils/lambdaClient.js';

interface TriggerPollResult {
  found: boolean;
  delivered?: boolean;
  payload?: unknown;
  deliveredAt?: number | null;
}

export interface TriggerRecord {
  id: string;
  description?: string;
  createdAt: string;
  webhookToken?: string;
  payload?: unknown;
  delivered: boolean;
  deliveredAt?: string;
}

function triggerStore(workingDir: string): string {
  return join(workingDir, '.vigil', 'triggers');
}

function triggerPath(workingDir: string, id: string): string {
  return join(triggerStore(workingDir), `${id}.json`);
}

function safeId(input: unknown): string {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s) return `trig-${Date.now().toString(36)}`;
  return s.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
}

function ensureStore(workingDir: string): void {
  const dir = triggerStore(workingDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

export function listTriggers(workingDir: string): TriggerRecord[] {
  const dir = triggerStore(workingDir);
  if (!existsSync(dir)) return [];
  const out: TriggerRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), 'utf-8')) as TriggerRecord);
    } catch {
      // Skip malformed.
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deliverTrigger(workingDir: string, id: string, payload: unknown): TriggerRecord {
  ensureStore(workingDir);
  const path = triggerPath(workingDir, id);
  const existing: Partial<TriggerRecord> = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf-8')) as TriggerRecord)
    : { id, createdAt: nowIso() };
  const record: TriggerRecord = {
    id: existing.id ?? id,
    description: existing.description,
    createdAt: existing.createdAt ?? nowIso(),
    payload,
    delivered: true,
    deliveredAt: nowIso(),
  };
  writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');
  return record;
}

export function createTriggerTools(workingDir: string): ToolDefinition[] {
  return [
    {
      name: 'RemoteTriggerCreate',
      description:
        'Register a webhook-style trigger. Returns a stable id; an external ' +
        'caller can deliver a payload by writing JSON to ' +
        '`.vigil/triggers/<id>.json` (or POSTing through the AWS Lambda ' +
        'webhook relay if configured). RemoteTriggerWait blocks until the ' +
        'payload arrives.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable id (alnum/-/_, ≤96 chars).' },
          description: { type: 'string', description: 'Why this trigger exists.' },
        },
      },
      handler: async (args) => {
        ensureStore(workingDir);
        const id = safeId(args['id']);
        const path = triggerPath(workingDir, id);
        if (!existsSync(path)) {
          const record: TriggerRecord = {
            id,
            description: typeof args['description'] === 'string' ? args['description'] : undefined,
            createdAt: nowIso(),
            delivered: false,
          };
          writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');
        }
        const mirror = await callLambda<{ ok: boolean; id?: string; webhookToken?: string }>('cliTriggerRegister', {
          id,
          description: typeof args['description'] === 'string' ? args['description'] : undefined,
        });
        if (mirror.ok && mirror.result?.webhookToken) {
          try {
            const current = JSON.parse(readFileSync(path, 'utf-8')) as TriggerRecord;
            writeFileSync(path, JSON.stringify({
              ...current,
              webhookToken: mirror.result.webhookToken,
            }, null, 2), 'utf-8');
          } catch {
            // Local token persistence is convenience only; the returned body below is authoritative.
          }
        }
        const auth = readCliAuth();
        const uidLiteral = auth?.uid ? `"${auth.uid}"` : 'uid';
        const webhookBody = mirror.result?.webhookToken
          ? `{ uid: ${uidLiteral}, triggerId: "${id}", webhookToken: "${mirror.result.webhookToken}", payload: ... }`
          : `{ uid: ${uidLiteral}, triggerId: "${id}", webhookToken: "<token>", payload: ... }`;
        const remoteMsg = mirror.ok
          ? `\nWebhook URL: POST ${process.env['VIGIL_LAMBDA_BASE'] ?? 'https://cfqeqx4lt9.execute-api.us-east-1.amazonaws.com'}/api/cliWebhook with body ${webhookBody}`
          : `\nRemote registration unavailable (${mirror.error ?? 'unauthenticated'}). Local drop file remains active.`;
        return `Trigger "${id}" registered. Local drop: .vigil/triggers/${id}.json${remoteMsg}`;
      },
    },
    {
      name: 'RemoteTriggerWait',
      description:
        'Wait for a trigger payload to arrive. Polls the local drop file; ' +
        'returns the payload as soon as `delivered: true` appears, or times ' +
        'out after `timeoutSeconds` (default 60, max 1800).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          timeoutSeconds: { type: 'number', description: '1..1800. Default 60.' },
          pollMs: { type: 'number', description: 'Poll interval, default 1000.' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const id = safeId(args['id']);
        const path = triggerPath(workingDir, id);
        const timeout = Math.max(1, Math.min(1800, Number(args['timeoutSeconds']) || 60)) * 1000;
        const interval = Math.max(100, Math.min(10000, Number(args['pollMs']) || 1000));
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          // Path 1: local drop file (test fixtures, offline runs).
          if (existsSync(path)) {
            try {
              const stat = statSync(path);
              if (stat.size > 0) {
                const record = JSON.parse(readFileSync(path, 'utf-8')) as TriggerRecord;
                if (record.delivered) {
                  return JSON.stringify({ id, payload: record.payload, deliveredAt: record.deliveredAt, source: 'local' });
                }
              }
            } catch {
              // Ignore transient read errors during polling.
            }
          }
          // Path 2: Lambda relay (webhook delivered to Firestore).
          const remote = await callLambda<TriggerPollResult>('cliTriggerPoll', { id });
          if (remote.ok && remote.result?.found && remote.result.delivered) {
            // Mirror the delivered payload to local for parity.
            try {
              writeFileSync(path, JSON.stringify({
                id,
                createdAt: nowIso(),
                payload: remote.result.payload,
                delivered: true,
                deliveredAt: remote.result.deliveredAt
                  ? new Date(remote.result.deliveredAt).toISOString()
                  : nowIso(),
              }, null, 2), 'utf-8');
            } catch {
              // Mirror is best-effort; the JSON return below is the source of truth.
            }
            return JSON.stringify({
              id,
              payload: remote.result.payload,
              deliveredAt: remote.result.deliveredAt,
              source: 'webhook',
            });
          }
          await new Promise((r) => setTimeout(r, interval));
        }
        return `RemoteTriggerWait timed out after ${timeout / 1000}s for "${id}".`;
      },
    },
    {
      name: 'RemoteTriggerList',
      description: 'List registered triggers (delivered and pending).',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const items = listTriggers(workingDir);
        if (items.length === 0) return 'No triggers.';
        return items
          .map((t) => `${t.id} [${t.delivered ? 'delivered' : 'pending'}] ${t.description ?? ''}`)
          .join('\n');
      },
    },
    {
      name: 'RemoteTriggerDelete',
      description: 'Delete a trigger record.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args) => {
        const id = safeId(args['id']);
        const path = triggerPath(workingDir, id);
        if (!existsSync(path)) return `No trigger "${id}".`;
        unlinkSync(path);
        return `Trigger "${id}" deleted.`;
      },
    },
  ];
}
