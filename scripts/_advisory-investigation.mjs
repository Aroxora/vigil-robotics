// _advisory-investigation.mjs — per-package deep-dive on every
// vulnerable package surfaced by npm-audit. For each, this pass:
//
//   1. pulls the GitHub Security Advisory records for the npm package
//   2. cross-checks against OSV.dev
//   3. resolves the dependency path via `npm ls`
//   4. queries the npm registry for available versions + dist-tags
//   5. proposes a fix target (preferring npm-audit's fixAvailable; falling
//      back to the latest dist-tag if audit just says "fix available")
//   6. validates the fix in a sandboxed copy of package.json +
//      package-lock.json by running `npm install --package-lock-only`
//      followed by `npm audit --json` to confirm clearance
//
// Output, per advisory, under `<outDir>/advisories/<id>/`:
//   - evidence.json    — raw evidence (GHSA + OSV + npm ls + npm view)
//   - report.md        — human-readable research report
//   - proposed-fix.md  — before/after, command, post-fix audit comparison
//
// The summary object returned is small enough to inline into the
// top-level findings.json (and Firestore doc).

import { execSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';

// The GHSA API is rate-limited (60/hr unauth, 5000/hr with
// GITHUB_TOKEN); set GITHUB_TOKEN before running large surfaces.
// Each sandbox validation runs two npm subcommands. The caps below
// are intentionally high — the requirement is full coverage per
// finding, not "fast". For sub-minute runs use a smaller subset by
// pre-filtering the vulnerable[] array before calling this.
const MAX_INVESTIGATIONS = 500;
const MAX_SANDBOX_VALIDATIONS = 500;
const PER_DEP_GHSA_LIMIT = 12;
const OSV_LIMIT = 12;
const HTTP_TIMEOUT_MS = 15000;
const NPM_TIMEOUT_MS = 120_000;

const SEV_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

export async function investigateAdvisories({ root, outDir, vulnerable }) {
  if (!vulnerable?.length) {
    return { investigated: 0, advisories: [], sandboxValidations: 0, skipped: 'no vulnerable packages' };
  }

  const advRoot = join(outDir, 'advisories');
  mkdirSync(advRoot, { recursive: true });
  const sandboxRoot = join(root, 'security-analysis', '.sandbox');
  rmSync(sandboxRoot, { recursive: true, force: true });

  const sorted = [...vulnerable].sort((a, b) =>
    (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0)
  );
  const queue = sorted.slice(0, MAX_INVESTIGATIONS);

  const advisories = [];
  let sandboxBudget = MAX_SANDBOX_VALIDATIONS;

  for (const v of queue) {
    const advId = sanitizeId(v.name);
    const advOutDir = join(advRoot, advId);
    mkdirSync(advOutDir, { recursive: true });

    const evidence = {
      pkg: v.name,
      severity: v.severity,
      isDirect: v.isDirect,
      fixAvailable: v.fixAvailable,
      via: v.via,
      queriedAt: new Date().toISOString(),
      ghsa: [],
      osv: [],
      depPath: [],
      npmView: null,
      errors: [],
    };

    try {
      const ghsa = await ghAdvisoriesForNpm(v.name);
      evidence.ghsa = ghsa.slice(0, PER_DEP_GHSA_LIMIT).map(shapeGhsa.bind(null, v.name));
    } catch (e) {
      evidence.errors.push(`ghsa: ${msg(e)}`);
    }

    try {
      evidence.osv = (await osvQuery(v.name)).slice(0, OSV_LIMIT);
    } catch (e) {
      evidence.errors.push(`osv: ${msg(e)}`);
    }

    try {
      const view = JSON.parse(execSync(`npm view ${v.name} --json`, {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 16 * 1024 * 1024,
      }));
      evidence.npmView = {
        latest: view['dist-tags']?.latest ?? null,
        distTags: view['dist-tags'] ?? {},
        recentVersions: Array.isArray(view.versions) ? view.versions.slice(-30) : [],
        deprecated: view.deprecated ?? null,
        repository: typeof view.repository === 'string' ? view.repository : view.repository?.url ?? null,
        license: typeof view.license === 'string' ? view.license : view.license?.type ?? null,
      };
    } catch (e) {
      evidence.errors.push(`npm view: ${msg(e)}`);
    }

    try {
      evidence.depPath = collectDepPaths(root, v.name);
    } catch (e) {
      evidence.errors.push(`npm ls: ${msg(e)}`);
    }

    const proposedFix = computeFixTarget(v, evidence);

    if (proposedFix.target && sandboxBudget > 0) {
      try {
        const sandboxResult = sandboxValidateFix({
          root, sandboxRoot, pkgName: v.name, target: proposedFix.target,
          isDirect: v.isDirect,
        });
        proposedFix.sandboxValidated = true;
        proposedFix.postFixAudit = sandboxResult.postFixAudit;
        proposedFix.beforeAfter = sandboxResult.beforeAfter;
        sandboxBudget--;
      } catch (e) {
        proposedFix.sandboxValidated = false;
        proposedFix.sandboxError = msg(e);
      }
    } else if (proposedFix.target) {
      proposedFix.sandboxValidated = false;
      proposedFix.sandboxSkipped = 'budget exhausted';
    }

    writeFileSync(join(advOutDir, 'evidence.json'),
      JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    writeFileSync(join(advOutDir, 'report.md'),
      renderAdvisoryReport(v, evidence, proposedFix), 'utf8');
    writeFileSync(join(advOutDir, 'proposed-fix.md'),
      renderProposedFix(v, evidence, proposedFix), 'utf8');

    const vulnDetails = (evidence.ghsa ?? []).map((g) => ({
      ghsaId: g.ghsaId,
      cveId: g.cveId,
      severity: g.severity,
      summary: g.summary,
      description: (g.description ?? '').slice(0, 800),
      cvssScore: g.cvss?.score ?? null,
      cvssVector: g.cvss?.vector_string ?? null,
      cwes: (g.cwes ?? []).map((c) => c.cwe_id),
      publishedAt: g.publishedAt,
      htmlUrl: g.htmlUrl,
      affectedVersions: g.vulnerableVersions.map((vv) => ({
        range: vv.range,
        firstPatched: vv.firstPatchedVersion?.identifier ?? null,
      })),
      references: (g.references ?? []).slice(0, 5),
    }));

    const osvDetails = (evidence.osv ?? []).map((o) => ({
      id: o.id,
      summary: o.summary,
      aliases: o.aliases,
      published: o.published,
      severity: o.severity,
    }));

    advisories.push({
      id: advId,
      pkg: v.name,
      severity: v.severity,
      isDirect: v.isDirect,
      ghsaCount: evidence.ghsa.length,
      osvCount: evidence.osv.length,
      depPaths: evidence.depPath.length,
      depPathSample: evidence.depPath.slice(0, 3),
      currentVersion: evidence.npmView?.latest ?? null,
      proposedTarget: proposedFix.target,
      proposedTargetSource: proposedFix.source,
      proposedFixCommand: proposedFix.command,
      proposedFixNote: proposedFix.note,
      sandboxValidated: !!proposedFix.sandboxValidated,
      postFixClears: proposedFix.postFixAudit?.clearedForPkg ?? null,
      reportPath: `advisories/${advId}/report.md`,
      evidencePath: `advisories/${advId}/evidence.json`,
      fixPath: `advisories/${advId}/proposed-fix.md`,
      vulnDetails,
      osvDetails,
    });
  }

  rmSync(sandboxRoot, { recursive: true, force: true });

  return {
    investigated: advisories.length,
    totalVulnerable: vulnerable.length,
    sandboxValidations: MAX_SANDBOX_VALIDATIONS - sandboxBudget,
    advisories,
  };
}

function shapeGhsa(pkgName, a) {
  return {
    ghsaId: a.ghsa_id,
    cveId: a.cve_id,
    severity: a.severity,
    summary: a.summary,
    description: typeof a.description === 'string' ? a.description.slice(0, 2400) : null,
    publishedAt: a.published_at,
    updatedAt: a.updated_at,
    withdrawnAt: a.withdrawn_at ?? null,
    htmlUrl: a.html_url,
    cvss: a.cvss ?? null,
    cwes: a.cwes ?? null,
    references: (a.references ?? []).slice(0, 8).map((r) => r.url ?? r),
    vulnerableVersions: (a.vulnerabilities ?? [])
      .filter((vv) => vv.package?.ecosystem === 'npm' && vv.package?.name === pkgName)
      .map((vv) => ({
        range: vv.vulnerable_version_range,
        patchedVersions: vv.patched_versions ?? null,
        firstPatchedVersion: vv.first_patched_version ?? null,
      })),
  };
}

function computeFixTarget(v, evidence) {
  if (v.fixAvailable && typeof v.fixAvailable === 'object' && v.fixAvailable.version) {
    return {
      target: v.fixAvailable.version,
      pkg: v.fixAvailable.name ?? v.name,
      isMajor: !!v.fixAvailable.isSemVerMajor,
      source: 'npm-audit.fixAvailable',
      command: `npm install ${v.fixAvailable.name ?? v.name}@${v.fixAvailable.version}`,
      note: v.fixAvailable.isSemVerMajor
        ? 'Major version bump — review breaking-change notes before merging.'
        : null,
    };
  }
  if (v.fixAvailable === true && evidence.npmView?.latest) {
    return {
      target: evidence.npmView.latest,
      pkg: v.name,
      isMajor: false,
      source: 'npm-view.latest',
      command: `npm install ${v.name}@${evidence.npmView.latest}`,
      note: 'npm-audit said a fix is available but did not pin a version. Targeting latest dist-tag.',
    };
  }
  const firstPatched = evidence.ghsa
    .flatMap((g) => g.vulnerableVersions.map((vv) => vv.firstPatchedVersion?.identifier))
    .filter(Boolean)
    .sort()
    .pop();
  if (firstPatched) {
    return {
      target: firstPatched,
      pkg: v.name,
      source: 'ghsa.firstPatchedVersion',
      command: `npm install ${v.name}@${firstPatched}`,
      note: 'Derived from GHSA first_patched_version (no audit-suggested fix). Verify the range covers all listed advisories.',
    };
  }
  return {
    target: null,
    source: 'no-fix-found',
    command: null,
    note: 'No fixed version published yet. Watch the GHSA records and consider switching deps if upstream is stalled.',
  };
}

function collectDepPaths(root, pkgName) {
  const r = spawnSync('npm', ['ls', pkgName, '--all', '--json'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024, shell: true,
  });
  // npm ls exits non-zero on extraneous/missing peers but still emits valid JSON.
  const raw = r.stdout || '';
  if (!raw.trim()) return [];
  let tree;
  try { tree = JSON.parse(raw); } catch { return []; }
  const out = new Set();
  walkTree(tree, pkgName, [], out);
  return [...out].slice(0, 25);
}

function walkTree(node, target, path, out) {
  if (!node?.dependencies) return;
  for (const [name, child] of Object.entries(node.dependencies)) {
    const next = [...path, `${name}@${child.version ?? '?'}`];
    if (name === target) out.add(next.join(' > '));
    if (child.dependencies) walkTree(child, target, next, out);
  }
}

function sandboxValidateFix({ root, sandboxRoot, pkgName, target, isDirect }) {
  const sandbox = join(sandboxRoot, sanitizeId(pkgName));
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });

  // Copy package.json + a SANITIZED package-lock.json — no node_modules;
  // --package-lock-only avoids needing it. We strip lock entries with
  // no version field (e.g. an `optional: true` shim with no resolution),
  // which arborist crashes on with "Invalid Version: " during dedupe.
  const beforePkgPath = join(root, 'package.json');
  const beforeLockPath = join(root, 'package-lock.json');
  cpSync(beforePkgPath, join(sandbox, 'package.json'));
  const lockRaw = JSON.parse(readFileSync(beforeLockPath, 'utf8'));
  if (lockRaw.packages) {
    for (const [k, v] of Object.entries(lockRaw.packages)) {
      if (k === '') continue;
      if (v && !v.version && !v.link) delete lockRaw.packages[k];
    }
  }
  writeFileSync(join(sandbox, 'package-lock.json'), JSON.stringify(lockRaw, null, 2) + '\n', 'utf8');

  const beforePkgText = readFileSync(beforePkgPath, 'utf8');
  const sandboxPkg = JSON.parse(beforePkgText);
  const beforeLines = extractRelevantLines(beforePkgText, pkgName);

  if (isDirect) {
    for (const block of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (sandboxPkg[block]?.[pkgName] !== undefined) {
        sandboxPkg[block][pkgName] = `^${target}`;
      }
    }
  } else {
    sandboxPkg.overrides = { ...(sandboxPkg.overrides ?? {}), [pkgName]: target };
  }
  const afterPkgText = JSON.stringify(sandboxPkg, null, 2) + '\n';
  writeFileSync(join(sandbox, 'package.json'), afterPkgText, 'utf8');
  const afterLines = extractRelevantLines(afterPkgText, pkgName);

  // --ignore-scripts: the repo has a postinstall hook that pulls files
  // from outside the sandbox; we don't actually want to run any scripts
  // here, only re-resolve the lock.
  const install = spawnSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund', '--ignore-scripts'], {
    cwd: sandbox, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: NPM_TIMEOUT_MS, shell: true,
  });
  if (install.status !== 0 && install.status !== null) {
    throw new Error(`npm install (sandbox) exit ${install.status}: ${String(install.stderr || install.stdout).slice(0, 200)}`);
  }

  const audit = spawnSync('npm', ['audit', '--json'], {
    cwd: sandbox, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024, shell: true, timeout: NPM_TIMEOUT_MS,
  });
  let postFixAudit = { error: 'no audit output' };
  const auditText = audit.stdout || '';
  if (auditText.trim()) {
    try {
      const j = JSON.parse(auditText);
      postFixAudit = {
        bySeverity: j.metadata?.vulnerabilities ?? {},
        stillPresent: !!j.vulnerabilities?.[pkgName],
        clearedForPkg: !j.vulnerabilities?.[pkgName],
      };
    } catch (e) {
      postFixAudit = { error: msg(e) };
    }
  }

  return {
    postFixAudit,
    beforeAfter: { before: beforeLines, after: afterLines },
  };
}

