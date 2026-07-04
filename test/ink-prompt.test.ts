/**
 * Phase 2 — Ink Prompt input box.
 *
 * Real-world test: spawn the prompt smoke harness as a subprocess, pipe
 * keystrokes through stdin, capture stderr's outcome markers (SUBMIT /
 * CANCEL / STATE), assert on the final buffer.
 *
 * Per CLAUDE.md "Tests run real, no compromises" — no mocked stdin, no
 * stub for Ink's reconciler. The harness mounts a real Ink tree with
 * process.stdin / process.stdout and the test drives it byte-by-byte.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ink-prompt-smoke.mjs');
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILT = path.resolve(REPO_ROOT, 'dist', 'ui', 'ink', 'Prompt.js');

interface RunResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  /** Final SUBMIT / CANCEL / null. */
  outcome: { type: 'submit'; text: string } | { type: 'cancel' } | null;
  /** Last STATE: line, decoded as { text, cursor } */
  lastState: { text: string; cursor: number } | null;
}

interface KeystrokeStep {
  /** Bytes to write to the subprocess stdin */
  bytes: string;
  /** Optional dwell after writing, in ms — gives Ink time to render */
  dwellMs?: number;
}

async function runPrompt(steps: KeystrokeStep[], extraArgs: string[] = []): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, ...extraArgs], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.stdout.on('data', (b) => { stdout += b.toString(); });

    let lastState: RunResult['lastState'] = null;
    let outcome: RunResult['outcome'] = null;

    // Drive the keystrokes serially with the requested dwells so Ink's
    // reconciler has a tick between actions. 120ms default lets Ink
    // commit the previous render before the next chunk arrives — without
    // this gap, Ink batches multiple keypresses into one parser call and
    // the reducer + render cycle can lag the input.
    const run = async () => {
      for (const step of steps) {
        child.stdin.write(step.bytes);
        await new Promise((r) => setTimeout(r, step.dwellMs ?? 120));
      }
      // Don't end stdin — the prompt may need to keep listening.
    };

    child.on('exit', (code) => {
      if (process.env['INK_TEST_DEBUG']) {
        const log = `[ink-test] exit=${code}\n--- stderr ---\n${stderr}\n--- stdout(first 200) ---\n${stdout.slice(0, 200)}\n`;
        fs.writeFileSync('/tmp/ink-test-debug.log', log, { flag: 'a' });
      }
      // Parse stderr for STATE: lines and SUBMIT/CANCEL outcomes.
      // SUBMIT_JSON wins over SUBMIT when both are present — it carries
      // the original (possibly multi-line) text JSON-encoded so the
      // line-oriented parser can recover newlines.
      for (const line of stderr.split('\n')) {
        const stateMatch = line.match(/^STATE:\s*(.*)\|(\d+)$/);
        if (stateMatch) {
          lastState = { text: stateMatch[1] || '', cursor: Number(stateMatch[2]) };
          continue;
        }
        const submitJsonMatch = line.match(/^SUBMIT_JSON:\s*(.*)$/);
        if (submitJsonMatch) {
          try {
            const text = JSON.parse(submitJsonMatch[1] || '""') as string;
            outcome = { type: 'submit', text };
          } catch {
            // fall back to plain SUBMIT below
          }
          continue;
        }
        const submitMatch = line.match(/^SUBMIT:\s*(.*)$/);
        if (submitMatch && !outcome) {
          outcome = { type: 'submit', text: submitMatch[1] || '' };
          continue;
        }
        if (line === 'CANCEL') outcome = { type: 'cancel' };
      }
      resolve({ exitCode: code, stderr, stdout, outcome, lastState });
    });

    void run();

    // Hard timeout so a hang doesn't wedge the suite. Set above jest's
    // per-test default (5s) — the per-test timeout is bumped on each
    // describe to 15s.
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, 12_000);
  });
}

const ENTER = '\r';
// Use \x08 (BS) for backspace in pipe-mode tests. Ink interprets
// \x7f (DEL) as key.delete (forward-delete), not key.backspace,
// especially after an escape-sequence prefix. \x08 is unambiguous.
const BACKSPACE = '\x08';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const CTRL_A = '\x01';
const CTRL_E = '\x05';
const CTRL_C = '\x03';

// Each subprocess test boots Node, mounts Ink, drives a sequence of
// keystrokes with dwells, captures stderr — comfortably exceeds the
// default 5s per-test timeout. 15s gives headroom without hiding hangs.
jest.setTimeout(15_000);

