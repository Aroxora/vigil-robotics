import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const BLOCKED_KALI_TOOLS = new Set([
  'metasploit-framework',
  'msfconsole',
  'msfvenom',
  'meterpreter',
  'beef-xss',
  'set',
  'hydra',
  'medusa',
  'ncrack',
  'mimikatz',
  'secretsdump.py',
  'crackmapexec',
  'netexec',
  'responder',
  'ettercap',
  'bettercap',
  'dsniff',
  'arpspoof',
  'sslstrip',
  'sliver',
  'covenant',
  'powershell-empire',
  'starkiller',
  'evil-winrm',
  'aircrack-ng',
  'reaver',
  'wifite',
]);

const DENIED_ARG_PATTERNS = [
  /[;&|`$<>]/,
  /\b(?:reverse\s*shell|bind\s*shell|meterpreter|payload|shellcode|c2|command\s*(?:and|&)\s*control)\b/i,
  /\b(?:--exec|-e)\s*(?:\/bin\/)?(?:sh|bash|cmd|powershell)\b/i,
  /\b(?:credential\s*(?:dump|harvest|theft)|hashdump|lsass|mimikatz|secretsdump)\b/i,
  /\b(?:psexec|wmiexec|smbexec|evil-winrm|crackmapexec|netexec)\b/i,
  /\b(?:--rate|-rate)\s+\d{5,}\b/i,
  /\b(?:-p-|\b--script\s+(?:vuln|exploit|brute))\b/i,
];

export function assertAuthorizedTarget(target, action = 'active-scan') {
  if (!target || typeof target !== 'string') {
    throw new Error(`CNE scope denied: ${action} requires an explicit target.`);
  }
  if (isLocalLabTarget(target)) {
    return { authority: 'local-lab', target, action };
  }

  const envTargets = parseEnvTargets();
  if (envTargets.some((entry) => targetMatches(target, entry))) {
    return {
      authority: 'unsigned-env-allowlist',
      target,
      action,
      warning: 'VIGIL_SCOPE_TARGETS is accepted as an operator override; signed scope documents are preferred.',
    };
  }

  const scope = loadScope();
  if (!scope) {
    throw new Error(`CNE scope denied: ${target} is not loopback/lab and no VIGIL_SCOPE_FILE or VIGIL_SCOPE_JSON was provided.`);
  }

  const signature = verifyScope(scope);
  if (!signature.valid) {
    throw new Error(`CNE scope denied: ${signature.reason}`);
  }

  if (!scope.permittedActions?.includes(action) && !(action === 'safe-validation' && scope.permittedActions?.includes('active-scan'))) {
    throw new Error(`CNE scope denied: scope ${scope.id} does not permit ${action}.`);
  }

  if (scope.exclusions && targetInScope(target, scope.exclusions)) {
    throw new Error(`CNE scope denied: ${target} is explicitly excluded by scope ${scope.id}.`);
  }

  if (!targetInScope(target, scope.targets)) {
    throw new Error(`CNE scope denied: ${target} is not covered by signed scope ${scope.id}.`);
  }

  return { authority: 'signed-scope', target, action, scopeId: scope.id };
}

export function denyIfUnsafeKaliInvocation(tool, args = '') {
  const normalizedTool = String(tool || '').trim().toLowerCase();
  const normalizedArgs = String(args || '');

  if (BLOCKED_KALI_TOOLS.has(normalizedTool)) {
    throw new Error(`CNE policy denied Kali tool "${tool}": not shipped in the public CNE profile.`);
  }

  for (const pattern of DENIED_ARG_PATTERNS) {
    if (pattern.test(normalizedArgs)) {
      throw new Error(`CNE policy denied Kali arguments for "${tool}": ${pattern.source}`);
    }
  }
}

export function extractTargetFromArgs(args = '') {
  const text = String(args || '');
  const url = text.match(/\bhttps?:\/\/[^\s"'<>`]+/i)?.[0];
  if (url) return trimTarget(url);
  const ip = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/)?.[0];
  if (ip) return trimTarget(ip);
  const host = text.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|test|example|invalid|localhost)\b/i)?.[0];
  return host ? trimTarget(host) : '';
}