function extractRelevantLines(pkgText, pkgName) {
  const lines = pkgText.split('\n');
  const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`"${escaped}"\\s*:`);
  return lines.filter((l) => re.test(l)).map((l) => l.trim());
}

function renderAdvisoryReport(v, evidence, proposed) {
  const lines = [];
  lines.push(`# Advisory research — \`${v.name}\``);
  lines.push('');
  lines.push(`- Severity: **${v.severity}**`);
  lines.push(`- Direct dependency: ${v.isDirect ? 'yes' : 'no (transitive)'}`);
  lines.push(`- npm-audit fix available: ${describeFixAvailable(v.fixAvailable)}`);
  lines.push(`- Queried at: ${evidence.queriedAt}`);
  if (evidence.npmView?.latest) lines.push(`- Latest published version: \`${evidence.npmView.latest}\``);
  if (evidence.npmView?.deprecated) lines.push(`- ⚠️ Package marked deprecated: ${evidence.npmView.deprecated}`);
  lines.push('');

  lines.push('## Dependency path');
  if (evidence.depPath.length) {
    for (const p of evidence.depPath.slice(0, 10)) lines.push(`- \`${p}\``);
    if (evidence.depPath.length > 10) lines.push(`- … (+${evidence.depPath.length - 10} more)`);
  } else {
    lines.push('_No paths resolved (npm ls returned no entries for this package)._');
  }
  lines.push('');

  lines.push(`## GitHub Security Advisories (${evidence.ghsa.length})`);
  if (!evidence.ghsa.length) {
    lines.push('_No GHSA records found for this npm package._');
  } else {
    for (const g of evidence.ghsa) {
      lines.push(`### ${g.ghsaId} — ${g.severity?.toUpperCase() ?? '?'} ${g.cveId ? `(${g.cveId})` : ''}`);
      if (g.summary) lines.push(`> ${g.summary}`);
      if (g.publishedAt) lines.push(`- Published: ${g.publishedAt}`);
      if (g.withdrawnAt) lines.push(`- ⚠️ Withdrawn: ${g.withdrawnAt}`);
      for (const vv of g.vulnerableVersions) {
        const patched = vv.firstPatchedVersion?.identifier ?? vv.patchedVersions ?? '(none)';
        lines.push(`- Range: \`${vv.range}\` → patched: \`${patched}\``);
      }
      if (g.cvss?.score) lines.push(`- CVSS: ${g.cvss.score} (${g.cvss.vector_string ?? 'no vector'})`);
      if (g.cwes?.length) lines.push(`- CWE: ${g.cwes.map((c) => c.cwe_id).join(', ')}`);
      lines.push(`- Link: ${g.htmlUrl}`);
      lines.push('');
    }
  }

  lines.push(`## OSV.dev cross-check (${evidence.osv.length})`);
  if (!evidence.osv.length) {
    lines.push('_No OSV records found._');
  } else {
    for (const o of evidence.osv) {
      lines.push(`- \`${o.id}\` — ${o.summary ?? '(no summary)'} ${o.aliases?.length ? `[${o.aliases.join(', ')}]` : ''}`);
    }
  }
  lines.push('');

  lines.push('## Proposed fix');
  lines.push(`See \`proposed-fix.md\` for the before/after diff and sandbox validation.`);
  if (proposed.target) {
    lines.push(`Target: \`${proposed.pkg}@${proposed.target}\` (source: ${proposed.source})`);
  } else {
    lines.push(`No fix target derivable. ${proposed.note ?? ''}`);
  }
  lines.push('');

  if (evidence.errors.length) {
    lines.push('## Investigation errors');
    for (const e of evidence.errors) lines.push(`- ${e}`);
  }
  return lines.join('\n') + '\n';
}

