#!/usr/bin/env node
/**
 * _threat-intel.mjs — Real-time threat intelligence aggregator.
 *
 * Queries multiple free/public APIs to enrich IPs, domains, and hashes:
 *   - Shodan InternetDB (free, no key) — open ports, CVEs, tags
 *   - ipinfo.io (free tier) — ASN, geolocation, org
 *   - urlscan.io (free) — domain/IP scan history and verdicts
 *   - dns.google (DoH) — DNS lookups
 *   - crt.sh — certificate transparency
 *
 * Optional (set env vars for enriched output):
 *   VIRUSTOTAL_API_KEY — VirusTotal v3 (free 500 req/day)
 *   ABUSEIPDB_API_KEY  — AbuseIPDB (free 1000 req/day)
 *
 * Usage:
 *   node scripts/_threat-intel.mjs <ip|domain|hash> [--json]
 *
 * Exits 0 on no threats, 2 on threats found.
 */

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-ti] Access denied: VIGIL_SESSION_TOKEN not set.\n');
  process.exit(1);
}

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const indicator = argv.find((a) => !a.startsWith('--'));
const JSON_OUT = argv.includes('--json');
const EMIT_FINDINGS = argv.includes('--emit-vigil-findings');
const TIMEOUT_MS = 10_000;

if (!indicator) {
  process.stderr.write('Usage: node scripts/_threat-intel.mjs <ip|domain|hash> [--json]\n');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Vigil-ThreatIntel/1.0', ...opts.headers }, ...opts });
  } catch (e) { return null; } finally { clearTimeout(t); }
}

function detectType(ind) {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ind)) return 'ip';
  if (/^[0-9a-fA-F]{32}$/.test(ind)) return 'md5';
  if (/^[0-9a-fA-F]{40}$/.test(ind)) return 'sha1';
  if (/^[0-9a-fA-F]{64}$/.test(ind)) return 'sha256';
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(ind)) return 'domain';
  return 'unknown';
}

function vigilHome() { return process.env['VIGIL_HOME']?.trim() || join(homedir(), '.vigil'); }

// ── Intel sources ─────────────────────────────────────────────────────────────

