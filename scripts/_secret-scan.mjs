#!/usr/bin/env node
/**
 * _secret-scan.mjs — Detect secrets, credentials, and API keys committed to source code.
 *
 * Scans source files for high-confidence secret patterns, optionally pushes
 * Critical findings to the Vigil findings store.
 *
 * Usage:
 *   node scripts/_secret-scan.mjs [--json] [--emit-vigil-findings] [--dir <path>]
 *
 * Exits 0 on success, 1 on fatal error.
 */

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-secret-scan] Access denied: VIGIL_SESSION_TOKEN not set.\n');
  process.exit(1);
}

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const EMIT_FINDINGS = argv.includes('--emit-vigil-findings');
const dirArg = argv.indexOf('--dir');
const SCAN_DIR = dirArg >= 0 ? argv[dirArg + 1] : (dirname(fileURLToPath(import.meta.url)) + '/..');

// ── Pattern library ──────────────────────────────────────────────────────────

const PATTERNS = [
  { name: 'Anthropic API Key',    severity: 'critical', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'Anthropic Project Key',severity: 'critical', re: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI API Key',       severity: 'critical', re: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'AWS Access Key',       severity: 'critical', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'AWS Secret Key',       severity: 'critical', re: /(?:aws[_-]?secret|AWS_SECRET[_A-Z]*)\s*[=:]\s*['\"]?[A-Za-z0-9/+=]{40}['\"]?/gi },
  { name: 'GCP Service Account',  severity: 'critical', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'GitHub PAT (classic)', severity: 'high',     re: /ghp_[A-Za-z0-9]{36}/g },
  { name: 'GitHub Fine-grained',  severity: 'high',     re: /github_pat_[A-Za-z0-9_]{82}/g },
  { name: 'GitHub OAuth Token',   severity: 'high',     re: /gho_[A-Za-z0-9]{36}/g },
  { name: 'GitHub Actions Token', severity: 'high',     re: /ghs_[A-Za-z0-9]{36}/g },
  { name: 'NPM Token',            severity: 'high',     re: /npm_[A-Za-z0-9]{36}/g },
  { name: 'Stripe Secret Key',    severity: 'critical', re: /sk_live_[A-Za-z0-9]{24,}/g },
  { name: 'Stripe Publishable',   severity: 'medium',   re: /pk_live_[A-Za-z0-9]{24,}/g },
  { name: 'Twilio Auth Token',    severity: 'critical', re: /SK[0-9a-f]{32}/g },
  { name: 'SendGrid API Key',     severity: 'high',     re: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g },
  { name: 'Slack Bot Token',      severity: 'high',     re: /xoxb-[0-9A-Za-z-]{35,}/g },
  { name: 'Slack User Token',     severity: 'high',     re: /xoxp-[0-9A-Za-z-]{35,}/g },
  { name: 'Slack Webhook',        severity: 'medium',   re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g },
  { name: 'Private Key (PEM)',    severity: 'critical', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/g },
  { name: 'Firebase DB URL',      severity: 'medium',   re: /https:\/\/[a-z0-9-]+\.firebaseio\.com/g },
  { name: 'Firebase Web API Key', severity: 'medium',   re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'JWT Token (live)',     severity: 'high',     re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'Generic Password',     severity: 'high',     re: /(?:^|\s)(?:password|passwd|PASS|DB_PASS)\s*[=:]\s*['\"][^'"]{8,}['"]/gm },
  { name: 'Connection String',    severity: 'high',     re: /(?:mongodb|postgres|mysql|redis):\/\/[^/\s"']{8,}/gi },
  { name: 'Bearer Token (header)',severity: 'medium',   re: /Authorization:\s*Bearer\s+[A-Za-z0-9._\-]{20,}/g },
  { name: 'Generic API Key',      severity: 'medium',   re: /(?:api[_-]?key|api[_-]?secret|apikey)\s*[=:]\s*['\"][A-Za-z0-9_-]{16,}['"]/gi },
  { name: 'Tavily API Key',       severity: 'high',     re: /tvly-[A-Za-z0-9_-]{15,}/g },
  { name: 'DeepSeek API Key',     severity: 'high',     re: /sk-[a-f0-9]{32,}/g },
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.angular', 'coverage', 'security-analysis',
  '__pycache__', '.vscode', '.vigil', '.erosolar', '.agi', '.claude',
]);

const SCAN_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.java', '.cs', '.php',
  '.sh', '.bash', '.zsh', '.ps1',
  '.json', '.yml', '.yaml', '.toml', '.conf', '.ini', '.cfg',
  '.env', '.env.local', '.env.production', '.env.staging',
  '.xml', '.html', '.plist',
]);

// Known-false-positive patterns to skip
const FP_PATTERNS = [
  /\bexample\b/i, /\bplaceholder\b/i, /\byour[_-]?api[_-]?key\b/i,
  /\bfoo\b/, /\bbar\b/, /\btest\b/i, /\b12345\b/, /\babcde\b/i,
  /REPLACE_ME/i, /INSERT_HERE/i, /x{4,}/i, /sk-xxx/i,
  // skip pattern strings in validator / regex code
  /startsWith\(/, /\.length/, /format:/i, /pattern/i,
];

// ── Vigil findings store helpers ─────────────────────────────────────────────

function vigilHome() {
  return process.env['VIGIL_HOME']?.trim() || join(homedir(), '.vigil');
}

function loadFindings() {
  const p = join(vigilHome(), 'findings.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

function saveFindings(records) {
  const home = vigilHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'findings.json'), JSON.stringify(records, null, 2) + '\n');
}

function genId(prefix = 'SEC') {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

// ── Scanner ──────────────────────────────────────────────────────────────────

const hits = [];

function walk(dir, depth = 0) {
  if (depth > 10) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.name.startsWith('.') && !e.name.startsWith('.env')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) { walk(full, depth + 1); continue; }
    if (!e.isFile()) continue;
    const ext = extname(e.name).toLowerCase();
    if (!SCAN_EXTS.has(ext) && !e.name.startsWith('.env')) continue;
    let text;
    try {
      const st = statSync(full);
      if (st.size > 2 * 1024 * 1024) continue;
      text = readFileSync(full, 'utf8');
    } catch { continue; }
    const relPath = relative(SCAN_DIR, full).replace(/\\/g, '/');
    for (const pat of PATTERNS) {
      const matches = [...text.matchAll(pat.re)];
      for (const m of matches) {
        const val = m[0];
        // Skip likely false positives
        if (FP_PATTERNS.some((fp) => fp.test(val))) continue;
        // Mask the value
        const masked = val.length > 12 ? val.slice(0, 6) + '****' + val.slice(-4) : '****';
        // Get line number
        const lineNum = text.slice(0, m.index).split('\n').length;
        const fingerprint = createHash('sha256').update(pat.name + relPath + val).digest('hex').slice(0, 12);
        hits.push({
          pattern: pat.name,
          severity: pat.severity,
          file: relPath,
          line: lineNum,
          excerpt: masked,
          fingerprint,
        });
      }
    }
  }
}

walk(SCAN_DIR);

// Deduplicate by fingerprint
const seen = new Set();
const deduped = hits.filter((h) => {
  if (seen.has(h.fingerprint)) return false;
  seen.add(h.fingerprint);
  return true;
});

// Sort by severity
const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
deduped.sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9));

