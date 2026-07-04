#!/usr/bin/env node
/**
 * _sbom-builder.mjs — Software Bill of Materials generator with vuln correlation.
 *
 * Walks package manifests (package.json, requirements.txt, Cargo.toml, go.mod,
 * pom.xml, Gemfile.lock), emits CycloneDX 1.4 JSON SBOM, then queries OSV.dev
 * for known vulnerabilities in each component.
 *
 * Usage:
 *   node scripts/_sbom-builder.mjs [--dir <path>] [--json] [--no-vuln] [--emit-vigil-findings]
 *
 * Outputs to stdout; save with: node scripts/_sbom-builder.mjs > sbom.json
 */

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-sbom] Access denied: VIGIL_SESSION_TOKEN not set.\n');
  process.exit(1);
}

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const dirArg = argv.indexOf('--dir');
const rootDir = resolve(dirArg >= 0 ? argv[dirArg + 1] : '.');
const emitJson = !argv.includes('--text');
const skipVuln = argv.includes('--no-vuln');
const emitFindings = argv.includes('--emit-vigil-findings');

const TIMEOUT_MS = 12_000;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Manifest parsers ──────────────────────────────────────────────────────────

function parseNpmPackageJson(filePath) {
  try {
    const pkg = JSON.parse(readFileSync(filePath, 'utf8'));
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    return Object.entries(all).map(([name, version]) => ({
      type: 'library',
      name,
      version: String(version).replace(/^[\^~>=<]/, '').split(' ')[0],
      purl: `pkg:npm/${name}`,
      ecosystem: 'npm',
    }));
  } catch { return []; }
}

function parseNpmLockfile(filePath) {
  try {
    const lock = JSON.parse(readFileSync(filePath, 'utf8'));
    const packages = lock.packages || lock.dependencies || {};
    return Object.entries(packages)
      .filter(([name]) => name && name !== '')
      .map(([name, info]) => ({
        type: 'library',
        name: name.replace(/^node_modules\//, ''),
        version: info.version || 'unknown',
        purl: `pkg:npm/${name.replace(/^node_modules\//, '')}`,
        ecosystem: 'npm',
      }));
  } catch { return []; }
}

function parsePipRequirements(filePath) {
  try {
    return readFileSync(filePath, 'utf8').split('\n')
      .map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('-'))
      .map(l => {
        const m = l.match(/^([A-Za-z0-9_.-]+)[=><~!]+([^\s;]+)/);
        if (!m) return null;
        return {
          type: 'library', name: m[1], version: m[2],
          purl: `pkg:pypi/${m[1].toLowerCase()}`,
          ecosystem: 'PyPI',
        };
      }).filter(Boolean);
  } catch { return []; }
}

function parseCargoToml(filePath) {
  try {
    const text = readFileSync(filePath, 'utf8');
    const deps = [];
    let inDeps = false;
    for (const line of text.split('\n')) {
      if (/^\[(dependencies|dev-dependencies|build-dependencies)\]/.test(line)) { inDeps = true; continue; }
      if (/^\[/.test(line)) { inDeps = false; continue; }
      if (!inDeps) continue;
      const m = line.match(/^([a-z0-9_-]+)\s*=\s*["{]?([0-9][^"}\s,]*)/i);
      if (m) deps.push({ type: 'library', name: m[1], version: m[2], purl: `pkg:cargo/${m[1]}`, ecosystem: 'crates.io' });
    }
    return deps;
  } catch { return []; }
}

function parseGoMod(filePath) {
  try {
    return readFileSync(filePath, 'utf8').split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('require') || /^\S+\s+v\S+/.test(l))
      .flatMap(l => {
        const m = l.match(/([a-z0-9.\-/]+)\s+v([0-9][^\s]+)/i);
        if (!m) return [];
        return [{ type: 'library', name: m[1], version: m[2], purl: `pkg:golang/${m[1]}`, ecosystem: 'Go' }];
      });
  } catch { return []; }
}

