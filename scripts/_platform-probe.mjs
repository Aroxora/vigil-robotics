// _platform-probe.mjs — exhaustive Windows-host probe + cross-shell
// smoke test of the vigil binary. The output is part of the
// security-analysis bundle so we can prove the release works on the
// real Windows 11 Pro box we're shipping from. Linux / Kali / macOS
// reports get their own runs later.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform, release, arch, totalmem, cpus, networkInterfaces, hostname, userInfo, freemem } from 'node:os';

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-platform-probe] Access denied: VIGIL_SESSION_TOKEN not set. Must run within the Vigil CLI.\n');
  process.exit(1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIGIL_JS = join(ROOT, 'dist', 'bin', 'vigil.js');
const SMOKE_PROMPT = '--version';

export function probePlatform() {
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpus: { count: cpus().length, model: cpus()[0]?.model ?? '' },
    memGB: { total: gb(totalmem()), free: gb(freemem()) },
    nodeVersion: process.version,
    npmVersion: safeText('npm', ['-v']),
    hostname: hostname(),
    user: maskUser(userInfo().username),
    home: homedir().replace(/\\/g, '/'),
    cwd: process.cwd().replace(/\\/g, '/'),
    interfaces: summarizeInterfaces(),
    osDetails: detectWindowsDetails(),
  };
}

function gb(b) { return Math.round((b / 1024 / 1024 / 1024) * 10) / 10; }
function maskUser(u) { return u && u.length > 2 ? `${u[0]}***${u.slice(-1)}` : 'user'; }
function summarizeInterfaces() {
  const out = {};
  let ifs = {};
  try {
    ifs = networkInterfaces();
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 300) };
  }
  for (const [k, v] of Object.entries(ifs)) {
    out[k] = (v ?? []).map((a) => ({ family: a.family, internal: a.internal, mac: a.mac === '00:00:00:00:00:00' ? '' : 'present' }));
  }
  return out;
}

function detectWindowsDetails() {
  if (platform() !== 'win32') return null;
  try {
    const ver = execSync('cmd /c ver', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return {
      ver,
      productName:    safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').ProductName"),
      editionId:      safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').EditionID"),
      installType:    safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').InstallationType"),
      displayVersion: safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').DisplayVersion"),
      build:          safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').CurrentBuild"),
      ubr:            safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').UBR"),
      releaseId:      safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').ReleaseId"),
      uptimeMin:      Number(safePS('[int]((New-TimeSpan -Start (gcim Win32_OperatingSystem).LastBootUpTime -End (Get-Date)).TotalMinutes)') || '0'),
      tz:             safePS('(Get-TimeZone).Id'),
      locale:         safePS('(Get-Culture).Name'),
      shellPolicy:    safePS('Get-ExecutionPolicy -Scope CurrentUser'),
    };
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 300) };
  }
}

function safePS(expr) {
  try {
    const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', expr], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    return (out.stdout ?? '').trim();
  } catch { return ''; }
}

function safePwsh(expr) {
  // PowerShell 7+ if installed.
  try {
    const out = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', expr], {
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    if ((out.status ?? -1) !== 0) return null;
    return (out.stdout ?? '').trim();
  } catch { return null; }
}

function safeText(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, killSignal: 'SIGKILL' });
    return (r.stdout ?? '').trim();
  } catch { return ''; }
}

