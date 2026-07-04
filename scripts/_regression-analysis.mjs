#!/usr/bin/env node
// _regression-analysis.mjs - local regression-risk analysis for Vigil.
//
// The script inventories git changes, maps them to runtime surfaces, selects
// focused validation commands, and can optionally execute those checks. It is
// intentionally defensive and local: no network calls, no external probing.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_READ_BYTES = 1024 * 1024;

const args = parseArgs(process.argv.slice(2));
const root = resolve(String(args.root ?? process.cwd()));
const generatedAt = new Date().toISOString();
const outDir = args.out
  ? resolve(String(args.out))
  : join(root, 'security-analysis', `regression-analysis-${safeTs(generatedAt)}`);
const base = String(args.base ?? detectDefaultBase(root) ?? 'HEAD~1');
const head = String(args.head ?? 'HEAD');
const shouldRun = Boolean(args.run);
const shouldWrite = !args['no-write'];
const timeoutMs = Number(args['max-command-ms'] ?? DEFAULT_TIMEOUT_MS);

const changedFiles = collectChangedFiles({ root, base, head });
const packageMap = collectPackageManifests(root);
const surfaces = summarizeSurfaces(changedFiles);
const variantLinks = collectVariantLinks(root, changedFiles);
const recommendedChecks = recommendChecks({ root, changedFiles, packageMap, base, head });
const executedChecks = shouldRun
  ? runChecks({ root, checks: recommendedChecks.filter((check) => check.runnable !== false), timeoutMs })
  : [];

const report = {
  schemaVersion: 'vigil.regression-analysis.v1',
  generatedAt,
  root,
  base,
  head,
  mode: shouldRun ? 'analysis-and-execution' : 'analysis-only',
  summary: {
    changedFileCount: changedFiles.length,
    highRiskSurfaceCount: surfaces.filter((surface) => surface.risk === 'high').length,
    recommendedCheckCount: recommendedChecks.length,
    executedCheckCount: executedChecks.length,
    failedExecutedCheckCount: executedChecks.filter((check) => check.exitCode !== 0).length,
    cveOrAdvisoryReferenceCount: variantLinks.references.length,
  },
  changedFiles,
  surfaces,
  variantLinks,
  recommendedChecks,
  executedChecks,
  residualRisk: buildResidualRisk({ changedFiles, surfaces, recommendedChecks, executedChecks, shouldRun }),
};