function parseGemfileLock(filePath) {
  try {
    const deps = [];
    let inGems = false;
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      if (line.trim() === 'GEM') { inGems = true; continue; }
      if (/^\S/.test(line) && line.trim() !== 'specs:') { inGems = false; }
      if (!inGems) continue;
      const m = line.match(/^\s{4}([a-z0-9_-]+)\s+\(([0-9][^)]+)\)/i);
      if (m) deps.push({ type: 'library', name: m[1], version: m[2], purl: `pkg:gem/${m[1]}`, ecosystem: 'RubyGems' });
    }
    return deps;
  } catch { return []; }
}

// ── Discover manifests ────────────────────────────────────────────────────────

function findManifests(dir) {
  const found = [];
  const MANIFEST_FILES = [
    'package-lock.json', 'package.json',
    'requirements.txt', 'requirements-dev.txt', 'requirements-prod.txt',
    'Cargo.toml', 'go.mod', 'Gemfile.lock',
  ];

  function walk(d, depth = 0) {
    if (depth > 4) return;
    try {
      const entries = readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor') continue;
        const full = join(d, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (MANIFEST_FILES.includes(e.name)) found.push(full);
      }
    } catch { /* permission denied */ }
  }
  walk(dir);
  return found;
}

// lazy import for readdirSync
import { readdirSync } from 'node:fs';

function parseManifest(filePath) {
  const base = filePath.split('/').pop();
  if (base === 'package-lock.json') return parseNpmLockfile(filePath);
  if (base === 'package.json') return parseNpmPackageJson(filePath);
  if (base.startsWith('requirements')) return parsePipRequirements(filePath);
  if (base === 'Cargo.toml') return parseCargoToml(filePath);
  if (base === 'go.mod') return parseGoMod(filePath);
  if (base === 'Gemfile.lock') return parseGemfileLock(filePath);
  return [];
}

// ── OSV vuln query ────────────────────────────────────────────────────────────

async function queryOsvBatch(components) {
  // OSV batch API: https://osv.dev/docs/#section/API
  const queries = components.map(c => ({
    package: { name: c.name, ecosystem: c.ecosystem },
    version: c.version,
  }));

  try {
    const res = await fetchWithTimeout('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Vigil-SBOM/1.0' },
      body: JSON.stringify({ queries }),
    });
    if (!res.ok) return components.map(() => []);
    const data = await res.json();
    return (data.results || []).map(r => r.vulns || []);
  } catch {
    return components.map(() => []);
  }
}

// ── Vigil findings store ──────────────────────────────────────────────────────

function vigilHome() {
  return process.env['VIGIL_HOME']?.trim() || join(homedir(), '.vigil');
}

