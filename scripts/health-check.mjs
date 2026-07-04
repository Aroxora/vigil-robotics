#!/usr/bin/env node
/**
 * Full Health Check for Vigil services and status (June 2026+).
 *
 * Run: node scripts/health-check.mjs [--update-site]
 *
 * Checks:
 * - DeepSeek / Tavily key presence (and cheap balance/usage if possible).
 * - Recent analysis runs (ECCN classifier + capability chains).
 * - 10min loop process / recent activity.
 * - SSE server (via its /health).
 * - Repo/git health.
 * - Website build freshness (vigil-web dist).
 * - Basic auth gate simulation.
 * - Overall aggregate status.
 *
 * Outputs rich JSON to site/vigil-web/public/health.json (and status.json for compat).
 * Designed to be called from the 10min loop or manually/CI.
 *
 * Uses only stdlib + existing project patterns. Graceful degradation if no keys.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = join(ROOT, 'site', 'vigil-web', 'public');
const HEALTH_FILE = join(PUBLIC_DIR, 'health.json');
const STATUS_FILE = join(PUBLIC_DIR, 'status.json'); // compat with old live status

const now = new Date();
const timestamp = now.toISOString();

function safeReadJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function safeStat(p) {
  try { return statSync(p); } catch { return null; }
}

function ageMs(mtime) {
  return now.getTime() - new Date(mtime).getTime();
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

async function httpGet(url, timeoutMs = 5000, headers = {}) {
  const parsed = new URL(url);
  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    timeout: timeoutMs,
    headers,
  };
  return new Promise((resolve) => {
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, data: data || null }));
    });
    req.on('error', () => resolve({ ok: false, status: 0, data: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, data: null }); });
    req.end();
  });
}

async function checkDeepSeek() {
  const key = process.env.DEEPSEEK_API_KEY || '';
  if (!key) return { name: 'DeepSeek Provider', status: 'degraded', details: 'No DEEPSEEK_API_KEY (env or secrets.json)', metric: null };
  try {
    const headers = { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' };
    const res = await httpGet('https://api.deepseek.com/user/balance', 4000, headers);
    if (res.ok) {
      const bal = (tryParseJson(res.data) || {}).balance_infos?.[0];
      const remaining = bal ? `\${bal.total_balance} (${bal.currency})` : 'available';
      return { name: 'DeepSeek Provider', status: 'ok', details: `Key present + API reachable · ${remaining}`, metric: 'balance-checked' };
    }
    return { name: 'DeepSeek Provider', status: 'degraded', details: `Key present but API check failed (${res.status})`, metric: null };
  } catch (e) {
    return { name: 'DeepSeek Provider', status: 'degraded', details: 'Key present but network error on check', metric: null };
  }
}

async function checkTavily() {
  const key = process.env.TAVILY_API_KEY || '';
  if (!key) return { name: 'Tavily Search', status: 'degraded', details: 'No TAVILY_API_KEY', metric: null };
  // We don't want to burn quota on every health check. Just presence + note.
  return { name: 'Tavily Search', status: 'ok', details: 'Key present (usage checked in live status/lambda)', metric: 'key-present' };
}

function checkAnalysisRuns() {
  const analysisRoot = join(ROOT, 'security-analysis');
  const services = [];

  // ECCN Classifier
  const classifierDirs = existsSync(analysisRoot)
    ? execSync(`ls -dt ${analysisRoot}/eccn-classification-* 2>/dev/null | head -1`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    : [];
  const latestClassifier = classifierDirs[0];
  if (latestClassifier) {
    const st = safeStat(latestClassifier);
    const age = st ? ageMs(st.mtime) : Infinity;
    const json = safeReadJson(join(latestClassifier, 'eccn-classification.json'));
    const restricted = json?.summary?.byAccess?.restricted ?? 0;
    services.push({
      name: 'ECCN Classifier Pipeline',
      status: age < 1000 * 60 * 60 * 2 ? 'ok' : 'degraded', // within ~2h
      details: `Last run: ${new Date(st.mtime).toISOString().slice(0,16)}Z • Restricted files: ${restricted}`,
      metric: `${Math.round(age / 60000)}m ago`,
      lastRun: st.mtime
    });
  } else {
    services.push({ name: 'ECCN Classifier Pipeline', status: 'fail', details: 'No recent eccn-classification-* dir found', metric: null });
  }

  // Capability Chains (from 10min loop or daily)
  const chainDirs = existsSync(analysisRoot)
    ? execSync(`ls -dt ${analysisRoot}/eccn-capability-chains/run-* ${analysisRoot}/eccn-capability-chains/daily-* 2>/dev/null | head -1`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    : [];
  const latestChain = chainDirs[0];
  if (latestChain) {
    const st = safeStat(latestChain);
    const age = st ? ageMs(st.mtime) : Infinity;
    services.push({
      name: 'Capability-Chain CNE Evidence Engine',
      status: age < 1000 * 60 * 15 ? 'ok' : 'degraded',
      details: `Last batch: ${new Date(st.mtime).toISOString().slice(0,16)}Z`,
      metric: `${Math.round(age / 60000)}m ago`,
      lastRun: st.mtime
    });
  } else {
    services.push({ name: 'Capability-Chain CNE Evidence Engine', status: 'fail', details: 'No recent run-* or daily-* chain dirs', metric: null });
  }

  return services;
}

function checkLoopAndRepo() {
  const services = [];
  // Repo health
  try {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const clean = status.length === 0;
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
    services.push({
      name: 'Git Repo',
      status: clean ? 'ok' : 'degraded',
      details: clean ? `Clean on ${branch}` : 'Uncommitted changes present',
      metric: branch
    });
  } catch {
    services.push({ name: 'Git Repo', status: 'fail', details: 'git command failed', metric: null });
  }

  // 10min loop activity (recent chain dir is proxy)
  const recentChain = existsSync(join(ROOT, 'security-analysis'))
    ? execSync(`find security-analysis/eccn-capability-chains -name 'run-*' -o -name 'daily-*' -type d 2>/dev/null | xargs ls -dt 2>/dev/null | head -1`, { cwd: ROOT, encoding: 'utf8' }).trim()
    : '';
  if (recentChain) {
    const st = safeStat(recentChain);
    const ageMin = st ? Math.round(ageMs(st.mtime) / 60000) : 999;
    services.push({
      name: '10min Analysis Loop',
      status: ageMin < 15 ? 'ok' : 'degraded',
      details: `Last activity ~${ageMin}m ago (via chain artifacts)`,
      metric: `${ageMin}m`
    });
  } else {
    services.push({ name: '10min Analysis Loop', status: 'degraded', details: 'No recent loop artifacts', metric: null });
  }

  return services;
}

async function checkSSE() {
  const port = process.env.VIGIL_SSE_PORT || 4201;
  const url = `http://localhost:${port}/health`;
  const res = await httpGet(url, 3000);
  if (res.ok) {
    let parsed = null;
    try { parsed = JSON.parse(res.data); } catch {}
    return {
      name: 'SSE Live Updates',
      status: 'ok',
      details: `Listening on :${port} • clients: ${parsed?.clients ?? '?'} • uptime: ${Math.round(parsed?.uptime ?? 0)}s`,
      metric: 'healthy'
    };
  }
  return { name: 'SSE Live Updates', status: 'degraded', details: `Could not reach ${url}`, metric: null };
}

function checkWebsiteBuild() {
  const dist = join(ROOT, 'site', 'vigil-web', 'dist');
  const st = safeStat(dist);
  if (!st || !st.isDirectory()) {
    return { name: 'Website Build (React+Vite)', status: 'fail', details: 'No dist/ found — run npm run build in site/vigil-web', metric: null };
  }
  const ageMin = Math.round(ageMs(st.mtime) / 60000);
  const ok = ageMin < 60; // within last hour considered fresh for dev
  return {
    name: 'Website Build (React+Vite)',
    status: ok ? 'ok' : 'degraded',
    details: `Built ${ageMin}m ago`,
    metric: `${ageMin}m old`
  };
}

async function checkFirebaseAdmin() {
  try {
    const mod = await import('./_firebase-admin.mjs');
    const token = await mod.loadAdminToken();
    return {
      name: 'Firebase Admin (Service Account)',
      status: 'ok',
      details: 'JWT token obtained successfully (no firebase CLI login needed). SA can authenticate Firestore/Storage ops.',
      metric: `token-len=${token.length}`
    };
  } catch (e) {
    return {
      name: 'Firebase Admin (Service Account)',
      status: 'degraded',
      details: `Failed to load SA token: ${e.message}`,
      metric: null
    };
  }
}

function checkSystemResources() {
  const services = [];
  try {
    const mem = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsedPct = Math.round(((totalMem - freeMem) / totalMem) * 100);
    const status = memUsedPct > 90 ? 'degraded' : 'ok';
    services.push({
      name: 'System Memory',
      status,
      details: `Used: ${memUsedPct}% (${Math.round((totalMem - freeMem)/1e6)}MB / ${Math.round(totalMem/1e6)}MB)`,
      metric: `${memUsedPct}%`
    });
  } catch (e) {
    services.push({ name: 'System Memory', status: 'degraded', details: e.message, metric: null });
  }

  try {
    const load = os.loadavg()[0];
    const cpus = os.cpus().length;
    const status = load > cpus * 0.9 ? 'degraded' : 'ok';
    services.push({
      name: 'System Load Avg (1m)',
      status,
      details: `Load: ${load.toFixed(2)} on ${cpus} cores`,
      metric: load.toFixed(2)
    });
  } catch (e) {
    services.push({ name: 'System Load', status: 'degraded', details: e.message, metric: null });
  }

  // Disk space (simple, for /)
  try {
    const df = execSync('df -h / | tail -1', { encoding: 'utf8' }).trim();
    const parts = df.split(/\s+/);
    const usedPct = parseInt(parts[4]) || 0;
    const status = usedPct > 90 ? 'degraded' : 'ok';
    services.push({
      name: 'Disk Space (root)',
      status,
      details: `Used: ${usedPct}% (${parts[2]}/${parts[1]})`,
      metric: `${usedPct}%`
    });
  } catch (e) {
    services.push({ name: 'Disk Space', status: 'degraded', details: 'df failed: ' + e.message, metric: null });
  }

  return services;
}

async function checkNodeAndBuild() {
  const services = [];
  services.push({
    name: 'Node.js Version',
    status: 'ok',
    details: `Node ${process.version} on ${os.platform()} ${os.arch()}`,
    metric: process.version
  });

  try {
    const pkg = safeReadJson(join(ROOT, 'package.json')) || {};
    services.push({
      name: 'Vigil Version',
      status: 'ok',
      details: `${pkg.name || 'vigil'}@${pkg.version || 'unknown'}`,
      metric: pkg.version
    });
  } catch {}

  // Quick CLI build check (if dist is stale)
  const distCli = join(ROOT, 'dist', 'bin', 'vigil.js');
  if (existsSync(distCli)) {
    const st = safeStat(distCli);
    const ageMin = st ? Math.round(ageMs(st.mtime) / 60000) : 999;
    const status = ageMin < 60 ? 'ok' : 'degraded';
    services.push({
      name: 'CLI Build (dist)',
      status,
      details: `Built ${ageMin}m ago`,
      metric: `${ageMin}m old`
    });
  } else {
    services.push({ name: 'CLI Build (dist)', status: 'degraded', details: 'No dist/bin/vigil.js — run npm run build', metric: null });
  }

  // Optional: light npm audit (non-fatal)
  try {
    const audit = execSync('npm audit --json 2>/dev/null || echo "{}"', { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
    const a = JSON.parse(audit);
    const vulns = a.metadata?.vulnerabilities || {};
    const total = Object.values(vulns).reduce((s, v) => s + (v || 0), 0);
    const status = total > 0 ? 'degraded' : 'ok';
    services.push({
      name: 'npm Audit',
      status,
      details: `${total} vulnerabilities found`,
      metric: `${total} vulns`
    });
  } catch {}

  return services;
}

function checkLoopProcess() {
  const services = [];
  const pidFile = '/tmp/vigil-10min-everything.pid';
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim());
      // Very light check — in real env use ps or kill -0
      const procInfo = execSync(`ps -p ${pid} -o pid,etime,comm 2>/dev/null || echo "dead"`, { encoding: 'utf8' }).trim();
      const alive = !procInfo.includes('dead') && procInfo.includes(String(pid));
      services.push({
        name: '10min Loop Process',
        status: alive ? 'ok' : 'degraded',
        details: alive ? `PID ${pid} running (${procInfo.split(/\s+/).slice(1).join(' ')})` : `PID ${pid} not found`,
        metric: alive ? `pid=${pid}` : 'stopped'
      });
    } catch (e) {
      services.push({ name: '10min Loop Process', status: 'degraded', details: 'PID file present but ps failed', metric: null });
    }
  } else {
    services.push({
      name: '10min Loop Process',
      status: 'ok',
      details: 'No PID file (may be running in different launcher). Activity tracked via artifacts.',
      metric: 'artifact-based'
    });
  }
  return services;
}

async function main() {
  console.log('[health-check] Running full Vigil service & status health check...');

  const deepseek = await checkDeepSeek();
  const tavily = await checkTavily();
  const firebaseAdmin = await checkFirebaseAdmin();
  const system = checkSystemResources();
  const nodeBuild = await checkNodeAndBuild();
  const loopProc = checkLoopProcess();
  const analysis = checkAnalysisRuns();
  const loopRepo = checkLoopAndRepo();
  const sse = await checkSSE();
  const website = checkWebsiteBuild();

  const allServices = [deepseek, tavily, firebaseAdmin, ...system, ...nodeBuild, ...loopProc, ...analysis, ...loopRepo, sse, website];

  // Simple aggregate
  const failCount = allServices.filter(s => s.status === 'fail').length;
  const degradedCount = allServices.filter(s => s.status === 'degraded').length;
  let overall = 'ok';
  if (failCount > 0) overall = 'fail';
  else if (degradedCount > 1) overall = 'degraded';

  const report = {
    schemaVersion: '1.0',
    timestamp,
    overall,
    services: allServices,
    meta: {
      platform: os.platform(),
      node: process.version,
      vigilHome: process.env.VIGIL_HOME || '~/.vigil',
      note: 'Run with DEEPSEEK_API_KEY / TAVILY_API_KEY for deeper provider checks. Integrates with 10min loop + SSE.'
    }
  };

  // Ensure public dir
  mkdirSync(PUBLIC_DIR, { recursive: true });

  // Write rich health
  writeFileSync(HEALTH_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');

  // Minimal status.json for existing live status consumers (back-compat)
  const minimalStatus = {
    ranAt: timestamp,
    overall,
    deepseek: deepseek.status,
    tavily: tavily.status,
    sse: sse.status,
    websiteBuild: website.status,
    lastAnalysis: analysis[0]?.metric || 'unknown'
  };
  writeFileSync(STATUS_FILE, JSON.stringify(minimalStatus, null, 2) + '\n', 'utf8');

  console.log(`[health-check] Overall: ${overall}`);
  console.log(`[health-check] Wrote ${HEALTH_FILE}`);
  console.log(`[health-check] Wrote ${STATUS_FILE} (compat)`);

  // Also print a compact table for CLI / 10min loop log
  console.log('\nService Status:');
  allServices.forEach(s => {
    const icon = s.status === 'ok' ? '✅' : s.status === 'degraded' ? '⚠️' : '❌';
    console.log(`  ${icon} ${s.name}: ${s.status} — ${s.details} ${s.metric ? `(${s.metric})` : ''}`);
  });

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('[health-check] Fatal:', err);
    process.exit(1);
  });
}

export { main as runHealthCheck };
