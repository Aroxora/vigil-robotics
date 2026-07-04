/**
 * Phase-1 of the Ink migration. Proves the StatusLine component actually
 * renders to a real Ink reconciler — not via a mocked terminal, not via
 * jest's ESM-vs-CJS gymnastics. Spawns scripts/ink-smoke.mjs as a child
 * process, captures stdout, asserts on the cleaned frame.
 *
 * Per CLAUDE.md "Tests run real, no compromises": this test exercises
 * Ink end-to-end against the same dist artifact the real CLI loads.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ink-smoke.mjs');
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILT = path.resolve(REPO_ROOT, 'dist', 'ui', 'ink', 'StatusLine.js');

describe('Ink StatusLine — Phase 1 (subprocess smoke)', () => {
  beforeAll(() => {
    if (!fs.existsSync(BUILT)) {
      throw new Error(`dist artifact missing: ${BUILT}\nRun: npx tsc -p tsconfig.json`);
    }
  });

  const run = (...args: string[]): string =>
    execFileSync('node', [SCRIPT, ...args], { encoding: 'utf-8', cwd: REPO_ROOT });

  test('status: renders the message text', () => {
    expect(run('status', 'Thinking…').trim()).toContain('Thinking…');
  });

  test('mode-only: renders only the mode chip', () => {
    expect(run('mode-only', 'HITL: on').trim()).toBe('HITL: on');
  });

  test('both: renders message + mode on separate lines', () => {
    const out = run('both', 'Working', 'HITL: on');
    expect(out).toContain('Working');
    expect(out).toContain('HITL: on');
    // Two distinct lines, in the documented order.
    const lines = out.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('Working');
    expect(lines[1]).toContain('HITL: on');
  });

  test('empty: renders zero output when no props', () => {
    expect(run('empty')).toBe('');
  });

  test('cjk + emoji: renders without truncation drift', () => {
    const out = run('cjk').trim();
    expect(out).toContain('处理中');
    expect(out).toContain('你好世界');
    expect(out).toContain('👨‍👩‍👧‍👦');
  });

  test('reconciler diffs: a different message produces a different frame', () => {
    const a = run('status', 'first').trim();
    const b = run('status', 'second').trim();
    expect(a).toContain('first');
    expect(b).toContain('second');
  });
});
