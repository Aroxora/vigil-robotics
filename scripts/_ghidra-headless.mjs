#!/usr/bin/env node
// _ghidra-headless.mjs - Binary vulnerability hardening analysis.
// Uses readelf/nm/file for quick local probes and Ghidra headless for
// opt-in deep binary metadata, function, string, xref, and decompile tools.

import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT_DIR = join(REPO_ROOT, 'tools', 'ghidra', 'scripts');
const DEFAULT_GHIDRA_HOME = process.env.VIGIL_GHIDRA_HOME
  || process.env.GHIDRA_INSTALL_DIR
  || process.env.GHIDRA_HOME
  || '/usr/share/ghidra';
const DEFAULT_JAVA_HOME = process.env.JAVA_HOME
  || (existsSync('/usr/lib/jvm/java-21-openjdk-amd64') ? '/usr/lib/jvm/java-21-openjdk-amd64' : undefined);
const ENABLE_GHIDRA = process.env.VIGIL_GHIDRA_HEADLESS === '1';
const DEFAULT_TIMEOUT_MS = 180_000;

// Authorization guard: Ghidra headless analysis (which can run arbitrary JVM
// code against untrusted binaries) must only be invoked from within a Vigil
// process. VIGIL_SESSION_TOKEN is set by `src/bin/vigil.ts` at startup and
// inherited by every subprocess Vigil spawns. Direct invocation from outside
// Vigil is blocked. The MCP server (`ghidra-mcp-server.mjs`) enforces the
// same check before it starts; this is the defense-in-depth layer for the
// library export surface and the CLI path (`node _ghidra-headless.mjs`).
function assertVigilCaller(label = 'ghidra-headless') {
  if (!process.env.VIGIL_SESSION_TOKEN) {
    const msg = `[${label}] Access denied: VIGIL_SESSION_TOKEN is not set. ` +
      'Ghidra headless analysis may only be invoked from within the Vigil CLI.\n';
    process.stderr.write(msg);
    process.exit(1);
  }
}

const RISKY_IMPORTS = new Set([
  'alloca', 'execve', 'gets', 'memcpy', 'popen', 'sprintf', 'strcat', 'strcpy',
  'strncat', 'strncpy', 'system', 'vsprintf',
]);

export function probeGhidraHeadless() {
  assertVigilCaller('ghidra:probe');
  const ghidraHome = DEFAULT_GHIDRA_HOME;
  const analyzeHeadless = analyzeHeadlessPath(ghidraHome);
  const result = {
    generatedAt: new Date().toISOString(),
    ghidraHome,
    analyzeHeadless,
    ghidraAvailable: existsSync(analyzeHeadless),
    ghidraEnabled: ENABLE_GHIDRA,
    scriptDir: SCRIPT_DIR,
    scriptsAvailable: [
      'VigilExportInfo.java',
      'VigilListFunctions.java',
      'VigilDecompile.java',
      'VigilSearchStrings.java',
      'VigilGetXRefs.java',
    ].every((name) => existsSync(join(SCRIPT_DIR, name))),
    note: 'Quick binary hardening scan via readelf/nm/file. Set VIGIL_GHIDRA_HEADLESS=1 or pass --target to run Ghidra headless.',
  };

  const suidBinaries = getSuidBinaries();
  const serviceBinaries = getServiceBinaries();
  const targets = [...suidBinaries.slice(0, 8), ...serviceBinaries.slice(0, 4)];

  const findings = [];
  for (const binary of targets) {
    const info = analyzeBinary(binary);
    if (info) findings.push(info);
  }

  result.scannedBinaries = targets.length;
  result.totalFindings = findings.filter((f) => f.insecurityCount > 0).length;
  result.findings = findings;
  result.headlessFindings = [];

  if (ENABLE_GHIDRA && result.ghidraAvailable && result.scriptsAvailable) {
    for (const target of targets.slice(0, 3)) {
      try {
        result.headlessFindings.push({
          target,
          result: analyzeBinaryWithGhidra(target, { timeoutMs: 120_000 }),
        });
      } catch (error) {
        result.headlessFindings.push({
          target,
          error: String(error?.message || error).slice(0, 400),
        });
      }
    }
  }

  return result;
}

