// MCP Server & Script Integration Tests
// Validates all 7 MCP server configs, script syntax, and CLI commands.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let ROOT = process.cwd();
if (!existsSync(join(ROOT, 'package.json'))) {
  ROOT = join(ROOT, '..');
}
if (!existsSync(join(ROOT, 'package.json'))) {
  ROOT = join(ROOT, '..');
}
const TIMEOUT = 10000;

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT, ...opts });
  } catch { return ''; }
}

function spawn(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT, ...opts });
}

// ── MCP Server Syntax Validation ──
const MCP_SERVERS = [
  'scripts/kali-tools-mcp.mjs',
  'scripts/network-defense-mcp.mjs',
  'scripts/threat-feed-mcp.mjs',
  'scripts/endpoint-defense-mcp.mjs',
  'scripts/ghidra-mcp-server.mjs',
  'scripts/cloud-security-mcp.mjs',
  'scripts/api-security-mcp.mjs',
];

describe('MCP Servers — Syntax & Authorization', () => {
  for (const server of MCP_SERVERS) {
    const path = join(ROOT, server);

    test(`${server} — file exists`, () => {
      expect(existsSync(path)).toBe(true);
    });

    test(`${server} — valid syntax`, () => {
      const r = spawn('node', ['-c', path]);
      expect(r.status).toBe(0);
    });

    test(`${server} — rejects unauthorized invocation`, () => {
      const r = spawn('node', [path, '--help'], {
        env: { ...process.env, VIGIL_SESSION_TOKEN: '' },
      });
      // Should exit with code 1 or print error about missing token
      const stderr = (r.stderr || '').toString();
      const stdout = (r.stdout || '').toString();
      const hasAuthError =
        r.status === 1 ||
        stderr.includes('VIGIL_SESSION_TOKEN') ||
        stdout.includes('VIGIL_SESSION_TOKEN');
      expect(hasAuthError).toBe(true);
    });

    test(`${server} — contains runnable export`, () => {
      const content = readFileSync(path, 'utf8');
      expect(content).toContain('StdioServerTransport');
      expect(content).toContain('server.connect');
      expect(content).toContain('#!/usr/bin/env node');
    });
  }
});

// ── MCP Configuration ──
describe('MCP Configuration', () => {
  const configPath = join(ROOT, '.vigil', 'mcp.json');
  const examplePath = join(ROOT, 'mcp.json.example');

  test('MCP config exists and is valid', () => {
    const configSource = existsSync(configPath) ? configPath : examplePath;
    expect(existsSync(configSource)).toBe(true);
    const config = JSON.parse(readFileSync(configSource, 'utf8'));
    expect(config.mcpServers).toBeDefined();
    const servers = Object.keys(config.mcpServers);
    expect(servers).toContain('ghidra');
    expect(servers).toContain('kali-tools');
    expect(servers).toContain('network-defense');
    expect(servers).toContain('threat-feed');
    expect(servers).toContain('endpoint-defense');
    expect(servers).toContain('cloud-security');
    expect(servers).toContain('api-security');
  });

  test('mcp.json.example matches format', () => {
    expect(existsSync(examplePath)).toBe(true);
    const example = JSON.parse(readFileSync(examplePath, 'utf8'));
    expect(example.mcpServers).toBeDefined();
  });
});

// ── Agent Profile Validation ──
describe('Agent Profiles', () => {
  test('agent-schemas.json is valid and uses one unified default profile', () => {
    const path = join(ROOT, 'src', 'contracts', 'agent-schemas.json');
    expect(existsSync(path)).toBe(true);
    const schema = JSON.parse(readFileSync(path, 'utf8'));
    const profiles = schema.profiles || [];
    const names = profiles.map(p => p.name);
    expect(names).toEqual(['vigil-code']);

    // The single default profile should contain the former CNE and OSINT surfaces.
    const profile = profiles.find(p => p.name === 'vigil-code');
    expect(profile).toBeDefined();
    expect(profile.metadata?.aliases).toContain('vigil-cne');
    expect(profile.metadata?.aliases).toContain('tailored-tornado');
    const prompt = profile.systemPrompt?.template || '';
    expect(prompt).toContain('Metasploit');
    expect(prompt).toContain('Ghidra');
    expect(prompt).toContain('sqlmap');
    expect(prompt).toContain('CVE');
    expect(prompt).toContain('OSINT');
    expect(prompt).toContain('regression analysis');
    expect(prompt).toContain('variant analysis');
  });
});

