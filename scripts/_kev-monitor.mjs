#!/usr/bin/env node
/**
 * _kev-monitor.mjs — CISA Known Exploited Vulnerabilities (KEV) catalog monitor.
 *
 * Fetches the CISA KEV feed, diffs against a local snapshot, and reports new entries.
 *
 * Usage:
 *   node scripts/_kev-monitor.mjs                  (human-readable diff)
 *   node scripts/_kev-monitor.mjs --json           (machine-readable JSON)
 *   node scripts/_kev-monitor.mjs --top 20         (most recent N entries)
 *   node scripts/_kev-monitor.mjs --filter apache  (filter by keyword)
 *   node scripts/_kev-monitor.mjs --since 2024-01-01
 */

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-kev-monitor] Access denied: VIGIL_SESSION_TOKEN not set. Must run within the Vigil CLI.\n');
  process.exit(1);
}

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const SNAPSHOT_DIR = join(homedir(), '.vigil');
const SNAPSHOT_PATH = join(SNAPSHOT_DIR, 'kev-snapshot.json');
const TIMEOUT_MS = 15_000;

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const topIdx = args.indexOf('--top');
const topN = topIdx !== -1 ? parseInt(args[topIdx + 1], 10) : null;
const filterIdx = args.indexOf('--filter');
const filterKw = filterIdx !== -1 ? args[filterIdx + 1]?.toLowerCase() : null;
const sinceIdx = args.indexOf('--since');
const sinceDate = sinceIdx !== -1 ? args[sinceIdx + 1] : null;

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchKev() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(KEV_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

function loadSnapshot() {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveSnapshot(data) {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ── Entry helpers ─────────────────────────────────────────────────────────────

function filterEntries(entries) {
  let result = entries;
  if (sinceDate) {
    result = result.filter(e => e.dateAdded >= sinceDate);
  }
  if (filterKw) {
    result = result.filter(e =>
      [e.vendorProject, e.product, e.shortDescription, e.cveID]
        .some(f => f?.toLowerCase().includes(filterKw))
    );
  }
  return result;
}

function entryText(e, idx) {
  const lines = [
    `  ${idx != null ? `#${idx + 1} ` : ''}${e.cveID}`,
    `    Vendor/Product : ${e.vendorProject} / ${e.product}`,
    `    Added          : ${e.dateAdded}${e.dueDate ? `  Due: ${e.dueDate}` : ''}`,
    `    Ransomware     : ${e.knownRansomwareCampaignUse ?? 'Unknown'}`,
    `    Description    : ${e.shortDescription}`,
  ];
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

let liveCatalog = null;
let fetchWarning = null;

try {
  liveCatalog = await fetchKev();
} catch (err) {
  fetchWarning = `Network error fetching KEV feed: ${err.message}. Using cached snapshot.`;
}

const snapshot = loadSnapshot();
const catalog = liveCatalog ?? snapshot;

if (!catalog) {
  process.stderr.write('[vigil-kev-monitor] No data available: fetch failed and no local snapshot found.\n');
  process.exit(1);
}

const allEntries = catalog.vulnerabilities ?? [];
const totalCount = allEntries.length;

// ── Determine new entries ─────────────────────────────────────────────────────

let newEntries = [];
if (liveCatalog && snapshot) {
  const snapshotIds = new Set((snapshot.vulnerabilities ?? []).map(e => e.cveID));
  newEntries = allEntries.filter(e => !snapshotIds.has(e.cveID));
}

// ── --top mode: most recent N entries by dateAdded ────────────────────────────

let topEntries = null;
if (topN != null && !isNaN(topN)) {
  topEntries = [...allEntries]
    .sort((a, b) => (b.dateAdded ?? '').localeCompare(a.dateAdded ?? ''))
    .slice(0, topN);
}

// ── Apply filters to new entries and top entries ──────────────────────────────

const filteredNew = filterEntries(newEntries);
const filteredTop = topEntries ? filterEntries(topEntries) : null;

// ── Output ────────────────────────────────────────────────────────────────────

if (jsonMode) {
  const out = {
    catalogTitle: catalog.title ?? 'CISA KEV',
    catalogVersion: catalog.catalogVersion ?? null,
    dateReleased: catalog.dateReleased ?? null,
    totalCount,
    snapshotExists: snapshot !== null,
    fetchWarning,
    newEntries: filteredNew,
    ...(filteredTop != null ? { topEntries: filteredTop } : {}),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} else {
  const lines = [];
  lines.push('');
  lines.push('━━━  CISA Known Exploited Vulnerabilities (KEV)  ━━━');
  lines.push(`  Catalog   : ${catalog.title ?? 'CISA KEV'}`);
  if (catalog.catalogVersion) lines.push(`  Version   : ${catalog.catalogVersion}`);
  if (catalog.dateReleased)   lines.push(`  Released  : ${catalog.dateReleased}`);
  lines.push(`  Total KEVs: ${totalCount}`);
  if (fetchWarning) lines.push(`\n  ⚠  ${fetchWarning}`);

  if (filteredTop != null) {
    lines.push('');
    lines.push(`── Most Recently Added (top ${filteredTop.length}) ──`);
    if (filteredTop.length === 0) {
      lines.push('  (no entries match filters)');
    } else {
      filteredTop.forEach((e, i) => lines.push(entryText(e, i)));
    }
  } else {
    lines.push('');
    if (!snapshot) {
      lines.push('  No previous snapshot found — this is the first run.');
      lines.push('  Snapshot saved. Run again to detect new additions.');
    } else if (!liveCatalog) {
      lines.push('  Showing cached data only (fetch failed).');
    } else {
      lines.push(`── New Entries Since Last Snapshot ──`);
      if (filteredNew.length === 0) {
        lines.push('  No new KEV entries since last snapshot.');
      } else {
        lines.push(`  ${filteredNew.length} new entr${filteredNew.length === 1 ? 'y' : 'ies'}:`);
        filteredNew.forEach((e, i) => lines.push(entryText(e, i)));
      }
    }
  }

  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

// ── Update snapshot (only if we got a live catalog) ───────────────────────────

if (liveCatalog) {
  saveSnapshot(liveCatalog);
}
