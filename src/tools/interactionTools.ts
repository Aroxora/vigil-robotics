/**
 * AskUserQuestion + PushNotification — agent-callable user-interaction tools.
 *
 * AskUserQuestion presents structured single/multi-select prompts. The
 * user's answer comes back as the tool result. The CLI surface uses
 * src/utils/askUserPrompt for rendering; in non-interactive contexts
 * (HITL pause / portal-driven runs) the prompt is queued for the host.
 *
 * PushNotification fires an OS-native desktop notification — useful
 * when the agent is running detached (long fuzz job, scheduled run)
 * and wants to flag the user without stealing focus.
 */

import { execFile, execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { createInterface } from 'node:readline';
import type { ToolDefinition } from '../core/toolRuntime.js';
import { formatAskUserPrompt, type AskUserOption } from '../utils/askUserPrompt.js';
import { callLambda } from '../utils/lambdaClient.js';

interface QuestionCreateResult { ok: boolean; id: string }
interface QuestionPollResult {
  found: boolean;
  answered?: boolean;
  selected?: string[];
  answeredAt?: number | null;
}

const MAX_OPTIONS = 9;

interface AskAnswer {
  selected: string[];
  cancelled: boolean;
}

function parseSelection(raw: string, optionCount: number, multiSelect: boolean): number[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const tokens = multiSelect ? trimmed.split(/[,\s]+/) : [trimmed];
  const out: number[] = [];
  for (const token of tokens) {
    const idx = Number.parseInt(token, 10) - 1;
    if (Number.isFinite(idx) && idx >= 0 && idx < optionCount) {
      out.push(idx);
    }
  }
  return Array.from(new Set(out));
}

async function askViaPortal(
  question: string,
  header: string,
  options: AskUserOption[],
  multiSelect: boolean,
  timeoutMs: number,
): Promise<AskAnswer> {
  // Push the question to Firestore via Lambda; the portal renders it
  // under the "Pending questions" panel. The user clicks an answer,
  // which writes back through cliQuestionAnswer; we poll until the
  // doc says answered or we hit the timeout.
  const created = await callLambda<QuestionCreateResult>('cliQuestionCreate', {
    question, header, multiSelect, options,
  });
  if (!created.ok || !created.result?.id) {
    return { selected: [], cancelled: true };
  }
  const id = created.result.id;
  const deadline = Date.now() + timeoutMs;
  const interval = 1500;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const polled = await callLambda<QuestionPollResult>('cliQuestionPoll', { id });
    if (polled.ok && polled.result?.found && polled.result.answered) {
      return { selected: polled.result.selected ?? [], cancelled: false };
    }
  }
  return { selected: [], cancelled: true };
}

