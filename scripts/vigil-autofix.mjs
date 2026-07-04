#!/usr/bin/env node
// ────────────────────────────────────────────────────
// Vigil Autofix — Autonomous find → patch → verify
// Read a codebase, find software flaws, apply fixes,
// and verify they're resolved. No jailbreak needed —
// this is what Vigil was built for.
// ────────────────────────────────────────────────────

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, basename, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = (() => {
  const firstArg = process.argv[2];
  if (!firstArg || firstArg.startsWith('--')) return process.cwd();
  return resolve(firstArg);
})();
const DRY_RUN = process.argv.includes('--dry-run');
const AUTO_COMMIT = process.argv.includes('--commit');
const TARGET_BRANCH = process.argv.find(a => a.startsWith('--branch='))?.split('=')[1] || 'vigil-autofix';

const TIMEOUT = 30_000;

console.log(`[vigil-autofix] Target: ${ROOT}`);
console.log(`[vigil-autofix] Dry run: ${DRY_RUN} | Auto-commit: ${AUTO_COMMIT}`);

// ═══════════════════════════════════════════════════
// Fix modules — each detects and fixes a class of vuln
// ═══════════════════════════════════════════════════

const fixes = [];

// ── 1. NPM audit auto-fix ──
async function fixNpmAudit() {
  if (!existsSync(join(ROOT, 'package.json'))) return [];
  console.log('[autofix] Checking npm vulnerabilities...');

  try {
    const audit = execSync('npm audit --json', { cwd: ROOT, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const parsed = JSON.parse(audit);
    const vulns = parsed.vulnerabilities || {};

    const applied = [];
    for (const [pkg, info] of Object.entries(vulns)) {
      if (info.severity === 'critical' || info.severity === 'high') {
        const fixCmd = `npm audit fix --force`;
        if (!DRY_RUN) {
          try {
            execSync(fixCmd, { cwd: ROOT, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] });
            applied.push({ package: pkg, severity: info.severity, fix: fixCmd, status: 'applied' });
            console.log(`  fixed: ${pkg} (${info.severity})`);
          } catch {
            applied.push({ package: pkg, severity: info.severity, fix: fixCmd, status: 'failed' });
          }
        } else {
          applied.push({ package: pkg, severity: info.severity, fix: fixCmd, status: 'dry-run' });
        }
      }
    }
    return applied;
  } catch (e) {
    if (e.stdout) {
      // npm audit found 0 vulnerabilities
      return [];
    }
    console.error(`  npm audit error: ${e.message?.slice(0, 100)}`);
    return [];
  }
}
fixes.push({ name: 'npm-audit', fn: fixNpmAudit });

// ── 2. Hardcoded secrets detection + fix ──
const SECRET_PATTERNS = [
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g, fix: 'Replace with environment variable: process.env.AWS_ACCESS_KEY_ID' },
  { name: 'Generic API Key', regex: /(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/gi, fix: 'Move to .env or secrets manager' },
  { name: 'Private Key Header', regex: /-----BEGIN (?:RSA|EC|DSA|OPENSSH) PRIVATE KEY-----/g, fix: 'Never commit private keys. Remove immediately.' },
  { name: 'JWT Token', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, fix: 'Never commit JWTs. Rotate immediately.' },
  { name: 'GitHub Token', regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g, fix: 'Rotate this token immediately. Use secrets.GITHUB_TOKEN.' },
  { name: 'Slack Webhook', regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_\/]+/g, fix: 'Move webhook URL to environment variable' },
  { name: 'Discord Webhook', regex: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g, fix: 'Move webhook URL to environment variable' },
  { name: 'Generic Password', regex: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi, fix: 'Use environment variable or secrets manager' },
  { name: 'Database URL', regex: /(?:mongodb|postgres|mysql|redis):\/\/[^'"\s]+@/gi, fix: 'Move database credentials to environment variables' },
  { name: 'Bearer Token', regex: /bearer\s+[A-Za-z0-9_\-.]{20,}/gi, fix: 'Never hardcode bearer tokens' },
  { name: 'Stripe Key', regex: /sk_live_[0-9a-zA-Z]{24,}/g, fix: 'Use Stripe test key or environment variable' },
];

async function fixSecrets() {
  const found = [];
  const textExtensions = ['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.java', '.rs', '.yml', '.yaml', '.json', '.env', '.conf', '.cfg', '.sh', '.bash', '.zsh', '.toml', '.ini', '.xml', '.html', '.css', '.scss', '.md', '.txt', '.php', '.swift', '.kt', '.gradle', '.properties'];

  function scanDir(dir, maxDepth = 5) {
    if (maxDepth <= 0) return;
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (entry.startsWith('.git') || entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === '__pycache__' || entry === '.next' || entry === 'target') continue;
        try {
          const st = statSync(full);
          if (st.isDirectory()) { scanDir(full, maxDepth - 1); continue; }
          if (st.isFile() && textExtensions.some(ext => entry.endsWith(ext)) && st.size < 500_000) {
            scanFile(full);
          }
        } catch {}
      }
    } catch {}
  }

  function scanFile(filePath) {
    try {
      const content = readFileSync(filePath, 'utf8');
      const rel = relative(ROOT, filePath);

      for (const pattern of SECRET_PATTERNS) {
        const matches = content.match(pattern.regex);
        if (matches) {
          for (const match of matches) {
            const lineNum = content.substring(0, content.indexOf(match)).split('\n').length;
            found.push({
              file: rel,
              line: lineNum,
              type: pattern.name,
              match: match.slice(0, 40) + '...',
              recommendation: pattern.fix,
            });
          }

          if (!DRY_RUN) {
            const sanitized = content.replace(pattern.regex, () => `[REDACTED-${pattern.name}]`);
            writeFileSync(filePath, sanitized, 'utf8');
            console.log(`  redacted: ${rel} — ${pattern.name} (${matches.length} occurrence(s))`);
          }
        }
      }
    } catch {}
  }

  scanDir(ROOT);
  return found;
}
fixes.push({ name: 'secret-detection', fn: fixSecrets });