// ── Package.json Validation ──
describe('package.json — Scripts & Files', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  test('includes all MCP server scripts in files array', () => {
    const files = pkg.files || [];
    expect(files).toContain('scripts/kali-tools-mcp.mjs');
    expect(files).toContain('scripts/_regression-analysis.mjs');
    expect(files).toContain('scripts/network-defense-mcp.mjs');
    expect(files).toContain('scripts/threat-feed-mcp.mjs');
    expect(files).toContain('scripts/endpoint-defense-mcp.mjs');
    expect(files).toContain('scripts/ghidra-mcp-server.mjs');
    expect(files).toContain('scripts/cloud-security-mcp.mjs');
    expect(files).toContain('scripts/api-security-mcp.mjs');
    expect(files).toContain('scripts/vigil-autofix.mjs');
    expect(files).toContain('scripts/vigil-daemon.mjs');
    expect(files).toContain('scripts/install-vigil.sh');
  });

  test('has all required npm scripts', () => {
    const scripts = Object.keys(pkg.scripts || {});
    expect(scripts).toContain('autofix');
    expect(scripts).toContain('autofix:apply');
    expect(scripts).toContain('daemon');
    expect(scripts).toContain('regression:analysis');
    expect(scripts).toContain('kali:mcp');
    expect(scripts).toContain('netdef:mcp');
    expect(scripts).toContain('threatfeed:mcp');
    expect(scripts).toContain('endpoint:mcp');
    expect(scripts).toContain('cloud:mcp');
    expect(scripts).toContain('api:mcp');
    expect(scripts).toContain('docker:build');
    expect(scripts).toContain('install:universal');
  });

  test('keywords include cne and related terms', () => {
    const kw = pkg.keywords || [];
    expect(kw).toContain('cne');
    expect(kw).toContain('computer-network-attack');
    expect(kw).toContain('offensive-cyber');
    expect(kw).toContain('red-team');
    expect(kw).toContain('vulnerability-assessment');
  });
});

// ── Dockerfile Validation ──
describe('Dockerfile', () => {
  test('exists and is well-formed', () => {
    const path = join(ROOT, 'Dockerfile');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('FROM kalilinux/kali-rolling');
    expect(content).toContain('GHIDRA_INSTALL_DIR');
    expect(content).toContain('@trenchwork/vigil');
    expect(content).toContain('ENTRYPOINT ["vigil"]');
    expect(content).toContain('HEALTHCHECK');
    expect(content).toContain('LABEL');
  });
});

// ── GitHub Actions Workflow ──
describe('GitHub Actions', () => {
  test('vigil-scan.yml exists and is valid', () => {
    const path = join(ROOT, '.github', 'workflows', 'vigil-scan.yml');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('name: Vigil CNE Security Scan');
    expect(content).toContain('comprehensive-findings');
    expect(content).toContain('upload-artifact');
    expect(content).toContain('gh issue create');
  });
});

// ── Autofix & Daemon Scripts ──
describe('Autofix & Daemon', () => {
  test('vigil-autofix.mjs — valid syntax', () => {
    const r = spawn('node', ['-c', join(ROOT, 'scripts/vigil-autofix.mjs')]);
    expect(r.status).toBe(0);
  });

  test('vigil-daemon.mjs — valid syntax', () => {
    const r = spawn('node', ['-c', join(ROOT, 'scripts/vigil-daemon.mjs')]);
    expect(r.status).toBe(0);
  });

  test('vigil-sse-server.mjs — valid syntax', () => {
    const r = spawn('node', ['-c', join(ROOT, 'scripts/vigil-sse-server.mjs')]);
    expect(r.status).toBe(0);
  });

  test('autofix dry-run completes without error', () => {
    const r = spawn('node', [join(ROOT, 'scripts/vigil-autofix.mjs'), '--dry-run'], { timeout: 60000 });
    expect(r.status).toBe(0);
    const stdout = r.stdout?.toString() || '';
    expect(stdout).toContain('Complete');
    expect(stdout).toContain('found');
  });

  test('install-vigil.sh is executable and valid', () => {
    const path = join(ROOT, 'scripts/install-vigil.sh');
    if (!existsSync(path)) {
      console.warn('install-vigil.sh not found — skipping');
      return;
    }
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('#!/usr/bin/env bash');
    expect(content).toContain('Vigil');
    expect(content).toContain('npm install');
  });
});

// ── Security Page Static Assets ──
describe('Security Page — Static Assets', () => {
  const publicDir = join(ROOT, 'site', 'vigil-web', 'public', 'security');

  test('latest.json exists and is valid JSON', () => {
    const path = join(publicDir, 'latest.json');
    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(data.findings).toBeDefined();
    expect(data.findings.passes).toBeDefined();
  });

  test('vulnerabilities.json exists and is valid array', () => {
    const path = join(publicDir, 'vulnerabilities.json');
    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });
});

// ── Comprehensive Scanner Timeout Hardening ──
describe('safeText — Timeout & SIGKILL Guards', () => {
  test('_comprehensive-vuln-scan.mjs has killSignal in execSync/spawnSync', () => {
    const path = join(ROOT, 'scripts', '_comprehensive-vuln-scan.mjs');
    const content = readFileSync(path, 'utf8');
    // All execSync/spawnSync calls should have killSignal: 'SIGKILL'
    const execCalls = content.match(/execSync\(/g) || [];
    const killSignals = content.match(/killSignal:\s*['"]SIGKILL['"]/g) || [];
    // At minimum the safeText, safePS, safeWsl, haveExe wrappers should have it
    expect(killSignals.length).toBeGreaterThanOrEqual(4);
  });

  test('_vigil-comprehensive.mjs has killSignal guard', () => {
    const path = join(ROOT, 'scripts', '_vigil-comprehensive.mjs');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain("killSignal: 'SIGKILL'");
  });
});