export function analyzeBinaryWithGhidra(target, options = {}) {
  assertVigilCaller('ghidra:analyze');
  const result = runGhidraScript(target, 'VigilExportInfo', [], options);
  return {
    ...result,
    securitySignals: securitySignalsFromExport(result),
  };
}

export function listFunctionsWithGhidra(target, options = {}) {
  assertVigilCaller('ghidra:list-functions');
  return runGhidraScript(target, 'VigilListFunctions', [options.maxFunctions || 1000], options);
}

export function decompileFunctionWithGhidra(target, functionNameOrAddress, options = {}) {
  assertVigilCaller('ghidra:decompile');
  return runGhidraScript(target, 'VigilDecompile', [functionNameOrAddress], options);
}

export function searchStringsWithGhidra(target, pattern = '', options = {}) {
  assertVigilCaller('ghidra:search-strings');
  return runGhidraScript(target, 'VigilSearchStrings', [pattern, options.maxResults || 100], options);
}

export function getXrefsWithGhidra(target, address, options = {}) {
  assertVigilCaller('ghidra:xrefs');
  return runGhidraScript(target, 'VigilGetXRefs', [address], options);
}

function analyzeHeadlessPath(ghidraHome) {
  const name = process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless';
  return join(ghidraHome, 'support', name);
}