function emitVigilFindings(vulnComponents) {
  const findingsPath = join(vigilHome(), 'findings.json');
  let existing = [];
  try { existing = JSON.parse(readFileSync(findingsPath, 'utf8')); } catch { /* new */ }

  const existingIds = new Set(existing.map(f => f.id));
  const newFindings = [];

  for (const { component, vulns } of vulnComponents) {
    for (const v of vulns) {
      const cve = v.aliases?.find(a => /^CVE-/.test(a)) || v.id;
      const id = `VF-${Date.now().toString(36).slice(-6).toUpperCase()}`;
      if (existingIds.has(cve)) continue;

      const severity = v.database_specific?.severity?.toLowerCase() ||
        (v.severity?.[0]?.score >= 9 ? 'critical' :
         v.severity?.[0]?.score >= 7 ? 'high' :
         v.severity?.[0]?.score >= 4 ? 'medium' : 'low');

      newFindings.push({
        id, severity,
        title: `${component.name}@${component.version}: ${v.summary || v.id}`,
        cve,
        target: component.purl,
        notes: `SBOM finding — ${component.ecosystem}`,
        ts: new Date().toISOString(),
      });
      existingIds.add(cve);
    }
  }

  if (newFindings.length > 0) {
    mkdirSync(vigilHome(), { recursive: true });
    writeFileSync(findingsPath, JSON.stringify([...existing, ...newFindings], null, 2));
    process.stderr.write(`[vigil-sbom] Emitted ${newFindings.length} new findings to ${findingsPath}\n`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

process.stderr.write(`[vigil-sbom] Scanning: ${rootDir}\n`);

const manifests = findManifests(rootDir);
if (manifests.length === 0) {
  process.stderr.write('[vigil-sbom] No package manifests found.\n');
  process.exit(0);
}

// Prefer lockfiles over source manifests (more precise versions)
const seen = new Set();
const filteredManifests = manifests.filter(f => {
  const dir = dirname(f);
  const base = f.split('/').pop();
  const key = dir;
  // If we have a lockfile for this dir, skip the plain package.json
  if (base === 'package.json' && manifests.some(m => m === join(dir, 'package-lock.json'))) return false;
  if (seen.has(key + base)) return false;
  seen.add(key + base);
  return true;
});

process.stderr.write(`[vigil-sbom] Found ${filteredManifests.length} manifest(s)\n`);

const allComponents = filteredManifests.flatMap(parseManifest);

// Deduplicate by purl+version
const dedupMap = new Map();
for (const c of allComponents) {
  const key = `${c.purl}@${c.version}`;
  if (!dedupMap.has(key)) dedupMap.set(key, c);
}
const components = [...dedupMap.values()];

process.stderr.write(`[vigil-sbom] ${components.length} unique components\n`);

// Query OSV in chunks of 100
const CHUNK = 100;
const vulnMap = new Map();

if (!skipVuln && components.length > 0) {
  process.stderr.write(`[vigil-sbom] Querying OSV.dev for vulnerabilities...\n`);
  for (let i = 0; i < components.length; i += CHUNK) {
    const chunk = components.slice(i, i + CHUNK);
    const results = await queryOsvBatch(chunk);
    for (let j = 0; j < chunk.length; j++) {
      const vulns = results[j] || [];
      if (vulns.length > 0) vulnMap.set(chunk[j].purl + '@' + chunk[j].version, vulns);
    }
  }
  process.stderr.write(`[vigil-sbom] Vulnerable components: ${vulnMap.size}\n`);
}

// Build CycloneDX 1.4 SBOM
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.4',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'Trenchwork', name: 'Vigil', version: '1.1' }],
    component: { type: 'application', name: rootDir.split('/').pop() || 'project' },
  },
  components: components.map(c => ({
    type: c.type,
    name: c.name,
    version: c.version,
    purl: c.purl,
    properties: [{ name: 'vigil:ecosystem', value: c.ecosystem }],
  })),
  vulnerabilities: [...vulnMap.entries()].flatMap(([key, vulns]) => {
    const comp = components.find(c => c.purl + '@' + c.version === key);
    return vulns.map(v => ({
      id: v.aliases?.find(a => /^CVE-/.test(a)) || v.id,
      source: { name: 'OSV', url: `https://osv.dev/vulnerability/${v.id}` },
      ratings: v.severity?.map(s => ({ source: { name: s.type }, score: s.score, severity: '' })) || [],
      description: v.summary || '',
      affects: [{ ref: comp?.purl || key }],
      published: v.published,
      updated: v.modified,
    }));
  }),
};

const vulnComponents = [...vulnMap.entries()].map(([key, vulns]) => ({
  component: components.find(c => c.purl + '@' + c.version === key),
  vulns,
})).filter(x => x.component);

if (emitFindings) emitVigilFindings(vulnComponents);

// Summary line
const totalVulns = sbom.vulnerabilities.length;
const critHigh = vulnComponents.filter(({ vulns }) =>
  vulns.some(v => (v.database_specific?.severity || '').match(/critical|high/i))
).length;

if (emitJson) {
  process.stdout.write(JSON.stringify(sbom, null, 2) + '\n');
} else {
  // Human-readable summary
  const lines = [
    `\n═══ SBOM: ${rootDir.split('/').pop()} ═══`,
    `Components: ${components.length}  Manifests: ${filteredManifests.length}`,
    `Vulnerabilities: ${totalVulns}  (${critHigh} components with Crit/High)`,
    '',
    ...filteredManifests.map(m => `  ${m.replace(rootDir, '.')}`),
  ];

  if (vulnComponents.length > 0) {
    lines.push('\nVulnerable components:');
    for (const { component, vulns } of vulnComponents.sort((a, b) => b.vulns.length - a.vulns.length).slice(0, 30)) {
      const cveList = vulns.map(v => v.aliases?.find(a => /^CVE-/.test(a)) || v.id).join(', ');
      lines.push(`  ${component.ecosystem.padEnd(10)} ${component.name}@${component.version}  →  ${cveList}`);
    }
  }

  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}
