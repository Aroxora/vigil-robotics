#!/usr/bin/env node
// ────────────────────────────────────────────────────
// Vigil Daemon — Continuous CNE monitoring
// Runs as a background process, watches for:
//  - New/changed files (potential malware drops)
//  - New listening ports (backdoors)
//  - Suspicious processes (miners, shells)
//  - Configuration changes (tampering)
//  - New cron jobs / persistence mechanisms
//
// Sends alerts via stdout, syslog, or webhook.
// Run: node scripts/vigil-daemon.mjs [--interval 60]
// ────────────────────────────────────────────────────

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, hostname } from 'node:os';
import { createHash } from 'node:crypto';

const INTERVAL_SEC = parseInt(process.argv.find(a => a.startsWith('--interval='))?.split('=')[1] || '60', 10);
const WEBHOOK_URL = process.env.VIGIL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || '';
const STATE_DIR = join(homedir(), '.vigil', 'daemon');
const HOST = hostname();
const IS_WIN = platform() === 'win32';

mkdirSync(STATE_DIR, { recursive: true });

// ── State persistence ──
function loadState(name) {
  try { return JSON.parse(readFileSync(join(STATE_DIR, `${name}.json`), 'utf8')); } catch { return {}; }
}
function saveState(name, data) {
  writeFileSync(join(STATE_DIR, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

// ── Safe exec ──
function safeRun(cmd, timeoutMs = 15_000) {
  try {
    const finalCmd = IS_WIN ? cmd : `timeout ${Math.floor(timeoutMs / 1000)} ${cmd}`;
    return execSync(finalCmd, {
      encoding: 'utf8', timeout: timeoutMs + 3000,
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024,
      killSignal: 'SIGKILL',
    }).trim();
  } catch { return ''; }
}

// ── Alerting ──
function alert(severity, title, detail) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] [${severity.toUpperCase()}] ${title}`;
  console.log(`${severity === 'critical' ? '\x1b[31m' : severity === 'high' ? '\x1b[33m' : '\x1b[36m'}${msg}\x1b[0m`);
  if (detail) console.log(`  ${detail.slice(0, 200)}`);

  // Webhook alert
  if (WEBHOOK_URL && (severity === 'critical' || severity === 'high')) {
    try {
      execSync(`curl -sS -X POST '${WEBHOOK_URL}' -H 'Content-Type: application/json' -d '${JSON.stringify({ content: `**Vigil Daemon [${severity.toUpperCase()}]** — ${HOST}\\n${title}\\n${(detail || '').slice(0, 300)}` }).replace(/'/g, "\\'")}' 2>/dev/null || true`, { timeout: 5000, stdio: 'ignore' });
    } catch {}
  }
}

// ═══════════════════════════════════════════════════
// Watchers
// ═══════════════════════════════════════════════════

// ── 1. New listening ports (possible backdoors) ──
function watchPorts() {
  const state = loadState('ports');
  const current = {};

  const tcp = safeRun('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null', 10000);
  if (tcp) {
    for (const line of tcp.split('\n').slice(1)) {
      const match = line.match(/(\S+)\s+\S+\s+\S+\s+(\S+)\s+(\S+)/);
      if (match) {
        const addr = match[2];
        const port = addr.split(':').pop();
        const process = match[3];
        if (port && !isNaN(parseInt(port))) {
          current[port] = { address: addr, process: process.slice(0, 100), raw: line.slice(0, 200) };
        }
      }
    }
  }

  const prevPorts = new Set(Object.keys(state));
  const currPorts = new Set(Object.keys(current));

  // New ports opened
  for (const port of currPorts) {
    if (!prevPorts.has(port) && parseInt(port) > 0 && parseInt(port) < 1024) {
      const svc = current[port];
      alert('high', `New privileged port ${port} opened`, `${svc.process} listening on ${svc.address}`);
    } else if (!prevPorts.has(port)) {
      const svc = current[port];
      alert('medium', `New port ${port} opened`, `${svc.process} listening on ${svc.address}`);
    }
  }

  // Ports closed (info only)
  for (const port of prevPorts) {
    if (!currPorts.has(port)) {
      console.log(`  Port ${port} closed`);
    }
  }

  saveState('ports', current);
  return Object.keys(current).length;
}