// ── Emit to Vigil findings store ─────────────────────────────────────────────

if (EMIT_FINDINGS && deduped.length > 0) {
  const existing = loadFindings();
  const existingFingerprints = new Set(existing.map((f) => f._secretFingerprint).filter(Boolean));
  const toAdd = deduped
    .filter((h) => ['critical', 'high'].includes(h.severity))
    .filter((h) => !existingFingerprints.has(h.fingerprint))
    .map((h) => ({
      id: genId('SEC'),
      severity: h.severity,
      title: `${h.pattern} exposed in ${h.file}:${h.line}`,
      target: h.file,
      notes: `Masked value: ${h.excerpt}  fingerprint:${h.fingerprint}`,
      ts: new Date().toISOString(),
      _secretFingerprint: h.fingerprint,
    }));
  if (toAdd.length > 0) {
    saveFindings([...existing, ...toAdd]);
    process.stderr.write(`[vigil-secret-scan] Added ${toAdd.length} findings to Vigil store\n`);
  }
}

// ── Output ───────────────────────────────────────────────────────────────────

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ total: deduped.length, findings: deduped }, null, 2) + '\n');
} else {
  const critCount  = deduped.filter((h) => h.severity === 'critical').length;
  const highCount  = deduped.filter((h) => h.severity === 'high').length;
  const medCount   = deduped.filter((h) => h.severity === 'medium').length;
  process.stdout.write([
    '',
    '═══ Source Code Secret Scan ═══',
    `Scanned: ${SCAN_DIR}`,
    `Findings: ${deduped.length} total  |  ${critCount} CRITICAL  ${highCount} HIGH  ${medCount} MEDIUM`,
    '',
  ].join('\n'));
  for (const h of deduped.slice(0, 60)) {
    const sev = h.severity === 'critical' ? '[CRIT]' : h.severity === 'high' ? '[HIGH]' : '[MED] ';
    process.stdout.write(`  ${sev}  ${h.pattern.padEnd(26)} ${h.file}:${h.line}  ${h.excerpt}\n`);
  }
  if (deduped.length > 60) {
    process.stdout.write(`  ... and ${deduped.length - 60} more\n`);
  }
  process.stdout.write('\n');
}

process.exit(deduped.length > 0 ? 2 : 0);