export function isLocalLabTarget(target) {
  const host = hostnameFromTarget(target);
  return host === 'localhost' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host.endsWith('.localhost') ||
    host.endsWith('.test') ||
    host.endsWith('.example') ||
    host.endsWith('.invalid');
}

function loadScope() {
  if (process.env.VIGIL_SCOPE_JSON?.trim()) {
    return JSON.parse(process.env.VIGIL_SCOPE_JSON);
  }
  if (process.env.VIGIL_SCOPE_FILE?.trim() && existsSync(process.env.VIGIL_SCOPE_FILE)) {
    return JSON.parse(readFileSync(process.env.VIGIL_SCOPE_FILE, 'utf8'));
  }
  return null;
}

function parseEnvTargets() {
  return (process.env.VIGIL_SCOPE_TARGETS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function verifyScope(scope) {
  if (!scope.signature?.value) {
    return { valid: false, reason: `scope ${scope.id || '(unknown)'} has no signature` };
  }
  if (scope.signature.algorithm !== 'HMAC-SHA256') {
    return { valid: false, reason: `unsupported signature algorithm ${scope.signature.algorithm}` };
  }
  const secret = process.env.VIGIL_SCOPE_SIGNING_KEY;
  if (!secret) {
    return { valid: false, reason: 'VIGIL_SCOPE_SIGNING_KEY is required for signed scope verification' };
  }
  const unsigned = { ...scope };
  delete unsigned.signature;
  const expected = createHmac('sha256', secret).update(canonicalJson(unsigned)).digest('hex');
  const actual = String(scope.signature.value);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(actual, 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: `scope ${scope.id} signature verification failed` };
  }

  const now = Date.now();
  if (Date.parse(scope.issuedAt) > now) {
    return { valid: false, reason: `scope ${scope.id} is not active until ${scope.issuedAt}` };
  }
  if (Date.parse(scope.expiresAt) <= now) {
    return { valid: false, reason: `scope ${scope.id} expired at ${scope.expiresAt}` };
  }
  return { valid: true, reason: `scope ${scope.id} verified` };
}

function targetInScope(target, targets = {}) {
  return [
    ...(targets.urls || []),
    ...(targets.domains || []),
    ...(targets.ipRanges || []),
    ...(targets.accountIds || []),
    ...(targets.cloudResourceIds || []),
  ].some((entry) => targetMatches(target, entry));
}

function targetMatches(target, scopeEntry) {
  const host = hostnameFromTarget(target);
  const entry = trimTarget(scopeEntry);
  if (!entry) return false;
  if (entry.startsWith('*.')) {
    return host.endsWith(entry.slice(1)) && host !== entry.slice(2);
  }
  if (entry.includes('/')) {
    return ipMatchesRange(host, entry);
  }
  return host === hostnameFromTarget(entry) || trimTarget(target) === entry;
}

function hostnameFromTarget(target) {
  const cleaned = trimTarget(target);
  try {
    if (/^https?:\/\//i.test(cleaned)) return new URL(cleaned).hostname.toLowerCase();
  } catch {
    return cleaned;
  }
  return cleaned.replace(/\/.*$/, '').replace(/:\d+$/, '').toLowerCase();
}

function trimTarget(value) {
  return String(value || '').trim().replace(/[),.;\]}]+$/g, '').replace(/^['"`]+|['"`]+$/g, '').replace(/\/+$/g, '').toLowerCase();
}

function ipMatchesRange(ip, range) {
  if (!range.includes('/')) return ip === range;
  const [base, bitsRaw] = range.split('/');
  const bits = Number(bitsRaw);
  const ipNum = ipv4ToNumber(ip);
  const baseNum = ipv4ToNumber(base);
  if (ipNum === null || baseNum === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function ipv4ToNumber(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    out = (out << 8) + value;
  }
  return out >>> 0;
}

function canonicalJson(value) {
  return JSON.stringify(sortForJson(value));
}

function sortForJson(value) {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = sortForJson(value[key]);
      return acc;
    }, {});
}
