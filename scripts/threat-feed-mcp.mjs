#!/usr/bin/env node
// MCP stdio server — Real-time Threat Intelligence Feed integration.
// Ingests live IOC feeds, CISA KEV, EPSS scores, OSV advisories,
// OTX pulses, and more. Cross-references against local assets.
// All operations are read-only API queries.
//
// Authorization: VIGIL_SESSION_TOKEN must be set by the Vigil CLI.

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-threatfeed-mcp] Error: VIGIL_SESSION_TOKEN is not set.\n' +
    'This server must be started by the Vigil CLI, not directly.\n');
  process.exit(1);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync, spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT = 15_000;
const IS_WIN = platform() === 'win32';

// ──────────────────────────────
// Helpers
// ──────────────────────────────
function safeRun(cmd, timeoutMs = TIMEOUT_MS) {
  try {
    const finalCmd = IS_WIN
      ? cmd.replaceAll('2>/dev/null', '2>$null')
      : `timeout ${Math.floor(timeoutMs / 1000)} ${cmd}`;
    return execSync(finalCmd, {
      encoding: 'utf8', timeout: timeoutMs + 5000,
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
      killSignal: 'SIGKILL',
    }).trim();
  } catch { return ''; }
}

function httpGet(url, headers = {}, timeoutMs = HTTP_TIMEOUT) {
  try {
    const headerArgs = Object.entries(headers).map(([k, v]) => `-H '${k}: ${v}'`).join(' ');
    const cmd = `curl -sS --max-time ${Math.floor(timeoutMs / 1000)} ${headerArgs} '${url}' 2>/dev/null`;
    const raw = safeRun(cmd, timeoutMs + 5000);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  } catch { return null; }
}

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function guarded(fn) {
  try {
    return jsonResult(await fn());
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] };
  }
}

// ──────────────────────────────
// Cache for rate-limited feeds
// ──────────────────────────────
const feedCache = new Map();
function getCached(key, ttlMs = 300_000) {
  const entry = feedCache.get(key);
  if (entry && (Date.now() - entry.ts) < ttlMs) return entry.data;
  return null;
}
function setCached(key, data) {
  feedCache.set(key, { data, ts: Date.now() });
}

// ──────────────────────────────
// MCP Server
// ──────────────────────────────
const server = new McpServer({
  name: 'vigil-threat-feed',
  version: '1.0.0',
});

