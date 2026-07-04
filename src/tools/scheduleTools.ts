/**
 * ScheduleWakeup + Cron* — Claude-Code-parity scheduling tools.
 *
 * ScheduleWakeup: in-process self-pacing. The agent calls this to
 * resume itself after N seconds, e.g. while waiting for a build to
 * finish or polling for an external state change. The wake-up arrives
 * as a virtual user message at the scheduled time.
 *
 * CronCreate / CronList / CronDelete: persisted recurring schedule.
 * Records are written to <workingDir>/.vigil/cron.json. The
 * portal mirrors them to Firestore for cross-device visibility, and
 * a server-side worker (AWS Lambda EventBridge) actually fires them.
 *
 * The CLI does not run the cron loop itself — it only manages the
 * schedule entries. Treat this tool as the registration surface.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';
import { callLambda } from '../utils/lambdaClient.js';

export interface CronEntry {
  id: string;
  prompt: string;
  schedule: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  notes?: string;
}

interface PendingWakeup {
  id: string;
  delaySeconds: number;
  reason: string;
  scheduledAt: string;
}

const PENDING_WAKEUPS = new Map<string, PendingWakeup>();

function cronStorePath(workingDir: string): string {
  return join(workingDir, '.vigil', 'cron.json');
}

function readCron(workingDir: string): CronEntry[] {
  const path = cronStorePath(workingDir);
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(data)) return [];
    return data as CronEntry[];
  } catch {
    return [];
  }
}

function writeCron(workingDir: string, entries: CronEntry[]): void {
  const dir = join(workingDir, '.vigil');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cronStorePath(workingDir), JSON.stringify(entries, null, 2), 'utf-8');
}

function safeId(input: unknown, prefix: string): string {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s) return `${prefix}-${Date.now().toString(36)}`;
  return s.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
}

const CRON_FIELD_RE = /^(\*|[0-9*/,-]+)$/;

export function isPlausibleCron(spec: string): boolean {
  const fields = spec.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  return fields.every((f) => CRON_FIELD_RE.test(f));
}

export function getPendingWakeups(): readonly PendingWakeup[] {
  return Array.from(PENDING_WAKEUPS.values());
}

export function clearPendingWakeups(): void {
  PENDING_WAKEUPS.clear();
}

export function createScheduleTools(workingDir: string): ToolDefinition[] {
  return [
    {
      name: 'ScheduleWakeup',
      description:
        'Schedule the agent to resume itself after a delay (60..3600 seconds). ' +
        'Use during long-running waits — polling a build, watching for state ' +
        'changes — instead of busy-loops. The runtime fires the next turn at ' +
        'the scheduled time with `prompt` as the resumed input.',
      parameters: {
        type: 'object',
        properties: {
          delaySeconds: { type: 'number', description: 'Seconds to sleep, 60..3600.' },
          reason: { type: 'string', description: 'Short telemetry-friendly reason.' },
          prompt: { type: 'string', description: 'Prompt to fire on wake.' },
        },
        required: ['delaySeconds', 'reason', 'prompt'],
      },
      handler: async (args) => {
        const delay = Math.max(60, Math.min(3600, Number(args['delaySeconds']) || 0));
        const reason = String(args['reason'] ?? '').trim().slice(0, 200);
        const prompt = String(args['prompt'] ?? '').trim();
        if (!prompt) return 'ScheduleWakeup requires a non-empty prompt.';
        const id = `wake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        PENDING_WAKEUPS.set(id, {
          id,
          delaySeconds: delay,
          reason,
          scheduledAt: new Date(Date.now() + delay * 1000).toISOString(),
        });
        return `Wakeup "${id}" scheduled for ${delay}s (reason: ${reason || 'n/a'}).`;
      },
    },
    {
      name: 'CronCreate',
      description:
        'Register a recurring scheduled prompt. The schedule is a 5- or ' +
        '6-field cron expression (min hour dom mon dow [year]). The actual ' +
        'firing happens server-side via AWS EventBridge once the entry is ' +
        'synced to Firestore from the portal — the CLI just writes the spec.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable id (alnum/-/_, ≤96 chars).' },
          schedule: { type: 'string', description: 'Cron expression (5 or 6 fields).' },
          prompt: { type: 'string', description: 'Prompt that fires on each tick.' },
          enabled: { type: 'boolean', description: 'Defaults to true.' },
          notes: { type: 'string' },
        },
        required: ['schedule', 'prompt'],
      },
      handler: async (args) => {
        const schedule = String(args['schedule'] ?? '').trim();
        if (!isPlausibleCron(schedule)) {
          return `CronCreate rejected: "${schedule}" is not a valid 5/6-field cron expression.`;
        }
        const prompt = String(args['prompt'] ?? '').trim();
        if (!prompt) return 'CronCreate requires a non-empty prompt.';
        const id = safeId(args['id'], 'cron');
        const entries = readCron(workingDir);
        const idx = entries.findIndex((e) => e.id === id);
        const now = new Date().toISOString();
        const enabled = args['enabled'] === undefined ? true : Boolean(args['enabled']);
        const notes = typeof args['notes'] === 'string' ? args['notes'] : undefined;
        const entry: CronEntry = idx >= 0
          ? { ...entries[idx]!, schedule, prompt, enabled, updatedAt: now, ...(notes !== undefined ? { notes } : {}) }
          : { id, schedule, prompt, enabled, createdAt: now, updatedAt: now, ...(notes ? { notes } : {}) };
        if (idx >= 0) entries[idx] = entry;
        else entries.push(entry);
        writeCron(workingDir, entries);
        // Best-effort mirror to Firestore via Lambda so the server-side
        // tick (cliCronTick) can fire entries even when the CLI is offline.
        // A failure here is non-fatal: the local entry is still authoritative.
        // 3s timeout matches the "best-effort" contract — the local file is
        // already written; we don't block the agent loop on a slow round-trip
        // (and Jest's 5s default per-test cap forbids longer holds anyway).
        const mirror = await callLambda<{ ok: boolean }>('cliCronUpsert', {
          id, schedule, prompt, enabled, ...(notes !== undefined ? { notes } : {}),
        }, { timeoutMs: 3000 });
        const mirrorMsg = mirror.ok ? ' (mirrored to backend)' : ` (local-only: ${mirror.error ?? 'unauthenticated'})`;
        return `Cron "${id}" ${idx >= 0 ? 'updated' : 'created'}: ${schedule} — ${prompt.slice(0, 60)}${mirrorMsg}`;
      },
    },
    {
      name: 'CronList',
      description: 'List registered cron entries (does not include external/portal-only entries).',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const entries = readCron(workingDir);
        if (entries.length === 0) return 'No cron entries.';
        return entries
          .map((e) => `${e.id} [${e.enabled ? 'on' : 'off'}] ${e.schedule} — ${e.prompt.slice(0, 80)}`)
          .join('\n');
      },
    },
    {
      name: 'CronDelete',
      description: 'Delete a cron entry by id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args) => {
        const id = String(args['id'] ?? '').trim();
        if (!id) return 'CronDelete requires id.';
        const entries = readCron(workingDir);
        const next = entries.filter((e) => e.id !== id);
        if (next.length === entries.length) return `No cron entry "${id}".`;
        writeCron(workingDir, next);
        const mirror = await callLambda<{ ok: boolean }>('cliCronDelete', { id }, { timeoutMs: 3000 });
        const mirrorMsg = mirror.ok ? ' (backend updated)' : ` (local-only: ${mirror.error ?? 'unauthenticated'})`;
        return `Cron "${id}" deleted${mirrorMsg}.`;
      },
    },
  ];
}