function renderProposedFix(v, evidence, proposed) {
  const lines = [];
  lines.push(`# Proposed fix — \`${v.name}\``);
  lines.push('');
  lines.push(`- Severity addressed: **${v.severity}**`);
  lines.push(`- Strategy source: ${proposed.source}`);
  if (proposed.note) lines.push(`- Note: ${proposed.note}`);
  lines.push('');

  if (!proposed.target) {
    lines.push('## No automated fix proposed');
    lines.push('');
    lines.push(proposed.note ?? 'npm-audit reports no fix and no first_patched_version is published.');
    return lines.join('\n') + '\n';
  }

  lines.push('## Change');
  if (proposed.beforeAfter) {
    lines.push('```diff');
    for (const l of proposed.beforeAfter.before) lines.push(`- ${l}`);
    for (const l of proposed.beforeAfter.after) lines.push(`+ ${l}`);
    if (!v.isDirect && !proposed.beforeAfter.before.length) {
      lines.push(`+ "overrides": { "${v.name}": "${proposed.target}" }`);
    }
    lines.push('```');
  } else {
    lines.push(`Bump \`${v.name}\` to \`${proposed.target}\` (sandbox validation unavailable).`);
  }
  lines.push('');

  lines.push('## Apply');
  lines.push('```bash');
  lines.push(proposed.command ?? `npm install ${v.name}@${proposed.target}`);
  lines.push('```');
  if (!v.isDirect) {
    lines.push('');
    lines.push('_Transitive dep — the sandbox used an `overrides` block in `package.json`. ' +
      'You may prefer to wait for the parent package to bump its pin instead._');
  }
  lines.push('');

  lines.push('## Sandbox validation');
  if (proposed.sandboxValidated && proposed.postFixAudit) {
    const sev = proposed.postFixAudit.bySeverity ?? {};
    lines.push(`Ran \`npm install --package-lock-only\` + \`npm audit --json\` in an isolated temp dir.`);
    lines.push('');
    lines.push(`- Post-fix audit: critical=${sev.critical ?? 0} high=${sev.high ?? 0} ` +
      `moderate=${sev.moderate ?? 0} low=${sev.low ?? 0}`);
    lines.push(`- This advisory cleared for \`${v.name}\`: ${proposed.postFixAudit.clearedForPkg ? '✅ yes' : '❌ no'}`);
    if (!proposed.postFixAudit.clearedForPkg) {
      lines.push('');
      lines.push('⚠️ The proposed bump did **not** remove this advisory in the sandbox. ' +
        'Possible causes: another path still resolves to a vulnerable version, the override was ' +
        'shadowed, or a deeper transitive needs its own bump.');
    }
  } else if (proposed.sandboxSkipped) {
    lines.push(`Skipped: ${proposed.sandboxSkipped} (limit ${MAX_SANDBOX_VALIDATIONS} validations per run).`);
  } else if (proposed.sandboxError) {
    lines.push(`Failed: ${proposed.sandboxError}`);
  } else {
    lines.push('Not run.');
  }
  lines.push('');
  lines.push('## Merge gate');
  lines.push('This is a **proposed** patch only. Per the Vigil autonomy policy, auto-fixes go through:');
  lines.push('1. Draft PR (human-authored or generated)');
  lines.push('2. CI on the draft PR (full test suite)');
  lines.push('3. Human approval before merge + deploy');
  return lines.join('\n') + '\n';
}