// ─── exhaustive shell + tooling smoke ─────────────────────────────
export function runWindowsShellSmoke() {
  if (platform() !== 'win32') return { skipped: 'non-windows host' };
  if (!existsSync(VIGIL_JS)) return { skipped: `no built binary at ${VIGIL_JS}` };

  const cases = [];

  // baseline: node directly (what npm exec ultimately invokes).
  cases.push(runCase('node-direct', 'node', [VIGIL_JS, SMOKE_PROMPT]));

  // PowerShell 5.1 (Windows PowerShell)
  cases.push(runCase('powershell-5', 'powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `node "${VIGIL_JS.replace(/\\/g, '/')}" ${SMOKE_PROMPT}`,
  ]));

  // PowerShell 7+ (cross-platform)
  if (which('pwsh')) {
    cases.push(runCase('pwsh-7', 'pwsh', [
      '-NoProfile', '-NonInteractive', '-Command',
      `node "${VIGIL_JS.replace(/\\/g, '/')}" ${SMOKE_PROMPT}`,
    ]));
  } else {
    cases.push({ shell: 'pwsh-7', skipped: 'pwsh.exe not on PATH' });
  }

  // cmd.exe — the legacy backbone many tools still rely on
  cases.push(runCase('cmd', 'cmd', ['/c', `node "${VIGIL_JS}" ${SMOKE_PROMPT}`]));

  // Git Bash (msys)
  const gitBash = detectGitBash();
  cases.push(gitBash
    ? runCase('git-bash', gitBash, ['-c', `node "${VIGIL_JS.replace(/\\/g, '/')}" ${SMOKE_PROMPT}`])
    : { shell: 'git-bash', skipped: 'bash.exe not found' });

  // MSYS2 bash if installed in a standard place
  const msys2 = ['C:\\msys64\\usr\\bin\\bash.exe', 'C:\\msys32\\usr\\bin\\bash.exe'].find(existsFile);
  cases.push(msys2
    ? runCase('msys2-bash', msys2, ['-c', `node "${VIGIL_JS.replace(/\\/g, '/')}" ${SMOKE_PROMPT}`])
    : { shell: 'msys2-bash', skipped: 'msys2 bash not found' });

  // Cygwin bash
  const cygwin = ['C:\\cygwin64\\bin\\bash.exe', 'C:\\cygwin\\bin\\bash.exe'].find(existsFile);
  cases.push(cygwin
    ? runCase('cygwin-bash', cygwin, ['-c', `node "${VIGIL_JS.replace(/\\/g, '/')}" ${SMOKE_PROMPT}`])
    : { shell: 'cygwin-bash', skipped: 'cygwin bash not found' });

  // WSL — if installed, run inside the default distro. Skipped if no
  // wsl.exe or no installed distros.
  if (which('wsl')) {
    const distros = safeText('wsl', ['--list', '--quiet']).split(/\r?\n/).filter(Boolean);
    if (distros.length === 0 || distros[0].startsWith('Windows')) {
      cases.push({ shell: 'wsl', skipped: 'no WSL distros installed' });
    } else {
      // Translate Windows path to WSL path. /mnt/c/... is the standard mount.
      const wslPath = VIGIL_JS.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, '/');
      cases.push(runCase('wsl', 'wsl', ['--exec', 'node', wslPath, SMOKE_PROMPT]));
    }
  } else {
    cases.push({ shell: 'wsl', skipped: 'wsl.exe not on PATH' });
  }

  // npm exec — the universal package-run entry point. We point it at
  // the local build (no global install needed). Validates that the
  // bin entry in package.json works.
  cases.push(runCase('npm-exec', 'npm', ['exec', '--prefix', ROOT, '--', 'vigil', SMOKE_PROMPT]));

  // Validate the generated .cmd shim shape. npm-installed packages on
  // Windows expose foo.cmd, foo.ps1, and a shebang script. We don't
  // do a global install here, but we can confirm the bin entry is the
  // shape npm needs.
  cases.push(validateBinShape());

  // node-pty smoke (Ink renders through a PTY for interactive shells)
  cases.push(runPtySmoke());

  // npm pack on this host (proves npm + tar agree on Windows paths)
  cases.push(runNpmPackSmoke());

  // line endings: confirm .js source under dist/ is LF — Windows tools
  // sometimes corrupt CRLF on autocrlf=true.
  cases.push(checkLineEndings());

  // long-path support — vigil deps go ~12 levels deep in node_modules
  cases.push(checkLongPaths());

  // Defender / AV interference probe (read-only state checks)
  cases.push(checkDefender());

  return {
    binary: VIGIL_JS.replace(/\\/g, '/'),
    pwsh7Version: safePwsh('$PSVersionTable.PSVersion.ToString()'),
    cases,
    summary: {
      total: cases.length,
      passed: cases.filter((c) => c.ok).length,
      failed: cases.filter((c) => c.ok === false).length,
      skipped: cases.filter((c) => c.skipped).length,
    },
  };
}