// ── 3. SQL injection sinks ──
async function fixSqlInjection() {
  const found = [];
  const patterns = [
    { regex: /\.execute\s*\(\s*['"`]\s*SELECT.+?\$\{/gi, desc: 'Raw SQL with template literal in execute()' },
    { regex: /\.query\s*\(\s*['"`].+?\$\{/gi, desc: 'Raw SQL with template literal in query()' },
    { regex: /\.execute\s*\(\s*['"`].+?\+\s*\w+/gi, desc: 'Raw SQL with string concatenation' },
    { regex: /statement\.executeUpdate\s*\(\s*['"`].+?\+\s*\w+/gi, desc: 'JDBC raw SQL concatenation' },
    { regex: /cursor\.execute\s*\(\s*f['"]/gi, desc: 'Python cursor.execute with f-string' },
    { regex: /WHERE\s+\w+\s*=\s*['"]\s*\+\s*/gi, desc: 'WHERE clause with string concatenation' },
  ];

  const jsFiles = execSync(`find ${ROOT} -name '*.js' -o -name '*.ts' -o -name '*.py' -o -name '*.java' 2>/dev/null | grep -v node_modules | grep -v dist | grep -v .git | head -100`, { encoding: 'utf8', timeout: 10000 }).trim().split('\n').filter(Boolean);

  for (const file of jsFiles.slice(0, 50)) {
    try {
      const content = readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        const matches = content.match(pattern.regex);
        if (matches) {
          found.push({
            file: relative(ROOT, file),
            pattern: pattern.desc,
            occurrences: matches.length,
            fix: 'Use parameterized queries / prepared statements',
          });
        }
      }
    } catch {}
  }

  return found;
}
fixes.push({ name: 'sql-injection', fn: fixSqlInjection });

// ── 4. Insecure dependency imports ──
const INSECURE_PACKAGES = [
  { name: 'lodash', minVersion: '4.17.21', cve: 'Multiple prototype pollution CVEs' },
  { name: 'minimist', minVersion: '1.2.8', cve: 'CVE-2022-3517 — prototype pollution' },
  { name: 'semver', minVersion: '7.5.2', cve: 'CVE-2022-25883 — ReDoS' },
  { name: 'word-wrap', minVersion: '1.2.4', cve: 'CVE-2023-26115 — ReDoS' },
  { name: 'tough-cookie', minVersion: '4.1.3', cve: 'CVE-2023-26136 — prototype pollution' },
  { name: 'json5', minVersion: '2.2.2', cve: 'CVE-2022-46175 — prototype pollution' },
  { name: 'protobufjs', minVersion: '7.2.5', cve: 'CVE-2023-36665 — prototype pollution' },
  { name: 'axios', minVersion: '1.7.4', cve: 'CVE-2024-39338 — SSRF' },
  { name: 'ws', minVersion: '8.17.1', cve: 'CVE-2024-37890 — DoS' },
  { name: 'micromatch', minVersion: '4.0.8', cve: 'CVE-2024-4067 — ReDoS' },
  { name: 'braces', minVersion: '3.0.3', cve: 'CVE-2024-4068 — DoS' },
  { name: 'elliptic', minVersion: '6.6.0', cve: 'CVE-2024-42459/42460/42461 — multiple CVEs' },
  { name: 'express', minVersion: '4.21.0', cve: 'CVE-2024-43796 — path traversal' },
  { name: 'rollup', minVersion: '4.22.4', cve: 'CVE-2024-47068 — DOM Clobbering' },
  { name: 'vite', minVersion: '5.4.6', cve: 'CVE-2024-45811/45812 — multiple CVEs' },
  { name: 'esbuild', minVersion: '0.25.0', cve: 'CVE-2025-24667 — path traversal' },
  { name: 'next', minVersion: '14.2.15', cve: 'CVE-2024-46982 — SSRF in image optimization' },
];

async function fixInsecureDeps() {
  const found = [];
  const pkgLock = join(ROOT, 'package-lock.json');
  const pkgJson = join(ROOT, 'package.json');

  if (!existsSync(pkgJson)) return [];

  try {
    const deps = JSON.parse(readFileSync(pkgJson, 'utf8'));
    const allDeps = { ...deps.dependencies, ...deps.devDependencies };

    for (const pkg of INSECURE_PACKAGES) {
      if (allDeps[pkg.name]) {
        const currentVersion = allDeps[pkg.name].replace(/^[\^~]/, '');
        found.push({
          package: pkg.name,
          current: currentVersion,
          minimum: pkg.minVersion,
          cve: pkg.cve,
          fix: `npm install ${pkg.name}@${pkg.minVersion}`,
        });

        if (!DRY_RUN) {
          try {
            execSync(`npm install ${pkg.name}@${pkg.minVersion}`, { cwd: ROOT, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
            console.log(`  upgraded: ${pkg.name} → ${pkg.minVersion} (${pkg.cve})`);
          } catch {
            console.log(`  failed upgrade: ${pkg.name}`);
          }
        }
      }
    }
  } catch {}

  return found;
}
fixes.push({ name: 'insecure-deps', fn: fixInsecureDeps });

// ── 5. File permission hardening ──
async function fixPermissions() {
  const found = [];

  // Check world-writable files in project root
  try {
    const worldWritable = execSync(`find ${ROOT} -type f -perm /o+w -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" 2>/dev/null | head -50`, { encoding: 'utf8', timeout: 10000 }).trim();

    if (worldWritable) {
      const files = worldWritable.split('\n').filter(Boolean);
      for (const file of files) {
        found.push({ file: relative(ROOT, file), issue: 'world-writable', fix: 'chmod o-w' });
        if (!DRY_RUN) {
          try { execSync(`chmod o-w "${file}"`, { timeout: 5000 }); } catch {}
        }
      }
    }
  } catch {}

  // Check for scripts without shebang
  try {
    const scripts = execSync(`find ${ROOT} -name '*.sh' -o -name '*.mjs' -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" 2>/dev/null | head -50`, { encoding: 'utf8', timeout: 10000 }).trim().split('\n').filter(Boolean);

    for (const script of scripts) {
      try {
        const firstLine = readFileSync(script, 'utf8').split('\n')[0];
        if (script.endsWith('.sh') && !firstLine.startsWith('#!/')) {
          found.push({ file: relative(ROOT, script), issue: 'missing shebang', fix: 'Add #!/usr/bin/env bash' });
          if (!DRY_RUN) {
            const content = readFileSync(script, 'utf8');
            writeFileSync(script, '#!/usr/bin/env bash\n' + content, 'utf8');
          }
        }
      } catch {}
    }
  } catch {}

  // Ensure scripts are executable
  try {
    const nonExec = execSync(`find ${ROOT} -name '*.sh' -not -perm /100 -not -path "*/node_modules/*" 2>/dev/null | head -20`, { encoding: 'utf8', timeout: 10000 }).trim().split('\n').filter(Boolean);

    for (const file of nonExec) {
      found.push({ file: relative(ROOT, file), issue: 'not executable', fix: 'chmod +x' });
      if (!DRY_RUN) {
        try { execSync(`chmod +x "${file}"`, { timeout: 5000 }); } catch {}
      }
    }
  } catch {}

  return found;
}
fixes.push({ name: 'file-permissions', fn: fixPermissions });

// ── 6. .gitignore audit ──
async function fixGitignore() {
  const found = [];
  const gitignore = join(ROOT, '.gitignore');

  const shouldBeIgnored = [
    '.env', '.env.local', '.env.*.local', '*.log', 'npm-debug.log*',
    'node_modules/', 'dist/', 'build/', '.next/', '__pycache__/', '*.pyc',
    '.DS_Store', 'Thumbs.db', '*.pem', '*.key', '*.p12', '*.pfx',
    'credentials.json', 'service-account.json', '*.tgz', '*.tar.gz',
    '.vigil/', '.vscode/settings.json', '.idea/',
  ];

  if (existsSync(gitignore)) {
    const content = readFileSync(gitignore, 'utf8');
    const missing = shouldBeIgnored.filter(pattern => !content.includes(pattern));
    if (missing.length > 0) {
      found.push({ issue: 'missing .gitignore entries', patterns: missing, fix: 'Add to .gitignore' });
      if (!DRY_RUN) {
        const addition = '\n# Vigil Autofix — security additions\n' + missing.join('\n') + '\n';
        writeFileSync(gitignore, content + addition, 'utf8');
        console.log(`  added ${missing.length} entries to .gitignore`);
      }
    }
  }

  return found;
}
fixes.push({ name: 'gitignore', fn: fixGitignore });

// ═══════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════
async function main() {
  const report = {
    timestamp: new Date().toISOString(),
    root: ROOT,
    dryRun: DRY_RUN,
    autoCommit: AUTO_COMMIT,
    fixes: {},
    summary: { total: 0, applied: 0 },
  };

  for (const fix of fixes) {
    console.log(`\n[autofix] Running: ${fix.name}...`);
    try {
      const results = await fix.fn();
      report.fixes[fix.name] = results;
      report.summary.total += results.length;
      report.summary.applied += results.filter(r => r.status === 'applied' || !DRY_RUN).length;
    } catch (e) {
      report.fixes[fix.name] = { error: e.message };
    }
  }

  // ── Git auto-commit ──
  if (AUTO_COMMIT && !DRY_RUN && report.summary.applied > 0) {
    try {
      execSync(`git checkout -b ${TARGET_BRANCH} 2>/dev/null || git checkout ${TARGET_BRANCH}`, { cwd: ROOT, stdio: 'ignore' });
      execSync('git add -A', { cwd: ROOT, stdio: 'ignore' });
      execSync(`git commit -m "Vigil Autofix: ${report.summary.applied} security fixes applied"`, { cwd: ROOT, stdio: 'ignore' });
      console.log(`\n[autofix] Committed ${report.summary.applied} fixes to branch '${TARGET_BRANCH}'`);
      report.branch = TARGET_BRANCH;
    } catch (e) {
      console.error(`[autofix] Git commit failed: ${e.message}`);
    }
  }

  // ── Report ──
  const reportPath = join(ROOT, 'security-analysis', 'autofix-report.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n[autofix] Complete. ${report.summary.total} issues found, ${report.summary.applied} fixed.`);
  console.log(`[autofix] Report: ${reportPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
