/**
 * Phase 6 — InkPromptController integration. Proves the Ink-backed
 * controller satisfies the surface that interactiveShell.ts uses, via
 * a real subprocess that mounts the controller through the same
 * `createPromptController` factory production code goes through.
 *
 * Per CLAUDE.md "Tests run real": no mocks for Ink, no stub for the
 * controller. Outcome markers in the harness are surfaced via stderr
 * so the test asserts on real behaviour the production CLI would
 * observe.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ink-controller-smoke.mjs');
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILT = path.resolve(REPO_ROOT, 'dist', 'ui', 'ink', 'InkPromptController.js');

interface RunResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

async function run(scenario: string, stdinBytes: string = '', dwellMs = 800): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [SCRIPT, scenario], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    if (stdinBytes) {
      setTimeout(() => child.stdin.write(stdinBytes), 200);
    }
    child.on('exit', (code) => resolve({ exitCode: code, stdout, stderr }));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, dwellMs + 8_000);
    setTimeout(() => { try { child.stdin.end(); } catch { /* noop */ } }, dwellMs);
  });
}

jest.setTimeout(15_000);

describe('InkPromptController — Phase 6 integration', () => {
  beforeAll(() => {
    if (!fs.existsSync(BUILT)) {
      throw new Error(`dist artifact missing: ${BUILT}\nRun: npx tsc -p tsconfig.json`);
    }
  });

  test('addEvent → ChatStatic flow committed via the renderer shim', async () => {
    const r = await run('addEvent-flow');
    // The harness prints HISTORY-COUNT for diagnostic; the more
    // important assertion is that the rendered frame contains the
    // history items (proving the shim wrote them through to Ink).
    expect(r.stdout).toContain('WELCOME-LINE');
    expect(r.stdout).toContain('system-line');
    expect(r.stdout).toContain('assistant-line');
    expect(r.stdout).toContain('tool-line');
  });

  test('mode toggles update controller state without throwing', async () => {
    const r = await run('mode-toggle');
    expect(r.stderr).toContain('AUTO: off');
    expect(r.stderr).toContain('HITL: on');
  });

  test('user submission lands in chat history (the bug 1.1.0/1/2 missed)', async () => {
    // The legacy renderer auto-emitted 'prompt' events on submit; the
    // Ink path wasn't doing that, so user input vanished from the
    // visible transcript. Asserting on the actual rendered stdout is
    // the test that should have caught this before the first ship.
    const r = await run('submit-to-history');
    const stripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    expect(stripped).toContain('hello world');
    // The harness fires SUBMIT on the host callback after history was
    // updated. If history wasn't updated, "hello world" wouldn't be
    // in the rendered frame at all (the prompt buffer clears on
    // submit, so it can't be the buffer rendering still).
    expect(r.stderr).toContain('SUBMIT: hello world');
  });

  test('prompt buffer clears after submit (the 1.1.7 bug)', async () => {
    // Bug shipped in 1.1.7: after submit, the bordered prompt box
    // still showed the typed text. Cause was the Prompt component's
    // ref-state not syncing when the host cleared `initial`. Fixed
    // by adding a useEffect that resets stateRef when `initial`
    // diverges from what's already in the ref. The harness logs the
    // buffer state at the moment the host's onSubmit fires —
    // BUFFER-AFTER-SUBMIT must be the empty string.
    const r = await run('submit-to-history');
    expect(r.stderr).toContain('BUFFER-AFTER-SUBMIT: ""');
    expect(r.stderr).not.toMatch(/BUFFER-AFTER-SUBMIT: "hello world"/);
  });

  test('streaming deltas coalesce; thoughts filtered; final response commits once', async () => {
    const r = await run('stream-coalesce');
    // The reasoning text MUST NOT appear in the rendered frame —
    // before the fix this leaked as a chat bubble above the answer.
    expect(r.stdout).not.toContain('this is reasoning the user should NOT see');
    // The committed final must appear (rendered as the assistant
    // bubble after 'response' arrives).
    expect(r.stdout).toContain('Hi there!');
    // None of the partial streaming chunks should appear as their
    // own ChatItem — coalescing means the running text grows in
    // place. We can't directly assert on history shape from outside
    // the process, but we CAN assert the canonical line shape: the
    // word "Hi" should not appear on its own line followed by
    // " there" on a new line. We strip ANSI then check.
    const stripped = r.stdout
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b./g, '');
    // The bug pattern we're guarding against: each token on its own line.
    expect(stripped).not.toMatch(/^Hi$/m);
    expect(stripped).not.toMatch(/^ there$/m);
    expect(stripped).not.toMatch(/^!$/m);
  });

  test('addOutputTap fires for events while attached, stops on dispose', async () => {
    const r = await run('tap');
    // Both pre-detach events must fire.
    expect(r.stderr).toMatch(/TAP:\s*system=one;response=two;/);
    // The third event happens AFTER the tap is detached, so it must
    // NOT appear in the captured tap output.
    expect(r.stderr).not.toContain('three');
  });

  test('HITL prompt-open suspends Ink rendering, prompt-close resumes', async () => {
    // Regression for arrow-key UI bugs in HITL: when the raw-mode
    // HITL menu (core/hitl.ts → console.log + \x1b[2J\x1b[H) is up,
    // Ink must NOT keep rerendering its prompt area on top, and must
    // NOT lose the buffer it had pre-HITL. The controller now listens
    // to hitlEvents on start and toggles a hitlOpen flag that
    // short-circuits buildTree to an empty <Box>.
    const r = await run('hitl-suspend');
    expect(r.stderr).toContain('HITL-SUSPENDED-BEFORE: false');
    expect(r.stderr).toContain('HITL-SUSPENDED-DURING: true');
    expect(r.stderr).toContain('HITL-SUSPENDED-AFTER: false');
    // Buffer must survive the suspend/resume cycle untouched.
    expect(r.stderr).toContain('BUFFER-DURING: "preserved-across-hitl"');
    expect(r.stderr).toContain('BUFFER-AFTER: "preserved-across-hitl"');
  });
});
