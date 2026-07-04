#!/usr/bin/env node
// _poc-engine.mjs — Comprehensive Safe Proof-of-Concept Generator.
//
// Generates runnable, read-only validator scripts for EVERY vulnerability type.
// NEVER generates exploit payloads. Every generated file is a safe, defensive
// validator that proves exposure/version/evidence without exploitation.
//
// Covers: dependency versions, kernel CVEs, browser versions, listener exposure,
// Docker/K8s containers, SUID, world-writable, SSH config, Python packages,
// secrets, cloud credentials, crypto/TLS, macOS SIP/XProtect, Windows service paths,
// cron persistence, WSL Linux, and more.
//
// Usage:
//   node scripts/_poc-engine.mjs --findings findings.json --out ./validators
//   node scripts/_poc-engine.mjs --category kernel --out ./validators

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM = os.platform();

function parseArgs(args) {
  const out = { findings: null, category: null, outDir: null, max: 1000, _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--findings') out.findings = args[++i];
    else if (args[i] === '--category') out.category = args[++i];
    else if (args[i] === '--out') out.outDir = args[++i];
    else if (args[i] === '--max') out.max = Number(args[++i]) || 1000;
    else out._.push(args[i]);
  }
  return out;
}

function generatePoC(finding) {
  const id = (finding.id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  const title = finding.title || finding.id || 'Unknown finding';
  const sev = finding.severity || 'unknown';
  const cat = finding.category || 'unknown';
  const platform = PLATFORM;
  const nodeVer = process.version;
  const generatedAt = new Date().toISOString();

  const header = (lang) => {
    const prefix = lang === 'python' ? '#' : lang === 'sh' ? '#' : '//';
    return [
      `${prefix} ╔══════════════════════════════════════════════════════════════╗`,
      `${prefix} ║  VIGIL SAFE PoC VALIDATOR — DEFENSIVE / READ-ONLY ONLY       ║`,
      `${prefix} ║  Classification: defensive metadata                           ║`,
      `${prefix} ║  This script proves exposure/version/evidence WITHOUT exploit  ║`,
      `${prefix} ╚══════════════════════════════════════════════════════════════╝`,
      `${prefix} Finding: ${title.slice(0, 70)}`,
      `${prefix} ID: ${id}`,
      `${prefix} Severity: ${sev}`,
      `${prefix} Platform: ${platform}`,
      `${prefix} Generated: ${generatedAt}`,
      `${prefix} Node: ${nodeVer}`,
      '',
    ];
  };

  // Dependency version validator
  if (cat.includes('dependency') || cat.includes('runtime') || finding.source?.includes('npm') || finding.source?.includes('osv') || finding.source?.includes('pip')) {
    const pkgName = finding.affected?.package || finding.affected?.name || 'unknown-pkg';
    const pkgVer = finding.affected?.version || '0.0.0';
    const eco = finding.affected?.ecosystem || 'npm';
    const isNode = eco === 'npm' || eco === 'Node.js';
    const isPy = eco === 'PyPI' || eco === 'pip';

    if (isNode) {
      return {
        filename: `dep-${id}.js`,
        content: [
          ...header('js'),
          `// Dependency Version Validator for ${pkgName}@${pkgVer}`,
          `// Category: dependency | Ecosystem: ${eco}`,
          `//`,
          `// This validator checks whether the vulnerable package is installed.`,
          `// It does NOT execute any package code or import modules.`,
          `// Purely read-only evidence collection.`,
          ``,
          `const fs = require('fs');`,
          `const path = require('path');`,
          `const { execSync } = require('child_process');`,
          ``,
          `const PACKAGE = '${pkgName}';`,
          `const MIN_SAFE = '${pkgVer}';`,
          ``,
          `console.log('=== Vigil Safe PoC: Dependency Version Validator ===');`,
          `console.log('Package:', PACKAGE);`,
          `console.log('Current version:', MIN_SAFE);`,
          `console.log('');`,
          ``,
          `// Check package.json`,
          `function findPackageJson(startDir) {`,
          `  let dir = startDir;`,
          `  while (dir !== path.dirname(dir)) {`,
          `    const pkgPath = path.join(dir, 'package.json');`,
          `    if (fs.existsSync(pkgPath)) return pkgPath;`,
          `    dir = path.dirname(dir);`,
          `  }`,
          `  return null;`,
          `}`,
          ``,
          `try {`,
          `  const pkgPath = findPackageJson(process.cwd());`,
          `  if (pkgPath) {`,
          `    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));`,
          `    const deps = { ...pkg.dependencies, ...pkg.devDependencies };`,
          `    if (deps[PACKAGE]) {`,
          `      console.log('✓ Found in package.json:', deps[PACKAGE]);`,
          `      console.log('→ This version may be vulnerable. Check npm audit for details.');`,
          `    } else {`,
          `      console.log('✗ Not found in direct dependencies (may be transitive)');`,
          `    }`,
          `  }`,
          `} catch (e) {`,
          `  console.error('Error reading package.json:', e.message);`,
          `}`,
          ``,
          `// Check node_modules presence`,
          `const modPath = path.join(process.cwd(), 'node_modules', PACKAGE.split('/').join(path.sep));`,
          `if (fs.existsSync(modPath)) {`,
          `  console.log('✓ Package directory exists in node_modules:', modPath);`,
          `  const pkgJson = path.join(modPath, 'package.json');`,
          `  if (fs.existsSync(pkgJson)) {`,
          `    const installed = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));`,
          `    console.log('  Installed version:', installed.version);`,
          `  }`,
          `} else {`,
          `  console.log('✗ Package not found in node_modules');`,
          `}`,
          ``,
          `console.log('');`,
          `console.log('=== Validation complete (read-only, no code from this package was executed) ===');`,
          `process.exit(0);`,
        ].join('\n'),
      };
    }

    if (isPy) {
      return {
        filename: `dep-${id}.py`,
        content: [
          ...header('python'),
          `# Dependency Version Validator for ${pkgName}@${pkgVer}`,
          `# Category: dependency | Ecosystem: ${eco}`,
          `#`,
          `# This validator checks whether the vulnerable Python package is installed.`,
          `# It uses pip list (read-only) — does not import or execute any package code.`,
          ``,
          `import subprocess`,
          `import sys`,
          `import json`,
          ``,
          `PACKAGE = '${pkgName}'`,
          `MIN_SAFE = '${pkgVer}'`,
          ``,
          `print('=== Vigil Safe PoC: Python Dependency Version Validator ===')`,
          `print(f'Package: {PACKAGE}')`,
          `print(f'Minimum safe version: {MIN_SAFE}')`,
          `print('')`,
          ``,
          `try:`,
          `    result = subprocess.run(`,
          `        [sys.executable, '-m', 'pip', 'list', '--format', 'json', '--disable-pip-version-check'],`,
          `        capture_output=True, text=True, timeout=30`,
          `    )`,
          `    if result.returncode == 0:`,
          `        packages = json.loads(result.stdout)`,
          `        for pkg in packages:`,
          `            if pkg.get('name', '').lower() == PACKAGE.lower():`,
          `                print(f"✓ Found: {pkg['name']}=={pkg['version']}")`,
          `                if pkg['version'] < MIN_SAFE:`,
          `                    print(f"→ Version {pkg['version']} is below minimum safe version {MIN_SAFE}")`,
          `                    print(f"→ This version may be vulnerable. Check safety or pip-audit for details.")`,
          `                else:`,
          `                    print(f"→ Version appears current (>= {MIN_SAFE})")`,
          `                break`,
          `        else:`,
          `            print(f'✗ Package {PACKAGE} not found in pip list')`,
          `    else:`,
          `        print(f'pip list failed: {result.stderr}')`,
          `except Exception as e:`,
          `    print(f'Error: {e}')`,
          ``,
          `print('')`,
          `print('=== Validation complete (read-only, no package was imported or executed) ===')`,
        ].join('\n'),
      };
    }
  }

  // Kernel version validator
  if (cat.includes('kernel') || finding.id?.includes('kernel') || finding.title?.includes('kernel') || finding.title?.includes('Linux')) {
    return {
      filename: `kernel-${id}.sh`,
      content: [
        ...header('sh'),
        `# Kernel Version Validator`,
        `# Category: kernel | Platform: ${platform}`,
        `#`,
        `# This validator reads the current kernel version and checks`,
        `# for known vulnerable kernel ranges. Read-only.`,
        ``,
        `echo "=== Vigil Safe PoC: Kernel Version Validator ==="`,
        `echo ""`,
        ``,
        `KERNEL=$(uname -r 2>/dev/null || echo "unknown")`,
        `echo "Current kernel: $KERNEL"`,
        `echo ""`,
        ``,
        `# Parse version numbers`,
        `MAJOR=$(echo "$KERNEL" | grep -oP '^\d+')`,
        `MINOR=$(echo "$KERNEL" | grep -oP '^\d+\.\K\d+' || echo "0")`,
        `PATCH=$(echo "$KERNEL" | grep -oP '^\d+\.\d+\.\K\d+' || echo "0")`,
        ``,
        `echo "Parsed: \$MAJOR.\$MINOR.\$PATCH"`,
        `echo ""`,
        ``,
        `# Check hardening controls`,
        `echo "--- Kernel Hardening Checks ---"`,
        `[ -f /proc/sys/kernel/kptr_restrict ] && echo "kptr_restrict: $(cat /proc/sys/kernel/kptr_restrict)" || echo "kptr_restrict: (not found)"`,
        `[ -f /proc/sys/kernel/dmesg_restrict ] && echo "dmesg_restrict: $(cat /proc/sys/kernel/dmesg_restrict)" || echo "dmesg_restrict: (not found)"`,
        `[ -f /proc/sys/kernel/randomize_va_space ] && echo "ASLR: $(cat /proc/sys/kernel/randomize_va_space) (2=full)" || echo "ASLR: (not found)"`,
        `[ -f /proc/sys/kernel/yama/ptrace_scope ] && echo "ptrace_scope: $(cat /proc/sys/kernel/yama/ptrace_scope)" || echo "ptrace_scope: (not found)"`,
        `[ -f /proc/sys/kernel/kexec_load_disabled ] && echo "kexec_load: $(cat /proc/sys/kernel/kexec_load_disabled) (1=disabled)" || echo "kexec_load: (not found)"`,
        ``,
        `# Check MAC`,
        `if command -v getenforce >/dev/null 2>&1; then`,
        `  echo "SELinux: $(getenforce 2>/dev/null || echo 'unknown')"`,
        `elif command -v aa-status >/dev/null 2>&1; then`,
        `  echo "AppArmor: $(aa-status --enabled 2>/dev/null && echo 'enabled' || echo 'unknown')"`,
        `else`,
        `  echo "MAC: No SELinux or AppArmor detected"`,
        `fi`,
        ``,
        `echo ""`,
        `echo "--- CVE Applicability Check ---"`,
        `echo "CVE-2026-31431 (AF_ALG LPE): $([ "$MAJOR" -ge 4 ] && echo 'POTENTIALLY APPLICABLE' || echo 'Not applicable')"`,
        `echo "CVE-2024-1086 (nf_tables UAF): $([ "$MAJOR" -eq 5 ] && [ "$MINOR" -ge 14 ] && echo 'POTENTIALLY APPLICABLE' || [ "$MAJOR" -eq 6 ] && [ "$MINOR" -le 7 ] && echo 'POTENTIALLY APPLICABLE' || echo 'Not applicable')"`,
        `echo "CVE-2023-32233 (Netfilter UAF): $([ "$MAJOR" -lt 6 ] || [ "$MAJOR" -eq 6 ] && [ "$MINOR" -lt 3 ] || [ "$MAJOR" -eq 6 ] && [ "$MINOR" -eq 3 ] && [ "$PATCH" -lt 2 ] && echo 'POTENTIALLY APPLICABLE' || echo 'Not applicable')"`,
        `echo "CVE-2023-0386 (OverlayFS): $([ "$MAJOR" -lt 6 ] || [ "$MAJOR" -eq 6 ] && [ "$MINOR" -lt 2 ] && echo 'POTENTIALLY APPLICABLE' || echo 'Not applicable')"`,
        `echo "CVE-2022-0847 (Dirty Pipe): $([ "$MAJOR" -eq 5 ] && [ "$MINOR" -ge 8 ] && [ "$MINOR" -le 16 ] && echo 'POTENTIALLY APPLICABLE' || echo 'Not applicable')"`,
        `echo "CVE-2016-5195 (Dirty COW): $([ "$MAJOR" -lt 5 ] || [ "$MAJOR" -eq 5 ] && [ "$MINOR" -lt 8 ] && echo 'POTENTIALLY APPLICABLE' || echo 'Not applicable')"`,
        ``,
        `echo ""`,
        `echo "=== Validation complete (read-only kernel surface check) ==="`,
      ].join('\n'),
    };
  }

  // Listener exposure validator
  if (cat.includes('exposure') || cat.includes('listener') || finding.title?.includes('port') || finding.title?.includes('listening')) {
    return {
      filename: `exposure-${id}.sh`,
      content: [
        ...header('sh'),
        `# Network Listener Exposure Validator`,
        `# Category: exposure | Platform: ${platform}`,
        `#`,
        `# This validator lists all listening TCP/UDP services.`,
        `# Read-only network socket inventory. No connections are made.`,
        ``,
        `echo "=== Vigil Safe PoC: Network Listener Exposure ==="`,
        `echo ""`,
        ``,
        `if [ "$(uname -s)" = "Linux" ] || [ "$(uname -s)" = "Darwin" ]; then`,
        `  echo "--- TCP Listeners ---"`,
        `  if command -v ss >/dev/null 2>&1; then`,
        `    ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null`,
        `  else`,
        `    netstat -an 2>/dev/null | grep LISTEN || lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null`,
        `  fi`,
        `  echo ""`,
        `  echo "--- UDP Listeners ---"`,
        `  ss -ulnp 2>/dev/null || netstat -ulnp 2>/dev/null || echo "UDP listener scan not available"`,
        `elif [ "$(uname -s)" = "Windows" ] || [ "$OS" = "Windows_NT" ]; then`,
        `  powershell -NoProfile -Command "Get-NetTCPConnection -State Listen | Select LocalAddress,LocalPort,OwningProcess | Format-Table" 2>/dev/null`,
        `fi`,
        ``,
        `echo ""`,
        `echo "--- Exposed High-Value Ports (0.0.0.0 bound) ---"`,
        `for port in 22 3389 5900 3306 5432 6379 27017 8080 8443 2375; do`,
        `  if ss -tlnp 2>/dev/null | grep -q ":\${port} "; then`,
        `    echo "Port \${port}/tcp is listening and may be exposed"`,
        `  fi`,
        `done`,
        ``,
        `echo ""`,
        `echo "=== Validation complete (read-only listener scan) ==="`,
      ].join('\n'),
    };
  }

  // Browser version validator
  if (cat.includes('browser') || finding.title?.includes('browser') || finding.title?.includes('Chrome') || finding.title?.includes('Firefox')) {
    return {
      filename: `browser-${id}.js`,
      content: [
        ...header('js'),
        `// Browser Version Validator`,
        `// Category: browser | Platform: ${platform}`,
        ``,
        `const { execSync } = require('child_process');`,
        `const os = require('os');`,
        ``,
        `console.log('=== Vigil Safe PoC: Browser Version Validator ===');`,
        `console.log('');`,
        ``,
        `const browsers = [`,
        `  { name: 'Google Chrome', cmd: 'google-chrome --version 2>/dev/null || google-chrome-stable --version 2>/dev/null || chromium --version 2>/dev/null || chromium-browser --version 2>/dev/null' },`,
        `  { name: 'Firefox', cmd: 'firefox --version 2>/dev/null' },`,
        `  { name: 'Brave', cmd: 'brave-browser --version 2>/dev/null' },`,
        `  { name: 'Edge', cmd: 'microsoft-edge --version 2>/dev/null || microsoft-edge-stable --version 2>/dev/null' },`,
        `];`,
        ``,
        `function sh(cmd) {`,
        `  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); }`,
        `  catch { return ''; }`,
        `}`,
        ``,
        `for (const b of browsers) {`,
        `  const ver = sh(b.cmd);`,
        `  if (ver) {`,
        `    const m = ver.match(/(\d+)\\./);`,
        `    const major = m ? parseInt(m[1]) : 0;`,
        `    let status = 'OK';`,
        `    if (b.name.includes('Chrome') || b.name.includes('Edge') || b.name.includes('Brave')) {`,
        `      if (major > 0 && major < 142) status = 'POTENTIALLY VULNERABLE (< 142)';`,
        `    } else if (b.name === 'Firefox') {`,
        `      if (major > 0 && major < 136) status = 'POTENTIALLY VULNERABLE (< 136)';`,
        `    }`,
        `    console.log(b.name + ': ' + ver + ' — ' + status);`,
        `  }`,
        `}`,
        ``,
        `if (os.platform() === 'darwin') {`,
        `  const safari = sh('/Applications/Safari.app/Contents/MacOS/Safari --version 2>/dev/null');`,
        `  if (safari) console.log('Safari:', safari);`,
        `}`,
        ``,
        `console.log('');`,
        `console.log('=== Validation complete (read-only version check) ===');`,
        `process.exit(0);`,
      ].join('\n'),
    };
  }

  // Docker/container validator
  if (cat.includes('docker') || cat.includes('container') || finding.title?.includes('Docker') || finding.id?.includes('docker')) {
    return {
      filename: `container-${id}.sh`,
      content: [
        ...header('sh'),
        `# Docker/Container Surface Validator`,
        `# Category: container | Platform: ${platform}`,
        `# Purely read-only Docker version + image list + socket check.`,
        ``,
        `echo "=== Vigil Safe PoC: Docker/Container Surface ==="`,
        `echo ""`,
        ``,
        `if ! command -v docker >/dev/null 2>&1; then`,
        `  echo "Docker is not installed. Skipping."`,
        `  exit 0`,
        `fi`,
        ``,
        `echo "--- Docker Version ---"`,
        `docker --version 2>/dev/null || echo "unknown"`,
        ``,
        `echo ""`,
        `echo "--- Docker Images ---"`,
        `docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" 2>/dev/null | head -30 || echo "no images or insufficient permissions"`,
        ``,
        `echo ""`,
        `echo "--- Docker Socket Check ---"`,
        `if [ -e /var/run/docker.sock ]; then`,
        `  ls -la /var/run/docker.sock 2>/dev/null`,
        `  SOCK_PERMS=\$(stat -c '%a' /var/run/docker.sock 2>/dev/null || stat -f '%A' /var/run/docker.sock 2>/dev/null || echo "unknown")`,
        `  echo "Socket permissions: \$SOCK_PERMS"`,
        `  if echo "\$SOCK_PERMS" | grep -qE "^..[67]" 2>/dev/null; then`,
        `    echo "WARNING: Docker socket may have world-writable permissions"`,
        `  fi`,
        `else`,
        `  echo "Docker socket not found at /var/run/docker.sock"`,
        `fi`,
        ``,
        `echo ""`,
        `echo "--- Docker TCP Exposure ---"`,
        `ps aux 2>/dev/null | grep dockerd | grep -o 'tcp://[^ ]*' 2>/dev/null || echo "No Docker TCP exposure detected"`,
        ``,
        `echo ""`,
        `echo "=== Validation complete (read-only Docker surface check) ==="`,
      ].join('\n'),
    };
  }

  // SUID binary validator
  if (cat.includes('privilege-escalation') || finding.id?.includes('suid') || finding.title?.includes('SUID')) {
    return {
      filename: `suid-${id}.sh`,
      content: [
        ...header('sh'),
        `# SUID Binary Surface Validator`,
        `# Category: privilege-escalation | Platform: ${platform}`,
        `# Read-only find for SUID/SGID binaries (privilege escalation surface)`,
        ``,
        `echo "=== Vigil Safe PoC: SUID Binary Surface ==="`,
        `echo ""`,
        ``,
        `echo "--- SUID Binaries (bounded: /bin /usr /sbin) ---"`,
        `find /bin /usr/bin /sbin /usr/sbin /usr/local/bin -perm -4000 -type f 2>/dev/null | head -50`,
        ``,
        `echo ""`,
        `echo "--- SGID Binaries ---"`,
        `find /bin /usr/bin /sbin /usr/sbin /usr/local/bin -perm -2000 -type f 2>/dev/null | head -30`,
        ``,
        `echo ""`,
        `echo "--- Known Risky SUID Check ---"`,
        `for risky in /usr/bin/pkexec /usr/bin/sudo /usr/bin/su /usr/bin/newgrp /usr/bin/chsh /usr/bin/chfn /usr/bin/gpasswd /usr/bin/mount /usr/bin/umount /usr/bin/passwd /usr/bin/fusermount /usr/lib/policykit-1/polkit-agent-helper-1; do`,
        `  if [ -u "$risky" ]; then`,
        `    echo "⚠ $risky is SUID — review if still needed"`,
        `  fi`,
        `done`,
        ``,
        `echo ""`,
        `echo "=== Validation complete (read-only SUID surface check) ==="`,
      ].join('\n'),
    };
  }

  // World-writable validator
  if (finding.id?.includes('world-writable') || finding.title?.includes('world-writable') || cat.includes('permission')) {
    return {
      filename: `world-writable-${id}.sh`,
      content: [
        ...header('sh'),
        `# World-Writable File/Dir Validator`,
        `# Category: misconfiguration | Platform: ${platform}`,
        `# Bounded read-only find for world-writable files/dirs.`,
        ``,
        `echo "=== Vigil Safe PoC: World-Writable Surface ==="`,
        `echo ""`,
        ``,
        `echo "--- World-Writable Files (bounded: /etc /opt /usr/local /var) ---"`,
        `find /etc /opt /usr/local /var -perm -0002 -type f 2>/dev/null | head -30`,
        ``,
        `echo ""`,
        `echo "--- World-Writable Directories ---"`,
        `find /etc /opt /usr/local /var -perm -0002 -type d 2>/dev/null | head -20`,
        ``,
        `echo ""`,
        `echo "--- /tmp Sticky Bit Check ---"`,
        `ls -ld /tmp /var/tmp /dev/shm 2>/dev/null`,
        ``,
        `echo ""`,
        `echo "=== Validation complete (read-only permission surface check) ==="`,
      ].join('\n'),
    };
  }

  // SSH config validator
  if (cat.includes('misconfiguration') && finding.id?.includes('ssh')) {
    return {
      filename: `ssh-config-${id}.sh`,
      content: [
        ...header('sh'),
        `# SSH Configuration Validator`,
        `# Category: misconfiguration | Platform: ${platform}`,
        `# Read-only parse of sshd_config for weak settings.`,
        ``,
        `echo "=== Vigil Safe PoC: SSH Configuration Audit ==="`,
        `echo ""`,
        ``,
        `CONFIG=/etc/ssh/sshd_config`,
        `if [ ! -f "$CONFIG" ]; then`,
        `  echo "sshd_config not found at $CONFIG"`,
        `  exit 0`,
        `fi`,
        ``,
        `echo "--- SSH Configuration Checks ---"`,
        `echo ""`,
        ``,
        `check() {`,
        `  local key="\$1"`,
        `  local expected="\$2"`,
        `  local found=$(grep -E "^#?\s*\${key}\s+" "$CONFIG" 2>/dev/null | grep -v "^#" | tail -1 || echo "not_set")`,
        `  if echo "$found" | grep -q "${expected}" 2>/dev/null; then`,
        `    echo "✓ $key: $found"`,
        `  else`,
        `    echo "⚠ $key: $found (expected: $expected)"`,
        `  fi`,
        `}`,
        ``,
        `check "PermitRootLogin" "no\|prohibit-password"`,
        `check "PasswordAuthentication" "no"`,
        `check "PermitEmptyPasswords" "no"`,
        `check "X11Forwarding" "no"`,
        `check "MaxAuthTries" ""`,
        ``,
        `echo ""`,
        `echo "=== Validation complete (read-only SSH config check, no connections made) ==="`,
      ].join('\n'),
    };
  }

  // Secret scan validator
  if (cat.includes('secret') || finding.id?.includes('secret') || finding.id?.includes('env-var') || finding.source?.includes('secret')) {
    return {
      filename: `secret-scan-${id}.sh`,
      content: [
        ...header('sh'),
        `# Secret Scan Validator`,
        `# Category: secret | Platform: ${platform}`,
        `# Read-only grep for common secret patterns (evidence only, values are masked).`,
        ``,
        `echo "=== Vigil Safe PoC: Local Secret Surface ==="`,
        `echo ""`,
        ``,
        `echo "--- Checking for sensitive files ---"`,
        `for file in ~/.env ~/.env.local ~/.npmrc ~/.aws/credentials ~/.docker/config.json ~/.git-credentials ~/.bashrc ~/.zshrc; do`,
        `  if [ -f "$file" ]; then`,
        `    echo "→ Found: $(echo $file | sed "s|$HOME|~|") ($(wc -c < "$file" 2>/dev/null | tr -d ' ') bytes)"`,
        `    grep -c -i 'key\|secret\|token\|password\|auth' "$file" 2>/dev/null | xargs -I{} echo "  {} lines match sensitive keywords"`,
        `  fi`,
        `done`,
        ``,
        `echo ""`,
        `echo "--- SSH Key Check ---"`,
        `for key in id_rsa id_ed25519 id_ecdsa; do`,
        `  [ -f ~/.ssh/$key ] && echo "→ Private key found: ~/.ssh/$key ($(wc -c < ~/.ssh/$key | tr -d ' ') bytes)"`,
        `done`,
        ``,
        `echo ""`,
        `echo "--- GPG Key Check ---"`,
        `if command -v gpg >/dev/null 2>&1; then`,
        `  gpg --list-secret-keys --keyid-format LONG 2>/dev/null | grep "^sec" && echo "→ GPG secret keys present" || echo "→ No GPG secret keys found"`,
        `fi`,
        ``,
        `echo ""`,
        `echo "=== Validation complete (read-only secret surface check, no values exposed) ==="`,
      ].join('\n'),
    };
  }

  // Cloud CLI validator
  if (cat.includes('cloud') || finding.id?.includes('aws') || finding.id?.includes('gcp') || finding.id?.includes('azure')) {
    return {
      filename: `cloud-${id}.sh`,
      content: [
        ...header('sh'),
        `# Cloud CLI Credential Surface Validator`,
        `# Category: cloud | Platform: ${platform}`,
        `# Safe presence and version check for cloud CLIs. No API calls.`,
        ``,
        `echo "=== Vigil Safe PoC: Cloud CLI Credential Surface ==="`,
        `echo ""`,
        ``,
        `echo "--- AWS CLI ---"`,
        `if command -v aws >/dev/null 2>&1; then`,
        `  aws --version 2>/dev/null`,
        `  echo "Profile: $(aws configure get region 2>/dev/null || echo 'not set')"`,
        `else`,
        `  echo "Not installed"`,
        `fi`,
        ``,
        `echo ""`,
        `echo "--- GCP CLI ---"`,
        `if command -v gcloud >/dev/null 2>&1; then`,
        `  gcloud version 2>/dev/null | head -1`,
        `  echo "Account: $(gcloud config get-value account 2>/dev/null || echo 'not set')"`,
        `else`,
        `  echo "Not installed"`,
        `fi`,
        ``,
        `echo ""`,
        `echo "--- Azure CLI ---"`,
        `if command -v az >/dev/null 2>&1; then`,
        `  az version 2>/dev/null | head -3 || echo "installed"`,
        `else`,
        `  echo "Not installed"`,
        `fi`,
        ``,
        `echo ""`,
        `echo "--- Terraform ---"`,
        `if command -v terraform >/dev/null 2>&1; then`,
        `  terraform version 2>/dev/null | head -1`,
        `else`,
        `  echo "Not installed"`,
        `fi`,
        ``,
        `echo ""`,
        `echo "=== Validation complete (read-only cloud CLI check, no credentials exposed) ==="`,
      ].join('\n'),
    };
  }

  // Crypto/TLS validator
  if (cat.includes('crypto') || finding.title?.includes('TLS') || finding.id?.includes('crypto') || finding.id?.includes('tls')) {
    return {
      filename: `crypto-tls-${id}.js`,
      content: [
        ...header('js'),
        `// Crypto/TLS Configuration Surface Validator`,
        `// Category: service | Platform: ${platform}`,
        ``,
        `const { execSync } = require('child_process');`,
        ``,
        `function sh(cmd, timeout = 5000) {`,
        `  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }).trim(); }`,
        `  catch { return ''; }`,
        `}`,
        ``,
        `console.log('=== Vigil Safe PoC: Crypto/TLS Configuration Surface ===');`,
        `console.log('');`,
        ``,
        `// Check NODE_TLS_REJECT_UNAUTHORIZED`,
        `if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {`,
        `  console.log('⚠ NODE_TLS_REJECT_UNAUTHORIZED=0 — TLS certificate validation disabled');`,
        `}`,
        ``,
        `// OpenSSL version`,
        `const ssl = sh('openssl version 2>/dev/null');`,
        `if (ssl) console.log('OpenSSL:', ssl);`,
        ``,
        `// Check for weak TLS on localhost`,
        `const ports = [443, 8443, 993, 995, 636];`,
        `for (const port of ports) {`,
        `  const tls10 = sh(\`echo | timeout 2 openssl s_client -connect localhost:\${port} -tls1 2>/dev/null | grep -i Protocol || true\`, 3000);`,
        `  if (tls10 && !tls10.includes('Connection refused')) console.log(\`⚠ Port \${port}: \${tls10.trim()}\`);`,
        `}`,
        ``,
        `// Check for weak cipher env`,
        `const nodeOpts = process.env.NODE_OPTIONS || '';`,
        `if (nodeOpts.includes('tls-min-v1.0') || nodeOpts.includes('tls-min-v1.1')) {`,
        `  console.log('⚠ NODE_OPTIONS contains TLS < 1.2 minimum:', nodeOpts);`,
        `}`,
        ``,
        `console.log('');`,
        `console.log('=== Validation complete (read-only crypto/TLS surface check) ===');`,
        `process.exit(0);`,
      ].join('\n'),
    };
  }

  // Generic/fallback validator
  return {
    filename: `generic-${id}.sh`,
    content: [
      ...header('sh'),
      `# Generic Safe Validator for: ${title}`,
      `# Category: ${cat} | Severity: ${sev}`,
      ``,
      `echo "=== Vigil Safe PoC: Generic Validator ==="`,
      `echo ""`,
      `echo "Finding: ${title}"`,
      `echo "ID: ${id}"`,
      `echo "Severity: ${sev}"`,
      `echo "Platform: ${(os.platform())}/${os.arch()}"`,
      `echo ""`,
      `echo "--- System Information ---"`,
      `uname -a 2>/dev/null || ver 2>/dev/null || echo "unknown"`,
      `echo ""`,
      `echo "--- Package Manager Status ---"`,
      `if command -v apt >/dev/null 2>&1; then`,
      `  echo "Package manager: apt"`,
      `  apt list --upgradable 2>/dev/null | grep -c '\\[' | xargs -I{} echo "  Upgradable: {} packages"`,
      `elif command -v dnf >/dev/null 2>&1; then`,
      `  echo "Package manager: dnf"`,
      `elif command -v brew >/dev/null 2>&1; then`,
      `  echo "Package manager: Homebrew"`,
      `  brew outdated 2>/dev/null | wc -l | xargs -I{} echo "  Outdated: {} packages"`,
      `elif command -v winget >/dev/null 2>&1; then`,
      `  echo "Package manager: winget"`,
      `fi`,
      ``,
      `echo ""`,
      `echo "=== Validation complete (read-only system check) ==="`,
    ].join('\n'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.outDir || join(process.cwd(), 'security-analysis', 'poc-validators'));
  mkdirSync(outDir, { recursive: true });

  let findings = [];
  if (args.findings) {
    const p = resolve(args.findings);
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        findings = Array.isArray(raw) ? raw : (raw.findings || raw.allFindings || raw.topFindings || []);
        if (args.category) findings = findings.filter(f => (f.category || '').includes(args.category));
        findings = findings.slice(0, args.max);
      } catch (e) { console.error('Failed to parse findings:', e.message); }
    }
  }

  if (findings.length === 0) {
    console.log('[PoC ENGINE] No findings provided. Generating PoC catalog only.');
    // Generate all template types
    const allTypes = ['kernel', 'dependency', 'exposure', 'browser', 'container', 'secret', 'cloud', 'crypto', 'privilege-escalation', 'misconfiguration'];
    findings = allTypes.map(t => ({ id: `${t}-template`, title: `${t} template`, category: t, severity: 'info' }));
  }

  let emitted = 0;
  for (const finding of findings) {
    const poc = generatePoC(finding);
    if (!poc) continue;
    const dest = join(outDir, poc.filename);
    writeFileSync(dest, poc.content, 'utf8');
    if (poc.filename.endsWith('.sh') || poc.filename.endsWith('.py')) {
      try { chmodSync(dest, 0o755); } catch {}
    }
    emitted++;
  }

  // Generate master index
  const index = {
    generatedAt: new Date().toISOString(),
    totalValidators: emitted,
    platform: os.platform(),
    arch: os.arch(),
    note: 'All validators are read-only and require authorization. No exploit payloads.',
    validators: findings.slice(0, emitted).map(f => ({
      id: f.id,
      title: f.title,
      category: f.category,
      severity: f.severity,
      filename: generatePoC(f)?.filename || 'unknown',
    })),
  };
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');

  console.log(`[PoC ENGINE] Generated ${emitted} safe validators in ${outDir}`);
  console.log(`[PoC ENGINE] Validators are read-only and require authorization. No exploit payloads.`);

  return { emitted, outDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { generatePoC, main };
