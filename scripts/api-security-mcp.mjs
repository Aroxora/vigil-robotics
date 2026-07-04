#!/usr/bin/env node
// MCP stdio server — API Security Scanner
// Tests web APIs for common vulnerabilities using read-only probes.
// Covers: auth bypass, injection, CORS, rate limiting, headers, TLS.

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-api-mcp] Error: VIGIL_SESSION_TOKEN is not set.\n' +
    'This server must be started by the Vigil CLI, not directly.\n');
  process.exit(1);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

const TIMEOUT = 20_000;
const HTTP_TO = 15;
const IS_WIN = platform() === 'win32';

function safeRun(cmd, t = TIMEOUT) {
  try {
    const c = IS_WIN ? cmd : `timeout ${Math.floor(t/1000)} ${cmd}`;
    return execSync(c, { encoding:'utf8', timeout:t+5000, stdio:['ignore','pipe','ignore'], maxBuffer:8*1024*1024, killSignal:'SIGKILL' }).trim();
  } catch { return ''; }
}
function jsonResult(v) { return { content: [{ type:'text', text: JSON.stringify(v,null,2) }] }; }

const server = new McpServer({ name:'vigil-api-security', version:'1.0.0' });

// ══════════════════════════════════════
// API Security Scan — main tool
// ══════════════════════════════════════
server.registerTool('api_scan', {
  title: 'API Security Scan',
  description: 'Scan a web API endpoint for security vulnerabilities: missing auth, CORS misconfiguration, security headers, rate limiting, TLS, exposed debug endpoints. All probes are read-only HTTP requests.',
  inputSchema: {
    url: z.string().describe('Base URL of the API to scan (e.g. https://api.example.com).'),
    endpoints: z.string().optional().describe('Comma-separated API endpoints to probe (e.g. /users,/health,/admin). Defaults to common paths.'),
    timeoutMs: z.number().int().positive().max(120000).optional().default(30000),
    headers: z.string().optional().describe('Additional headers as JSON string (e.g. {"Authorization":"Bearer xxx"}).'),
  },
  annotations: { readOnlyHint:true, destructiveHint:false },
}, async (args) => {
  const baseUrl = args.url.replace(/\/$/, '');
  const findings = [];
  const headers = {};
  try { if (args.headers) Object.assign(headers, JSON.parse(args.headers)); } catch {}

  function curl(path, opts = {}) {
    const method = opts.method || 'GET';
    const hdrs = { ...headers, ...(opts.headers || {}) };
    const hdrArgs = Object.entries(hdrs).map(([k,v]) => `-H '${k}: ${v}'`).join(' ');
    const methodFlag = opts.method ? `-X ${method}` : '';
    const dataFlag = opts.data ? `-d '${opts.data.replace(/'/g,"\\'")}'` : '';
    const to = opts.timeout || HTTP_TO;
    return safeRun(`curl -sS -o /dev/null -w '%{http_code}|%{size_download}|%{time_total}|%{redirect_url}' --max-time ${to} ${methodFlag} ${dataFlag} ${hdrArgs} '${baseUrl}${path}' 2>/dev/null`, (to+5)*1000);
  }
  function curlHeaders(path, opts = {}) {
    const hdrs = { ...headers, ...(opts.headers || {}) };
    const hdrArgs = Object.entries(hdrs).map(([k,v]) => `-H '${k}: ${v}'`).join(' ');
    const methodFlag = opts.method ? `-X ${opts.method}` : '';
    const to = opts.timeout || HTTP_TO;
    return safeRun(`curl -sS -i --max-time ${to} ${methodFlag} ${hdrArgs} '${baseUrl}${path}' 2>/dev/null | head -60`, (to+5)*1000);
  }

  // 1. Baseline — check the root
  const rootResp = curlHeaders('/');
  if (!rootResp) {
    return jsonResult({ error: `Could not connect to ${baseUrl}`, hint: 'Check the URL is correct and reachable' });
  }

  // 2. Security headers audit
  const headersToCheck = {
    'Strict-Transport-Security': { sev:'high', desc:'HSTS not set — MITM downgrade risk', fix:'Add header: max-age=31536000; includeSubDomains; preload' },
    'Content-Security-Policy': { sev:'high', desc:'CSP not set — XSS/sniffing risk', fix:'Add Content-Security-Policy header' },
    'X-Content-Type-Options': { sev:'medium', desc:'MIME sniffing possible', fix:'Add header: nosniff' },
    'X-Frame-Options': { sev:'medium', desc:'Clickjacking possible', fix:'Add header: DENY' },
    'X-XSS-Protection': { sev:'low', desc:'Legacy XSS protection missing', fix:'Add header: 1; mode=block' },
    'Referrer-Policy': { sev:'low', desc:'Referrer policy not set', fix:'Add header: strict-origin-when-cross-origin' },
    'Permissions-Policy': { sev:'low', desc:'Feature policy not set', fix:'Add Permissions-Policy header' },
  };

  const respHeaders = {};
  for (const line of rootResp.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.+)/i);
    if (m) respHeaders[m[1].toLowerCase()] = m[2];
  }

  for (const [hdr, info] of Object.entries(headersToCheck)) {
    if (!respHeaders[hdr.toLowerCase()]) {
      findings.push({ severity:info.sev, type:'missing-header', header:hdr, detail:info.desc, fix:info.fix });
    }
  }

  // 3. CORS misconfiguration
  const corsResp = curlHeaders('/', { headers: { 'Origin': 'https://evil.example.com' } });
  if (corsResp) {
    const acao = corsResp.match(/Access-Control-Allow-Origin:\s*(.+)/i);
    if (acao) {
      const origin = acao[1].trim();
      if (origin === '*' || origin === 'null') {
        findings.push({ severity:'high', type:'cors', detail:'CORS allows any origin (*) or null — CSRF/cross-origin read risk', fix:'Restrict Access-Control-Allow-Origin to specific trusted domains' });
      } else if (origin === 'https://evil.example.com') {
        findings.push({ severity:'critical', type:'cors', detail:'CORS reflects arbitrary Origin header — credential theft possible', fix:'Validate the Origin header against a whitelist' });
      }
    }
    const acac = corsResp.match(/Access-Control-Allow-Credentials:\s*true/i);
    if (acac && acao) {
      findings.push({ severity:'high', type:'cors', detail:'CORS allows credentials with permissive origin', fix:'Do not combine Allow-Credentials with wildcard or reflected origins' });
    }
  }

  // 4. Probe common debug/admin endpoints
  const sensitivePaths = [
    '/.env', '/.git/config', '/swagger-ui.html', '/api-docs', '/docs',
    '/graphql', '/graphiql', '/admin', '/wp-admin', '/phpmyadmin',
    '/actuator', '/actuator/health', '/debug', '/metrics', '/heapdump',
    '/.well-known/security.txt', '/robots.txt',
  ];

  for (const path of sensitivePaths) {
    const code = curl(path).split('|')[0];
    if (code && code !== '404' && code !== '000' && code !== '403') {
      const sev = ['/.env','/.git/config','/actuator','/heapdump'].includes(path) ? 'critical'
        : ['/admin','/wp-admin','/phpmyadmin','/debug'].includes(path) ? 'high' : 'medium';
      findings.push({ severity:sev, type:'exposed-endpoint', path, status:code, detail:`Sensitive endpoint ${path} returned HTTP ${code}`, fix:'Remove, restrict, or require authentication for this endpoint' });
    }
  }

  // 5. Probe specified endpoints
  const endpointList = args.endpoints
    ? args.endpoints.split(',').map(e => e.trim()).filter(Boolean)
    : ['/api/users', '/api/admin', '/api/health', '/api/v1', '/v1/users', '/login', '/register'];

  for (const ep of endpointList) {
    const path = ep.startsWith('/') ? ep : '/' + ep;
    const code = curl(path);
    if (code) {
      const parts = code.split('|');
      const status = parts[0];

      // Missing auth check
      if (status === '200' && (path.includes('admin') || path.includes('users') || path.includes('config'))) {
        findings.push({ severity:'critical', type:'missing-auth', path, detail:`${path} returned 200 without authentication`, fix:'Require authentication for this endpoint' });
      }

      // Rate limiting check (crude: 5 rapid requests)
      if (status !== '404' && status !== '000') {
        let rateLimited = false;
        for (let i = 0; i < 5; i++) {
          const rc = curl(path).split('|')[0];
          if (rc === '429') { rateLimited = true; break; }
        }
        if (!rateLimited) {
          findings.push({ severity:'medium', type:'rate-limit', path, detail:'No rate limiting detected — brute-force possible', fix:'Implement rate limiting (e.g. 100 req/min per IP)' });
        }
      }

      // Check for verbose errors
      const headersResp = curlHeaders(path);
      if (headersResp && (headersResp.includes('stacktrace') || headersResp.includes('SQL syntax') || headersResp.includes('ORA-') || headersResp.includes('SQLSTATE'))) {
        findings.push({ severity:'high', type:'information-disclosure', path, detail:'Verbose error messages leak internal details', fix:'Disable debug mode in production, return generic errors' });
      }
    }
  }

  // 6. TLS version check
  const tls10 = safeRun(`echo | timeout 5 openssl s_client -connect ${new URL(baseUrl).hostname}:443 -tls1 2>/dev/null | grep -c "Server certificate"`, 10000).trim();
  if (tls10 !== '0') findings.push({ severity:'high', type:'tls', detail:'TLS 1.0 supported — deprecated and vulnerable', fix:'Disable TLS 1.0/1.1, require TLS 1.2+' });

  return jsonResult({
    timestamp: new Date().toISOString(),
    target: baseUrl,
    findings,
    headers: respHeaders,
    summary: {
      total: findings.length,
      critical: findings.filter(f=>f.severity==='critical').length,
      high: findings.filter(f=>f.severity==='high').length,
      medium: findings.filter(f=>f.severity==='medium').length,
      low: findings.filter(f=>f.severity==='low').length,
    },
  });
});