// ── CISA Known Exploited Vulnerabilities (KEV) ──
server.registerTool(
  'threat_cisa_kev',
  {
    title: 'CISA KEV Feed',
    description: 'Fetch the latest CISA Known Exploited Vulnerabilities catalog. Returns all actively exploited CVEs with vendor, product, due date for remediation, and ransomware association. Cached for 60 minutes.',
    inputSchema: {
      filter: z.string().optional().describe('Filter by vendor, product, or CVE substring. Omit for full catalog.'),
      limit: z.number().int().positive().max(100).optional().default(30),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    const cacheKey = 'cisa-kev';
    let data = getCached(cacheKey, 3_600_000);

    if (!data) {
      data = httpGet('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', {}, 20000);
      if (data?.vulnerabilities) {
        setCached(cacheKey, data);
      }
    }

    if (!data?.vulnerabilities) {
      return jsonResult({ error: 'CISA KEV feed unavailable', hint: 'Check network connectivity to cisa.gov' });
    }

    let vulns = data.vulnerabilities;
    if (args.filter) {
      const f = args.filter.toLowerCase();
      vulns = vulns.filter(v =>
        (v.cveID || '').toLowerCase().includes(f) ||
        (v.vendorProject || '').toLowerCase().includes(f) ||
        (v.product || '').toLowerCase().includes(f) ||
        (v.vulnerabilityName || '').toLowerCase().includes(f)
      );
    }

    const limited = vulns.slice(0, args.limit);
    const summary = {
      totalActive: data.vulnerabilities.length,
      filtered: limited.length,
      ransomwareAssociated: limited.filter(v => v.knownRansomwareCampaignUse === 'Known').length,
      topVendors: [...new Set(limited.map(v => v.vendorProject))].slice(0, 10),
    };

    return jsonResult({
      fetchedAt: new Date().toISOString(),
      summary,
      vulnerabilities: limited.map(v => ({
        cve: v.cveID,
        vendor: v.vendorProject,
        product: v.product,
        name: v.vulnerabilityName,
        dateAdded: v.dateAdded,
        dueDate: v.dueDate,
        requiredAction: v.requiredAction,
        ransomware: v.knownRansomwareCampaignUse,
        notes: v.notes?.slice(0, 200),
      })),
    });
  },
);

// ── EPSS Scores ──
server.registerTool(
  'threat_epss',
  {
    title: 'EPSS Score Lookup',
    description: 'Look up EPSS (Exploit Prediction Scoring System) scores for CVEs. Returns exploit probability and percentile ranking. Cached for 24 hours.',
    inputSchema: {
      cves: z.string().describe('Comma-separated CVE IDs (e.g. CVE-2024-1234,CVE-2024-5678). Max 50.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    const cveList = (args.cves || '').split(',').map(c => c.trim().toUpperCase()).filter(c => c.startsWith('CVE-')).slice(0, 50);
    if (!cveList.length) return jsonResult({ error: 'No valid CVE IDs provided' });

    const results = [];
    const uncached = [];

    for (const cve of cveList) {
      const cached = getCached(`epss:${cve}`, 86_400_000);
      if (cached) { results.push(cached); } else { uncached.push(cve); }
    }

    if (uncached.length > 0) {
      const url = `https://api.first.org/data/v1/epss?cve=${uncached.join(',')}`;
      const data = httpGet(url, {}, 15000);
      if (data?.data) {
        for (const entry of data.data) {
          const result = {
            cve: entry.cve,
            epss: parseFloat(entry.epss || '0'),
            percentile: parseFloat(entry.percentile || '0'),
            date: entry.date,
          };
          setCached(`epss:${entry.cve}`, result);
          results.push(result);
        }
      }
    }

    results.sort((a, b) => b.epss - a.epss);
    const highRisk = results.filter(r => r.epss > 0.1);
    const criticalRisk = results.filter(r => r.epss > 0.5);

    return jsonResult({
      lookedUp: cveList.length,
      found: results.length,
      summary: { highRiskCount: highRisk.length, criticalRiskCount: criticalRisk.length },
      results,
    });
  },
);

// ── AlienVault OTX pulses ──
server.registerTool(
  'threat_otx',
  {
    title: 'AlienVault OTX Pulses',
    description: 'Fetch recent threat intelligence pulses from AlienVault OTX. Returns IOCs, tags, and adversary information. Cached for 15 minutes.',
    inputSchema: {
      search: z.string().optional().describe('Search term for pulses (e.g. CVE ID, malware name, vendor).'),
      limit: z.number().int().positive().max(50).optional().default(10),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    const search = args.search || 'cve';
    const cacheKey = `otx:${search}`;
    let data = getCached(cacheKey, 900_000);

    if (!data) {
      const url = `https://otx.alienvault.com/api/v1/pulses/subscribed?q=${encodeURIComponent(search)}&limit=${args.limit}`;
      data = httpGet(url, { 'X-OTX-API-KEY': '' }, 15000);
      if (data?.results) setCached(cacheKey, data);
    }

    if (!data?.results) {
      return jsonResult({ error: 'OTX feed unavailable', search, hint: 'OTX may require API key or be rate-limited' });
    }

    const pulses = data.results.slice(0, args.limit).map(p => ({
      id: p.id,
      name: p.name,
      description: (p.description || '').slice(0, 300),
      created: p.created,
      adversary: p.adversary,
      tags: (p.tags || []).slice(0, 20),
      indicatorsCount: p.indicator_count || 0,
      tlp: p.TLP,
      references: (p.references || []).slice(0, 5),
    }));

    return jsonResult({
      fetchedAt: new Date().toISOString(),
      search,
      total: data.count || 0,
      pulses,
    });
  },
);

// ── URLhaus malware URL feed ──
server.registerTool(
  'threat_urlhaus',
  {
    title: 'URLhaus Malware Feed',
    description: 'Fetch recent malware URLs from URLhaus (abuse.ch). Returns malicious URLs, file hashes, tags, and threat types. Cached for 15 minutes.',
    inputSchema: {
      limit: z.number().int().positive().max(100).optional().default(30),
      filter: z.enum(['all', 'active', 'emotet', 'qakbot', 'gozi', 'dridex']).optional().default('active'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    const cacheKey = `urlhaus:${args.filter}`;
    let data = getCached(cacheKey, 900_000);

    if (!data) {
      const filterParam = args.filter !== 'all' ? `?${args.filter}=true` : '';
      data = httpGet(`https://urlhaus-api.abuse.ch/v1/urls/recent/${filterParam}`, {}, 15000);
      if (data?.urls) setCached(cacheKey, data);
    }

    if (!data?.urls) {
      return jsonResult({ error: 'URLhaus feed unavailable', hint: 'Check network connectivity to abuse.ch' });
    }

    const urls = data.urls.slice(0, args.limit).map(u => ({
      url: u.url,
      status: u.url_status,
      threat: u.threat,
      tags: u.tags || [],
      dateAdded: u.date_added,
      fileType: u.file_type,
      sha256: u.sha256_hash,
      reporter: u.reporter,
    }));

    const threats = {};
    for (const u of urls) {
      threats[u.threat] = (threats[u.threat] || 0) + 1;
    }

    return jsonResult({
      fetchedAt: new Date().toISOString(),
      filter: args.filter,
      total: data.urls.length,
      returned: urls.length,
      threatBreakdown: threats,
      urls,
    });
  },
);

// ── MalwareBazaar hash lookup ──
server.registerTool(
  'threat_malwarebazaar',
  {
    title: 'MalwareBazaar Hash Lookup',
    description: 'Look up file hashes against MalwareBazaar (abuse.ch). Returns malware family, tags, signature, and delivery method. Cached for 24 hours.',
    inputSchema: {
      hashes: z.string().describe('Comma-separated SHA256/MD5/SHA1 hashes. Max 20.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    const hashList = (args.hashes || '').split(',').map(h => h.trim()).filter(Boolean).slice(0, 20);
    if (!hashList.length) return jsonResult({ error: 'No valid hashes provided' });

    const results = [];
    const uncached = [];

    for (const hash of hashList) {
      const cached = getCached(`malbazaar:${hash}`, 86_400_000);
      if (cached) { results.push(cached); } else { uncached.push(hash); }
    }

    for (const hash of uncached) {
      const data = httpGet('https://mb-api.abuse.ch/api/v1/', {
        'Content-Type': 'application/x-www-form-urlencoded',
      }, 15000);

      // MalwareBazaar uses POST
      const raw = safeRun(
        `curl -sS --max-time ${Math.floor(HTTP_TIMEOUT / 1000)} -X POST 'https://mb-api.abuse.ch/api/v1/' -d 'query=get_info&hash=${hash}' 2>/dev/null`,
        HTTP_TIMEOUT + 5000
      );
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.query_status === 'ok' && parsed.data?.length > 0) {
            const d = parsed.data[0];
            const result = {
              hash: d.sha256_hash || hash,
              md5: d.md5_hash || '',
              sha1: d.sha1_hash || '',
              fileName: d.file_name || '',
              fileType: d.file_type || '',
              malwareFamily: d.signature || 'unknown',
              tags: d.tags || [],
              firstSeen: d.first_seen || '',
              reporter: d.reporter || '',
              deliveryMethod: d.delivery_method || '',
            };
            setCached(`malbazaar:${hash}`, result);
            results.push(result);
          }
        } catch {}
      }
    }

    const detections = results.filter(r => r.malwareFamily && r.malwareFamily !== 'unknown');
    return jsonResult({
      queried: hashList.length,
      found: results.length,
      detections: detections.length,
      results,
    });
  },
);

// ── OSV.dev advisory lookup ──
server.registerTool(
  'threat_osv',
  {
    title: 'OSV Advisory Lookup',
    description: 'Query the OSV.dev open-source vulnerability database. Returns advisories with affected versions, fix versions, references, and severity. Cached for 60 minutes.',
    inputSchema: {
      package: z.string().describe('Package name (e.g. openssl, lodash, org.apache.logging.log4j:log4j-core).'),
      ecosystem: z.string().optional().describe('Ecosystem (npm, PyPI, Maven, Go, crates.io, etc.). Omit for auto-detect.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    const cacheKey = `osv:${args.package}:${args.ecosystem || 'auto'}`;
    let data = getCached(cacheKey, 3_600_000);

    if (!data) {
      const body = JSON.stringify({
        package: { name: args.package, ecosystem: args.ecosystem || '' },
      });
      data = httpGet(`https://api.osv.dev/v1/query?package=${encodeURIComponent(args.package)}&ecosystem=${encodeURIComponent(args.ecosystem || '')}`, {
        'Content-Type': 'application/json',
      }, 15000);

      // OSV query uses POST, so try curl directly
      if (!data) {
        const raw = safeRun(
          `curl -sS --max-time ${Math.floor(HTTP_TIMEOUT / 1000)} -X POST 'https://api.osv.dev/v1/query' -H 'Content-Type: application/json' -d '${body.replace(/'/g, "\\'")}' 2>/dev/null`,
          HTTP_TIMEOUT + 5000
        );
        try { data = JSON.parse(raw || '{}'); } catch { data = null; }
      }
      if (data?.vulns) setCached(cacheKey, data);
    }

    if (!data?.vulns) {
      return jsonResult({ error: 'OSV query returned no results or failed', package: args.package });
    }

    const vulns = data.vulns.map(v => ({
      id: v.id,
      summary: (v.summary || '').slice(0, 300),
      aliases: (v.aliases || []).slice(0, 10),
      published: v.published,
      modified: v.modified,
      severity: (v.severity || []).slice(0, 5),
      affected: (v.affected || []).slice(0, 3).map(a => ({
        package: a.package?.name,
        versions: a.versions?.slice(0, 10) || [],
        ranges: (a.ranges || []).slice(0, 3).map(r => ({
          type: r.type,
          events: (r.events || []).slice(0, 5),
        })),
      })),
      references: (v.references || []).slice(0, 5).map(r => r.url),
    }));

    return jsonResult({
      package: args.package,
      ecosystem: args.ecosystem || 'auto',
      total: vulns.length,
      criticalCount: vulns.filter(v => v.severity?.some(s => s.type === 'CVSS_V3' && parseFloat(s.score) >= 9)).length,
      vulns,
    });
  },
);

// ── Local IOC cross-reference ──
server.registerTool(
  'threat_crossref',
  {
    title: 'Cross-Reference Local IOCs',
    description: 'Cross-reference local assets (IPs, domains, file hashes) against threat intelligence feeds. Combines OTX, URLhaus, and MalwareBazaar lookups and returns matches with severity ratings.',
    inputSchema: {
      ips: z.string().optional().describe('Comma-separated IP addresses to check.'),
      domains: z.string().optional().describe('Comma-separated domains to check.'),
      hashes: z.string().optional().describe('Comma-separated SHA256 hashes to check.'),
      timeoutMs: z.number().int().positive().max(120_000).optional().default(30000),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    const results = { matched: [], clean: [], unknown: [] };
    const timeout = args.timeoutMs || 30000;

    // Check IPs against OTX
    if (args.ips) {
      const ips = args.ips.split(',').map(i => i.trim()).filter(Boolean);
      for (const ip of ips) {
        const data = httpGet(`https://otx.alienvault.com/api/v1/indicators/IPv4/${ip}/general`, {}, Math.floor(timeout / ips.length / 2));
        if (data?.pulse_info?.count > 0) {
          results.matched.push({ type: 'ip', value: ip, pulses: data.pulse_info.count, tags: data.pulse_info?.pulses?.flatMap(p => p.tags || []).slice(0, 20) || [] });
        } else if (data) {
          results.clean.push({ type: 'ip', value: ip });
        } else {
          results.unknown.push({ type: 'ip', value: ip });
        }
      }
    }

    // Check domains against OTX
    if (args.domains) {
      const domains = args.domains.split(',').map(d => d.trim()).filter(Boolean);
      for (const domain of domains) {
        const data = httpGet(`https://otx.alienvault.com/api/v1/indicators/domain/${domain}/general`, {}, Math.floor(timeout / domains.length / 2));
        if (data?.pulse_info?.count > 0) {
          results.matched.push({ type: 'domain', value: domain, pulses: data.pulse_info.count, tags: data.pulse_info?.pulses?.flatMap(p => p.tags || []).slice(0, 20) || [] });
        } else if (data) {
          results.clean.push({ type: 'domain', value: domain });
        } else {
          results.unknown.push({ type: 'domain', value: domain });
        }
      }
    }

    // Check hashes against MalwareBazaar
    if (args.hashes) {
      const hashes = args.hashes.split(',').map(h => h.trim()).filter(Boolean);
      for (const hash of hashes) {
        const raw = safeRun(
          `curl -sS --max-time 10 -X POST 'https://mb-api.abuse.ch/api/v1/' -d 'query=get_info&hash=${hash}' 2>/dev/null`,
          15000
        );
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.query_status === 'ok' && parsed.data?.length > 0) {
              const d = parsed.data[0];
              results.matched.push({
                type: 'hash',
                value: hash,
                malwareFamily: d.signature || 'unknown',
                fileName: d.file_name || '',
                tags: d.tags || [],
              });
            } else {
              results.clean.push({ type: 'hash', value: hash });
            }
          } catch {
            results.unknown.push({ type: 'hash', value: hash });
          }
        }
      }
    }

    return jsonResult({
      timestamp: new Date().toISOString(),
      summary: {
        total: results.matched.length + results.clean.length + results.unknown.length,
        matched: results.matched.length,
        clean: results.clean.length,
        unknown: results.unknown.length,
      },
      ...results,
    });
  },
);

// ── GitHub Security Advisories ──
server.registerTool(
  'threat_ghsa',
  {
    title: 'GitHub Security Advisories',
    description: 'Query GitHub Security Advisories for a package or ecosystem. Returns advisories with CVE IDs, severity, and affected versions. Cached for 30 minutes.',
    inputSchema: {
      package: z.string().describe('Package name to search for.'),
      ecosystem: z.string().optional().describe('Ecosystem filter (npm, maven, pip, go, nuget, composer, rust).'),
      limit: z.number().int().positive().max(50).optional().default(20),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    const cacheKey = `ghsa:${args.package}:${args.ecosystem || ''}`;
    let data = getCached(cacheKey, 1_800_000);

    if (!data) {
      const ecosystemParam = args.ecosystem ? `&ecosystem=${args.ecosystem}` : '';
      const query = `{ securityAdvisories(first: ${args.limit}, classifications: GENERAL, publishedSince: "${new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}T00:00:00Z", ${args.ecosystem ? `ecosystem: ${args.ecosystem}, ` : ''}orderBy: { field: PUBLISHED_AT, direction: DESC }) { nodes { ghsaId summary severity permalink publishedAt withdrawnAt cveId: identifiers(first: 1, type: CVE) { nodes { value } } vulnerabilities(first: 5) { nodes { package { name ecosystem } severity vulnerableVersionRange firstPatchedVersion { identifier } } } } } }`;

      const raw = safeRun(
        `curl -sS --max-time 15 -X POST 'https://api.github.com/graphql' -H 'Authorization: Bearer ' -H 'Content-Type: application/json' -d '${JSON.stringify({ query }).replace(/'/g, "\\'")}' 2>/dev/null`,
        20000
      );
      if (!raw) {
        // Fallback to REST API
        const restQuery = args.package;
        data = httpGet(`https://api.github.com/advisories?per_page=${args.limit}&type=reviewed&${args.ecosystem ? `ecosystem=${args.ecosystem}&` : ''}q=${encodeURIComponent(restQuery)}`, {}, 15000);
      } else {
        try { data = JSON.parse(raw); } catch { data = null; }
      }
      if (data) setCached(cacheKey, data);
    }

    if (!data) {
      return jsonResult({ error: 'GitHub Advisory API unavailable', package: args.package, hint: 'Rate-limited — GitHub API allows 60 unauthenticated requests/hour' });
    }

    // Normalize response
    const advisories = [];
    if (data.data?.securityAdvisories?.nodes) {
      for (const n of data.data.securityAdvisories.nodes) {
        advisories.push({
          ghsaId: n.ghsaId,
          summary: n.summary?.slice(0, 250),
          severity: n.severity,
          permalink: n.permalink,
          publishedAt: n.publishedAt,
          cveId: n.cveId?.nodes?.[0]?.value || null,
          affectedPackages: (n.vulnerabilities?.nodes || []).map(v => ({
            name: v.package?.name,
            ecosystem: v.package?.ecosystem,
            severity: v.severity,
            patchedVersion: v.firstPatchedVersion?.identifier || null,
          })),
        });
      }
    } else if (Array.isArray(data)) {
      for (const a of data.slice(0, args.limit)) {
        advisories.push({
          ghsaId: a.ghsa_id,
          summary: (a.summary || a.description || '').slice(0, 250),
          severity: a.severity,
          cveId: a.cve_id,
          permalink: a.html_url,
          publishedAt: a.published_at,
        });
      }
    }

    return jsonResult({
      package: args.package,
      ecosystem: args.ecosystem || 'any',
      total: advisories.length,
      advisories,
    });
  },
);

// ──────────────────────────────
// Start server
// ──────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
