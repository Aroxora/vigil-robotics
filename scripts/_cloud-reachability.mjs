// _cloud-reachability.mjs — detect cloud surfaces reachable from
// the current host. Checks for installed CLI tools, active sessions,
// credential files, kubeconfigs, and Terraform state that would
// allow an attacker (or compromised user) to pivot into cloud.
//
// All checks are read-only; no cloud API calls are made beyond
// the local CLI's "whoami" equivalent.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

const home = homedir();
const TIMEOUT = 10_000;

export function probeCloudReachability() {
  return {
    generatedAt: new Date().toISOString(),
    aws: probeAws(),
    gcp: probeGcp(),
    azure: probeAzure(),
    firebase: probeFirebase(),
    terraform: probeTerraform(),
    kubernetes: probeKubernetes(),
    dockerHub: probeDockerHub(),
    npm: probeNpm(),
    gitRemotes: probeGitRemotes(),
  };
}

// ─── AWS ───────────────────────────────────────────────────────────
function probeAws() {
  if (!haveExe('aws')) return { installed: false };
  try {
    return {
      installed: true,
      identity: safeText('aws sts get-caller-identity --output json 2>$null'),
      configRegions: safeText('aws configure list 2>$null | Select-Object -First 30'),
      region: process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION'],
      profile: process.env['AWS_PROFILE'],
      credentialsFile: probeFile(join(home, '.aws', 'credentials')),
      configFile: probeFile(join(home, '.aws', 'config')),
      ssoCacheDir: probeDir(join(home, '.aws', 'sso', 'cache')),
      envKeySet: !!process.env['AWS_ACCESS_KEY_ID'],
      envSessionToken: !!process.env['AWS_SESSION_TOKEN'],
    };
  } catch {
    return { installed: true, identity: 'failed' };
  }
}

// ─── GCP ───────────────────────────────────────────────────────────
function probeGcp() {
  if (!haveExe('gcloud')) return { installed: false };
  try {
    return {
      installed: true,
      activeAccount: safeText('gcloud config get-value account 2>$null'),
      project: safeText('gcloud config get-value project 2>$null'),
      region: safeText('gcloud config get-value compute/region 2>$null'),
      accounts: safeText('gcloud auth list --format json 2>$null'),
      applicationCredentials: {
        envVar: !!process.env['GOOGLE_APPLICATION_CREDENTIALS'],
        path: process.env['GOOGLE_APPLICATION_CREDENTIALS'],
        adcExists: probeFile(join(home, 'AppData', 'Roaming', 'gcloud', 'application_default_credentials.json')),
      },
      configDir: probeDir(join(home, 'AppData', 'Roaming', 'gcloud')),
    };
  } catch {
    return { installed: true };
  }
}

// ─── Azure ─────────────────────────────────────────────────────────
function probeAzure() {
  if (!haveExe('az')) return { installed: false };
  try {
    return {
      installed: true,
      account: safeText('az account show --output json 2>$null'),
      subscriptions: safeText('az account list --output json --query "[].{name:name,id:id,isDefault:isDefault}" 2>$null'),
      configDir: probeDir(join(home, '.azure')),
      envKeySet: !!(process.env['AZURE_CLIENT_ID'] || process.env['AZURE_TENANT_ID']),
    };
  } catch {
    return { installed: true };
  }
}

// ─── Firebase ──────────────────────────────────────────────────────
function probeFirebase() {
  const result = { installed: haveExe('firebase') };
  if (!result.installed) return result;
  try {
    result.activeProjects = safeText('firebase projects:list --json 2>$null');
    result.loginTokens = probeDir(join(home, '.config', 'configstore'));
    result.configExists = probeFile('.firebaserc');
  } catch { /* ignore */ }
  return result;
}

// ─── Terraform / OpenTofu ──────────────────────────────────────────
function probeTerraform() {
  const result = {
    installed: haveExe('terraform') || haveExe('tofu'),
  };
  if (!result.installed) return result;
  // Scan common locations for .terraform dirs (they contain state/providers)
  const tfDirs = [];
  const scanDirs = [process.cwd(), home, join(home, 'projects'), join(home, 'git'), join(home, 'src')];
  for (const d of scanDirs) {
    findTerraformDirs(d, 3, tfDirs);
  }
  result.stateDirs = tfDirs.slice(0, 30);
  result.terraformRc = probeFile(join(home, '.terraformrc'));
  result.terraformD = probeDir(join(home, '.terraform.d'));
  result.envTokenSet = !!process.env['TF_TOKEN_app_terraform_io'] || !!process.env['TFE_TOKEN'] || !!process.env['TERRAFORM_CLOUD_TOKEN'];
  return result;
}

