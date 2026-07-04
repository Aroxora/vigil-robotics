#!/usr/bin/env node
/**
 * _finding-enricher.mjs — Bulk-enrich Vigil findings store with CVSS/EPSS/KEV data.
 *
 * Reads ~/.vigil/findings.json, queries NVD + EPSS + CISA KEV for each CVE-tagged
 * finding, writes enriched data back in-place.
 *
 * Usage:
 *   node scripts/_finding-enricher.mjs [--dry-run] [--json]
 *
 * Exits 0 on success, 1 on fatal error.
 */

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-enrich] Access denied: VIGIL_SESSION_TOKEN not set.\n');
  process.exit(1);
}

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const JSON_OUT = argv.includes('--json');
const TIMEOUT_MS = 10_000;

function vigilHome() {
  return process.env['VIGIL_HOME']?.trim() || join(homedir(), '.vigil');
}

function findingsPath() {
  return join(vigilHome(), 'findings.json');
}

function loadFindings() {
  const p = findingsPath();
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    // Handle both array-of-findings and { findings: [...] } wrapper
    return Array.isArray(raw) ? raw : (raw.findings ?? []);
  }
  catch { return []; }
}

function saveFindings(records) {
  const p = findingsPath();
  mkdirSync(vigilHome(), { recursive: true });
  writeFileSync(p, JSON.stringify(records, null, 2) + '\n');
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': 'Vigil-Enricher/1.0', ...(opts.headers || {}) } });
  } finally { clearTimeout(t); }
}

// ── EPSS batch ────────────────────────────────────────────────────────────────

async function fetchEpssBatch(cveIds) {
  if (!cveIds.length) return {};
  try {
    // FIRST EPSS accepts comma-separated CVE IDs
    const url = `https://api.first.org/data/v1/epss?cve=${cveIds.join(',')}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    for (const entry of (data.data || [])) {
      map[entry.cve] = { epss: parseFloat(entry.epss), percentile: parseFloat(entry.percentile), date: entry.date };
    }
    return map;
  } catch { return {}; }
}

// ── CISA KEV bulk fetch ───────────────────────────────────────────────────────

async function fetchKevCatalog() {
  try {
    const res = await fetchWithTimeout('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json');
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set((data.vulnerabilities || []).map(v => v.cveID?.toUpperCase()));
  } catch { return new Set(); }
}

// ── NVD single CVE ────────────────────────────────────────────────────────────

async function fetchNvdCvss(cveId) {
  try {
    const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${encodeURIComponent(cveId)}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = await res.json();
    const vuln = data?.vulnerabilities?.[0]?.cve;
    if (!vuln) return null;
    const m = vuln.metrics?.cvssMetricV31?.[0] || vuln.metrics?.cvssMetricV30?.[0] || vuln.metrics?.cvssMetricV2?.[0];
    if (!m) return null;
    return {
      score: m.cvssData?.baseScore ?? null,
      severity: m.cvssData?.baseSeverity ?? null,
      vector: m.cvssData?.vectorString ?? null,
      version: m.cvssData?.version ?? null,
    };
  } catch { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const findings = loadFindings();
const cveFindings = findings.filter(f => f.cve && /^CVE-\d{4}-\d+$/.test(f.cve));

if (cveFindings.length === 0) {
  process.stderr.write('[vigil-enrich] No CVE-tagged findings to enrich.\n');
  process.exit(0);
}

process.stderr.write(`[vigil-enrich] Enriching ${cveFindings.length} CVE findings...\n`);

// Fetch EPSS + KEV in parallel (bulk APIs)
const cveIds = [...new Set(cveFindings.map(f => f.cve.toUpperCase()))];
const [epssMap, kevSet] = await Promise.all([
  fetchEpssBatch(cveIds),
  fetchKevCatalog(),
]);

process.stderr.write(`[vigil-enrich] EPSS data: ${Object.keys(epssMap).length}  KEV catalog: ${kevSet.size} entries\n`);

// NVD: rate-limited — 6 req/s without API key, so we stagger with 200ms delay
const nvdMap = {};
for (let i = 0; i < cveIds.length; i++) {
  const id = cveIds[i];
  if (i > 0) await new Promise(r => setTimeout(r, 200));
  nvdMap[id] = await fetchNvdCvss(id);
  if (nvdMap[id]) process.stderr.write(`  ${id}: CVSS ${nvdMap[id].score}\n`);
}

// Apply enrichment
let enrichedCount = 0;
const enriched = findings.map(f => {
  if (!f.cve) return f;
  const id = f.cve.toUpperCase();
  const updates = {};

  const nvd = nvdMap[id];
  if (nvd?.score != null) {
    updates.cvss = nvd.score;
    updates.cvss_severity = nvd.severity;
    updates.cvss_vector = nvd.vector;
    // Also update severity field if it's still the default
    if (f.severity === 'high' && nvd.severity) {
      const mapped = nvd.severity.toLowerCase();
      if (['critical', 'high', 'medium', 'low'].includes(mapped)) updates.severity = mapped;
    }
  }

  const epss = epssMap[id];
  if (epss) {
    updates.epss = epss.epss;
    updates.epss_percentile = epss.percentile;
  }

  if (kevSet.has(id)) updates.kev = true;

  if (Object.keys(updates).length > 0) {
    enrichedCount++;
    return { ...f, ...updates, enriched_at: new Date().toISOString() };
  }
  return f;
});

process.stderr.write(`[vigil-enrich] Enriched ${enrichedCount}/${cveFindings.length} findings\n`);

if (!DRY_RUN) {
  saveFindings(enriched);
  process.stderr.write(`[vigil-enrich] Saved to ${findingsPath()}\n`);
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(enriched, null, 2) + '\n');
} else {
  const kevCount = enriched.filter(f => f.kev).length;
  const epssHigh = enriched.filter(f => f.epss >= 0.5).length;
  process.stdout.write([
    '',
    `═══ Findings Enrichment Summary ═══`,
    `Total findings: ${findings.length}  CVE-tagged: ${cveFindings.length}`,
    `Enriched:       ${enrichedCount}`,
    `KEV-listed:     ${kevCount}  (actively exploited in the wild)`,
    `EPSS ≥50%:      ${epssHigh}  (high exploitation probability)`,
    '',
  ].join('\n'));
}