if (shouldWrite) {
  mkdirSync(outDir, { recursive: true });
  report.output = outDir;
  writeFileSync(join(outDir, 'regression-analysis.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, 'regression-analysis.md'), renderMarkdown(report));
}

if (args.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(renderMarkdown(report));
}

if (executedChecks.some((check) => check.exitCode !== 0)) {
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) {
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 0) {
      parsed[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function safeTs(value) {
  return value.replace(/[:.]/g, '-');
}

function git(rootDir, gitArgs, options = {}) {
  return spawnSync('git', gitArgs, {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function detectDefaultBase(rootDir) {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master', 'HEAD~1']) {
    const res = git(rootDir, ['rev-parse', '--verify', ref], { maxBuffer: 1024 * 1024 });
    if (res.status === 0) {
      return ref;
    }
  }
  return null;
}

function collectChangedFiles({ root: rootDir, base: baseRef, head: headRef }) {
  const byPath = new Map();
  const range = baseRef ? `${baseRef}...${headRef}` : headRef;
  const diff = git(rootDir, ['diff', '--name-status', range]);
  if (diff.status === 0) {
    parseNameStatus(diff.stdout, 'baseline').forEach((entry) => upsertChange(byPath, entry));
  }

  const status = git(rootDir, ['status', '--porcelain=v1']);
  if (status.status === 0) {
    parsePorcelain(status.stdout).forEach((entry) => upsertChange(byPath, entry));
  }

  return Array.from(byPath.values())
    .map((entry) => ({
      ...entry,
      risk: classifyFileRisk(entry.path),
      surface: classifySurface(entry.path),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function parseNameStatus(stdout, source) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const status = parts[0] ?? 'M';
      const path = parts.length > 2 ? parts[2] : parts[1];
      return path ? { path, status, sources: [source] } : null;
    })
    .filter(Boolean);
}

function parsePorcelain(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || 'M';
      const rawPath = line.slice(3);
      const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;
      return path ? { path, status, sources: ['worktree'] } : null;
    })
    .filter(Boolean);
}

function upsertChange(map, entry) {
  const existing = map.get(entry.path);
  if (!existing) {
    map.set(entry.path, entry);
    return;
  }
  existing.status = mergeStatus(existing.status, entry.status);
  existing.sources = Array.from(new Set([...existing.sources, ...entry.sources]));
}

function mergeStatus(left, right) {
  if (left === right) return left;
  return `${left}+${right}`;
}

function collectPackageManifests(rootDir) {
  const manifests = new Map();
  for (const rel of ['package.json', 'site/vigil-web/package.json', 'aws/lambda/package.json']) {
    const file = join(rootDir, rel);
    if (!existsSync(file)) {
      continue;
    }
    try {
      manifests.set(rel, JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      manifests.set(rel, null);
    }
  }
  return manifests;
}

function classifySurface(path) {
  if (path === 'src/config.ts' || path.startsWith('src/bin/') || path.startsWith('src/headless/') || path.startsWith('src/runtime/') || path.startsWith('src/shell/')) {
    return 'cli-runtime';
  }
  if (path.startsWith('src/contracts/') || path.startsWith('agents/')) {
    return 'profile-contracts';
  }
  if (path.startsWith('src/plugins/') || path.startsWith('src/capabilities/')) {
    return 'tooling-and-mcp';
  }
  if (path.startsWith('scripts/')) {
    return 'automation-scripts';
  }
  if (
    path.startsWith('site/vigil-web/public/security/') ||
    path === 'site/vigil-web/public/health.json' ||
    path === 'site/vigil-web/public/status.json'
  ) {
    return 'generated-site-data';
  }
  if (path.startsWith('site/vigil-web/')) {
    return 'website';
  }
  if (path.startsWith('aws/') || path.includes('firebase') || path.includes('cloud')) {
    return 'cloud-api';
  }
  if (path.startsWith('test/') || /\.test\.[cm]?[jt]sx?$/.test(path)) {
    return 'tests';
  }
  if (path.endsWith('.md')) {
    return 'documentation';
  }
  if (path === 'package.json' || path.endsWith('/package.json') || path.endsWith('package-lock.json')) {
    return 'dependency-manifest';
  }
  return 'general';
}

function classifyFileRisk(path) {
  const surface = classifySurface(path);
  if (['cli-runtime', 'profile-contracts', 'tooling-and-mcp', 'cloud-api'].includes(surface)) {
    return 'high';
  }
  if (['automation-scripts', 'website', 'dependency-manifest'].includes(surface)) {
    return 'medium';
  }
  return 'low';
}

function summarizeSurfaces(changed) {
  const bySurface = new Map();
  for (const file of changed) {
    const current = bySurface.get(file.surface) ?? {
      surface: file.surface,
      files: [],
      risk: 'low',
      rationale: surfaceRationale(file.surface),
    };
    current.files.push(file.path);
    current.risk = maxRisk(current.risk, file.risk);
    bySurface.set(file.surface, current);
  }
  return Array.from(bySurface.values()).sort((a, b) => riskRank(b.risk) - riskRank(a.risk));
}

function surfaceRationale(surface) {
  const rationales = {
    'cli-runtime': 'Affects terminal launch, prompt routing, profile resolution, or agent execution.',
    'profile-contracts': 'Affects system prompt, rulebook, schema, or mode/profile behavior.',
    'tooling-and-mcp': 'Affects tool exposure, MCP mounting, or capability integration.',
    'automation-scripts': 'Affects repo automation or security-analysis pipelines.',
    'website': 'Affects published site UI/data behavior.',
    'generated-site-data': 'Affects generated public status or report data, usually lower risk than source changes.',
    'cloud-api': 'Affects deployed cloud or API behavior.',
    'tests': 'Affects test coverage or fixtures.',
    'documentation': 'Affects operator-facing instructions.',
    'dependency-manifest': 'Affects install, package, or dependency graph behavior.',
    'general': 'General source or config change.',
  };
  return rationales[surface] ?? rationales.general;
}

function maxRisk(left, right) {
  return riskRank(right) > riskRank(left) ? right : left;
}

function riskRank(risk) {
  return { low: 1, medium: 2, high: 3 }[risk] ?? 0;
}

function collectVariantLinks(rootDir, changed) {
  const references = new Set();
  let variantSurfaceTouched = false;
  for (const file of changed) {
    if (/variant|patchpivot|cve|advisory/i.test(file.path)) {
      variantSurfaceTouched = true;
    }
    const abs = join(rootDir, file.path);
    if (!existsSync(abs)) {
      continue;
    }
    try {
      const stats = statSync(abs);
      if (!stats.isFile() || stats.size > MAX_READ_BYTES) {
        continue;
      }
      const text = readFileSync(abs, 'utf8');
      for (const match of text.matchAll(/\b(CVE-\d{4}-\d{4,7}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\b/gi)) {
        references.add(match[1].toUpperCase());
      }
    } catch {
      // Ignore unreadable/generated files.
    }
  }
  return {
    variantSurfaceTouched,
    references: Array.from(references).sort(),
    recommendation: references.size || variantSurfaceTouched
      ? 'Run variant analysis for touched CVE/advisory surfaces and link any confirmed variant to regression tests.'
      : 'No explicit CVE/advisory references detected in changed files.',
  };
}

function recommendChecks({ root: rootDir, changedFiles: changed, packageMap, base: baseRef, head: headRef }) {
  const checks = [];
  const paths = changed.map((file) => file.path);
  const hasRootPackage = packageMap.has('package.json');
  const hasSitePackage = packageMap.has('site/vigil-web/package.json');
  const hasAwsPackage = packageMap.has('aws/lambda/package.json');

  addCheck(checks, {
    id: 'manifest-json-parse',
    command: 'node -e "JSON.parse(require(\'fs\').readFileSync(\'src/contracts/agent-schemas.json\',\'utf8\')); JSON.parse(require(\'fs\').readFileSync(\'package.json\',\'utf8\'));"',
    rationale: 'Validate the profile manifest and package metadata parse cleanly.',
    surfaces: ['profile-contracts', 'dependency-manifest'],
    runnable: true,
  });

  if (hasRootPackage) {
    addCheck(checks, {
      id: 'root-build',
      command: 'npm run build',
      rationale: 'Compile TypeScript and package bundled runtime files.',
      surfaces: ['cli-runtime', 'profile-contracts', 'tooling-and-mcp', 'automation-scripts'],
      runnable: true,
    });
  }

  if (paths.some((path) => path.startsWith('src/') || path.startsWith('test/') || path.startsWith('agents/'))) {
    addCheck(checks, {
      id: 'root-tests',
      command: 'npm test -- --runInBand',
      rationale: 'Exercise profile/schema/runtime integration and existing Jest coverage.',
      surfaces: ['cli-runtime', 'profile-contracts', 'tooling-and-mcp', 'tests'],
      runnable: hasRootPackage,
    });
  }

  const changedScripts = paths.filter((path) => /^scripts\/.*\.(mjs|cjs|js)$/.test(path));
  if (changedScripts.length) {
    addCheck(checks, {
      id: 'changed-script-syntax',
      command: changedScripts.map((path) => `node -c ${shellQuote(path)}`).join(' && '),
      rationale: 'Syntax-check changed Node automation scripts.',
      surfaces: ['automation-scripts'],
      runnable: true,
    });
  }

  if (paths.some((path) =>
    path.startsWith('site/vigil-web/src/') ||
    path.startsWith('site/vigil-web/public/threats/') ||
    path === 'site/vigil-web/package.json' ||
    path === 'site/vigil-web/vite.config.ts' ||
    path === 'site/vigil-web/index.html'
  )) {
    addCheck(checks, {
      id: 'site-build',
      command: 'npm --prefix site/vigil-web run build',
      rationale: 'Validate website bundle output for touched site files.',
      surfaces: ['website'],
      runnable: hasSitePackage,
    });
  }

  if (paths.some((path) => path.startsWith('aws/lambda/'))) {
    addCheck(checks, {
      id: 'aws-lambda-test',
      command: hasAwsPackage && packageMap.get('aws/lambda/package.json')?.scripts?.test
        ? 'npm --prefix aws/lambda test'
        : 'node -c aws/lambda/src/handlers.js',
      rationale: 'Validate Lambda handler syntax or package tests.',
      surfaces: ['cloud-api'],
      runnable: true,
    });
  }

  addCheck(checks, {
    id: 'regression-report',
    command: `npm run regression:analysis -- --base ${shellQuote(baseRef)} --head ${shellQuote(headRef)} --no-write --json`,
    rationale: 'Re-run this analysis after final edits to refresh the changed-file and check-selection map.',
    surfaces: ['general'],
    runnable: hasRootPackage,
  });

  return checks;
}

function addCheck(checks, check) {
  if (checks.some((existing) => existing.id === check.id)) {
    return;
  }
  checks.push(check);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function runChecks({ root: rootDir, checks, timeoutMs: timeout }) {
  const results = [];
  for (const check of checks) {
    const startedAt = new Date().toISOString();
    const res = spawnSync(check.command, [], {
      cwd: rootDir,
      shell: true,
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    results.push({
      id: check.id,
      command: check.command,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: res.status ?? (res.signal ? 1 : 0),
      signal: res.signal ?? null,
      timedOut: res.error?.code === 'ETIMEDOUT',
      stdoutTail: tail(res.stdout),
      stderrTail: tail(res.stderr),
    });
  }
  return results;
}

function tail(value, max = 4000) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(-max) : text;
}

function buildResidualRisk({ changedFiles, surfaces, recommendedChecks, executedChecks, shouldRun: ran }) {
  const risks = [];
  if (!changedFiles.length) {
    risks.push('No changed files detected; regression scope may need an explicit --base/--head range.');
  }
  if (!ran) {
    risks.push('Checks were selected but not executed; run with --run or execute the recommended commands before release.');
  }
  const failed = executedChecks.filter((check) => check.exitCode !== 0);
  if (failed.length) {
    risks.push(`${failed.length} executed check(s) failed; fix or explicitly waive before release.`);
  }
  const high = surfaces.filter((surface) => surface.risk === 'high');
  if (high.length && !recommendedChecks.some((check) => check.id === 'root-tests')) {
    risks.push('High-risk surfaces changed without a full test-suite recommendation; add targeted tests before release.');
  }
  return risks;
}

function renderMarkdown(data) {
  const lines = [];
  lines.push('# Vigil Regression Analysis');
  lines.push('');
  lines.push(`Generated: ${data.generatedAt}`);
  lines.push(`Baseline: ${data.base}`);
  lines.push(`Head: ${data.head}`);
  lines.push(`Mode: ${data.mode}`);
  if (data.output) {
    lines.push(`Output: ${relative(data.root, data.output) || data.output}`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push(`- Changed files: ${data.summary.changedFileCount}`);
  lines.push(`- High-risk surfaces: ${data.summary.highRiskSurfaceCount}`);
  lines.push(`- Recommended checks: ${data.summary.recommendedCheckCount}`);
  lines.push(`- Executed checks: ${data.summary.executedCheckCount}`);
  lines.push(`- Failed executed checks: ${data.summary.failedExecutedCheckCount}`);
  lines.push(`- CVE/GHSA references: ${data.summary.cveOrAdvisoryReferenceCount}`);
  lines.push('');
  lines.push('## Changed Files');
  if (!data.changedFiles.length) {
    lines.push('- None detected.');
  } else {
    for (const file of data.changedFiles) {
      lines.push(`- ${file.path} (${file.status}; ${file.surface}; ${file.risk}; ${file.sources.join('+')})`);
    }
  }
  lines.push('');
  lines.push('## Surface Risk');
  if (!data.surfaces.length) {
    lines.push('- No surfaces mapped.');
  } else {
    for (const surface of data.surfaces) {
      lines.push(`- ${surface.surface}: ${surface.risk} (${surface.files.length} file(s)) - ${surface.rationale}`);
    }
  }
  lines.push('');
  lines.push('## Variant Linkage');
  lines.push(`- Variant surface touched: ${data.variantLinks.variantSurfaceTouched ? 'yes' : 'no'}`);
  lines.push(`- References: ${data.variantLinks.references.length ? data.variantLinks.references.join(', ') : 'none'}`);
  lines.push(`- Recommendation: ${data.variantLinks.recommendation}`);
  lines.push('');
  lines.push('## Recommended Checks');
  for (const check of data.recommendedChecks) {
    lines.push(`- ${check.id}: \`${check.command}\``);
    lines.push(`  Rationale: ${check.rationale}`);
  }
  if (!data.recommendedChecks.length) {
    lines.push('- None.');
  }
  lines.push('');
  lines.push('## Executed Checks');
  if (!data.executedChecks.length) {
    lines.push('- Not executed in analysis-only mode.');
  } else {
    for (const check of data.executedChecks) {
      lines.push(`- ${check.id}: exit ${check.exitCode}${check.timedOut ? ' (timeout)' : ''}`);
    }
  }
  lines.push('');
  lines.push('## Residual Risk');
  if (!data.residualRisk.length) {
    lines.push('- No residual risks identified by the analyzer.');
  } else {
    for (const risk of data.residualRisk) {
      lines.push(`- ${risk}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}
