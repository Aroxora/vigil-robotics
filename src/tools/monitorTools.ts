/**
 * Monitor — Claude-Code-parity background process management.
 *
 * Spawns a long-running command and lets the agent inspect/stream/stop it
 * without blocking the conversation. Used for: dev servers, watchers,
 * fuzzers, builds-in-progress. The Bash tool stays best for short
 * commands; Monitor takes over once `run_in_background: true` is desired.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { ToolDefinition } from '../core/toolRuntime.js';
import { callLambda } from '../utils/lambdaClient.js';

interface MonitorEntry {
  id: string;
  command: string;
  startedAt: string;
  status: 'running' | 'exited';
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  buffer: string[];
  proc: ChildProcess;
}

const REGISTRY = new Map<string, MonitorEntry>();
const MAX_BUFFER_LINES = 1000;

function nextId(): string {
  return `mon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function appendOutput(entry: MonitorEntry, chunk: Buffer | string): void {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    entry.buffer.push(line);
  }
  if (entry.buffer.length > MAX_BUFFER_LINES) {
    entry.buffer.splice(0, entry.buffer.length - MAX_BUFFER_LINES);
  }
}

export function getMonitorRegistry(): ReadonlyMap<string, { command: string; status: string }> {
  const out = new Map<string, { command: string; status: string }>();
  for (const [id, e] of REGISTRY) out.set(id, { command: e.command, status: e.status });
  return out;
}

export async function shutdownAllMonitors(): Promise<void> {
  for (const entry of REGISTRY.values()) {
    if (entry.status === 'running') {
      try {
        entry.proc.kill('SIGTERM');
      } catch {
        // Ignore: process may already have exited.
      }
    }
  }
  REGISTRY.clear();
}

export function createMonitorTools(workingDir: string): ToolDefinition[] {
  return [
    {
      name: 'MonitorStart',
      description:
        'Spawn a long-running shell command in the background and return ' +
        'a monitor id. Use for dev servers, watchers, fuzzers, builds. ' +
        'Subsequent MonitorRead calls stream stdout/stderr lines.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
          cwd: { type: 'string', description: 'Working directory (defaults to session cwd).' },
        },
        required: ['command'],
      },
      handler: async (args) => {
        const command = String(args['command'] ?? '').trim();
        if (!command) return 'MonitorStart requires a command.';
        const cwd = typeof args['cwd'] === 'string' && args['cwd'].trim() ? args['cwd'].trim() : workingDir;
        const id = nextId();
        const proc = spawn(command, {
          cwd,
          shell: true,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const entry: MonitorEntry = {
          id,
          command,
          startedAt: new Date().toISOString(),
          status: 'running',
          buffer: [],
          proc,
        };
        proc.stdout?.on('data', (chunk) => appendOutput(entry, chunk));
        proc.stderr?.on('data', (chunk) => appendOutput(entry, chunk));
        proc.on('exit', (code, signal) => {
          entry.status = 'exited';
          entry.exitCode = code;
          entry.signal = signal;
          // Best-effort: mirror completion to the portal jobs collection.
          void callLambda('cliJobComplete', {
            id, status: code === 0 ? 'done' : 'failed', exitCode: code,
          }).catch(() => {});
        });
        proc.on('error', (err) => {
          appendOutput(entry, `[monitor error] ${err.message}`);
          entry.status = 'exited';
          entry.exitCode = -1;
          void callLambda('cliJobComplete', { id, status: 'failed', exitCode: -1 }).catch(() => {});
        });
        REGISTRY.set(id, entry);
        // Best-effort: mirror to portal jobs collection so the operator
        // sees this monitor in the rail "Jobs running" section.
        void callLambda('cliJobStart', {
          id,
          kind: 'monitor',
          tool: 'shell',
          name: command.split(/\s+/)[0] || 'monitor',
          command: command.slice(0, 500),
          status: 'running',
          startedAt: Date.now(),
        }).catch(() => {});
        return `Monitor "${id}" started: ${command}`;
      },
    },
    {
      name: 'MonitorRead',
      description:
        'Read buffered output from a monitor. Pass `since: <line-index>` ' +
        'to only return lines added since that index (the response includes ' +
        'a `nextCursor` to use for the next read).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Monitor id from MonitorStart.' },
          since: { type: 'number', description: 'Cursor returned by previous read.' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const id = String(args['id'] ?? '');
        const entry = REGISTRY.get(id);
        if (!entry) return `No monitor with id "${id}".`;
        const since = Number.isFinite(Number(args['since'])) ? Math.max(0, Number(args['since'])) : 0;
        const slice = entry.buffer.slice(since);
        const cursor = entry.buffer.length;
        const head = `[${entry.status}${entry.status === 'exited' ? ` exit=${entry.exitCode ?? 'null'}` : ''}] cursor=${cursor}`;
        return [head, ...slice].join('\n');
      },
    },
    {
      name: 'MonitorStop',
      description: 'Send SIGTERM to a running monitor. Idempotent.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args) => {
        const id = String(args['id'] ?? '');
        const entry = REGISTRY.get(id);
        if (!entry) return `No monitor with id "${id}".`;
        if (entry.status === 'running') {
          try {
            entry.proc.kill('SIGTERM');
          } catch (err) {
            return `MonitorStop kill failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        // Best-effort mirror.
        void callLambda('cliJobUpdate', { id, status: 'stopped' }).catch(() => {});
        return `Monitor "${id}" stopped.`;
      },
    },
    {
      name: 'MonitorList',
      description: 'List active and recently-exited monitors.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        if (REGISTRY.size === 0) return 'No monitors.';
        return Array.from(REGISTRY.values())
          .map((e) => `${e.id} [${e.status}] ${e.command}`)
          .join('\n');
      },
    },
  ];
}