// ─── Kubernetes ────────────────────────────────────────────────────
function probeKubernetes() {
  const result = { installed: haveExe('kubectl') };
  if (!result.installed) return result;
  try {
    result.currentContext = safeText('kubectl config current-context 2>$null');
    result.contexts = safeText('kubectl config get-contexts --output name 2>$null');
    result.clusters = safeText('kubectl config get-clusters 2>$null');
    result.users = safeText('kubectl config get-users 2>$null');
    const kubeDir = process.env['KUBECONFIG'] || join(home, '.kube', 'config');
    result.kubeconfig = probeFile(kubeDir);
  } catch { /* ignore */ }
  // Check for k3s, minikube, kind, rancher desktop
  result.minikube = haveExe('minikube');
  result.kind = haveExe('kind');
  result.k3s = haveExe('k3s');
  result.helm = haveExe('helm');
  return result;
}

// ─── Docker Hub / GHCR ─────────────────────────────────────────────
function probeDockerHub() {
  try {
    const cfg = probeFile(join(home, '.docker', 'config.json'));
    if (cfg?.content) {
      try {
        const j = JSON.parse(cfg.content);
        const auths = Object.keys(j.auths || j.credHelpers || {});
        return { dockerConfigExists: true, registries: auths };
      } catch { return { dockerConfigExists: true }; }
    }
    return { dockerConfigExists: false };
  } catch { return { dockerConfigExists: false }; }
}

// ─── npm (publish rights) ──────────────────────────────────────────
function probeNpm() {
  try {
    const whoami = safeText('npm whoami 2>$null');
    const rc = probeFile(join(home, '.npmrc'));
    const projectRc = probeFile('.npmrc');
    const tokens = [];
    if (rc?.content) {
      const matches = rc.content.match(/\/\/registry\.npmjs\.org\/:_authToken=([^\n]+)/);
      if (matches) tokens.push('global-npmrc-has-auth');
    }
    return {
      authenticated: !!whoami,
      user: whoami || null,
      globalNpmrcExists: rc?.exists ?? false,
      projectNpmrcExists: projectRc?.exists ?? false,
      tokenDetected: tokens.length > 0,
    };
  } catch { return { authenticated: false }; }
}

// ─── Git remotes (reachable via SSH/HTTPS) ─────────────────────────
function probeGitRemotes() {
  try {
    const remotes = safeText('git remote -v 2>$null');
    if (!remotes) return { remotes: [] };
    const lines = remotes.split(/\r?\n/).filter(Boolean);
    return { remotes: lines.slice(0, 30) };
  } catch { return { remotes: [] }; }
}

// ─── helpers ──────────────────────────────────────────────────────
function safeText(cmd) {
  try {
    const r = execSync(cmd, { encoding: 'utf8', timeout: TIMEOUT, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], killSignal: 'SIGKILL' });
    return r.trim();
  } catch { return ''; }
}

function haveExe(name) {
  const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
  return !!((r.stdout ?? '').split(/\r?\n/).filter(Boolean)[0]);
}

function probeFile(path) {
  try {
    if (!existsSync(path)) return { exists: false };
    const content = readFileSync(path, 'utf8').slice(0, 4000);
    return { exists: true, path: path.replace(/\\/g, '/'), size: content.length };
  } catch { return { exists: false }; }
}

function probeDir(path) {
  try {
    if (!existsSync(path)) return { exists: false };
    const items = readdirSync(path).slice(0, 40);
    return { exists: true, count: items.length, items };
  } catch { return { exists: false }; }
}

function findTerraformDirs(dir, maxDepth, out) {
  if (maxDepth <= 0 || out.length >= 50) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      const full = join(dir, e.name);
      if (e.name === '.terraform') {
        out.push(full.replace(/\\/g, '/'));
      } else {
        findTerraformDirs(full, maxDepth - 1, out);
      }
    }
  }
}
