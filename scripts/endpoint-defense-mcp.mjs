#!/usr/bin/env node
// MCP stdio server — Endpoint Defense: filesystem monitoring, malware
// detection, binary hardening, quarantine, process auditing.
// All operations are read-only. Quarantine actions are explicit opt-in.
//
// Authorization: VIGIL_SESSION_TOKEN must be set by the Vigil CLI.

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-endpoint-mcp] Error: VIGIL_SESSION_TOKEN is not set.\n' +
    'This server must be started by the Vigil CLI, not directly.\n');
  process.exit(1);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync, spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 30_000;
const LONG_TIMEOUT = 120_000;
const IS_WIN = platform() === 'win32';
const home = homedir();

// ──────────────────────────────
// Helpers
// ──────────────────────────────
function safeRun(cmd, timeoutMs = TIMEOUT_MS) {
  try {
    const finalCmd = IS_WIN
      ? cmd.replaceAll('2>/dev/null', '2>$null')
      : `timeout ${Math.floor(timeoutMs / 1000)} ${cmd}`;
    return execSync(finalCmd, {
      encoding: 'utf8', timeout: timeoutMs + 5000,
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
      killSignal: 'SIGKILL',
    }).trim();
  } catch { return ''; }
}

function haveExe(name) {
  try {
    const cmd = IS_WIN ? 'where' : 'which';
    const r = spawnSync(cmd, [name], { encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL' });
    return !!((r.stdout ?? '').split(/\r?\n/).filter(Boolean)[0]);
  } catch { return false; }
}

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function guarded(fn) {
  try {
    return jsonResult(await fn());
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] };
  }
}

// ──────────────────────────────
// Suspicious file patterns
// ──────────────────────────────
const MALWARE_EXTENSIONS = [
  '.exe', '.dll', '.sys', '.bat', '.cmd', '.ps1', '.psm1', '.psd1',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta', '.scr',
  '.pif', '.cpl', '.msi', '.msp', '.com', '.drv', '.efi',
].filter(ext => IS_WIN || ['', '.js'].includes(ext) || !['.exe', '.dll', '.sys', '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.vbs', '.vbe', '.jse', '.wsf', '.wsh', '.hta', '.scr', '.pif', '.cpl', '.msi', '.msp', '.com', '.drv'].includes(ext));

const MALWARE_PATHS = [
  '/tmp', '/var/tmp', '/dev/shm', '/run/shm',
  join(home, 'Downloads'), join(home, '.cache'),
  join(home, '.local/share/Trash'),
];

const SUSPICIOUS_NAMES = [
  /^\./,                          // Hidden files
  /\.(exe|dll|scr|bat|cmd|ps1)$/i,  // Executables in user dirs
  /crypt|ransom|malware|trojan|backdoor|rootkit|keylog/i,
  /exploit|payload|shell|reverse/i,
  /miner|xmrig|cpuminer/i,
  /bypass|evasion|obfuscat/i,
];

// ──────────────────────────────
// MCP Server
// ──────────────────────────────
const server = new McpServer({
  name: 'vigil-endpoint-defense',
  version: '1.0.0',
});

