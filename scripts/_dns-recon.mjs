#!/usr/bin/env node
/**
 * _dns-recon.mjs — Passive DNS recon: records + cert transparency + ASN.
 *
 * Queries public DNS-over-HTTPS, crt.sh, and ipinfo.io (free tier).
 * No active scanning — all passive sources only.
 *
 * Usage:
 *   node scripts/_dns-recon.mjs <domain> [--json] [--emit-vigil-findings]
 *
 * Exits 0 on success, 1 on fatal error.
 */

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-dns] Access denied: VIGIL_SESSION_TOKEN not set.\n');
  process.exit(1);
}

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const domain = argv.find((a) => !a.startsWith('--'))?.toLowerCase();
const JSON_OUT = argv.includes('--json');
const EMIT_FINDINGS = argv.includes('--emit-vigil-findings');
const TIMEOUT_MS = 10_000;

if (!domain) {
  process.stderr.write('Usage: node scripts/_dns-recon.mjs <domain> [--json]\n');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Vigil-DNSRecon/1.0', 'Accept': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
  } finally { clearTimeout(t); }
}

function vigilHome() { return process.env['VIGIL_HOME']?.trim() || join(homedir(), '.vigil'); }
function loadFindings() {
  const p = join(vigilHome(), 'findings.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}
function saveFindings(recs) {
  mkdirSync(vigilHome(), { recursive: true });
  writeFileSync(join(vigilHome(), 'findings.json'), JSON.stringify(recs, null, 2) + '\n');
}

// ── DNS-over-HTTPS (Cloudflare) ───────────────────────────────────────────────

async function dohQuery(name, type) {
  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
    const res = await fetchTimeout(url, { headers: { Accept: 'application/dns-json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.Answer || []).map((r) => ({ type, name: r.name, data: r.data, ttl: r.TTL }));
  } catch { return []; }
}

// ── crt.sh certificate transparency ──────────────────────────────────────────

async function crtshQuery(domain) {
  try {
    const res = await fetchTimeout(`https://crt.sh/?q=%25.${domain}&output=json`);
    if (!res.ok) return [];
    const certs = await res.json();
    const names = new Set();
    for (const c of certs) {
      for (const n of (c.name_value || '').split('\n')) {
        const clean = n.trim().replace(/^\*\./, '');
        if (clean.endsWith(domain) && clean.length > domain.length) {
          names.add(clean.toLowerCase());
        }
      }
    }
    return [...names].sort();
  } catch { return []; }
}

// ── Shodan InternetDB (free, no API key) ─────────────────────────────────────

async function internetdb(ip) {
  try {
    const res = await fetchTimeout(`https://internetdb.shodan.io/${ip}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── ipinfo.io (free tier, no key required for basic) ─────────────────────────

async function ipinfo(ip) {
  try {
    const res = await fetchTimeout(`https://ipinfo.io/${ip}/json`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

process.stderr.write(`[vigil-dns] Passive recon: ${domain}\n`);

const RECORD_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA'];

const [dnsResults, subdomains] = await Promise.all([
  Promise.all(RECORD_TYPES.map((t) => dohQuery(domain, t))),
  crtshQuery(domain),
]);

const records = {};
for (let i = 0; i < RECORD_TYPES.length; i++) {
  if (dnsResults[i].length > 0) records[RECORD_TYPES[i]] = dnsResults[i];
}

// Resolve IPs for subdomains (top 10 only to avoid hammering)
const aRecords = (records['A'] || []).map((r) => r.data);
const allIps = [...new Set(aRecords)];

// InternetDB + ipinfo for discovered IPs
const ipData = {};
for (const ip of allIps.slice(0, 5)) {
  const [idb, info] = await Promise.all([internetdb(ip), ipinfo(ip)]);
  ipData[ip] = { internetdb: idb, ipinfo: info };
}

// Security findings from InternetDB: open ports, known CVEs on IP
const securityFindings = [];
for (const [ip, data] of Object.entries(ipData)) {
  if (data.internetdb) {
    const idb = data.internetdb;
    if (idb.vulns && idb.vulns.length > 0) {
      for (const cve of idb.vulns) {
        securityFindings.push({ ip, cve, ports: idb.ports || [], tags: idb.tags || [] });
      }
    }
  }
}

if (EMIT_FINDINGS && securityFindings.length > 0) {
  const existing = loadFindings();
  const existingCves = new Set(existing.map((f) => f.cve?.toUpperCase()).filter(Boolean));
  const toAdd = securityFindings
    .filter((f) => !existingCves.has(f.cve.toUpperCase()))
    .map((f) => ({
      id: `DNS-${Date.now().toString(36).toUpperCase()}`,
      severity: 'high',
      title: `${f.cve} on ${f.ip} (Shodan InternetDB)`,
      target: domain,
      cve: f.cve,
      notes: `Ports: ${f.ports.join(', ')}  Tags: ${f.tags.join(', ')}`,
      ts: new Date().toISOString(),
    }));
  if (toAdd.length > 0) {
    saveFindings([...existing, ...toAdd]);
    process.stderr.write(`[vigil-dns] Added ${toAdd.length} CVE findings from Shodan InternetDB\n`);
  }
}

const result = { domain, records, subdomains, ips: ipData, securityFindings };

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

// ── Text output ───────────────────────────────────────────────────────────────

const lines = ['', `═══ DNS Recon: ${domain} ═══`, ''];

for (const [type, recs] of Object.entries(records)) {
  lines.push(`  ${type.padEnd(6)} ${recs.map((r) => r.data).join('  ·  ')}`);
}

if (subdomains.length > 0) {
  lines.push('', `  Subdomains (cert transparency): ${subdomains.length}`);
  for (const s of subdomains.slice(0, 20)) lines.push(`    · ${s}`);
  if (subdomains.length > 20) lines.push(`    ... +${subdomains.length - 20} more`);
}

for (const [ip, data] of Object.entries(ipData)) {
  lines.push('', `  IP: ${ip}`);
  if (data.ipinfo) {
    const i = data.ipinfo;
    lines.push(`    ASN: ${i.org || 'unknown'}  Location: ${i.city || ''}, ${i.country || ''}`);
  }
  if (data.internetdb) {
    const idb = data.internetdb;
    if (idb.ports?.length) lines.push(`    Open ports (Shodan): ${idb.ports.join(', ')}`);
    if (idb.tags?.length)  lines.push(`    Tags: ${idb.tags.join(', ')}`);
    if (idb.cpes?.length)  lines.push(`    CPEs: ${idb.cpes.slice(0, 3).join('  ')}`);
    if (idb.vulns?.length) lines.push(`    CVEs (Shodan): ${idb.vulns.join(', ')}`);
  }
}

if (securityFindings.length > 0) {
  lines.push('', `  ⚠  ${securityFindings.length} CVE(s) found on discovered IPs`);
}

lines.push('');
process.stdout.write(lines.join('\n') + '\n');
