// _variant-research.mjs — light-touch variant research over our
// direct dependency surface. For each tracked dep with a public
// security-advisory feed, query the GitHub Security Advisory API
// (ecosystem=npm) and surface the recent advisories.
//
// This is NOT patch-watch (no repo clone, no commit-message
// heuristic). It's the "pull what GitHub already classified as a
// security advisory" pass that complements npm-audit by pulling
// even draft / withdrawn / informational advisories that audit
// suppresses.

import { request } from 'node:https';

const PER_DEP_LIMIT = 5;
const TIMEOUT_MS = 12000;

export async function runVariantResearch(directDeps) {
  const results = [];
  for (const dep of directDeps) {
    try {
      const advs = await ghAdvisoriesForNpm(dep.name);
      results.push({
        name: dep.name,
        pinned: dep.pinned,
        advisories: advs.slice(0, PER_DEP_LIMIT).map((a) => ({
          ghsaId: a.ghsa_id,
          cveId: a.cve_id,
          severity: a.severity,
          summary: a.summary,
          publishedAt: a.published_at,
          updatedAt: a.updated_at,
          htmlUrl: a.html_url,
          vulnerableVersions: (a.vulnerabilities || [])
            .filter((v) => v.package?.ecosystem === 'npm' && v.package?.name === dep.name)
            .map((v) => v.vulnerable_version_range)
            .filter(Boolean),
        })),
        queriedAt: new Date().toISOString(),
      });
    } catch (e) {
      results.push({
        name: dep.name,
        pinned: dep.pinned,
        error: String(e?.message ?? e).slice(0, 300),
      });
    }
  }
  return results;
}

function ghAdvisoriesForNpm(name) {
  return new Promise((resolve, reject) => {
    const url = `/advisories?ecosystem=npm&affects=${encodeURIComponent(name)}&per_page=20`;
    const headers = {
      'User-Agent': 'vigil-security-analysis (+https://erosolar-1b0db.web.app)',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (process.env['GITHUB_TOKEN']) {
      headers['Authorization'] = `Bearer ${process.env['GITHUB_TOKEN']}`;
    }
    const req = request({
      hostname: 'api.github.com', path: url, method: 'GET', headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`bad json: ${e.message}`)); }
        } else if (res.statusCode === 403 || res.statusCode === 429) {
          reject(new Error(`rate-limited: ${res.statusCode}`));
        } else {
          reject(new Error(`http ${res.statusCode}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', (e) => reject(e));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.end();
  });
}