async function shodanInternetDB(ip) {
  const res = await fetchTimeout(`https://internetdb.shodan.io/${ip}`);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

async function ipinfoLookup(ip) {
  const res = await fetchTimeout(`https://ipinfo.io/${ip}/json`);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

async function urlscanSearch(indicator) {
  const res = await fetchTimeout(`https://urlscan.io/api/v1/search/?q=${encodeURIComponent(indicator)}&size=5`);
  if (!res?.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.results ?? [];
}

async function virusTotalLookup(indicator, type) {
  const apiKey = process.env.VIRUSTOTAL_API_KEY;
  if (!apiKey) return null;
  const endpoint = type === 'domain' ? `domains/${indicator}`
    : type === 'ip' ? `ip_addresses/${indicator}`
    : `files/${indicator}`;
  const res = await fetchTimeout(`https://www.virustotal.com/api/v3/${endpoint}`, {
    headers: { 'x-apikey': apiKey },
  });
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

async function abuseIPDB(ip) {
  const apiKey = process.env.ABUSEIPDB_API_KEY;
  if (!apiKey) return null;
  const res = await fetchTimeout(
    `https://api.abuseipdb.com/api/v2/check?ipAddress=${ip}&maxAgeInDays=90`,
    { headers: { Key: apiKey, Accept: 'application/json' } }
  );
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

async function dohLookup(domain, type = 'A') {
  const res = await fetchTimeout(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`,
    { headers: { Accept: 'application/dns-json' } }
  );
  if (!res?.ok) return [];
  const data = await res.json().catch(() => ({}));
  return (data.Answer || []).map((r) => r.data);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const type = detectType(indicator);
process.stderr.write(`[vigil-ti] ${type.toUpperCase()}: ${indicator}\n`);

const result = { indicator, type, sources: {} };
const threats = [];

if (type === 'ip') {
  const [idb, info, urlscans, vtData, abuse] = await Promise.all([
    shodanInternetDB(indicator),
    ipinfoLookup(indicator),
    urlscanSearch(indicator),
    virusTotalLookup(indicator, 'ip'),
    abuseIPDB(indicator),
  ]);

  if (idb) {
    result.sources.shodan = idb;
    if (idb.vulns?.length) threats.push({ source: 'Shodan', type: 'CVE', detail: idb.vulns.join(', '), severity: 'high' });
    if (idb.tags?.some((t) => ['c2', 'malware', 'botnet', 'scanner', 'tor'].includes(t)))
      threats.push({ source: 'Shodan', type: 'tag', detail: idb.tags.join(', '), severity: 'high' });
  }

  if (info) result.sources.ipinfo = info;

  if (abuse?.data) {
    result.sources.abuseipdb = abuse.data;
    if (abuse.data.abuseConfidenceScore >= 25)
      threats.push({ source: 'AbuseIPDB', type: 'abuse', detail: `score:${abuse.data.abuseConfidenceScore}% ${abuse.data.usageType}`, severity: abuse.data.abuseConfidenceScore >= 75 ? 'critical' : 'high' });
  }

  if (vtData?.data?.attributes) {
    const attr = vtData.data.attributes;
    result.sources.virustotal = { malicious: attr.last_analysis_stats?.malicious, suspicious: attr.last_analysis_stats?.suspicious, harmless: attr.last_analysis_stats?.harmless };
    if ((attr.last_analysis_stats?.malicious ?? 0) > 0)
      threats.push({ source: 'VirusTotal', type: 'detection', detail: `${attr.last_analysis_stats.malicious} engines flagged malicious`, severity: 'critical' });
  }

  if (urlscans?.length) {
    result.sources.urlscan = urlscans.slice(0, 3).map((r) => ({ url: r.page?.url, verdict: r.verdicts?.overall?.malicious }));
    const maliciousScans = urlscans.filter((r) => r.verdicts?.overall?.malicious);
    if (maliciousScans.length) threats.push({ source: 'urlscan.io', type: 'malicious_urls', detail: `${maliciousScans.length} malicious scans`, severity: 'high' });
  }

} else if (type === 'domain') {
  const [aRecords, mxRecords, urlscans, vtData] = await Promise.all([
    dohLookup(indicator, 'A'),
    dohLookup(indicator, 'MX'),
    urlscanSearch(indicator),
    virusTotalLookup(indicator, 'domain'),
  ]);

  result.sources.dns = { A: aRecords, MX: mxRecords };

  if (vtData?.data?.attributes) {
    const attr = vtData.data.attributes;
    result.sources.virustotal = { categories: attr.categories, malicious: attr.last_analysis_stats?.malicious };
    if ((attr.last_analysis_stats?.malicious ?? 0) > 0)
      threats.push({ source: 'VirusTotal', type: 'detection', detail: `${attr.last_analysis_stats.malicious} engines flagged malicious`, severity: 'critical' });
  }

  if (urlscans?.length) {
    result.sources.urlscan = urlscans.slice(0, 3).map((r) => ({ url: r.page?.url, verdict: r.verdicts?.overall?.malicious }));
    const malicious = urlscans.filter((r) => r.verdicts?.overall?.malicious);
    if (malicious.length) threats.push({ source: 'urlscan.io', type: 'malicious', detail: `${malicious.length} malicious scans`, severity: 'high' });
  }

  // Enrich IPs behind the domain via Shodan InternetDB
  if (aRecords.length > 0) {
    const idb = await shodanInternetDB(aRecords[0]);
    if (idb) {
      result.sources.shodan = idb;
      if (idb.vulns?.length) threats.push({ source: 'Shodan', type: 'CVE', detail: idb.vulns.join(', '), severity: 'high' });
    }
  }

} else if (['md5', 'sha1', 'sha256'].includes(type)) {
  const vtData = await virusTotalLookup(indicator, 'file');
  if (vtData?.data?.attributes) {
    const attr = vtData.data.attributes;
    result.sources.virustotal = {
      name: attr.meaningful_name,
      type: attr.type_description,
      malicious: attr.last_analysis_stats?.malicious,
      undetected: attr.last_analysis_stats?.undetected,
      size: attr.size,
      magic: attr.magic,
      tags: attr.tags,
    };
    if ((attr.last_analysis_stats?.malicious ?? 0) > 0)
      threats.push({ source: 'VirusTotal', type: 'malware', detail: `${attr.last_analysis_stats.malicious} detections — ${attr.meaningful_name ?? 'unknown'}`, severity: 'critical' });
  }
}

result.threats = threats;
result.verdict = threats.length === 0 ? 'clean' : threats.some((t) => t.severity === 'critical') ? 'malicious' : 'suspicious';

// ── Emit findings ─────────────────────────────────────────────────────────────

if (EMIT_FINDINGS && threats.length > 0) {
  const store = join(vigilHome(), 'findings.json');
  let findings = [];
  if (existsSync(store)) { try { findings = JSON.parse(readFileSync(store, 'utf8')); } catch {} }
  const newFindings = threats.filter((t) => t.severity === 'critical' || t.severity === 'high').map((t) => ({
    id: `TI-${Date.now().toString(36).toUpperCase()}`,
    severity: t.severity,
    title: `${t.source}: ${t.type} — ${indicator}`,
    target: indicator,
    notes: t.detail,
    ts: new Date().toISOString(),
  }));
  mkdirSync(vigilHome(), { recursive: true });
  writeFileSync(store, JSON.stringify([...findings, ...newFindings], null, 2) + '\n');
  process.stderr.write(`[vigil-ti] Added ${newFindings.length} findings to store\n`);
}

// ── Output ────────────────────────────────────────────────────────────────────

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  const verdictColor = result.verdict === 'malicious' ? '\x1b[31m' : result.verdict === 'suspicious' ? '\x1b[33m' : '\x1b[32m';
  const reset = '\x1b[0m';
  const lines = ['', `═══ Threat Intel: ${indicator} (${type}) ═══`, ''];
  lines.push(`  Verdict: ${verdictColor}${result.verdict.toUpperCase()}${reset}`);

  if (result.sources.shodan) {
    const s = result.sources.shodan;
    if (s.ports?.length)   lines.push(`  Ports:    ${s.ports.join(', ')}`);
    if (s.tags?.length)    lines.push(`  Tags:     ${s.tags.join(', ')}`);
    if (s.cpes?.length)    lines.push(`  CPEs:     ${s.cpes.slice(0, 3).join('  ')}`);
    if (s.vulns?.length)   lines.push(`  CVEs:     ${s.vulns.join(', ')}`);
    if (s.hostnames?.length) lines.push(`  PTR:      ${s.hostnames.slice(0, 4).join(', ')}`);
  }
  if (result.sources.ipinfo) {
    const i = result.sources.ipinfo;
    lines.push(`  ASN:      ${i.org ?? '?'}  ${i.city ?? ''}, ${i.country ?? ''}`);
  }
  if (result.sources.abuseipdb) {
    const a = result.sources.abuseipdb;
    lines.push(`  AbuseIPDB: score=${a.abuseConfidenceScore}%  reports=${a.totalReports}  type=${a.usageType}`);
  }
  if (result.sources.virustotal) {
    const v = result.sources.virustotal;
    if (v.malicious != null) lines.push(`  VirusTotal: ${v.malicious} malicious / ${v.harmless ?? v.undetected} harmless`);
    if (v.name) lines.push(`  File: ${v.name}  type=${v.type}`);
  }
  if (threats.length > 0) {
    lines.push('', '  Threats:');
    for (const t of threats) lines.push(`    ⚠  [${t.severity.toUpperCase()}] ${t.source}: ${t.detail}`);
  }
  if (!process.env.VIRUSTOTAL_API_KEY) lines.push('', '  Tip: set VIRUSTOTAL_API_KEY for deeper hash/domain analysis');
  if (!process.env.ABUSEIPDB_API_KEY)  lines.push('  Tip: set ABUSEIPDB_API_KEY for IP abuse score');
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

process.exit(threats.length > 0 ? 2 : 0);