async function askInternal(
  question: string,
  header: string,
  options: AskUserOption[],
  multiSelect: boolean,
): Promise<AskAnswer> {
  if (!process.stdin.isTTY) {
    // HITL bridge: ask through the portal. 10-minute timeout by default
    // so a forgotten detached agent eventually returns rather than
    // hanging forever.
    if (process.env['VIGIL_DISABLE_PORTAL_HITL'] === '1') {
      return { selected: [], cancelled: true };
    }
    return askViaPortal(question, header, options, multiSelect, 10 * 60 * 1000);
  }

  // Ink-rendered TTY menu — replaces the prior raw-stdout + readline
  // fallback. Single-select uses arrow keys + Enter; multi-select adds
  // Space to toggle. Esc / Ctrl+C cancels. The parent shell's
  // InkPromptController is paused while the agent awaits this tool, so
  // mounting a transient Ink tree here is safe.
  try {
    const { showAskUserMenu } = await import('../ui/ink/AskUserMenu.js');
    return await showAskUserMenu({
      question, header, options: options.map((o) => ({ label: o.label, description: o.description })),
      multiSelect,
    });
  } catch (_) {
    // Ink failed to mount (degraded TTY, headless test runner). Fall
    // back to the readline path so the agent loop doesn't deadlock.
    const formatted = formatAskUserPrompt({ question, header, options, multiSelect });
    process.stdout.write(formatted.lines.join('\n') + '\n');
    process.stdout.write(
      multiSelect
        ? 'Enter option numbers (comma-separated), or blank to cancel: '
        : 'Enter option number, or blank to cancel: ',
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    try {
      const line: string = await new Promise((resolve) => {
        rl.once('line', (l) => resolve(l));
        rl.once('close', () => resolve(''));
      });
      const indices = parseSelection(line, options.length, multiSelect);
      if (indices.length === 0) return { selected: [], cancelled: true };
      return { selected: indices.map((i) => options[i]!.label), cancelled: false };
    } finally {
      rl.close();
    }
  }
}

function notifyLinux(title: string, body: string): boolean {
  try {
    execFileSync('notify-send', ['--', title, body], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function notifyMac(title: string, body: string): boolean {
  // osascript is built into macOS; no extra install required.
  const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedBody = body.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${escapedBody}" with title "${escapedTitle}"`;
  try {
    execFileSync('osascript', ['-e', script], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function notifyFallback(title: string, body: string): void {
  // Last resort: ring the bell + write the title/body to stderr so the
  // user at least sees it in the active terminal session.
  process.stderr.write(`\x07[notify] ${title}\n${body}\n`);
}

export async function pushNotification(title: string, body: string): Promise<'os' | 'fallback'> {
  const t = title.trim();
  const b = body.trim();
  if (!t) return 'fallback';
  const os = platform();
  if (os === 'linux' && notifyLinux(t, b)) return 'os';
  if (os === 'darwin' && notifyMac(t, b)) return 'os';
  notifyFallback(t, b);
  return 'fallback';
}

export function createInteractionTools(): ToolDefinition[] {
  return [
    {
      name: 'AskUserQuestion',
      description:
        'Ask the user a structured question (single or multi-select). ' +
        'Use to disambiguate scope, pick between trade-offs, or confirm ' +
        'an irreversible action. Each option needs a label + description.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The full question (≤200 chars).' },
          header: { type: 'string', description: 'Short label (≤24 chars).' },
          multiSelect: { type: 'boolean', description: 'Allow multiple answers.' },
          options: {
            type: 'array',
            description: `Between 2 and ${MAX_OPTIONS} options. Each: { label, description }.`,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label', 'description'],
            },
          },
        },
        required: ['question', 'header', 'options'],
      },
      handler: async (args) => {
        const question = String(args['question'] ?? '').trim();
        const header = String(args['header'] ?? '').trim().slice(0, 24);
        const multiSelect = Boolean(args['multiSelect']);
        const rawOptions = Array.isArray(args['options']) ? args['options'] : [];
        if (!question) return 'AskUserQuestion requires `question`.';
        if (rawOptions.length < 2 || rawOptions.length > MAX_OPTIONS) {
          return `AskUserQuestion requires 2..${MAX_OPTIONS} options.`;
        }
        const options: AskUserOption[] = rawOptions.map((raw) => {
          const r = (raw ?? {}) as Record<string, unknown>;
          return {
            label: String(r['label'] ?? '').trim() || '(unlabeled)',
            description: String(r['description'] ?? '').trim(),
          };
        });
        const answer = await askInternal(question, header, options, multiSelect);
        if (answer.cancelled) return 'User cancelled the question.';
        return JSON.stringify({ selected: answer.selected });
      },
    },
    {
      name: 'PushNotification',
      description:
        'Fire an OS-native desktop notification (Linux notify-send / macOS ' +
        'osascript). Use when the agent is running detached and wants to ' +
        'flag the user without stealing focus. Falls back to terminal-bell ' +
        '+ stderr if no native channel is available.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short notification title.' },
          body: { type: 'string', description: 'Body text.' },
        },
        required: ['title'],
      },
      handler: async (args) => {
        const title = String(args['title'] ?? '').trim();
        if (!title) return 'PushNotification requires a title.';
        const body = String(args['body'] ?? '').trim();
        const channel = await pushNotification(title, body);
        return `Notification dispatched (${channel}): ${title}`;
      },
    },
  ];
}

// Suppress "unused import" warnings for the shape execFile is here in case
// callers want a non-blocking variant later; intentionally not deleted.
void execFile;