// ── 2. New processes (miners, shells, persistence) ──
function watchProcesses() {
  const state = loadState('processes');
  const seen = new Set(Object.keys(state));
  const current = {};

  const ps = safeRun('ps ax -o pid= -o comm= --no-headers 2>/dev/null', 10000);
  if (!ps) return 0;

  const suspicious = ['miner', 'xmrig', 'cpuminer', 'backdoor', 'bind_shell', 'reverse_shell', 'keylog', 'ransom', 'trojan', 'payload', 'exploit', 'beacon', 'c2_', 'rat_', 'botnet', 'stealer', 'dropper', 'inject', 'hook', 'persist', 'hidden', 'rootkit'];

  for (const line of ps.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = parts[0];
    const comm = parts.slice(1).join(' ');

    current[pid] = comm.slice(0, 200);

    // New process
    if (!seen.has(pid)) {
      // Check for suspicious names
      for (const s of suspicious) {
        if (comm.toLowerCase().includes(s)) {
          alert('critical', `Suspicious process detected: ${comm.slice(0, 80)}`, `PID ${pid} — name matches pattern "${s}"`);
          break;
        }
      }
    }
  }

  saveState('processes', current);
  return Object.keys(current).length;
}

// ── 3. File integrity (watch critical paths) ──
function watchFiles() {
  const state = loadState('files') || {};
  const watchPaths = [
    '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/sudoers',
    '/etc/crontab', '/etc/cron.d', '/etc/systemd/system',
    homedir() + '/.ssh/authorized_keys',
    homedir() + '/.bashrc', homedir() + '/.profile', homedir() + '/.zshrc',
  ];

  let changes = 0;
  for (const path of watchPaths) {
    try {
      if (!existsSync(path)) continue;
      const st = statSync(path);
      const fingerprint = `${st.size}:${st.mtime.getTime()}:${st.mode}`;

      if (state[path] && state[path] !== fingerprint) {
        alert('high', `File modified: ${path}`, `Previous: ${state[path]}, Current: ${fingerprint}`);
        changes++;
      }
      state[path] = fingerprint;
    } catch {}
  }

  // Watch for new files in /tmp with executable bit
  try {
    const tmpExec = safeRun('find /tmp -maxdepth 1 -type f -executable -mmin -5 2>/dev/null | head -10', 10000);
    if (tmpExec) {
      const tmpFiles = tmpExec.split('\n').filter(Boolean);
      const tmpState = loadState('tmpfiles') || {};
      for (const f of tmpFiles) {
        if (!tmpState[f]) {
          alert('high', `New executable in /tmp: ${f}`, 'Possible malware drop');
          changes++;
        }
        tmpState[f] = Date.now();
      }
      saveState('tmpfiles', tmpState);
    }
  } catch {}

  saveState('files', state);
  return changes;
}

// ── 4. New cron / persistence entries ──
function watchPersistence() {
  const state = loadState('persist');
  const checksums = {};
  let changes = 0;

  const sources = [
    ['/etc/crontab', safeRun('cat /etc/crontab 2>/dev/null', 5000)],
    ['cron.d', safeRun('cat /etc/cron.d/* 2>/dev/null', 5000)],
    ['user crontab', safeRun('crontab -l 2>/dev/null || true', 5000)],
    ['systemd timers', safeRun('systemctl list-timers --all --no-pager 2>/dev/null | head -50', 10000)],
    ['autostart', safeRun(`cat ${homedir()}/.config/autostart/*.desktop 2>/dev/null || true`, 5000)],
  ];

  for (const [name, content] of sources) {
    const hash = createHash('sha256').update(content || '').digest('hex');
    checksums[name] = hash;

    if (state[name] && state[name] !== hash) {
      alert('high', `Persistence mechanism changed: ${name}`, 'Cron, timer, or autostart modified — possible attacker persistence');
      changes++;
    }
  }

  saveState('persist', checksums);
  return changes;
}