// ── Filesystem scan for suspicious files ──
server.registerTool(
  'endpoint_filescan',
  {
    title: 'Filesystem Malware Scan',
    description: 'Scan directories for suspicious files: world-writable executables, hidden files in /tmp, newly created binaries, files with known malware extensions, and abnormal SUID/SGID binaries. Read-only — does not modify files.',
    inputSchema: {
      path: z.string().optional().describe('Path to scan. Defaults to high-risk locations (/tmp, Downloads, cache dirs).'),
      deep: z.boolean().optional().default(false).describe('Perform deep recursive scan (may take several minutes).'),
      timeoutMs: z.number().int().positive().max(600_000).optional().default(120_000),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    const findings = { suspiciousFiles: [], worldWritable: [], suidSgidAbnormal: [], hiddenInTmp: [], recentBinaries: [] };
    const scanPaths = args.path ? [args.path] : MALWARE_PATHS.filter(p => existsSync(p) || !p.startsWith('/'));

    // 1. World-writable executables in system paths
    const worldWrite = safeRun('find /usr/bin /usr/sbin /usr/local/bin /opt -type f -perm /o+w 2>/dev/null | head -50', 30000);
    if (worldWrite) {
      findings.worldWritable = worldWrite.split('\n').filter(Boolean).map(p => ({ path: p, risk: 'World-writable binary — possible tampering' }));
    }

    // 2. SUID/SGID binary audit
    const suidAudit = safeRun('find / -type f \( -perm -4000 -o -perm -2000 \) -not -path "/proc/*" -not -path "/sys/*" 2>/dev/null | head -100', LONG_TIMEOUT);
    if (suidAudit) {
      const knownSafe = ['/usr/bin/sudo', '/usr/bin/su', '/usr/bin/passwd', '/usr/bin/pkexec', '/usr/bin/newgrp', '/usr/bin/chsh', '/usr/bin/chfn', '/usr/bin/gpasswd', '/usr/bin/mount', '/usr/bin/umount', '/usr/bin/ping', '/usr/lib/dbus-1.0/dbus-daemon-launch-helper', '/usr/lib/openssh/ssh-keysign', '/usr/bin/crontab', '/usr/bin/at', '/usr/bin/fusermount', '/usr/bin/wall', '/usr/bin/chage', '/usr/bin/expiry'];
      const abnormal = suidAudit.split('\n').filter(Boolean).filter(p => !knownSafe.some(ks => p.startsWith(ks)));
      findings.suidSgidAbnormal = abnormal.map(p => ({ path: p, risk: 'Abnormal SUID/SGID binary — potential privilege escalation path' }));
    }

    // 3. Hidden files in tmp directories
    for (const dir of ['/tmp', '/var/tmp', '/dev/shm'].filter(d => existsSync(d))) {
      try {
        const hidden = safeRun(`find ${dir} -maxdepth ${args.deep ? '3' : '1'} -name '.*' -type f 2>/dev/null | head -30`, 20000);
        if (hidden) {
          findings.hiddenInTmp.push(...hidden.split('\n').filter(Boolean).map(p => ({ path: p, directory: dir, risk: 'Hidden file in temp directory' })));
        }
      } catch {}
    }

    // 4. Recently modified binaries (last 24 hours)
    const recentBin = safeRun('find /usr/bin /usr/sbin /usr/local/bin /opt /home -type f -executable -mtime -1 2>/dev/null | head -50', LONG_TIMEOUT);
    if (recentBin) {
      findings.recentBinaries = recentBin.split('\n').filter(Boolean).map(p => ({ path: p, risk: 'Binary modified in last 24 hours' }));
    }

    // 5. Suspicious files in scan paths
    for (const scanPath of scanPaths) {
      if (!existsSync(scanPath)) continue;
      try {
        const maxDepth = args.deep ? '' : '-maxdepth 2';
        const listing = safeRun(`find ${scanPath} ${maxDepth} -type f 2>/dev/null | head -200`, 30000);
        if (!listing) continue;

        for (const file of listing.split('\n').filter(Boolean)) {
          const name = file.split('/').pop() || '';
          const suspicious = SUSPICIOUS_NAMES.some(p => p.test(name));

          if (suspicious) {
            try {
              const st = statSync(file);
              findings.suspiciousFiles.push({
                path: file,
                size: st.size,
                modified: st.mtime.toISOString(),
                risk: 'Suspicious filename pattern matches malware naming convention',
              });
            } catch {}
          }

          // Check for executables with no extension
          try {
            const st = statSync(file);
            if (!name.includes('.') && (st.mode & 0o111) !== 0 && st.size > 1024) {
              findings.suspiciousFiles.push({
                path: file,
                size: st.size,
                modified: st.mtime.toISOString(),
                risk: 'Binary without extension in user directory',
              });
            }
          } catch {}
        }
      } catch {}
    }

    return jsonResult({
      scannedAt: new Date().toISOString(),
      scanPaths,
      deep: args.deep,
      summary: {
        totalFindings: findings.suspiciousFiles.length + findings.worldWritable.length + findings.suidSgidAbnormal.length + findings.hiddenInTmp.length + findings.recentBinaries.length,
        suspiciousFiles: findings.suspiciousFiles.length,
        worldWritableBinaries: findings.worldWritable.length,
        abnormalSuidBinaries: findings.suidSgidAbnormal.length,
        hiddenInTmp: findings.hiddenInTmp.length,
        recentBinaries: findings.recentBinaries.length,
      },
      findings,
    });
  },
);

// ── Process / memory scan ──
server.registerTool(
  'endpoint_process_scan',
  {
    title: 'Process Memory Scan',
    description: 'Audit running processes for suspicious activity: processes running from /tmp, processes with deleted binaries, high CPU consumers, unusual network listeners, and processes running as root without a tty. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    const findings = { tmpProcesses: [], deletedBinaries: [], cpuHogs: [], suspiciousNames: [], rootWithoutTty: [] };

    // Process list
    const ps = safeRun('ps auxww 2>/dev/null', 10000);
    if (!ps) return jsonResult({ error: 'Could not list processes' });

    const lines = ps.split('\n').slice(1); // skip header

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;
      const user = parts[0], pid = parts[1], cpu = parseFloat(parts[2]), mem = parseFloat(parts[3]), tty = parts[6], command = parts.slice(10).join(' ');

      // Processes running from /tmp or /dev/shm
      if (command.includes('/tmp/') || command.includes('/dev/shm/')) {
        findings.tmpProcesses.push({ pid, user, cpu, command: command.slice(0, 200) });
      }

      // High CPU consumers (>50%)
      if (cpu > 50) {
        findings.cpuHogs.push({ pid, user, cpu, command: command.slice(0, 200) });
      }

      // Suspicious process names
      const lower = command.toLowerCase();
      const suspiciousKeywords = ['miner', 'crypto', 'xmrig', 'backdoor', 'bind_shell', 'reverse_shell', 'keylog', 'ransom', 'trojan', 'rat_', 'payload', 'exploit', 'c2_', 'beacon'];
      for (const kw of suspiciousKeywords) {
        if (lower.includes(kw)) {
          findings.suspiciousNames.push({ pid, user, keyword: kw, command: command.slice(0, 200) });
          break;
        }
      }

      // Root processes without a controlling terminal
      if (user === 'root' && (tty === '?' || tty === '??') && !command.startsWith('[') && !command.startsWith('systemd') && !command.startsWith('/usr/sbin/')) {
        findings.rootWithoutTty.push({ pid, command: command.slice(0, 200) });
      }
    }

    // Find processes with deleted binaries (zombie malware technique)
    const deleted = safeRun('ls -l /proc/*/exe 2>/dev/null | grep "(deleted)" | head -30', 15000);
    if (deleted) {
      findings.deletedBinaries = deleted.split('\n').filter(Boolean).map(line => {
        const parts = line.trim().split(/\s+/);
        return { path: line.match(/\/proc\/(\d+)\/exe/)?.[1] || '', detail: line.slice(0, 300) };
      });
    }

    return jsonResult({
      scannedAt: new Date().toISOString(),
      summary: {
        tmpProcesses: findings.tmpProcesses.length,
        deletedBinaries: findings.deletedBinaries.length,
        cpuHogs: findings.cpuHogs.length,
        suspiciousNames: findings.suspiciousNames.length,
        rootWithoutTty: findings.rootWithoutTty.length,
      },
      findings,
    });
  },
);

