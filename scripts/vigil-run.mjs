#!/usr/bin/env node
// vigil-run.mjs — authorized wrapper for Vigil analysis scripts.
//
// Mints a VIGIL_SESSION_TOKEN and then spawns the target script so that
// the session-token guard in each analysis script passes. This is the
// intended entry point when running analysis outside the interactive CLI
// (e.g. `npm run analyze:local`, `npm run ghidra:probe`).
//
// Usage (via npm scripts — do not invoke the analysis scripts directly):
//   node scripts/vigil-run.mjs scripts/security-analysis.mjs --local
//   node scripts/vigil-run.mjs scripts/_ghidra-headless.mjs --probe

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCRIPTS_ROOT = resolve(ROOT, 'scripts');

const [, , targetRel, ...rest] = process.argv;

if (!targetRel) {
  process.stderr.write('Usage: node scripts/vigil-run.mjs <script> [...args]\n');
  process.exit(1);
}

const token = process.env.VIGIL_SESSION_TOKEN || randomBytes(32).toString('hex');
const target = resolve(ROOT, targetRel);

if (!target.startsWith(`${SCRIPTS_ROOT}/`) || !/\.(?:mjs|js)$/.test(target)) {
  process.stderr.write('[vigil-run] Refusing to mint VIGIL_SESSION_TOKEN for a non-repo script target.\n');
  process.exit(1);
}

const child = spawn(process.execPath, [target, ...rest], {
  stdio: 'inherit',
  env: { ...process.env, VIGIL_SESSION_TOKEN: token },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 0;
  }
});