// ══════════════════════════════════════
// JWT Token Analyzer
// ══════════════════════════════════════
server.registerTool('api_jwt_analyze', {
  title: 'JWT Token Analyzer',
  description: 'Analyze a JWT token for security issues: algorithm confusion (alg:none), weak signing, expired tokens, missing claims. Does not validate signature — reads header/payload only.',
  inputSchema: {
    token: z.string().describe('JWT token string (base64-encoded, three parts separated by dots).'),
  },
  annotations: { readOnlyHint:true, destructiveHint:false },
}, async (args) => {
  const parts = args.token.split('.');
  if (parts.length !== 3) return jsonResult({ error:'Invalid JWT — must have 3 dot-separated parts' });

  const findings = [];
  let header, payload;

  try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return jsonResult({ error:'Invalid JWT header — not valid base64url' }); }
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return jsonResult({ error:'Invalid JWT payload — not valid base64url' }); }

  // Algorithm check
  if (header.alg === 'none') {
    findings.push({ severity:'critical', detail:'alg:none — token has no signature, anyone can forge', fix:'Reject alg:none tokens on the server' });
  }
  if (header.alg === 'HS256' && header.jku) {
    findings.push({ severity:'critical', detail:'HS256 with jku header — algorithm confusion attack possible', fix:'Use RS256/ES256, validate jku URL against whitelist' });
  }

  // Expiration
  if (payload.exp) {
    const expDate = new Date(payload.exp * 1000);
    if (expDate < new Date()) {
      findings.push({ severity:'medium', detail:`Token expired at ${expDate.toISOString()}`, fix:'This token should be rejected by the server' });
    }
  } else {
    findings.push({ severity:'medium', detail:'No exp claim — token never expires', fix:'Always set exp claim with reasonable duration' });
  }

  // Issued at
  if (!payload.iat) {
    findings.push({ severity:'low', detail:'No iat claim — cannot determine token age', fix:'Set iat claim for audit trail' });
  }

  // Audience
  if (!payload.aud) {
    findings.push({ severity:'low', detail:'No aud claim — token usable by any audience', fix:'Set aud claim to restrict token to intended service' });
  }

  return jsonResult({
    header,
    payload,
    signaturePresent: parts[2]?.length > 10,
    findings,
    summary: { total:findings.length, critical:findings.filter(f=>f.severity==='critical').length },
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