function runGhidraScript(target, scriptBaseName, scriptArgs = [], options = {}) {
  const targetPath = resolve(String(target || ''));
  if (!target || !existsSync(targetPath)) {
    throw new Error(`target does not exist: ${targetPath}`);
  }

  const ghidraHome = options.ghidraHome || DEFAULT_GHIDRA_HOME;
  const analyzeHeadless = analyzeHeadlessPath(ghidraHome);
  if (!existsSync(analyzeHeadless)) {
    throw new Error(`Ghidra analyzeHeadless not found: ${analyzeHeadless}`);
  }

  const scriptFile = `${scriptBaseName}.java`;
  if (!existsSync(join(SCRIPT_DIR, scriptFile))) {
    throw new Error(`Vigil Ghidra script not found: ${scriptFile}`);
  }

  const createdProjectDir = !options.projectDir;
  const projectDir = options.projectDir
    ? resolve(String(options.projectDir))
    : mkdtempSync(join(tmpdir(), 'vigil-ghidra-'));
  const safeBase = basename(targetPath).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  const projectName = `vigil_${safeBase}_${randomBytes(4).toString('hex')}`;

  const args = [
    projectDir,
    projectName,
    '-import',
    targetPath,
    '-overwrite',
    '-scriptPath',
    SCRIPT_DIR,
    '-postScript',
    scriptFile,
    ...scriptArgs.map((arg) => String(arg)),
  ];
  if (!options.keepProject) args.push('-deleteProject');

  try {
    const run = spawnSync(analyzeHeadless, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: ghidraEnv(options),
    });
    if (run.error) throw run.error;

    const text = `${run.stdout || ''}\n${run.stderr || ''}`;
    const payload = extractVigilJson(text);
    if (!payload && run.status !== 0) {
      throw new Error(`Ghidra exited ${run.status}: ${text.slice(-1000)}`);
    }
    if (!payload) {
      throw new Error(`Ghidra script ${scriptFile} did not emit a Vigil JSON marker`);
    }

    return {
      ok: true,
      target: targetPath,
      ghidraHome,
      script: scriptFile,
      projectDir: options.keepProject ? projectDir : null,
      projectName: options.keepProject ? projectName : null,
      ...payload,
    };
  } finally {
    if (createdProjectDir && !options.keepProject) {
      try { rmSync(projectDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

function ghidraEnv(options = {}) {
  const xdgRoot = options.xdgRoot ? resolve(String(options.xdgRoot)) : join(tmpdir(), 'vigil-ghidra-xdg');
  const configHome = join(xdgRoot, 'config');
  const cacheHome = join(xdgRoot, 'cache');
  const dataHome = join(xdgRoot, 'data');
  for (const dir of [configHome, cacheHome, dataHome]) {
    try { mkdirSync(dir, { recursive: true }); } catch (_) {}
  }
  return {
    ...process.env,
    ...(DEFAULT_JAVA_HOME ? { JAVA_HOME: DEFAULT_JAVA_HOME } : {}),
    JAVA_TOOL_OPTIONS: [process.env.JAVA_TOOL_OPTIONS, '-XX:+PerfDisableSharedMem'].filter(Boolean).join(' '),
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_DATA_HOME: dataHome,
  };
}

function extractVigilJson(text) {
  const match = /__VIGIL_OUTPUT__(.*?)__VIGIL_END__/s.exec(text);
  if (!match) return null;
  return JSON.parse(match[1]);
}

function securitySignalsFromExport(result) {
  const imports = Array.isArray(result.imports) ? result.imports : [];
  const sections = Array.isArray(result.sections) ? result.sections : [];
  const riskyImports = imports
    .filter((item) => RISKY_IMPORTS.has(String(item.name || '').toLowerCase()))
    .map((item) => ({
      name: item.name,
      library: item.library || null,
      address: item.address || null,
    }));
  const writableExecutableSections = sections
    .filter((item) => item.write === true && item.execute === true)
    .map((item) => ({
      name: item.name,
      start: item.start,
      end: item.end,
      size: item.size,
    }));
  return {
    riskyImportCount: riskyImports.length,
    riskyImports,
    writableExecutableSections,
  };
}

function getSuidBinaries() {
  try {
    const r = execSync(
      'find / -perm -4000 -type f 2>/dev/null | grep -v "^/proc\\|^/sys\\|^/snap" | head -12',
      { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return r.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getServiceBinaries() {
  const paths = [
    '/usr/sbin/sshd',
    '/usr/sbin/nginx',
    '/usr/sbin/apache2',
    '/usr/sbin/cron',
    '/usr/sbin/cupsd',
    '/usr/bin/dockerd',
    '/usr/lib/snapd/snapd',
    '/usr/lib/policykit-1/polkitd',
    '/usr/lib/systemd/systemd',
    '/usr/bin/dbus-daemon',
  ];
  return paths.filter((p) => existsSync(p));
}

function commandOutput(command, args) {
  const run = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 4000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (run.error) throw run.error;
  return String(run.stdout || '').trim();
}

function analyzeBinary(binary) {
  try {
    const shortName = binary.split('/').pop();
    let fileType = '';
    let pie = '';
    let canary = '';
    let relro = '';
    let nx = '';
    let rpath = '';
    let unsafeSyms = '';
    let weakCrypto = '';

    try { fileType = commandOutput('file', [binary]); } catch {}
    try {
      pie = commandOutput('readelf', ['-h', binary]).includes('Type:                              DYN') ? 'PIE' : 'NO-PIE';
    } catch {}
    try {
      canary = commandOutput('readelf', ['-s', binary]).includes('__stack_chk') ? 'CANARY' : 'NO-CANARY';
    } catch {}
    try {
      relro = commandOutput('readelf', ['-l', binary]).includes('GNU_RELRO') ? 'RELRO' : 'NO-RELRO';
    } catch {}
    try {
      const lines = commandOutput('readelf', ['-l', binary]).split('\n');
      const stackIdx = lines.findIndex((line) => line.includes('GNU_STACK'));
      const stackText = stackIdx >= 0 ? `${lines[stackIdx]} ${lines[stackIdx + 1] || ''}` : '';
      const flags = (stackText.match(/\s([R ][W ][E ])\s+0x[0-9a-f]+$/i)?.[1] || '').trim();
      nx = flags.includes('E') ? 'NX-DISABLED' : 'NX';
    } catch {}
    try {
      const dyn = commandOutput('readelf', ['-d', binary]);
      rpath = dyn.split('\n').filter((line) => /RPATH|RUNPATH/i.test(line)).join('\n').slice(0, 200);
    } catch {}
    try {
      unsafeSyms = commandOutput('nm', ['-D', binary])
        .split('\n')
        .filter((line) => /\b(strcpy|strcat|sprintf|gets|system|popen|alloca)\b/i.test(line))
        .join('\n') || 'none';
    } catch {}
    try {
      weakCrypto = commandOutput('nm', ['-D', binary])
        .split('\n')
        .filter((line) => /\b(MD5_|SHA1_|DES_|RC4_)/i.test(line))
        .join('\n') || 'none';
    } catch {}

    const issues = [];
    if (pie === 'NO-PIE') issues.push({ type: 'NO-PIE', desc: 'Not compiled as PIE; ASLR bypass may be easier', sev: 'high' });
    if (canary === 'NO-CANARY') issues.push({ type: 'NO-CANARY', desc: 'No stack canary; stack corruption bugs are higher impact', sev: 'critical' });
    if (relro === 'NO-RELRO') issues.push({ type: 'NO-RELRO', desc: 'No RELRO; GOT overwrite may be possible', sev: 'high' });
    if (nx === 'NX-DISABLED') issues.push({ type: 'NX-DISABLED', desc: 'NX bit disabled; injected code execution may be easier', sev: 'critical' });
    if (rpath) issues.push({ type: 'RPATH', desc: 'Has RPATH/RUNPATH; review for shared library hijacking risk', sev: 'medium' });
    if (unsafeSyms !== 'none') issues.push({ type: 'UNSAFE-FUNCTIONS', desc: `Links unsafe functions: ${unsafeSyms.split('\n').map((l) => l.trim().split(/\s+/).pop()).join(', ')}`, sev: 'high' });
    if (weakCrypto !== 'none') issues.push({ type: 'WEAK-CRYPTO', desc: `Links weak crypto: ${weakCrypto.split('\n').map((l) => l.trim().split(/\s+/).pop()).join(', ')}`, sev: 'medium' });

    return {
      binary,
      name: shortName,
      fileType,
      pie,
      canary,
      relro,
      nx,
      hasRpath: !!rpath,
      unsafeFunctions: unsafeSyms !== 'none' ? unsafeSyms.split('\n').filter((l) => l !== 'none').length : 0,
      weakCryptoSymbols: weakCrypto !== 'none' ? weakCrypto.split('\n').filter((l) => l !== 'none').length : 0,
      insecurityCount: issues.length,
      issues,
    };
  } catch {
    return null;
  }
}

function parseCliArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function cliMain() {
  const args = parseCliArgs(process.argv.slice(2));
  let result;
  const options = {
    ghidraHome: typeof args.ghidraHome === 'string' ? args.ghidraHome : undefined,
    projectDir: typeof args.projectDir === 'string' ? args.projectDir : undefined,
    keepProject: args.keepProject === true,
    timeoutMs: typeof args.timeoutMs === 'string' ? Number(args.timeoutMs) : undefined,
  };

  if (args.probe || !args.target) {
    result = probeGhidraHeadless();
  } else {
    const script = String(args.script || 'VigilExportInfo').replace(/\.java$/, '');
    if (script === 'VigilExportInfo') {
      result = analyzeBinaryWithGhidra(args.target, options);
    } else if (script === 'VigilListFunctions') {
      result = listFunctionsWithGhidra(args.target, { ...options, maxFunctions: Number(args.maxFunctions || args.max || 1000) });
    } else if (script === 'VigilDecompile') {
      result = decompileFunctionWithGhidra(args.target, String(args.function || args.address || ''), options);
    } else if (script === 'VigilSearchStrings') {
      result = searchStringsWithGhidra(args.target, String(args.pattern || ''), { ...options, maxResults: Number(args.maxResults || args.max || 100) });
    } else if (script === 'VigilGetXRefs') {
      result = getXrefsWithGhidra(args.target, String(args.address || ''), options);
    } else {
      throw new Error(`unknown Ghidra script: ${script}`);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertVigilCaller('ghidra-headless-cli');
  try {
    cliMain();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
    process.exitCode = 1;
  }
}