function describeFixAvailable(fix) {
  if (fix === false || fix == null) return 'no';
  if (fix === true) return 'yes (unpinned)';
  if (typeof fix === 'object') {
    return `yes → \`${fix.name ?? '?'}@${fix.version ?? '?'}\`${fix.isSemVerMajor ? ' (semver major)' : ''}`;
  }
  return 'yes';
}

function ghAdvisoriesForNpm(name) {
  return httpsJson({
    hostname: 'api.github.com',
    path: `/advisories?ecosystem=npm&affects=${encodeURIComponent(name)}&per_page=20`,
    headers: ghHeaders(),
  });
}

function osvQuery(name) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ package: { ecosystem: 'npm', name } });
    const req = request({
      hostname: 'api.osv.dev',
      path: '/v1/query',
      method: 'POST',
      headers: {
        'User-Agent': 'vigil-security-analysis (+https://erosolar-1b0db.web.app)',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`osv http ${res.statusCode}: ${text.slice(0, 200)}`));
        try {
          const parsed = JSON.parse(text);
          resolve((parsed.vulns ?? []).map((v) => ({
            id: v.id,
            summary: v.summary,
            aliases: v.aliases ?? [],
            modified: v.modified,
            published: v.published,
            severity: (v.severity ?? []).map((s) => s.score).filter(Boolean),
          })));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

function httpsJson({ hostname, path, headers }) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname, path, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
        } else if (res.statusCode === 403 || res.statusCode === 429) {
          reject(new Error(`rate-limited: ${res.statusCode}`));
        } else {
          reject(new Error(`http ${res.statusCode}: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function ghHeaders() {
  const h = {
    'User-Agent': 'vigil-security-analysis (+https://erosolar-1b0db.web.app)',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env['GITHUB_TOKEN']) h['Authorization'] = `Bearer ${process.env['GITHUB_TOKEN']}`;
  return h;
}

function sanitizeId(s) {
  return s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
}

function msg(e) { return String(e?.message ?? e).slice(0, 240); }