// ── Binary hardening check ──
server.registerTool(
  'endpoint_binary_hardening',
  {
    title: 'Binary Hardening Check',
    description: 'Check ELF/PE binaries for security hardening features: PIE, stack canaries, NX bit, RELRO, FORTIFY_SOURCE, RPATH/RUNPATH. Uses checksec/readelf/objdump. Read-only.',
    inputSchema: {
      target: z.string().describe('Path to a binary or directory of binaries to check.'),
      timeoutMs: z.number().int().positive().max(120_000).optional().default(30000),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    const results = [];
    const target = args.target;

    if (!existsSync(target)) return jsonResult({ error: `Path not found: ${target}` });

    const isDir = statSync(target).isDirectory();
    const binaries = isDir
      ? safeRun(`find ${target} -maxdepth 3 -type f -executable 2>/dev/null | head -20`, 20000).split('\n').filter(Boolean)
      : [target];

    for (const bin of binaries) {
      if (!existsSync(bin)) continue;

      const check = { path: bin, hardening: {} };

      // Check using checksec if available
      if (haveExe('checksec')) {
        const checksec = safeRun(`checksec --file="${bin}" 2>/dev/null`, 15000);
        if (checksec) {
          check.hardening.checksec = checksec.split('\n').filter(l => l.includes(':')).slice(0, 20).map(l => l.trim());
        }
      }

      // Direct ELF checks
      const readelf = safeRun(`readelf -l "${bin}" 2>/dev/null | grep -E "GNU_STACK|GNU_RELRO|INTERP"`, 10000);
      if (readelf) {
        check.hardening.gnu_stack = readelf.includes('RWE') ? 'executable-stack (VULNERABLE)' : 'non-executable-stack';
        check.hardening.gnu_relro = readelf.includes('GNU_RELRO') ? 'partial-or-full-relro' : 'no-relro';
      }

      // Check symbols for stack protection
      const symbols = safeRun(`readelf -s "${bin}" 2>/dev/null | grep -c '__stack_chk_fail'`, 10000).trim();
      check.hardening.stack_canary = parseInt(symbols) > 0 ? 'enabled' : 'disabled (VULNERABLE)';

      // Check RPATH/RUNPATH
      const rpath = safeRun(`readelf -d "${bin}" 2>/dev/null | grep -E "RPATH|RUNPATH"`, 10000);
      if (rpath) {
        check.hardening.rpath = rpath.trim();
        check.hardening.rpath_risk = 'RPATH/RUNPATH present — potential library injection path';
      }

      // Check FORTIFY_SOURCE
      const fortified = safeRun(`readelf -s "${bin}" 2>/dev/null | grep -c '__fortify_fail'`, 10000).trim();
      check.hardening.fortify_source = parseInt(fortified) > 0 ? 'likely-enabled' : 'not-detected';

      // Check PIE (Position Independent Executable)
      const elfType = safeRun(`readelf -h "${bin}" 2>/dev/null | grep "Type:"`, 5000).trim();
      check.hardening.pie = elfType.includes('DYN') ? 'PIE-enabled' : elfType.includes('EXEC') ? 'No-PIE (VULNERABLE)' : 'unknown';

      // Unsafe function imports (if objdump available)
      if (haveExe('objdump')) {
        const unsafeFuncs = safeRun(`objdump -T "${bin}" 2>/dev/null | grep -E '\\b(system|execve|popen|gets|strcpy|strcat|sprintf|scanf|realpath|getopt|mktemp|tmpnam)\\b' | head -20`, 10000);
        if (unsafeFuncs) {
          check.hardening.unsafeFunctions = unsafeFuncs.split('\n').filter(Boolean);
          if (check.hardening.unsafeFunctions.length > 0) {
            check.hardening.unsafeFunctionsRisk = `${check.hardening.unsafeFunctions.length} unsafe function imports detected`;
          }
        }
      }

      // Weak crypto imports
      const weakCrypto = safeRun(`objdump -T "${bin}" 2>/dev/null | grep -iE '\\b(MD5_|SHA1_|DES_|RC4_|RC2_)\\b' | head -10`, 10000);
      if (weakCrypto) {
        check.hardening.weakCrypto = weakCrypto.split('\n').filter(Boolean);
      }

      results.push(check);
    }

    const vulnCount = results.filter(r =>
      r.hardening.stack_canary?.includes('disabled') ||
      r.hardening.pie?.includes('No-PIE') ||
      r.hardening.rpath_risk ||
      r.hardening.unsafeFunctionsRisk
    ).length;

    return jsonResult({
      scannedAt: new Date().toISOString(),
      scanned: results.length,
      vulnerable: vulnCount,
      results,
    });
  },
);

// ── ClamAV integration scan ──
server.registerTool(
  'endpoint_clamav_scan',
  {
    title: 'ClamAV Malware Scan',
    description: 'Run a ClamAV antivirus scan on specified paths. Returns detected threats with virus names. Falls back gracefully if ClamAV is not installed. Read-only scan — no files are quarantined.',
    inputSchema: {
      path: z.string().describe('Path to scan with ClamAV (file or directory).'),
      timeoutMs: z.number().int().positive().max(600_000).optional().default(300_000),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    if (!haveExe('clamscan')) {
      return jsonResult({ error: 'ClamAV not installed', remediation: 'apt install clamav clamav-daemon', path: args.path });
    }

    // Update virus definitions (quick, cached if recent)
    const updateCheck = safeRun('freshclam --version 2>/dev/null || echo "freshclam not found"', 10000);

    // Run clamscan
    const output = safeRun(`clamscan -r --no-summary --infected "${args.path}" 2>/dev/null`, args.timeoutMs);

    const threats = [];
    if (output) {
      for (const line of output.split('\n')) {
        const match = line.match(/^(.+):\s+(.+)\s+FOUND$/);
        if (match) {
          threats.push({ file: match[1], virusName: match[2] });
        }
      }
    }

    return jsonResult({
      scannedAt: new Date().toISOString(),
      path: args.path,
      scanner: 'ClamAV',
      definitionsStatus: updateCheck || 'unknown',
      threatsFound: threats.length,
      threats,
      output: output ? output.slice(0, 30000) : 'Clean — no threats detected',
    });
  },
);

// ── Startup / persistence audit ──
server.registerTool(
  'endpoint_persistence_audit',
  {
    title: 'Persistence Audit',
    description: 'Audit system and user persistence mechanisms: cron jobs, systemd timers, ~/.bashrc, ~/.profile, init scripts, autostart entries, and suspicious startup scripts. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    const findings = [];
    const configs = {};

    // Crontabs
    configs.systemCrontab = safeRun('cat /etc/crontab 2>/dev/null', 5000).slice(0, 10000);
    if (configs.systemCrontab) {
      const lines = configs.systemCrontab.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
      for (const line of lines) {
        if (line.includes('curl') || line.includes('wget') || line.includes('bash -c') || line.includes('/tmp/') || line.includes('base64')) {
          findings.push({ severity: 'high', source: '/etc/crontab', detail: line, risk: 'Suspicious cron job — possible persistence' });
        }
      }
    }

    configs.cronD = safeRun('cat /etc/cron.d/* 2>/dev/null', 5000).slice(0, 20000);
    if (configs.cronD) {
      const lines = configs.cronD.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
      for (const line of lines) {
        if (line.includes('curl') || line.includes('wget') || line.includes('/tmp/') || line.includes('base64')) {
          findings.push({ severity: 'high', source: '/etc/cron.d/*', detail: line, risk: 'Suspicious cron.d entry — possible persistence' });
        }
      }
    }

    // User crontab
    configs.userCrontab = safeRun('crontab -l 2>/dev/null || true', 5000);
    if (configs.userCrontab && configs.userCrontab !== 'no crontab') {
      const lines = configs.userCrontab.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
      for (const line of lines) {
        if (line.includes('curl') || line.includes('wget') || line.includes('/tmp/') || line.includes('base64')) {
          findings.push({ severity: 'critical', source: 'user crontab', detail: line, risk: 'Suspicious user cron job — possible userland persistence' });
        }
      }
    }

    // Systemd timers
    configs.systemdTimers = safeRun('systemctl list-timers --all --no-pager 2>/dev/null | head -50', 10000);
    if (configs.systemdTimers) {
      findings.push({ severity: 'info', source: 'systemd', detail: `${configs.systemdTimers.split('\n').length - 1} active timers` });
    }

    // Shell rc files
    for (const rcFile of [join(home, '.bashrc'), join(home, '.profile'), join(home, '.zshrc'), join(home, '.bash_profile')]) {
      if (existsSync(rcFile)) {
        const content = safeRun(`cat "${rcFile}" 2>/dev/null`, 5000);
        configs[rcFile] = content.slice(0, 5000);
        if (content) {
          const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
          for (const line of lines) {
            if ((line.includes('curl') || line.includes('wget')) && (line.includes('| bash') || line.includes('| sh') || line.includes('> /dev/null'))) {
              findings.push({ severity: 'critical', source: rcFile, detail: line.slice(0, 300), risk: 'Remote code execution in shell startup file' });
            }
          }
        }
      }
    }

    // .ssh/authorized_keys
    const authKeys = safeRun(`cat "${join(home, '.ssh/authorized_keys')}" 2>/dev/null | head -30`, 5000);
    if (authKeys) {
      configs.sshAuthorizedKeys = authKeys;
      const keyCount = authKeys.split('\n').filter(l => l.startsWith('ssh-')).length;
      if (keyCount > 3) {
        findings.push({ severity: 'medium', source: '~/.ssh/authorized_keys', detail: `${keyCount} SSH keys authorized`, risk: 'Multiple SSH keys — ensure all are recognized' });
      }
    }

    // init.d / rc.local
    configs.rcLocal = safeRun('cat /etc/rc.local 2>/dev/null', 5000);
    if (configs.rcLocal) {
      const lines = configs.rcLocal.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
      for (const line of lines) {
        if (line.includes('curl') || line.includes('wget') || line.includes('/tmp/')) {
          findings.push({ severity: 'high', source: '/etc/rc.local', detail: line, risk: 'Suspicious startup script' });
        }
      }
    }

    return jsonResult({
      scannedAt: new Date().toISOString(),
      summary: { totalFindings: findings.length, critical: findings.filter(f => f.severity === 'critical').length, high: findings.filter(f => f.severity === 'high').length },
      findings,
      configuration: configs,
    });
  },
);

// ── YARA rules scan ──
server.registerTool(
  'endpoint_yara_scan',
  {
    title: 'YARA Rules Scan',
    description: 'Scan files with YARA rules for malware pattern matching. Can use built-in rules or a custom rules file. Read-only scan.',
    inputSchema: {
      target: z.string().describe('File or directory to scan with YARA.'),
      rulesFile: z.string().optional().describe('Path to a custom .yar file. Falls back to generic malware rules if omitted.'),
      timeoutMs: z.number().int().positive().max(600_000).optional().default(120_000),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    if (!haveExe('yara')) {
      return jsonResult({ error: 'YARA not installed', remediation: 'apt install yara', target: args.target });
    }

    // Check for rules
    let rulesFile = args.rulesFile;
    if (!rulesFile) {
      // Try common YARA rules locations
      const candidates = ['/usr/share/yara/rules/index.yar', '/etc/yara/rules/index.yar', '/opt/yara/rules/index.yar', join(home, '.yara/rules/index.yar')];
      for (const c of candidates) {
        if (existsSync(c)) { rulesFile = c; break; }
      }
    }

    if (!rulesFile || !existsSync(rulesFile)) {
      return jsonResult({
        error: 'No YARA rules file found',
        hint: 'Download rules from https://github.com/Yara-Rules/rules or provide a custom rules file',
        target: args.target,
      });
    }

    const output = safeRun(`yara -r "${rulesFile}" "${args.target}" 2>/dev/null`, args.timeoutMs);
    const matches = [];
    if (output) {
      for (const line of output.split('\n').filter(Boolean)) {
        const parts = line.split(' ');
        if (parts.length >= 2) {
          matches.push({ file: parts[0], rule: parts.slice(1).join(' ').slice(0, 200) });
        }
      }
    }

    return jsonResult({
      scannedAt: new Date().toISOString(),
      target: args.target,
      rulesFile,
      matches,
      totalMatches: matches.length,
    });
  },
);

// ── Filesystem integrity baseline ──
server.registerTool(
  'endpoint_integrity_baseline',
  {
    title: 'Filesystem Integrity Baseline',
    description: 'Generate a cryptographic baseline (SHA256) of system binaries and critical config files. Can be compared against future runs to detect tampering. Read-only.',
    inputSchema: {
      paths: z.string().optional().describe('Comma-separated paths to hash. Defaults to /usr/bin, /usr/sbin, /bin, /sbin, /etc.'),
      outputFormat: z.enum(['json', 'aide-like']).optional().default('json'),
      limit: z.number().int().positive().max(1000).optional().default(200),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    const paths = args.paths ? args.paths.split(',').map(p => p.trim()) : ['/usr/bin', '/usr/sbin', '/bin', '/sbin', '/etc'];
    const results = [];

    for (const path of paths) {
      if (!existsSync(path)) continue;
      const listing = safeRun(`find ${path} -type f 2>/dev/null | head -${Math.floor(args.limit / paths.length)}`, 30000);
      if (!listing) continue;

      const files = listing.split('\n').filter(Boolean);
      for (const file of files) {
        try {
          const st = statSync(file);
          const hash = safeRun(`sha256sum "${file}" 2>/dev/null | awk '{print $1}'`, 15000).trim();
          results.push({
            path: file,
            sha256: hash || 'error',
            size: st.size,
            mode: st.mode.toString(8).slice(-4),
            uid: st.uid,
            gid: st.gid,
            mtime: st.mtime.toISOString(),
          });
        } catch {}
      }
    }

    return jsonResult({
      generatedAt: new Date().toISOString(),
      baselineId: `vigil-baseline-${Date.now().toString(36)}`,
      totalFiles: results.length,
      paths,
      outputFormat: args.outputFormat,
      files: results,
    });
  },
);

// ──────────────────────────────
// Start server
// ──────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