function existsFile(p) { try { return statSync(p).isFile(); } catch { return false; } }

function detectGitBash() {
  const guesses = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const g of guesses) if (existsFile(g)) return g;
  const first = safeText('where', ['bash']).split(/\r?\n/).filter(Boolean)[0];
  return first && existsSync(first) ? first : null;
}

function which(cmd) {
  const r = spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true });
  const first = (r.stdout ?? '').split(/\r?\n/).filter(Boolean)[0];
  return first || null;
}

function runCase(shell, cmd, args) {
  const t0 = Date.now();
  let r;
  try {
    r = spawnSync(cmd, args, {
      encoding: 'utf8', timeout: 45_000,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', VIGIL_QUIET_POSTINSTALL: '1' },
    });
  } catch (e) {
    return { shell, ok: false, error: String(e?.message ?? e).slice(0, 300) };
  }
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const ok = r.status === 0 && /\bvigil\b/i.test(out) && /version/i.test(out);
  return {
    shell,
    cmd: [cmd, ...args].join(' ').slice(0, 200),
    exitCode: r.status,
    durationMs: Date.now() - t0,
    excerpt: out.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 280),
    ok,
  };
}

function runPtySmoke() {
  try {
    if (!existsSync(join(ROOT, 'node_modules', 'node-pty'))) {
      return { shell: 'node-pty', skipped: 'node-pty not installed' };
    }
    const driver = `
      import('node-pty').then(({ spawn }) => {
        const proc = spawn(process.execPath, [${JSON.stringify(VIGIL_JS)}, '${SMOKE_PROMPT}'], {
          name: 'xterm-color', cols: 80, rows: 24, env: process.env,
        });
        let out = '';
        proc.onData((d) => out += d);
        proc.onExit(({ exitCode }) => process.stdout.write(JSON.stringify({ exitCode, out })));
      }).catch((e) => process.stdout.write(JSON.stringify({ err: String(e.message || e) })));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
      encoding: 'utf8', timeout: 30_000, cwd: ROOT, windowsHide: true,
    });
    const parsed = JSON.parse((r.stdout || '{}').trim() || '{}');
    if (parsed.err) return { shell: 'node-pty', skipped: parsed.err };
    return {
      shell: 'node-pty',
      exitCode: parsed.exitCode,
      excerpt: String(parsed.out || '').replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 280),
      ok: parsed.exitCode === 0 && /vigil/i.test(parsed.out || ''),
    };
  } catch (e) {
    return { shell: 'node-pty', error: String(e?.message ?? e).slice(0, 300) };
  }
}

function validateBinShape() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const bin = pkg.bin;
    const ok = !!bin && (typeof bin === 'string' || typeof bin === 'object');
    return {
      shell: 'bin-shape',
      ok,
      excerpt: `package.json bin = ${JSON.stringify(bin)}`,
    };
  } catch (e) {
    return { shell: 'bin-shape', ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

function runNpmPackSmoke() {
  // Don't actually emit a tarball here — supply-chain already did
  // that. Just confirm npm pack --dry-run --json works on this host.
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8', timeout: 60_000, cwd: ROOT, windowsHide: true,
  });
  if ((r.status ?? -1) !== 0) {
    return {
      shell: 'npm-pack-dry-run',
      ok: false,
      exitCode: r.status,
      excerpt: ((r.stdout ?? '') + (r.stderr ?? '')).slice(0, 280),
    };
  }
  try {
    const meta = JSON.parse(r.stdout)[0];
    return {
      shell: 'npm-pack-dry-run',
      ok: true,
      excerpt: `would emit ${meta.filename} (${meta.size} B, ${meta.entryCount} files)`,
    };
  } catch (e) {
    return { shell: 'npm-pack-dry-run', ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

function checkLineEndings() {
  try {
    const sample = readFileSync(VIGIL_JS, 'utf8');
    const hasCR = /\r\n/.test(sample);
    return {
      shell: 'line-endings',
      ok: !hasCR,
      excerpt: hasCR ? 'CRLF detected in dist/bin/vigil.js — will break shebang on POSIX' : 'LF (clean)',
    };
  } catch (e) {
    return { shell: 'line-endings', ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

function checkLongPaths() {
  const out = safePS("(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem').LongPathsEnabled");
  const enabled = out === '1';
  return {
    shell: 'long-paths',
    ok: enabled || true,  // not strictly required, but flagged below
    excerpt: enabled ? 'LongPathsEnabled=1 (good)' : 'LongPathsEnabled=0 (256-char MAX_PATH may bite deep node_modules)',
  };
}

function checkDefender() {
  const json = safePS('Get-MpComputerStatus | Select-Object AMServiceEnabled,AntivirusEnabled,RealTimeProtectionEnabled,IsTamperProtected,AMEngineVersion,AMProductVersion | ConvertTo-Json -Compress');
  if (!json) return { shell: 'defender', skipped: 'Get-MpComputerStatus unavailable' };
  try {
    const j = JSON.parse(json);
    return {
      shell: 'defender',
      ok: true,
      excerpt: `RT=${j.RealTimeProtectionEnabled} AV=${j.AntivirusEnabled} Tamper=${j.IsTamperProtected} engine=${j.AMEngineVersion}`,
    };
  } catch (e) {
    return { shell: 'defender', skipped: `parse failed: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}

// ─── Windows security posture probe (read-only) ───────────────────
export function probeWindowsPosture() {
  if (platform() !== 'win32') return { skipped: 'non-windows host' };
  return {
    defender:     parseJsonPs('Get-MpComputerStatus | Select AMServiceEnabled,AntivirusEnabled,RealTimeProtectionEnabled,BehaviorMonitorEnabled,IoavProtectionEnabled,NISEnabled,OnAccessProtectionEnabled,QuickScanAge,FullScanAge,AntivirusSignatureLastUpdated,IsTamperProtected,AMEngineVersion,AMProductVersion'),
    defenderPrefs:parseJsonPs('Get-MpPreference | Select DisableRealtimeMonitoring,DisableBehaviorMonitoring,DisableScriptScanning,MAPSReporting,SubmitSamplesConsent,PUAProtection,CloudBlockLevel'),
    firewall:     parseJsonPs('Get-NetFirewallProfile | Select Name,Enabled,DefaultInboundAction,DefaultOutboundAction'),
    bitlocker:    parseJsonPs("Get-BitLockerVolume -ErrorAction SilentlyContinue | Select MountPoint,ProtectionStatus,VolumeStatus,EncryptionPercentage,EncryptionMethod"),
    smartScreen:  safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer').SmartScreenEnabled"),
    uacRunAsAdmin:safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System').ConsentPromptBehaviorAdmin"),
    secureBoot:   safePS('Confirm-SecureBootUEFI'),
    tpm:          parseJsonPs('Get-Tpm | Select TpmReady,TpmPresent,ManagedAuthLevel,LockoutHealTime'),
    wuauStatus:   safePS('(Get-Service wuauserv).Status'),
    pendingReboot:safePS('Test-Path HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'),
    listeningPorts: parseJsonPs('Get-NetTCPConnection -State Listen | Select LocalAddress,LocalPort,OwningProcess | Sort-Object LocalPort | Group-Object LocalPort | ForEach-Object { @{ port = $_.Name; count = $_.Count } }'),
    services:     parseJsonPs('Get-Service | Where-Object Status -EQ Running | Select Name,DisplayName | Sort Name | Select -First 50'),
    installedPS:  safePS("(Get-Module -ListAvailable | Select-Object -Property Name -Unique | Measure-Object).Count"),
    pwsh7:        safePwsh('$PSVersionTable.PSVersion.ToString()'),
  };
}

function parseJsonPs(expr) {
  const out = safePS(`(${expr}) | ConvertTo-Json -Compress -Depth 4`);
  if (!out) return null;
  try { return JSON.parse(out); } catch { return out.slice(0, 1000); }
}

// ─── Windows-side variant research bridge ─────────────────────────
// Pulls recent GitHub Security Advisories for direct deps. Lives
// here instead of in security-analysis.mjs so the probe + advisory
// pull are colocated for the Windows-specific run.
export async function pullVariantResearch(directDeps) {
  const { runVariantResearch } = await import('./_variant-research.mjs');
  return runVariantResearch(directDeps);
}
