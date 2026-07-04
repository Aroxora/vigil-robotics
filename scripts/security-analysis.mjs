#!/usr/bin/env node
// security-analysis.mjs — real, multi-pass defensive security
// analysis on this repo. Emits a structured findings bundle, then
// pushes findings to Firestore and the binary tarball to Firebase
// Storage.
//
// Unlike patchpivot (which is variant-analysis only and intentionally
// keeps binaries OUT of the repo and out of any artifact store other
// than the operator's local ~/.erosolar/artifacts/), this pipeline
// does FOUR things and SAVES the binary deliberately:
//
//   1. dep audit + sca + license + outdated
//   2. SAST sink scan + secret regex sweep on OUR source
//   3. SBOM
//   4. supply-chain integrity: npm pack → sha256 → keep tarball
//      locally at security-analysis/<runId>/binaries/ AND upload to
//      Firebase Storage so downstream defenders can pull the exact
//      audited blob (the gitignore retains *.tgz outside of the
//      analysis output dir, so we don't double-commit binaries)
//   5. variant intel: upstream advisory feed pointers for direct deps
//
// Usage:
//   node scripts/security-analysis.mjs                # full run, upload
//   node scripts/security-analysis.mjs --local        # skip uploads
//   node scripts/security-analysis.mjs --no-pack      # skip npm pack

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-security-analysis] Access denied: VIGIL_SESSION_TOKEN not set. Must run within the Vigil CLI.\n');
  process.exit(1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = new Set(process.argv.slice(2));
const LOCAL_ONLY = ARGS.has('--local');
const SKIP_PACK = ARGS.has('--no-pack');
const SKIP_CNE_INVENTORY = ARGS.has('--no-cne-inventory');

const NOW = new Date();
const RUN_ID = NOW.toISOString().replace(/[:.]/g, '-');
const OUT_DIR = join(ROOT, 'security-analysis', RUN_ID);
const BIN_DIR = join(OUT_DIR, 'binaries');
mkdirSync(BIN_DIR, { recursive: true });

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const repoMeta = {
  name: pkg.name,
  version: pkg.version,
  npmHomepage: `https://www.npmjs.com/package/${pkg.name}`,
  git: safeExec('git rev-parse HEAD').trim(),
  branch: safeExec('git rev-parse --abbrev-ref HEAD').trim(),
  remote: safeExec('git config --get remote.origin.url').trim(),
};

// Pattern sets used by scanCode(). Declared before main() to dodge
// the temporal-dead-zone since main() invokes scanCode() at runtime.
const SECRET_PATTERNS = [
  { name: 'npm-token',       re: /\bnpm_[A-Za-z0-9]{36,}\b/ },
  { name: 'aws-access-key',  re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'gh-pat',          re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'gh-oauth',        re: /\bgho_[A-Za-z0-9]{36}\b/ },
  { name: 'slack-bot',       re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'google-api-key',  re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'private-rsa',     re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/ },
  { name: 'deepseek-key',    re: /\bsk-[0-9a-f]{32}\b/ },
  { name: 'anthropic-key',   re: /\bsk-ant-(?:api03|sid|prod)-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'openai-key',      re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'tavily-key',      re: /\btvly-(?:dev-|live-)?[A-Za-z0-9]{20,}\b/ },
  { name: 'firebase-jwt',    re: /\beyJhbGciOiJSUzI1NiIs[A-Za-z0-9_.-]{40,}/ },
  { name: 'generic-bearer',  re: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{30,}/ },
  { name: 'generic-ai-key',  re: /\b(?:sk|api[-_]?key|api[-_]?secret)['\"]?\s*[:=]\s*['\"][A-Za-z0-9_-]{20,}['\"]/ },
  { name: 'xai-grok-key',    re: /\bxai-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'jwt-generic',     re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'base64-secret',   re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/ }, // potential high entropy, filtered later
  { name: 'env-secret',      re: /(?:SECRET|TOKEN|KEY|PASSWORD|API_KEY)\s*=\s*['"][^'"]{8,}['"]/i },
];

const RISKY_SINKS = [
  { name: 'eval',                      re: /(^|[^.\w])eval\s*\(/ },
  { name: 'Function-ctor',             re: /\bnew\s+Function\s*\(/ },
  { name: 'child_process.exec',        re: /\bchild_process\.exec\s*\(/ },
  { name: 'execSync-shell-true',       re: /execSync\(.{0,80}\bshell\s*:\s*true/ },
  { name: 'spawn-shell-true',          re: /\bspawn\(.{0,80}\bshell\s*:\s*true/ },
  { name: 'http-noTLS',                re: /\brequire\(['"]http['"]\)/ },
  { name: 'fs.chmod-777',              re: /chmod(?:Sync)?\([^,]+,\s*0o?777/ },
  { name: 'TODO-security',             re: /\b(?:TODO|FIXME|XXX)\b[^\n]*\b(?:secur|crypto|password|token|secret)/i },
  { name: 'tls-reject-unauthorized-0', re: /(?:NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|rejectUnauthorized\s*:\s*false)/ },
  { name: 'weak-crypto-algo',          re: /\b(?:createHash|createHmac)\s*\(\s*['"](?:md5|sha1)['"]/ },
  { name: 'math-random-crypto',        re: /Math\.random\(\)[^\n]*\b(?:token|key|secret|nonce|iv|salt|crypto)/i },
  { name: 'hardcoded-cert-key',        re: /['"]-----BEGIN\s+(?:CERTIFICATE|PRIVATE\s+KEY)-----/ },
  { name: 'cert-verify-bypass',        re: /(?:checkServerIdentity|verify)\s*:\s*\(\s*\)\s*=>\s*(?:undefined|true|void\s*0)/ },
  { name: 'innerHTML-raw',             re: /\.innerHTML\s*=\s*[^;]+/ },
  { name: 'document-write',            re: /document\.write\s*\(/ },
  { name: 'dangerouslySetInnerHTML',   re: /dangerouslySetInnerHTML\s*=\s*\{/ },
  { name: 'prototype-pollution',       re: /\bObject\.assign\s*\(\s*[^,]+,\s*[^)]*__proto__|constructor\.prototype/ },
  { name: 'regex-dos',                 re: /new\s+RegExp\s*\(\s*[^,]+,\s*['"](?:g|i|gi|ig)?['"]?\s*\)/ }, // simplistic
  { name: 'fs-unlink-recursive',       re: /fs\.rmSync|fs\.rmdirSync|rimraf.*\{.*recursive/ },
];

const SCAN_DIRS = ['src', 'agents', 'scripts', 'aws/lambda/src', 'aws/scripts', 'site/vigil-app/src', 'Erosolar_Browser', 'site'];
const SCAN_EXTRA = ['package.json', 'README.md', 'mcp.json.example', '.env.example'];
const SECRET_SCAN_EXTRAS = ['.env', '.env.local', '.npmrc', 'mcp.json', '.env.example'];

await main();

async function main() {
  console.log(`[security-analysis] run=${RUN_ID}`);
  console.log(`[security-analysis] target=${pkg.name}@${pkg.version}`);
  console.log(`[security-analysis] out=${relative(ROOT, OUT_DIR)}`);

  console.log('[1/20] npm audit');
  const npmAudit = safeJSON('npm audit --json', { swallow: true });
  const auditSummary = summarizeAudit(npmAudit);
  writeJSON('1-npm-audit.json', npmAudit);
  writeJSON('1-npm-audit-summary.json', auditSummary);

  console.log('[2/20] license scan');
  const licenseReport = scanLicenses();
  writeJSON('2-licenses.json', licenseReport);

  console.log('[3/20] outdated deps');
  const outdated = safeJSON('npm outdated --json --depth=0', { swallow: true, allowEmpty: true }) || {};
  writeJSON('3-outdated.json', outdated);

  console.log('[4/20] SAST + secret scan');
  const codeFindings = scanCode();
  writeJSON('4-code-findings.json', codeFindings);

  console.log('[5/20] SBOM');
  const sbom = buildSbom();
  writeJSON('5-sbom.cyclonedx-min.json', sbom);

  console.log('[6/20] supply-chain integrity (pack + hash + retain)');
  let supplyChain = { skipped: true };
  if (!SKIP_PACK) {
    supplyChain = packAndHash();
    writeJSON('6-supply-chain.json', supplyChain);
  }

  console.log('[7/20] variant intel');
  const variantIntel = collectVariantIntel();
  writeJSON('7-variant-intel.json', variantIntel);

  console.log('[8/20] variant research (GitHub Security Advisories)');
  const { runVariantResearch } = await import('./_variant-research.mjs');
  const variantResearch = await runVariantResearch(variantIntel.targets);
  writeJSON('8-variant-research.json', variantResearch);

  console.log('[9/20] Glasswing-era disclosure lifecycle (CVE triage + patch pipeline tracking)');
  const glasswingDisclosure = collectGlasswingDisclosures({ root: ROOT, auditSummary, variantIntel });
  writeJSON('9-glasswing-disclosures.json', glasswingDisclosure);

  console.log('[10/20] cloud reachability (AWS, GCP, Azure, Firebase, k8s, Terraform)');
  const { probeCloudReachability } = await import('./_cloud-reachability.mjs');
  const cloudReachability = probeCloudReachability();
  writeJSON('10-cloud-reachability.json', cloudReachability);

  console.log('[11/20] platform probe (host + Windows posture)');
  const { probePlatform, probeWindowsPosture } = await import('./_platform-probe.mjs');
  const platformInfo = probePlatform();
  const windowsPosture = probeWindowsPosture();
  writeJSON('9-platform.json', { platform: platformInfo, windowsPosture });

  console.log('[12/20] exhaustive cross-shell smoke');
  const { runWindowsShellSmoke } = await import('./_platform-probe.mjs');
  const shellSmoke = runWindowsShellSmoke();
  writeJSON('10-shell-smoke.json', shellSmoke);

  console.log('[13/20] advisory investigation (per-pkg deep dive + sandboxed fix)');
  const { investigateAdvisories } = await import('./_advisory-investigation.mjs');
  const advisoryReport = await investigateAdvisories({
    root: ROOT,
    outDir: OUT_DIR,
    vulnerable: auditSummary.vulnerable,
  });
  writeJSON('11-advisory-investigation.json', advisoryReport);

  console.log('[14/20] CNE inventory (apps, protocols, OS surface, cloud)');
  let cneInventory;
  if (SKIP_CNE_INVENTORY) {
    cneInventory = { skipped: '--no-cne-inventory set', generatedAt: NOW.toISOString() };
  } else {
    const { probeCneInventory } = await import('./_cne-inventory.mjs');
    cneInventory = probeCneInventory();
  }
  writeJSON('12-cne-inventory.json', cneInventory);

  console.log('[15/20] patchpivot findings (variant-analysis CVE ingestion)');
  const { probePatchpivotFindings } = await import('./_patchpivot-findings.mjs');
  const patchpivotFindings = await probePatchpivotFindings();
  writeJSON('13-patchpivot-findings.json', patchpivotFindings);

  console.log('[16/20] comprehensive vulnerability scan (browsers, Python, WSL, Docker, installed SW)');
  const { probeComprehensiveVulns } = await import('./_comprehensive-vuln-scan.mjs');
  const comprehensiveVulns = probeComprehensiveVulns();
  writeJSON('14-comprehensive-vulns.json', comprehensiveVulns);

  console.log('[17/20] Ghidra headless binary analysis (SUID binaries, service daemons, hardening checks)');
  let ghidraResults = { skipped: 'Ghidra headless scan skipped' };
  try {
    const { probeGhidraHeadless } = await import('./_ghidra-headless.mjs');
    ghidraResults = probeGhidraHeadless();
  } catch (e) { ghidraResults = { error: String(e).slice(0, 300) }; }
  writeJSON('15-ghidra-analysis.json', ghidraResults);

  console.log('[18/18] normalized vulnerability discovery (safe PoC code generation + enhanced ECCN triage with crypto/AI-key detection + 25+ validator templates)');
  let vulnerabilityDiscovery = { skipped: 'Vulnerability discovery skipped' };
  try {
    const { runVulnerabilityDiscovery } = await import('./_vulnerability-discovery.mjs');
    vulnerabilityDiscovery = await runVulnerabilityDiscovery({
      root: ROOT,
      outDir: OUT_DIR,
      auditSummary,
      advisoryReport,
      codeFindings,
      cneInventory,
      comprehensiveVulns,
      ghidraResults,
    });
    if (vulnerabilityDiscovery.validatorsEmitted) {
      console.log(`    → ${vulnerabilityDiscovery.validatorsEmitted} safe PoC validator files generated`);
    }
  } catch (e) {
    vulnerabilityDiscovery = { error: String(e).slice(0, 300) };
  }
  writeJSON('16-vulnerability-discovery.json', vulnerabilityDiscovery);

  // Phase 3: Comprehensive vulnerability discovery
  console.log('[19/20] Phase 3 comprehensive vulnerability discovery (all surfaces, all platforms)');
  let comprehensiveReport = { skipped: 'comprehensive scan skipped' };
  try {
    const { runComprehensive } = await import('./_vigil-comprehensive.mjs');
    comprehensiveReport = await runComprehensive({
      platform: process.platform,
      outDir: OUT_DIR,
      skipNetwork: ARGS.has('--skip-network'),
      maxFindings: ARGS.has('--max-findings') ? Number(process.argv[process.argv.indexOf('--max-findings') + 1]) || 5000 : 5000,
    });
  } catch (e) {
    comprehensiveReport = { error: String(e).slice(0, 300) };
  }
  writeJSON('17-vigil-comprehensive.json', comprehensiveReport);

  // Phase 3: ECCN classification
  console.log('[20/20] Full ECCN classification & compliance scan');
  let eccnReport = { skipped: 'ECCN classification skipped' };
  try {
    const { classifyRepository } = await import('./_eccn-classifier.mjs');
    const eccnOutDir = join(OUT_DIR, 'eccn-classification');
    eccnReport = classifyRepository(ROOT, eccnOutDir);
  } catch (e) {
    eccnReport = { error: String(e).slice(0, 300) };
  }
  writeJSON('18-eccn-classification.json', eccnReport);

  const companyAdvisories = comprehensiveVulns?.companyAdvisories || comprehensiveVulns || {};

  const findings = {
    runId: RUN_ID,
    ranAt: NOW.toISOString(),
    repo: repoMeta,
    passes: {
      'npm-audit': auditSummary,
      licenses: licenseReport.summary,
      outdated: { count: Object.keys(outdated).length, packages: Object.keys(outdated) },
      'code-findings': {
        secrets: codeFindings.secrets.length,
        risky_sinks: codeFindings.sinks.length,
        world_writable: codeFindings.world_writable.length,
      },
      sbom: { components: sbom.components.length },
      'supply-chain': supplyChain,
      'variant-intel': { tracked: variantIntel.targets.length },
      'variant-research': summarizeVariantResearch(variantResearch),
      'glasswing-disclosures': glasswingDisclosure,
      'cloud-reachability': summarizeCloudReachability(cloudReachability),
      'advisory-investigation': {
        investigated: advisoryReport.investigated,
        totalVulnerable: advisoryReport.totalVulnerable ?? 0,
        sandboxValidations: advisoryReport.sandboxValidations ?? 0,
        advisories: advisoryReport.advisories ?? [],
      },
      'cne-inventory': summarizeCneInventory(cneInventory),
      'patchpivot-findings': patchpivotFindings,
      'comprehensive-vulns': comprehensiveVulns,
      'ghidra-analysis': ghidraResults,
      'vulnerability-discovery': summarizeVulnerabilityDiscovery(vulnerabilityDiscovery),
      'company-advisories': companyAdvisories,
      platform: platformInfo,
      windowsPosture,
      shellSmoke: shellSmoke.skipped ? shellSmoke : shellSmoke.summary,
    },
    severity: deriveSeverity(auditSummary, codeFindings),
  };
  writeJSON('findings.json', findings);
  writeFile('findings.md', renderMarkdown(findings, codeFindings, licenseReport, variantIntel));

  // Generate machine-readable vulnerability list for external integration.
  const vulnList = buildVulnList(auditSummary, advisoryReport, patchpivotFindings, cneInventory, comprehensiveVulns, vulnerabilityDiscovery);
  writeJSON('vulnerabilities.json', vulnList);

  console.log(`\n[security-analysis] OK ${OUT_DIR}`);
  console.log(`[security-analysis] severity=${findings.severity}`);

  if (LOCAL_ONLY) {
    console.log('[security-analysis] --local set, skipping upload');
    return;
  }

  const { uploadToFirebase } = await import('./_firebase-upload.mjs');
  await uploadToFirebase({ runId: RUN_ID, outDir: OUT_DIR, findings, supplyChain });
  console.log('[security-analysis] OK uploaded to Firestore + Firebase Storage');
}

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function writeJSON(name, value) {
  writeFileSync(join(OUT_DIR, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}
function writeFile(name, value) {
  writeFileSync(join(OUT_DIR, name), value, 'utf8');
}

function safeExec(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, killSignal: 'SIGKILL' }); }
  catch { return ''; }
}

function safeJSON(cmd, { swallow = false, allowEmpty = false } = {}) {
  try {
    const out = execSync(cmd, {
      encoding: 'utf8', cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    if (!out.trim() && allowEmpty) return null;
    return JSON.parse(out);
  } catch (e) {
    if (swallow) {
      const stdout = e.stdout?.toString() ?? '';
      if (stdout.trim()) {
        try { return JSON.parse(stdout); } catch { /* fall through */ }
      }
      if (allowEmpty) return null;
      return { error: String(e.message || e).slice(0, 400) };
    }
    throw e;
  }
}

function summarizeAudit(audit) {
  if (!audit?.metadata) return { totalAdvisories: 0, bySeverity: {}, vulnerable: [] };
  const sev = audit.metadata.vulnerabilities ?? {};
  const vulnerable = [];
  for (const [name, info] of Object.entries(audit.vulnerabilities ?? {})) {
    vulnerable.push({
      name,
      severity: info.severity,
      isDirect: info.isDirect,
      via: (info.via ?? []).map((v) => typeof v === 'string' ? v : v.source ?? v.name).filter(Boolean),
      fixAvailable: info.fixAvailable
        ? (typeof info.fixAvailable === 'object' ? info.fixAvailable : true)
        : false,
    });
  }
  return { totalAdvisories: vulnerable.length, bySeverity: sev, vulnerable };
}

function scanLicenses() {
  const seen = new Map();
  const root = join(ROOT, 'node_modules');
  if (!existsSync(root)) return { summary: { byLicense: {}, unlicensed: 0 }, packages: [] };
  walkPackages(root, (pkgPath) => {
    try {
      const p = JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8'));
      if (!p.name) return;
      const key = `${p.name}@${p.version}`;
      if (seen.has(key)) return;
      const lic = typeof p.license === 'string'
        ? p.license
        : p.license?.type ?? (Array.isArray(p.licenses)
          ? p.licenses.map((l) => l.type || l).join(' OR ')
          : 'UNKNOWN');
      seen.set(key, { name: p.name, version: p.version, license: lic || 'UNKNOWN' });
    } catch { /* skip */ }
  });
  const packages = [...seen.values()];
  const byLicense = {};
  let unlicensed = 0;
  for (const p of packages) {
    const k = p.license || 'UNKNOWN';
    byLicense[k] = (byLicense[k] ?? 0) + 1;
    if (!p.license || p.license === 'UNKNOWN') unlicensed++;
  }
  return { summary: { byLicense, unlicensed }, packages };
}

function walkPackages(root, fn) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.bin' || entry.name === '.cache') continue;
    if (entry.name.startsWith('.') && !entry.name.startsWith('@')) continue;
    const full = join(root, entry.name);
    if (entry.name.startsWith('@')) {
      walkPackages(full, fn);
      continue;
    }
    if (existsSync(join(full, 'package.json'))) fn(full);
    const nested = join(full, 'node_modules');
    if (existsSync(nested)) walkPackages(nested, fn);
  }
}

function scanCode() {
  const secrets = [];
  const sinks = [];
  const world_writable = [];

  for (const dir of SCAN_DIRS) {
    const full = join(ROOT, dir);
    if (!existsSync(full)) continue;
    walkFiles(full, (filePath) => {
      const rel = relative(ROOT, filePath).replace(/\\/g, '/');
      if (rel.includes('/node_modules/')) return;
      if (rel.endsWith('.lock') || rel.endsWith('.min.js')) return;
      const text = safeRead(filePath);
      if (!text) return;
      scanTextForFindings(text, rel, secrets, sinks);
      try {
        const st = statSync(filePath);
        if (process.platform !== 'win32' && (st.mode & 0o002)) {
          world_writable.push({ path: rel, mode: (st.mode & 0o777).toString(8) });
        }
      } catch { /* skip */ }
    });
  }

  for (const file of [...SCAN_EXTRA, ...SECRET_SCAN_EXTRAS]) {
    const p = join(ROOT, file);
    if (!existsSync(p)) continue;
    const text = safeRead(p);
    if (!text) continue;
    scanTextForFindings(text, file, secrets, sinks);
  }

  return { secrets, sinks, world_writable };
}

function scanTextForFindings(text, rel, secrets, sinks) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of SECRET_PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        secrets.push({
          rule: p.name,
          file: rel,
          line: i + 1,
          excerpt: maskToken(line.slice(0, 200)),
        });
      }
    }
    for (const p of RISKY_SINKS) {
      const m = line.match(p.re);
      if (m) {
        sinks.push({ rule: p.name, file: rel, line: i + 1, excerpt: line.trim().slice(0, 200) });
      }
    }
    // Simple high-entropy secret finder (next iteration to find more)
    if (/[A-Za-z0-9+/=]{32,}/.test(line) && !/^(const|let|var|export|import|function|class|\/\/| \*|console\.|process\.)/.test(line.trim())) {
      const potential = line.match(/[A-Za-z0-9+/=]{40,}/g) || [];
      for (const pot of potential) {
        if (entropy(pot) > 4.5) {  // high entropy threshold
          secrets.push({
            rule: 'high-entropy-string',
            file: rel,
            line: i + 1,
            excerpt: maskToken(pot.slice(0, 30) + '…'),
          });
        }
      }
    }
  }
}

function entropy(s) {
  const freq = {};
  for (const c of s) freq[c] = (freq[c] || 0) + 1;
  let e = 0;
  for (const c in freq) {
    const p = freq[c] / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

function maskToken(s) {
  return s
    .replace(/\bnpm_[A-Za-z0-9]{36,}\b/g, (t) => `${t.slice(0, 8)}…${t.slice(-4)}`)
    .replace(/\bsk-[0-9a-f]{32}\b/g, (t) => `${t.slice(0, 6)}…${t.slice(-4)}`)
    .replace(/\bsk-ant-[A-Za-z0-9_-]{15,}\b/g, (t) => `${t.slice(0, 10)}…${t.slice(-4)}`)
    .replace(/\bsk-proj-[A-Za-z0-9_-]{15,}\b/g, (t) => `${t.slice(0, 10)}…${t.slice(-4)}`)
    .replace(/\btvly-[A-Za-z0-9-]+\b/g, (t) => `${t.slice(0, 8)}…${t.slice(-4)}`)
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, (t) => `${t.slice(0, 6)}…${t.slice(-4)}`);
}

function safeRead(p) {
  try {
    const st = statSync(p);
    if (st.size > 2 * 1024 * 1024) return '';
    return readFileSync(p, 'utf8');
  } catch { return ''; }
}

function walkFiles(root, fn) {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.angular') continue;
    if (e.name === '.git' || e.name === '.firebase') continue;
    const full = join(root, e.name);
    if (e.isDirectory()) walkFiles(full, fn);
    else if (e.isFile()) fn(full);
  }
}

function buildSbom() {
  const lockPath = join(ROOT, 'package-lock.json');
  if (!existsSync(lockPath)) {
    return { bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, components: [], notice: 'No package-lock.json found — run npm install first for full SBOM.' };
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const components = [];
  const seen = new Set();
  for (const [pathKey, info] of Object.entries(lock.packages ?? {})) {
    if (!pathKey || pathKey === '') continue;
    const name = info.name ?? pathKey.split('node_modules/').slice(-1)[0];
    const version = info.version;
    if (!name || !version) continue;
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    components.push({
      type: 'library',
      name,
      version,
      purl: `pkg:npm/${name.replace('@', '%40')}@${version}`,
      licenses: info.license ? [{ license: { id: info.license } }] : undefined,
      hashes: info.integrity ? [{ alg: 'sha512', content: info.integrity.replace(/^sha512-/, '') }] : undefined,
    });
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${cryptoRandomUUID()}`,
    version: 1,
    metadata: {
      timestamp: NOW.toISOString(),
      component: { type: 'application', name: pkg.name, version: pkg.version },
    },
    components,
  };
}

function cryptoRandomUUID() {
  try { return globalThis.crypto.randomUUID(); }
  catch {
    return [8, 4, 4, 4, 12].map((n) => randomHex(n)).join('-');
    function randomHex(n) {
      let s = '';
      for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
      return s;
    }
  }
}

function packAndHash() {
  const tmp = join(BIN_DIR, '.pack-tmp');
  mkdirSync(tmp, { recursive: true });
  const out = execSync(`npm pack --pack-destination "${tmp}" --json`, {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024,
  });
  const meta = JSON.parse(out)[0];
  const srcPath = join(tmp, meta.filename);
  const dstName = `${pkg.name.replace('/', '-').replace(/^@/, '')}-${pkg.version}.tgz`;
  const dstPath = join(BIN_DIR, dstName);
  renameSync(srcPath, dstPath);
  try { require('node:fs').rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  const buf = readFileSync(dstPath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const sha512 = createHash('sha512').update(buf).digest('hex');
  return {
    package: `${pkg.name}@${pkg.version}`,
    tarball: dstName,
    relPath: relative(ROOT, dstPath).replace(/\\/g, '/'),
    sizeBytes: buf.length,
    sha256,
    sha512,
    npmIntegrity: meta.integrity,
    files: meta.files?.length ?? null,
  };
}

function collectVariantIntel() {
  // Build a small intel sheet for the direct deps that have public
  // advisory feeds. Operators use this as a starter list for the
  // patch-watch loop.
  const directs = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
  const known = {
    '@anthropic-ai/sdk': 'https://github.com/anthropics/anthropic-sdk-typescript/security/advisories',
    'openai': 'https://github.com/openai/openai-node/security/advisories',
    '@google/genai': 'https://github.com/googleapis/js-genai/security/advisories',
    '@modelcontextprotocol/sdk': 'https://github.com/modelcontextprotocol/typescript-sdk/security/advisories',
    'react': 'https://github.com/facebook/react/security/advisories',
    'ink': 'https://github.com/vadimdemedes/ink/security/advisories',
    'typescript': 'https://github.com/microsoft/TypeScript/security/advisories',
    'jest': 'https://github.com/jestjs/jest/security/advisories',
    'eslint': 'https://github.com/eslint/eslint/security/advisories',
    'firebase-tools': 'https://github.com/firebase/firebase-tools/security/advisories',
    'playwright': 'https://github.com/microsoft/playwright/security/advisories',
    'node-pty': 'https://github.com/microsoft/node-pty/security/advisories',
    // Glasswing-era intelligence feeds — not npm packages, but critical
    // for staying ahead of the AI-driven vulnerability discovery frontier.
    'exploitbench': 'https://github.com/anthropics/exploitbench',
    'exploitgym': 'https://github.com/anthropics/exploitgym',
    'wolfssl': 'https://github.com/wolfSSL/wolfssl/security/advisories',
  };
  const targets = directs.filter((d) => known[d]).map((d) => ({
    name: d,
    pinned: pkg.dependencies?.[d] ?? pkg.devDependencies?.[d] ?? pkg.optionalDependencies?.[d],
    advisory: known[d],
  }));
  return { targets, generatedAt: NOW.toISOString() };
}

function collectGlasswingDisclosures({ root, auditSummary, variantIntel }) {
  // Track the disclosure lifecycle for known Glasswing-era
  // vulnerabilities. The Glasswing project (Anthropic, May 2026)
  // demonstrated that AI-driven discovery now far outpaces human
  // triage+patch capacity. This pass surfaces:
  //
  //   1. Known Glasswing-discovered CVEs affecting our dependency tree
  //   2. CVE lifecycle stage per finding (discovered→triaged→disclosed→patched→advisory)
  //   3. Disclosure-window tracking (90-day coordinated disclosure)
  //   4. Triage-bottleneck metrics (how many findings await human review)

  const knownCVEs = [
    {
      cve: 'CVE-2026-5194',
      pkg: 'wolfssl',
      summary: 'Certificate forgery via exploit construction in wolfSSL',
      severity: 'critical',
      discoveredBy: 'Claude Mythos Preview / Project Glasswing',
      disclosedAt: '2026-05-20',
      patchedAt: null, // newly disclosed, patch in progress
      advisoryUrl: 'https://github.com/wolfSSL/wolfssl/security/advisories',
      notes: 'Allows attacker to forge certificates for hosting fake websites (bank/email) that appear legitimate.',
    },
  ];

  // Cross-reference our dependency tree
  const inOurTree = [];
  const vulnerable = auditSummary?.vulnerable ?? [];
  for (const cve of knownCVEs) {
    const match = vulnerable.find((v) =>
      v.name.toLowerCase().includes(cve.pkg.toLowerCase()) ||
      (v.via ?? []).some((d) => {
        const name = typeof d === 'string' ? d : (d?.source ?? d?.name ?? '');
        return name.toLowerCase().includes(cve.pkg.toLowerCase());
      })
    );
    if (match) {
      inOurTree.push({ ...cve, matchVia: match.name, matchSeverity: match.severity });
    }
  }

  // Triage-bottleneck metrics: how many npm-audit findings need
  // human verification before they can advance to disclosure/patched.
  const totalFindings = vulnerable.length;
  const triageNeeded = vulnerable.filter((v) =>
    // Not auto-fixable (no fixAvailable) or requires human review for
    // semver-major bumps — these represent the "bottleneck" that
    // Glasswing identified as the new critical constraint.
    !v.fixAvailable ||
    (typeof v.fixAvailable === 'object' && v.fixAvailable.isSemVerMajor)
  );

  // Disclosure-window tracking: count findings by disclosure stage
  const stageCounts = {
    discovered: vulnerable.length, // npm audit surfaced these
    triaged: vulnerable.filter((v) => v.fixAvailable != null).length,
    disclosed: 0, // requires operational context (have we reported them?)
    patched: vulnerable.filter((v) => v.fixAvailable && typeof v.fixAvailable === 'object').length,
    advisoryPublished: auditSummary?.totalAdvisories ?? 0,
  };

  // External benchmark awareness: ExploitBench + ExploitGym track
  // frontier-model exploit-development capability over time. These
  // are not npm deps but are worth watching for defender awareness.
  const benchmarks = [
    {
      name: 'ExploitBench',
      url: 'https://github.com/anthropics/exploitbench',
      description: 'Academic benchmark for model exploit development capabilities',
      relevance: 'Mythos Preview is the strongest performer — tracks the AI exploitation frontier.',
    },
    {
      name: 'ExploitGym',
      url: 'https://github.com/anthropics/exploitgym',
      description: 'Exploit development benchmark for frontier AI models',
      relevance: 'Second benchmark confirming Mythos Preview leads exploit capability measurements.',
    },
    {
      name: 'UK AISI Cyber Ranges',
      url: 'https://www.aisi.gov.uk/',
      description: 'UK AI Security Institute multistep cyberattack simulation ranges',
      relevance: 'Mythos Preview is the first model to solve both ranges end-to-end.',
    },
  ];

  return {
    generatedAt: NOW.toISOString(),
    knownGlasswingCVEs: knownCVEs.length,
    inOurDependencyTree: inOurTree.length,
    inOurTree,
    triageBottleneck: {
      totalFindings,
      requireHumanTriage: triageNeeded.length,
      autoFixable: totalFindings - triageNeeded.length,
      note: 'Glasswing finding: AI discovery outpacing human triage. Triage-needed count represents the new bottleneck.',
    },
    disclosureLifecycle: stageCounts,
    defensePosture: {
      patchCycleUrgency: 'shorten patch testing and deployment timelines',
      recommendations: [
        'Shorten patch cycles and make security fixes available quickly',
        'Help users stay up-to-date — ease installation of updates',
        'Harden network default configurations',
        'Enforce multi-factor authentication',
        'Keep comprehensive logs for detection and response',
        'Use AI-assisted tools (Claude Security, vigil) for triage automation',
      ],
    },
    externalBenchmarks: benchmarks,
  };
}

function summarizeVariantResearch(items) {
  let totalAdv = 0;
  let crit = 0, high = 0, moderate = 0, low = 0;
  const perDep = [];
  for (const r of items) {
    const n = (r.advisories ?? []).length;
    totalAdv += n;
    for (const a of r.advisories ?? []) {
      const s = (a.severity ?? '').toLowerCase();
      if (s === 'critical') crit++;
      else if (s === 'high') high++;
      else if (s === 'moderate' || s === 'medium') moderate++;
      else if (s === 'low') low++;
    }
    perDep.push({ name: r.name, count: n, error: r.error });
  }
  return { tracked: items.length, totalAdvisories: totalAdv, bySeverity: { critical: crit, high, moderate, low }, perDep };
}

function summarizeCloudReachability(cr) {
  if (!cr) return { skipped: true };
  return {
    aws: cr.aws?.installed ?? false,
    awsIdentity: cr.aws?.identity ? 'active' : 'none',
    gcp: cr.gcp?.installed ?? false,
    gcpAccount: cr.gcp?.activeAccount || null,
    azure: cr.azure?.installed ?? false,
    firebase: cr.firebase?.installed ?? false,
    terraform: cr.terraform?.installed ?? false,
    terraformStates: cr.terraform?.stateDirs?.length ?? 0,
    kubernetes: cr.kubernetes?.installed ?? false,
    kubeContexts: cr.kubernetes?.contexts ? String(cr.kubernetes.contexts).split(/\r?\n/).filter(Boolean).length : 0,
    dockerRegistries: cr.dockerHub?.registries?.length ?? 0,
    npmPublish: cr.npm?.authenticated ?? false,
  };
}

function summarizeCneInventory(ci) {
  if (!ci || ci.skipped) return { skipped: ci?.skipped ?? 'not run' };
  const countOrTotal = (v) => Array.isArray(v) ? v.length : (v?.total ?? (v?.sample?.length ?? 0));
  const harden = ci.hardening?.summary ?? { total: 0, passed: 0, failed: 0 };
  return {
    generatedAt: ci.generatedAt,
    apps: {
      registryUninstall: countOrTotal(ci.apps?.registryUninstall),
      appx:              countOrTotal(ci.apps?.appx),
      winget:            countOrTotal(ci.apps?.winget),
      choco:             countOrTotal(ci.apps?.choco),
      scoop:             countOrTotal(ci.apps?.scoop),
      msiProducts:       countOrTotal(ci.apps?.msiProducts),
    },
    protocols: {
      smb1Enabled:       ci.protocols?.smb?.server?.EnableSMB1Protocol === true,
      tls10ServerOn:     Number(ci.protocols?.tls?.['TLS 1.0']?.serverEnabled) === 1,
      tls12ServerOn:     Number(ci.protocols?.tls?.['TLS 1.2']?.serverEnabled) === 1,
      tls13ServerOn:     Number(ci.protocols?.tls?.['TLS 1.3']?.serverEnabled) === 1,
      ntlmLevel:         ci.protocols?.ntlm?.lmCompatibilityLevel,
      llmnrEnabled:      ci.protocols?.llmnr,
      rdpNlaEnabled:     Number(ci.protocols?.rdp?.userAuthentication) === 1,
      winrmStatus:       ci.protocols?.winrm?.serviceStatus,
    },
    features: {
      optionalFeatures:  countOrTotal(ci.features?.optionalFeatures),
      capabilities:      countOrTotal(ci.features?.capabilities),
      hyperV:            ci.features?.hyperV,
      wsl:               ci.features?.wsl,
      sandbox:           ci.features?.sandbox,
      smartAppControl:   ci.features?.smartAppControl,
    },
    persistence: {
      services:          countOrTotal(ci.persistence?.services),
      scheduledTasks:    countOrTotal(ci.persistence?.scheduledTasks),
      startupCommands:   countOrTotal(ci.persistence?.startupCommands),
      drivers:           countOrTotal(ci.persistence?.drivers),
    },
    advancedPersistence: {
      wmiFilters:        countOrTotal(ci.advancedPersistence?.wmi?.eventFilters),
      wmiConsumers:      countOrTotal(ci.advancedPersistence?.wmi?.eventConsumers),
      lsaPackages:       ci.advancedPersistence?.lsaPackages?.packages ?? null,
      ifeoHijacks:       countOrTotal(ci.advancedPersistence?.ifeo?.entries),
      accessibilityHijacks: ci.advancedPersistence?.accessibilityHijacks
        ? Object.entries(ci.advancedPersistence.accessibilityHijacks).filter(([,v]) => v?.hijacked).map(([k]) => k)
        : [],
      bitsJobs:          countOrTotal(ci.advancedPersistence?.bitsJobs),
    },
    networkSurface: {
      activeTcp:         countOrTotal(ci.networkSurface?.activeConnections),
      tlsListeners:      countOrTotal(ci.networkSurface?.listeners),
      udpListeners:      countOrTotal(ci.networkSurface?.udpListeners),
      arpEntries:        countOrTotal(ci.networkSurface?.arpTable),
      dnsEntries:        Number(ci.networkSurface?.dnsCache?.count ?? 0),
      shares:            countOrTotal(ci.networkSurface?.networkShares),
      proxy:             ci.networkSurface?.proxySettings?.proxyEnable === '1',
    },
    identity: {
      localUsers:        countOrTotal(ci.identity?.localUsers),
      localGroups:       countOrTotal(ci.identity?.localGroups),
      adminCount:        countOrTotal(ci.identity?.administratorsMembers),
      rdpUsers:          countOrTotal(ci.identity?.remoteDesktopUsers),
    },
    cryptoSecrets: {
      personalCerts:     countOrTotal(ci.cryptoSecrets?.certificateStore?.personal),
      caCerts:           countOrTotal(ci.cryptoSecrets?.certificateStore?.ca),
      credManagerTargets: String(ci.cryptoSecrets?.credentialManager?.targets ?? '').split(/\r?\n/).filter(Boolean).length,
      sshKeysPresent:    ci.cryptoSecrets?.sshKeys?.userSshDir?.exists === true,
      gpgKeysPresent:    ci.cryptoSecrets?.gpgKeys?.exists === true,
      envSecretsFound:   countOrTotal(ci.cryptoSecrets?.environmentSecrets),
    },
    virtualization: {
      wslInstalled:      ci.virtualization?.wsl?.installed === true,
      wslKali:           ci.virtualization?.wsl?.kaliWsl === true,
      hyperVEnabled:     ci.virtualization?.hyperV?.enabled === true,
      hyperVVMs:         countOrTotal(ci.virtualization?.hyperV?.vms),
      dockerInstalled:   ci.virtualization?.docker?.installed === true,
      dockerContainers:  countOrTotal(ci.virtualization?.docker?.containers),
      sandboxEnabled:    ci.virtualization?.sandboxEnabled === 'Enabled',
    },
    serviceVulns: {
      unquotedPaths:     countOrTotal(ci.serviceVulns?.unquotedServicePaths),
      alwaysInstallElevated: ci.serviceVulns?.alwaysInstallElevated?.hklm === '1' || ci.serviceVulns?.alwaysInstallElevated?.hkcu === '1',
      writablePathDirs:  ci.serviceVulns?.pathInterception?.writable ?? 0,
    },
    securityTools: ci.securityTools?.tools ?? {},
    osVulns: {
      hotfixCount: countOrTotal(ci.osVulns?.installedHotfixes),
      lastPatchDate: ci.osVulns?.lastPatchDate || null,
      buildVersion: `${ci.osVulns?.buildInfo?.osVersion ?? '?'} build ${ci.osVulns?.buildInfo?.build ?? '?'}`,
      wuServiceRunning: ci.osVulns?.windowsUpdate?.serviceRunning === 'Running',
      pendingReboot: ci.osVulns?.pendingReboot === 'True',
      missingPatchesScanned: !ci.osVulns?.missingPatches?.skipped,
    },
    hardening: harden,
    hardeningFails: (ci.hardening?.checks ?? []).filter((c) => c.status === 'fail').map((c) => c.id),
  };
}

function summarizeVulnerabilityDiscovery(discovery) {
  if (!discovery || discovery.skipped || discovery.error) {
    return discovery ?? { skipped: 'not run' };
  }
  return {
    schemaVersion: discovery.schemaVersion,
    generatedAt: discovery.generatedAt,
    summary: discovery.summary ?? {},
    validatorsEmitted: discovery.validatorsEmitted ?? 0,
    sources: discovery.sources ?? {},
    topFindings: discovery.topFindings ?? [],
    safePocLibrary: discovery.safePocLibrary ?? [],
    eccnRegistry: {
      generatedAt: discovery.eccnRegistry?.generatedAt,
      policy: discovery.eccnRegistry?.policy,
      summary: discovery.eccnRegistry?.summary ?? { total: 0, restricted: 0, controlled: 0, public: 0 },
      entries: (discovery.eccnRegistry?.entries ?? []).slice(0, 200),
    },
  };
}

function deriveSeverity(audit, code) {
  const sev = audit.bySeverity ?? {};
  if ((sev.critical ?? 0) > 0) return 'critical';
  if ((code.secrets.length ?? 0) > 0) return 'high';
  if ((sev.high ?? 0) > 0) return 'high';
  if ((sev.moderate ?? 0) > 0) return 'moderate';
  if ((sev.low ?? 0) > 0) return 'low';
  return 'info';
}

function buildVulnList(audit, advisoryReport, patchpivotFindings, cneInventory, comprehensiveVulns, vulnerabilityDiscovery) {
  // Produces a clean, machine-readable JSON list of all vulnerabilities
  // found across all sources. Designed for external integration — every
  // entry has a stable schema with CVE IDs, severities, descriptions,
  // fix targets, and re-check URLs.
  const vulns = [];
  const now = new Date().toISOString();

  // npm audit vulnerabilities
  const npmVulns = audit?.vulnerable ?? [];
  const advisories = advisoryReport?.advisories ?? [];
  for (const v of npmVulns) {
    const adv = advisories.find((a) => a.pkg === v.name);
    const details = (adv?.vulnDetails ?? []).map((d) => ({
      ghsaId: d.ghsaId,
      cveId: d.cveId,
      severity: d.severity,
      summary: d.summary,
      description: d.description?.slice(0, 500) ?? '',
      cvssScore: d.cvssScore,
      cvssVector: d.cvssVector,
      cwes: d.cwes,
      publishedAt: d.publishedAt,
      htmlUrl: d.htmlUrl,
      affectedRange: d.affectedVersions?.map((av) => av.range) ?? [],
      firstPatched: d.affectedVersions?.find((av) => av.firstPatched)?.firstPatched ?? null,
    }));

    vulns.push({
      source: 'npm-audit',
      package: v.name,
      severity: v.severity,
      isDirect: v.isDirect,
      fixAvailable: !!v.fixAvailable,
      proposedFix: {
        target: adv?.proposedTarget ?? null,
        source: adv?.proposedTargetSource ?? null,
        command: adv?.proposedFixCommand ?? (adv?.proposedTarget ? `npm install ${v.name}@${adv.proposedTarget}` : null),
        sandboxValidated: adv?.sandboxValidated ?? false,
        sandboxCleared: adv?.postFixClears ?? false,
      },
      depPaths: adv?.depPathSample ?? [],
      vulnDetails: details,
      recheckUrl: `https://github.com/advisories?query=${encodeURIComponent(v.name)}`,
      lastChecked: now,
    });
  }

  // Patchpivot variant-analysis findings
  if (patchpivotFindings && !patchpivotFindings.skipped) {
    for (const f of patchpivotFindings.findings ?? []) {
      vulns.push({
        source: 'patchpivot-variant-analysis',
        cveId: f.cveId,
        title: f.title,
        severity: f.severity,
        status: f.status,
        cvss: f.cvss,
        bugClass: f.bugClass,
        affected: f.affected,
        description: f.description,
        hypothesis: f.hypothesis?.slice(0, 800) ?? '',
        variantCount: f.variantCount,
        disclosure: f.disclosure ?? {},
        recheckUrl: `https://nvd.nist.gov/vuln/detail/${f.cveId}`,
        lastChecked: now,
      });
    }
  }

  // Windows OS vulnerabilities (from CNE inventory)
  if (cneInventory && !cneInventory.skipped) {
    const missing = cneInventory?.osVulns?.missingPatches?.raw ?? '';
    const hotfixCount = cneInventory?.osVulns?.installedHotfixes?.length
      ?? (Array.isArray(cneInventory?.osVulns?.installedHotfixes) ? cneInventory.osVulns.installedHotfixes.length : 0);
    const lastPatch = cneInventory?.osVulns?.lastPatchDate ?? null;
    const buildVer = `${cneInventory?.osVulns?.buildInfo?.osVersion ?? '?'} build ${cneInventory?.osVulns?.buildInfo?.build ?? '?'}`;

    vulns.push({
      source: 'windows-os',
      buildVersion: buildVer,
      installedHotfixes: hotfixCount,
      lastPatchDate: lastPatch,
      pendingReboot: cneInventory?.osVulns?.pendingReboot === 'True',
      wuRunning: cneInventory?.osVulns?.windowsUpdate?.serviceRunning === 'Running',
      missingPatchesSummary: missing ? 'scan succeeded — see raw' : 'scan requires admin',
      recheckUrl: `https://msrc.microsoft.com/update-guide`,
      lastChecked: now,
    });
  }

  // Company advisories (Twitch, Google, Apple, Microsoft, Oracle, etc.)
  const companyAdvs = comprehensiveVulns?.companyAdvisories;
  if (companyAdvs?.companies) {
    for (const company of companyAdvs.companies) {
      for (const adv of (company.recentAdvisories ?? [])) {
        vulns.push({
          source: `company-advisory-${company.company.toLowerCase().replace(/[^a-z]/g, '-')}`,
          company: company.company,
          vendor: company.company,
          cveId: adv.id,
          product: adv.product,
          severity: adv.severity,
          description: adv.desc,
          date: adv.date,
          advisoryFeed: company.advisoryFeed,
          advisoryUrl: company.url,
          trackedProducts: company.trackedProducts,
          note: company.note,
          lastChecked: now,
        });
      }
      // Also add the company itself as an advisory tracking entry
      if (company.recentAdvisories.length === 0) {
        vulns.push({
          source: `company-advisory-${company.company.toLowerCase().replace(/[^a-z]/g, '-')}`,
          company: company.company,
          vendor: company.company,
          trackedProducts: company.trackedProducts,
          advisoryFeed: company.advisoryFeed,
          advisoryUrl: company.url,
          note: company.note,
          lastChecked: now,
        });
      }
    }
  }

  // Linux kernel vulnerabilities (from comprehensive scan)
  const kernelVulns = comprehensiveVulns?.kernel?.kernelVulns ?? [];
  for (const kv of kernelVulns) {
    if (kv.applicable) {
      vulns.push({
        source: 'kernel-cve',
        cveId: kv.cve,
        product: `Linux Kernel ${comprehensiveVulns?.kernel?.kernel || 'unknown'}`,
        severity: kv.severity,
        description: kv.description,
        name: kv.name,
        lastChecked: now,
      });
    }
  }

  // Linux system packages with security upgrades
  if (comprehensiveVulns?.systemPackages?.securityUpgrades > 0) {
    vulns.push({
      source: 'linux-system-packages',
      product: 'apt/dpkg system packages',
      severity: 'high',
      description: `${comprehensiveVulns.systemPackages.securityUpgrades} security upgrades available out of ${comprehensiveVulns.systemPackages.upgradable} total upgradable packages (${comprehensiveVulns.systemPackages.totalPackages} installed).`,
      upgradable: comprehensiveVulns.systemPackages.upgradable,
      securityUpgrades: comprehensiveVulns.systemPackages.securityUpgrades,
      lastChecked: now,
    });
  }

  // Kali tool vulnerabilities
  const kaliToolVulns = comprehensiveVulns?.kaliTools?.toolVulns ?? [];
  for (const tv of kaliToolVulns) {
    vulns.push({
      source: 'kali-tool-cve',
      cveId: tv.cve,
      product: `Kali Linux: ${tv.tool}`,
      severity: tv.severity,
      description: tv.desc,
      lastChecked: now,
    });
  }

  // SUID binaries
  if (comprehensiveVulns?.suidBinaries?.riskyPresent > 0) {
    vulns.push({
      source: 'linux-suid',
      product: 'SUID Binaries',
      severity: 'medium',
      description: `${comprehensiveVulns.suidBinaries.riskyPresent} risky SUID binaries found (${comprehensiveVulns.suidBinaries.totalCount} total SUID binaries). List: ${(comprehensiveVulns.suidBinaries.riskyBinaries || []).join(', ')}`,
      totalSuid: comprehensiveVulns.suidBinaries.totalCount,
      riskyCount: comprehensiveVulns.suidBinaries.riskyPresent,
      lastChecked: now,
    });
  }

  // Normalized discovery pass: safe evidence recipes, threat intel enrichment,
  // binary hardening signals, local exposures, secret/path findings, and ECCN triage.
  for (const f of vulnerabilityDiscovery?.findings ?? []) {
    vulns.push({
      source: `vulnerability-discovery:${f.source}`,
      normalized: true,
      id: f.id,
      category: f.category,
      title: f.title,
      severity: f.severity,
      cveIds: f.cveIds ?? [],
      ghsaIds: f.ghsaIds ?? [],
      osvIds: f.osvIds ?? [],
      affected: f.affected ?? {},
      evidence: (f.evidence ?? []).slice(0, 3),
      safeProof: f.safeProof,
      remediation: f.remediation ?? {},
      threatIntel: f.threatIntel ?? {},
      eccn: f.eccn ?? {},
      references: f.references ?? [],
      priority: f.priority ?? {},
      recheckUrl: f.references?.[0] ?? null,
      lastChecked: now,
    });
  }

  for (const vuln of vulns) {
    if (!vuln.proofOfConcept) {
      vuln.proofOfConcept = buildProofOfConceptDescriptor(vuln);
    }
  }

  return {
    schemaVersion: '1.0.0',
    generatedAt: now,
    totalVulnerabilities: vulns.length,
    bySeverity: vulns.reduce((acc, v) => {
      const s = (v.severity ?? 'unknown').toLowerCase();
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {}),
    bySource: vulns.reduce((acc, v) => {
      acc[v.source] = (acc[v.source] ?? 0) + 1;
      return acc;
    }, {}),
    vulnerabilities: vulns,
  };
}

function buildProofOfConceptDescriptor(vuln) {
  const base = {
    label: 'PoC',
    type: 'read-only proof-of-concept',
    destructive: false,
    availability: 'website',
    safety: 'Evidence collection only; does not execute exploit payloads.',
  };

  if (vuln.safeProof) {
    return {
      ...base,
      title: `PoC: ${vuln.title || vuln.id || vuln.source}`,
      mode: vuln.safeProof.mode || 'benign-validation',
      command: vuln.safeProof.command ?? null,
      expected: vuln.safeProof.expected ?? null,
      validatorFile: vuln.safeProof.validatorFile ?? null,
      limitations: vuln.safeProof.limitations ?? null,
    };
  }

  if (vuln.source === 'npm-audit') {
    return {
      ...base,
      title: `PoC: dependency advisory presence for ${vuln.package}`,
      mode: 'dependency-version-evidence',
      command: `npm audit --json`,
      expected: `Audit output contains ${vuln.package} with severity ${vuln.severity}.`,
      validatorFile: null,
    };
  }

  if (vuln.source === 'patchpivot-variant-analysis') {
    return {
      ...base,
      title: `PoC: variant-analysis evidence for ${vuln.cveId}`,
      mode: 'controlled-variant-analysis',
      command: 'vigil --vuln-discovery',
      expected: 'Variant hypothesis, affected surface, CVSS, disclosure, and read-only validator metadata are present.',
      validatorFile: null,
    };
  }

  if (vuln.source === 'windows-os') {
    return {
      ...base,
      title: 'PoC: Windows patch posture evidence',
      mode: 'os-patch-inventory',
      command: 'Get-HotFix; Get-ComputerInfo | Select-Object WindowsVersion,OsBuildNumber',
      expected: 'Installed hotfixes, build number, pending reboot, and Windows Update status are captured.',
      validatorFile: null,
    };
  }

  if (vuln.source?.startsWith('company-advisory-')) {
    return {
      ...base,
      title: `PoC: public advisory tracking for ${vuln.vendor || vuln.company || vuln.cveId || vuln.source}`,
      mode: 'public-advisory-evidence',
      command: vuln.advisoryUrl ? `curl -fsSL ${vuln.advisoryUrl}` : 'vigil --vuln-discovery',
      expected: 'Public vendor advisory feed confirms the tracked product or CVE metadata.',
      validatorFile: null,
    };
  }

  if (vuln.source === 'kernel-cve') {
    return {
      ...base,
      title: `PoC: kernel version applicability for ${vuln.cveId}`,
      mode: 'kernel-version-evidence',
      command: 'uname -r; sysctl kernel.kptr_restrict kernel.dmesg_restrict kernel.randomize_va_space',
      expected: 'Kernel version and hardening controls are captured for advisory applicability review.',
      validatorFile: null,
    };
  }

  if (vuln.source === 'linux-system-packages') {
    return {
      ...base,
      title: 'PoC: Linux security-upgrade evidence',
      mode: 'package-manager-evidence',
      command: 'apt list --upgradable 2>/dev/null | grep -i security || true',
      expected: 'Package manager output shows pending security upgrades without installing or executing packages.',
      validatorFile: null,
    };
  }

  if (vuln.source === 'kali-tool-cve') {
    return {
      ...base,
      title: `PoC: installed Kali tool advisory evidence for ${vuln.product || vuln.cveId}`,
      mode: 'installed-tool-version-evidence',
      command: `dpkg-query -W '${String(vuln.product || '').replace(/^Kali Linux:\s*/, '')}' 2>/dev/null || apt-cache policy '${String(vuln.product || '').replace(/^Kali Linux:\s*/, '')}'`,
      expected: 'Installed package metadata can be compared with the public CVE advisory.',
      validatorFile: null,
    };
  }

  if (vuln.source === 'linux-suid') {
    return {
      ...base,
      title: 'PoC: SUID binary exposure evidence',
      mode: 'filesystem-permission-evidence',
      command: 'find / -perm -4000 -type f -print 2>/dev/null',
      expected: 'Read-only filesystem walk lists SUID binaries for hardening review.',
      validatorFile: null,
    };
  }

  return {
    ...base,
    title: `PoC: ${vuln.title || vuln.source || 'vulnerability evidence'}`,
    mode: 'benign-validation',
    command: 'vigil --vuln-discovery',
    expected: 'Vigil records evidence, severity, remediation, and references without running exploit payloads.',
    validatorFile: null,
  };
}

function renderMarkdown(findings, code, lic, intel) {
  const lines = [];
  lines.push(`# Security analysis — ${findings.repo.name}@${findings.repo.version}`);
  lines.push('');
  lines.push(`- Run id: \`${findings.runId}\``);
  lines.push(`- Git: \`${findings.repo.git || '(none)'}\` on \`${findings.repo.branch}\``);
  lines.push(`- Severity rollup: **${findings.severity.toUpperCase()}**`);
  lines.push('');
  lines.push('## 1. npm audit');
  const s = findings.passes['npm-audit'].bySeverity ?? {};
  lines.push(`critical=${s.critical ?? 0} high=${s.high ?? 0} moderate=${s.moderate ?? 0} low=${s.low ?? 0} info=${s.info ?? 0}`);
  lines.push('');
  const vuln = findings.passes['npm-audit'].vulnerable ?? [];
  if (vuln.length) {
    lines.push('| pkg | severity | direct | fix |');
    lines.push('|---|---|---|---|');
    for (const v of vuln.slice(0, 25)) {
      lines.push(`| \`${v.name}\` | ${v.severity} | ${v.isDirect ? 'yes' : 'no'} | ${v.fixAvailable ? 'yes' : 'no'} |`);
    }
    if (vuln.length > 25) lines.push(`| … | (+${vuln.length - 25} more) | | |`);
    lines.push('');
  }
  lines.push('## 2. licenses');
  const byL = lic.summary.byLicense;
  const top = Object.entries(byL).sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [k, v] of top) lines.push(`- ${k}: ${v}`);
  if (lic.summary.unlicensed) lines.push(`- ⚠️ UNKNOWN: ${lic.summary.unlicensed}`);
  lines.push('');
  lines.push('## 3. outdated deps');
  lines.push(`tracked outdated: ${findings.passes.outdated.count}`);
  lines.push('');
  lines.push('## 4. code findings');
  lines.push(`secrets=${code.secrets.length} risky_sinks=${code.sinks.length} world_writable=${code.world_writable.length}`);
  if (code.secrets.length) {
    lines.push('');
    lines.push('### secrets');
    for (const f of code.secrets.slice(0, 20)) {
      lines.push(`- \`${f.file}:${f.line}\` [${f.rule}] ${f.excerpt}`);
    }
  }
  if (code.sinks.length) {
    lines.push('');
    lines.push('### risky sinks (triage required)');
    for (const f of code.sinks.slice(0, 30)) {
      lines.push(`- \`${f.file}:${f.line}\` [${f.rule}] ${f.excerpt}`);
    }
  }
  lines.push('');
  lines.push('## 5. SBOM');
  lines.push(`CycloneDX 1.5 — ${findings.passes.sbom.components} components.`);
  lines.push('');
  lines.push('## 6. supply-chain integrity');
  if (findings.passes['supply-chain'].skipped) {
    lines.push('skipped (--no-pack).');
  } else {
    const sc = findings.passes['supply-chain'];
    lines.push(`tarball: \`${sc.tarball}\``);
    lines.push(`size:    ${sc.sizeBytes} bytes`);
    lines.push(`sha256:  \`${sc.sha256}\``);
    lines.push(`sha512:  \`${sc.sha512}\``);
    lines.push(`integrity (npm): \`${sc.npmIntegrity}\``);
  }
  lines.push('');
  lines.push('## 7. variant intel');
  for (const t of intel.targets) lines.push(`- ${t.name} ${t.pinned} — ${t.advisory}`);
  lines.push('');

  const vr = findings.passes['variant-research'];
  if (vr) {
    lines.push('## 8. variant research (GH Security Advisories)');
    lines.push(`tracked=${vr.tracked} totalAdvisories=${vr.totalAdvisories}`);
    lines.push(`bySeverity: critical=${vr.bySeverity.critical} high=${vr.bySeverity.high} moderate=${vr.bySeverity.moderate} low=${vr.bySeverity.low}`);
    lines.push('');
    for (const d of vr.perDep) {
      if (d.count > 0 || d.error) {
        lines.push(`- \`${d.name}\` — ${d.error ? `error: ${d.error}` : `${d.count} advisories`}`);
      }
    }
    lines.push('');
  }

  const gd = findings.passes['glasswing-disclosures'];
  if (gd) {
    lines.push('## 9. Glasswing-era disclosure lifecycle');
    lines.push(`Known Glasswing CVEs tracked: ${gd.knownGlasswingCVEs}`);
    lines.push(`In our dependency tree: ${gd.inOurDependencyTree}`);
    if (gd.inOurTree?.length) {
      lines.push('');
      for (const c of gd.inOurTree) {
        lines.push(`- **${c.cve}** (${c.severity}) — ${c.pkg}: ${c.summary}`);
        lines.push(`  Match via: \`${c.matchVia}\` severity=${c.matchSeverity}`);
        lines.push(`  Discovered by: ${c.discoveredBy}`);
        lines.push(`  Advisory: ${c.advisoryUrl}`);
      }
    }
    if (gd.triageBottleneck) {
      const tb = gd.triageBottleneck;
      lines.push('');
      lines.push(`### Triage bottleneck`);
      lines.push(`total=${tb.totalFindings} requireHumanTriage=${tb.requireHumanTriage} autoFixable=${tb.autoFixable}`);
      lines.push(`> ${tb.note}`);
    }
    if (gd.disclosureLifecycle) {
      const dl = gd.disclosureLifecycle;
      lines.push('');
      lines.push(`### Disclosure lifecycle stages`);
      lines.push(`discovered=${dl.discovered} triaged=${dl.triaged} disclosed=${dl.disclosed} patched=${dl.patched} advisoryPublished=${dl.advisoryPublished}`);
    }
    if (gd.defensePosture?.recommendations?.length) {
      lines.push('');
      lines.push(`### Glasswing defense posture`);
      for (const r of gd.defensePosture.recommendations) lines.push(`- ${r}`);
    }
    lines.push('');
  }

  const plat = findings.passes.platform;
  if (plat) {
    lines.push('## 10. host platform');
    lines.push(`platform=${plat.platform} ${plat.arch} release=${plat.release}`);
    lines.push(`node=${plat.nodeVersion} npm=${plat.npmVersion}`);
    lines.push(`cpus=${plat.cpus.count} model=${plat.cpus.model}`);
    lines.push(`mem total=${plat.memGB.total}GB free=${plat.memGB.free}GB`);
    if (plat.osDetails && !plat.osDetails.error) {
      const o = plat.osDetails;
      lines.push(`windows=${o.productName} ${o.editionId} v${o.displayVersion} build=${o.build}.${o.ubr}`);
      lines.push(`uptime=${o.uptimeMin}min tz=${o.tz} locale=${o.locale} execpolicy=${o.shellPolicy}`);
    }
    lines.push('');
  }

  const wp = findings.passes.windowsPosture;
  if (wp && !wp.skipped) {
    lines.push('## 11. windows security posture');
    if (wp.defender) {
      lines.push(`defender: AV=${wp.defender.AntivirusEnabled} RT=${wp.defender.RealTimeProtectionEnabled} Tamper=${wp.defender.IsTamperProtected} engine=${wp.defender.AMEngineVersion} sigs=${wp.defender.AntivirusSignatureLastUpdated}`);
    }
    if (Array.isArray(wp.firewall)) {
      for (const fp of wp.firewall) lines.push(`firewall: ${fp.Name} enabled=${fp.Enabled} in=${fp.DefaultInboundAction} out=${fp.DefaultOutboundAction}`);
    }
    if (wp.tpm) lines.push(`tpm: present=${wp.tpm.TpmPresent} ready=${wp.tpm.TpmReady}`);
    if (wp.secureBoot) lines.push(`secureBoot: ${wp.secureBoot}`);
    if (wp.pwsh7) lines.push(`pwsh7: ${wp.pwsh7}`);
    lines.push('');
  }

  const sh = findings.passes.shellSmoke;
  if (sh && !sh.skipped) {
    lines.push('## 12. cross-shell smoke');
    lines.push(`passed=${sh.passed}/${sh.total} failed=${sh.failed} skipped=${sh.skipped}`);
    lines.push('');
  }

  const ai = findings.passes['advisory-investigation'];
  if (ai) {
    lines.push('## 13. advisory investigation');
    lines.push(`investigated=${ai.investigated}/${ai.totalVulnerable} sandboxValidations=${ai.sandboxValidations}`);
    if (ai.advisories?.length) {
      lines.push('');
      lines.push('| pkg | severity | direct | proposed | sandbox cleared | report |');
      lines.push('|---|---|---|---|---|---|');
      for (const a of ai.advisories.slice(0, 30)) {
        lines.push(`| \`${a.pkg}\` | ${a.severity} | ${a.isDirect ? 'yes' : 'no'} | ` +
          `${a.proposedTarget ? '`' + a.proposedTarget + '`' : '—'} | ` +
          `${a.sandboxValidated ? (a.postFixClears ? '✅' : '❌') : '·'} | ` +
          `\`${a.reportPath}\` |`);
      }
    }
    lines.push('');
  }

  const ci = findings.passes['cne-inventory'];
  if (ci && !ci.skipped) {
    lines.push('## 14. CNE inventory (apps · protocols · features · persistence · hardening)');
    lines.push(`Generated: ${ci.generatedAt}`);
    lines.push('');
    lines.push('### apps');
    const a = ci.apps;
    lines.push(`registry-uninstall=${a.registryUninstall} appx=${a.appx} winget=${a.winget} choco=${a.choco} scoop=${a.scoop} msi=${a.msiProducts}`);
    lines.push('');
    lines.push('### protocols');
    const p = ci.protocols;
    lines.push(`smb1=${p.smb1Enabled} tls1.0-srv=${p.tls10ServerOn} tls1.2-srv=${p.tls12ServerOn} tls1.3-srv=${p.tls13ServerOn} ntlm-level=${p.ntlmLevel} llmnr=${p.llmnrEnabled} rdp-nla=${p.rdpNlaEnabled} winrm=${p.winrmStatus}`);
    lines.push('');
    lines.push('### Windows 11 Pro features');
    const f = ci.features;
    lines.push(`optional-features=${f.optionalFeatures} capabilities=${f.capabilities} hyperv=${f.hyperV} wsl=${f.wsl} sandbox=${f.sandbox} smart-app-control=${f.smartAppControl}`);
    lines.push('');
    lines.push('### persistence surface');
    const pe = ci.persistence;
    lines.push(`services=${pe.services} sched-tasks=${pe.scheduledTasks} startup-cmds=${pe.startupCommands} drivers=${pe.drivers}`);
    lines.push('');
    lines.push(`### hardening sentinel checks: ${ci.hardening.passed}/${ci.hardening.total} pass`);
    if (ci.hardeningFails?.length) {
      lines.push('Failed:');
      for (const id of ci.hardeningFails) lines.push(`- ${id}`);
    }
    lines.push('');
    lines.push('_Full per-check evidence in `12-cne-inventory.json`._');
  } else if (ci?.skipped) {
    lines.push('## 14. CNE inventory');
    lines.push(`skipped: ${ci.skipped}`);
  }

  const pp = findings.passes['patchpivot-findings'];
  if (pp && !pp.skipped) {
    lines.push('');
    lines.push('## 15. Patchpivot variant-analysis findings');
    lines.push(`Source: ${pp.sourceRepo}`);
    lines.push(`Total findings: ${pp.totalFindings} — ${Object.entries(pp.bySeverity ?? {}).map(([k,v]) => `${k}=${v}`).join(', ')}`);
    if (pp.findings?.length) {
      for (const f of pp.findings) {
        lines.push(`- **${f.cveId}** ${f.severity?.toUpperCase()} [${f.status}] — ${f.title}`);
        if (f.bugClass) lines.push(`  Bug class: ${f.bugClass}`);
        if (f.cvss) lines.push(`  CVSS: ${f.cvss}`);
        if (f.disclosure?.channel) lines.push(`  Disclosure: ${f.disclosure.channel} (submitted: ${f.disclosure.submitted})`);
      }
    }
  }

  const cv = findings.passes['comprehensive-vulns'];
  if (cv && !cv.skipped) {
    lines.push('');
    lines.push('## 16. Comprehensive vulnerability scan');

    // Linux kernel
    if (cv.kernel) {
      lines.push('');
      lines.push('### Linux Kernel');
      lines.push(`Version: \`${cv.kernel.kernel}\``);
      const totalKv = cv.kernel.totalApplicableVulns ?? 0;
      lines.push(`Applicable CVEs: ${totalKv}`);
      for (const k of (cv.kernel.kernelVulns ?? []).filter(v => v.applicable)) {
        lines.push(`- **${k.cve}** [${k.severity}] ${k.name}: ${k.description?.slice(0, 120)}`);
      }
    }

    // System packages
    if (cv.systemPackages) {
      lines.push('');
      lines.push('### System Packages');
      lines.push(`${cv.systemPackages.totalPackages} installed, ${cv.systemPackages.upgradable} upgradable, ${cv.systemPackages.securityUpgrades} security upgrades available`);
      if (cv.systemPackages.outdatedSample?.length) {
        lines.push('Sample outdated:');
        for (const p of cv.systemPackages.outdatedSample.slice(0, 15)) {
          lines.push(`- \`${p.name}\` → ${p.available}`);
        }
      }
    }

    // Kali tools
    if (cv.kaliTools?.isKali) {
      lines.push('');
      lines.push('### Kali Linux Tools');
      lines.push(`Installed: ${cv.kaliTools.totalToolsInstalled}/${cv.kaliTools.totalToolsKnown}`);
      if (cv.kaliTools.toolVulns?.length) {
        lines.push('Known tool CVEs:');
        for (const tv of cv.kaliTools.toolVulns) {
          lines.push(`- **${tv.cve}** [${tv.severity}] ${tv.tool}: ${tv.desc}`);
        }
      }
    }

    // Browsers
    if (cv.browsers?.browsers?.length) {
      lines.push('');
      lines.push('### Browsers');
      for (const b of cv.browsers.browsers) {
        const vuln = b.likelyVulnerable ? '⚠️ VULNERABLE' : 'OK';
        lines.push(`- ${b.name} ${b.version} — ${vuln}`);
      }
    }

    // SUID
    if (cv.suidBinaries) {
      lines.push('');
      lines.push('### SUID Binaries');
      lines.push(`Total: ${cv.suidBinaries.totalCount}, risky: ${cv.suidBinaries.riskyPresent}`);
      if (cv.suidBinaries.riskyBinaries?.length) {
        lines.push('Risky: ' + cv.suidBinaries.riskyBinaries.join(', '));
      }
    }

    // Listening services
    if (cv.listeningServices) {
      lines.push('');
      lines.push('### Network Services');
      lines.push(`TCP listeners: ${cv.listeningServices.tcpListenerCount}, UDP: ${cv.listeningServices.udpListenerCount}`);
      if (cv.listeningServices.exposedServices?.length) {
        lines.push('Exposed ports:');
        for (const s of cv.listeningServices.exposedServices) {
          lines.push(`- Port ${s.port} exposed on 0.0.0.0`);
        }
      }
    }

    // SSH config
    if (cv.sshConfig?.configured) {
      lines.push('');
      lines.push(`### SSH Configuration: ${cv.sshConfig.passed}/${cv.sshConfig.totalChecks} pass`);
      for (const c of cv.sshConfig.checks) {
        lines.push(`- ${c.pass ? 'PASS' : 'FAIL'}: ${c.check} (current: ${c.current})`);
      }
    }

    // World writable
    if (cv.worldWritable) {
      lines.push('');
      lines.push(`### World-Writable Files: ${cv.worldWritable.worldWritableFiles} files, ${cv.worldWritable.worldWritableDirs} dirs`);
    }

    // Docker
    if (cv.docker?.installed) {
      lines.push('');
      lines.push(`### Docker: ${cv.docker.images} images`);
      if (cv.docker.scanResults?.length) {
        for (const s of cv.docker.scanResults) {
          lines.push(`- ${s.image}: ${s.criticalHigh ?? s.vulns ?? 'unknown'} vulns`);
        }
      }
    }
  }

  const vd = findings.passes['vulnerability-discovery'];
  if (vd && !vd.skipped && !vd.error) {
    lines.push('');
    lines.push('## 17. Vulnerability discovery (safe PoC evidence + ECCN)');
    lines.push(`Findings=${vd.summary?.total ?? 0} immediate=${vd.summary?.immediate ?? 0} urgent=${vd.summary?.urgent ?? 0} CISA-KEV=${vd.summary?.cisaKev ?? 0}`);
    lines.push(`Safe proofs=${vd.summary?.safeProofs ?? 0} ECCN restricted=${vd.eccnRegistry?.summary?.restricted ?? 0} controlled=${vd.eccnRegistry?.summary?.controlled ?? 0}`);
    if (vd.topFindings?.length) {
      lines.push('');
      for (const f of vd.topFindings.slice(0, 15)) {
        lines.push(`- **${String(f.severity ?? 'unknown').toUpperCase()}** [${f.priority?.label ?? 'unscored'}/${f.priority?.score ?? 0}] ${f.title}`);
        if (f.cveIds?.length) lines.push(`  CVE: ${f.cveIds.join(', ')}`);
        if (f.safeProof?.command) lines.push(`  Safe proof: \`${f.safeProof.command}\``);
        if (f.eccn?.eccn) lines.push(`  ECCN: ${f.eccn.eccn} (${f.eccn.distribution})`);
      }
    }
  } else if (vd?.error || vd?.skipped) {
    lines.push('');
    lines.push('## 17. Vulnerability discovery');
    lines.push(vd.error ? `error: ${vd.error}` : `skipped: ${vd.skipped}`);
  }

  const ca = findings.passes['company-advisories'];
  if (ca?.companies) {
    lines.push('');
    lines.push('## Company Security Advisories Tracked');
    lines.push(`Tracking ${ca.totalCompanies} companies with ${ca.totalRecentAdvisories} recent CVE disclosures.`);
    lines.push('');
    for (const company of ca.companies) {
      if (company.recentAdvisories.length > 0) {
        lines.push(`### ${company.company}`);
        lines.push(`URL: ${company.url}`);
        lines.push(`Products tracked: ${company.trackedProducts.join(', ')}`);
        lines.push(`| CVE | Product | Severity | Description | Date |`);
        lines.push('|---|---|---|---|---|');
        for (const adv of company.recentAdvisories) {
          lines.push(`| ${adv.id} | ${adv.product} | ${adv.severity} | ${adv.desc} | ${adv.date} |`);
        }
        lines.push(`> ${company.note}`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}