// ── 5. New users / SSH keys ──
function watchUsers() {
  const state = loadState('users');
  const current = {};

  // Check for new users
  const passwd = safeRun('cat /etc/passwd 2>/dev/null', 5000);
  if (passwd) {
    for (const line of passwd.split('\n').filter(Boolean)) {
      const [user, , uid] = line.split(':');
      if (uid && parseInt(uid) >= 1000 && parseInt(uid) < 65534) {
        current[user] = uid;
        if (state[user] === undefined) {
          alert('critical', `New user account: ${user}`, `UID ${uid} — investigate immediately`);
        }
      }
    }
  }

  // Check SSH authorized_keys
  const authKeys = safeRun(`cat ${homedir()}/.ssh/authorized_keys 2>/dev/null | wc -l`, 5000).trim();
  if (authKeys) {
    const keyCount = parseInt(authKeys);
    const prevCount = state['ssh_keys'] || 0;
    if (keyCount > prevCount) {
      alert('critical', `${keyCount - prevCount} new SSH key(s) added`, 'Check ~/.ssh/authorized_keys for unauthorized access');
    }
    current['ssh_keys'] = keyCount;
  }

  saveState('users', current);
  return Object.keys(current).length;
}

// ── 6. Suspicious network connections ──
function watchNetwork() {
  const state = loadState('network') || {};
  const current = {};
  let alerts = 0;

  const conns = safeRun('ss -tnp state established 2>/dev/null | head -100', 10000);
  if (conns) {
    for (const line of conns.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;

      // Check for connections to known-bad ports (common C2 ports)
      const remote = parts[4] || '';
      const port = remote.split(':').pop() || '';
      const badPorts = ['4444', '5555', '6666', '6667', '7777', '8080', '8443', '8888', '9001', '1337', '31337', '44444', '55555'];
      if (badPorts.includes(port)) {
        alert('high', `Connection to suspicious port ${port}`, `Remote: ${remote}`);
        alerts++;
      }
    }
  }

  saveState('network', current);
  return alerts;
}

// ═══════════════════════════════════════════════════
// Main loop
// ═══════════════════════════════════════════════════
const WATCHERS = [
  { name: 'ports', fn: watchPorts },
  { name: 'processes', fn: watchProcesses },
  { name: 'files', fn: watchFiles },
  { name: 'persistence', fn: watchPersistence },
  { name: 'users', fn: watchUsers },
  { name: 'network', fn: watchNetwork },
];

let iteration = 0;

console.log(`[vigil-daemon] Starting continuous monitoring on ${HOST} (${platform()})`);
console.log(`[vigil-daemon] Interval: ${INTERVAL_SEC}s | Webhook: ${WEBHOOK_URL ? 'configured' : 'none'}`);
console.log(`[vigil-daemon] State: ${STATE_DIR}`);
console.log('');

async function tick() {
  iteration++;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] Tick #${iteration}`);

  for (const watcher of WATCHERS) {
    try {
      const count = watcher.fn();
      if (iteration === 1) console.log(`  ${watcher.name}: ${count} baseline items recorded`);
    } catch (e) {
      console.error(`  ${watcher.name}: error — ${e.message?.slice(0, 100)}`);
    }
  }
  console.log('');
}

// First run builds baselines
await tick();

// Then run on interval
setInterval(tick, INTERVAL_SEC * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[vigil-daemon] Shutting down. State preserved in ~/.vigil/daemon/');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n[vigil-daemon] Terminated.');
  process.exit(0);
});