describe('Ink Prompt — Phase 2 (subprocess + real stdin)', () => {
  beforeAll(() => {
    if (!fs.existsSync(BUILT)) {
      throw new Error(`dist artifact missing: ${BUILT}\nRun: npx tsc -p tsconfig.json`);
    }
  });

  test('typed text is captured and submitted on Enter', async () => {
    const r = await runPrompt([
      { bytes: 'hello world' },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'hello world' });
  });

  test('prompt buffer clears after submit when typed via real keystrokes', async () => {
    // Regression for the typed-via-keystroke path of the buffer-clear
    // bug. The earlier fix (1.1.7) only covered the case where the host
    // programmatically called setBuffer() before submit, because that
    // changed the controller's `initial` prop and triggered Prompt's
    // [initial]-keyed useEffect. Real typing only mutates Prompt's
    // internal stateRef, never the controller's buffer, so `initial`
    // stays the same string before and after submit and the effect
    // never fires — leaving the typed text on screen post-submit.
    // Fix: clear stateRef synchronously inside Prompt's Enter handler
    // before notifying the host.
    const r = await runPrompt([
      { bytes: 'do not echo this' },
      { bytes: ENTER, dwellMs: 250 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'do not echo this' });
    expect(r.lastState).toEqual({ text: '', cursor: 0 });
  });

  test('backspace removes the last character', async () => {
    const r = await runPrompt([
      { bytes: 'foox' },
      { bytes: BACKSPACE },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'foo' });
  });

  test('left/right arrows move the cursor mid-buffer', async () => {
    // Type "abXc", arrow-left once (cursor between X and c), backspace
    // (deletes X). Backspace removes the char *before* the cursor, so
    // cursor=3 → deletes char at index 2 = 'X' → buffer "abc".
    const r = await runPrompt([
      { bytes: 'abXc' },
      { bytes: LEFT },
      { bytes: BACKSPACE },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'abc' });
  });

  test('Ctrl+A jumps to home, Ctrl+E to end', async () => {
    // Type "world", Ctrl+A, type "hello ", Ctrl+E, submit.
    const r = await runPrompt([
      { bytes: 'world' },
      { bytes: CTRL_A },
      { bytes: 'hello ' },
      { bytes: CTRL_E },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'hello world' });
  });

  test('Ctrl+C with empty buffer cancels', async () => {
    const r = await runPrompt([
      { bytes: CTRL_C, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'cancel' });
  });

  test('Ctrl+C with non-empty buffer clears the buffer (does not exit)', async () => {
    const r = await runPrompt([
      { bytes: 'partial' },
      { bytes: CTRL_C },
      { bytes: 'replaced' },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'replaced' });
  });

  test('bracketed paste: multi-line content lands in the buffer with newlines preserved', async () => {
    // Terminal-bracketed paste: \x1b[200~ ... \x1b[201~. Inside the
    // wrapper, \n is literal text, NOT Enter. Without the
    // bracketed-paste handler in Prompt.tsx, the embedded \n submits
    // halfway through and the second line never lands. Reproduces
    // the most-reported pasting-code-blocks bug.
    const r = await runPrompt([
      { bytes: '\x1b[200~line one\nline two\x1b[201~', dwellMs: 200 },
      { bytes: ENTER, dwellMs: 250 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'line one\nline two' });
  });

  test('up/down arrows are consumed without submitting or mutating the buffer', async () => {
    // Bug class this guards against: HITL's raw-mode menu shares
    // stdin with Ink, so every up/down press in HITL also reaches the
    // Prompt's useInput handler. If those keys leaked through to the
    // chunk-walk path, sanitize() would strip the CSI bytes but the
    // buffer state could still race with the parallel HITL re-render
    // (see InkPromptController.hitlOpen guard). Here we drive the same
    // arrow sequences against a standalone Prompt and assert the
    // buffer is exactly what the user typed — nothing dropped, nothing
    // added, no spurious submit.
    const UP = '\x1b[A';
    const DOWN = '\x1b[B';
    const r = await runPrompt([
      { bytes: 'abc' },
      { bytes: UP, dwellMs: 80 },
      { bytes: DOWN, dwellMs: 80 },
      { bytes: UP, dwellMs: 80 },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'abc' });
  });

  test('Shift+Tab fires the onToggleMode callback (CSI back-tab)', async () => {
    // Most terminals encode Shift+Tab as the CSI "back tab" sequence
    // \x1b[Z. The Prompt handler listens for both that and Ink's
    // tab+shift key flag. We drive the CSI form here because it's
    // what xterm / iTerm / kitty / Windows Terminal all send.
    const r = await runPrompt([
      { bytes: '\x1b[Z', dwellMs: 100 },
      { bytes: 'after-toggle', dwellMs: 100 },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.stderr).toContain('TOGGLE-MODE');
    expect(r.outcome).toEqual({ type: 'submit', text: 'after-toggle' });
  });

  test('paste sanitization: ANSI escapes are stripped from input', async () => {
    // Same payload class as hardening issue #3.
    const r = await runPrompt([
      { bytes: 'a\x1b[2J\x1b[Hb', dwellMs: 100 },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    expect(r.outcome).toEqual({ type: 'submit', text: 'ab' });
  });

  test('paste sanitization: BEL / NUL stripped (\\b interpreted as backspace)', async () => {
    const r = await runPrompt([
      { bytes: 'x\x07y\x00z\bend', dwellMs: 100 },
      { bytes: ENTER, dwellMs: 200 },
    ]);
    // \x07 (BEL) and \x00 (NUL) are stripped by sanitize. \x08 reaches
    // Ink's parser as a backspace key event, which removes the preceding
    // char from the buffer. So 'xyz' → backspace → 'xy', then 'end' →
    // 'xyend'. This is the documented Ink/terminal behaviour: the user
    // can't see the escape sequence inside paste, but they can paste a
    // literal BS to delete a character.
    expect(r.outcome).toEqual({ type: 'submit', text: 'xyend' });
  });

  test('initial value is preselected', async () => {
    const r = await runPrompt([
      { bytes: ENTER, dwellMs: 200 },
    ], ['--initial', 'preset']);
    expect(r.outcome).toEqual({ type: 'submit', text: 'preset' });
  });
});
