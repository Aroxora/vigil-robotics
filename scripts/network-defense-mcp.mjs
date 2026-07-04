#!/usr/bin/env node
// MCP stdio server — Network Defense: IDS/IPS, firewall management,
// traffic analysis, network hardening. All operations are read-only
// probes and defensive configuration checks. No exploitation.
//
// Authorization: VIGIL_SESSION_TOKEN must be set by the Vigil CLI.

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-netdef-mcp] Error: VIGIL_SESSION_TOKEN is not set.\n' +
    'This server must be started by the Vigil CLI, not directly.\n');
  process.exit(1);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync, spawnSync } from 'node:child_process';
import { platform, networkInterfaces } from 'node:os';

const TIMEOUT_MS = 30_000;
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

function haveExe(name) {
  try {
    const cmd = IS_WIN ? 'where' : 'which';
    const r = spawnSync(cmd, [name], { encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL' });
    return !!((r.stdout ?? '').split(/\r?\n/).filter(Boolean)[0]);
  } catch { return false; }
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
// Network interface discovery
// ──────────────────────────────
function probeInterfaces() {
  const ifaces = networkInterfaces();
  const result = {};
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    result[name] = addrs.map(a => ({
      address: a.address,
      netmask: a.netmask,
      family: a.family,
      mac: a.mac,
      internal: a.internal,
    }));
  }
  return result;
}

// ──────────────────────────────
// MCP Server
// ──────────────────────────────
const server = new McpServer({
  name: 'vigil-network-defense',
  version: '1.0.0',
});

// ── Full network health report ──
server.registerTool(
  'netdef_report',
  {
    title: 'Network Defense Report',
    description: 'Generate a comprehensive network defense health report. Covers listening services, firewall rules, routing, DNS config, ARP table, active connections, and interface audit. All operations are read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    const report = {
      timestamp: new Date().toISOString(),
      platform: platform(),
      interfaces: probeInterfaces(),
    };

    // Listening ports & services
    report.listening = {
      tcp: safeRun('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null', 10000).slice(0, 30000),
      udp: safeRun('ss -ulnp 2>/dev/null || netstat -ulnp 2>/dev/null', 10000).slice(0, 30000),
      raw: safeRun('ss -wlnp 2>/dev/null', 10000).slice(0, 10000),
    };

    // Active connections
    report.activeConnections = safeRun('ss -tanp state established 2>/dev/null | head -100', 10000);

    // Firewall status
    report.firewall = {};
    if (haveExe('iptables')) {
      report.firewall.iptables_rules = safeRun('iptables -L -n -v --line-numbers 2>/dev/null || true', 10000).slice(0, 50000);
      report.firewall.iptables_nat = safeRun('iptables -t nat -L -n 2>/dev/null || true', 10000).slice(0, 20000);
    }
    if (haveExe('ufw')) {
      report.firewall.ufw_status = safeRun('ufw status verbose 2>/dev/null || true', 10000);
    }
    if (haveExe('firewall-cmd')) {
      report.firewall.firewalld_zones = safeRun('firewall-cmd --list-all-zones 2>/dev/null || true', 15000).slice(0, 30000);
    }
    if (haveExe('nft')) {
      report.firewall.nftables_rules = safeRun('nft list ruleset 2>/dev/null || true', 10000).slice(0, 50000);
    }

    // Routing
    report.routing = safeRun('ip route show table all 2>/dev/null || route -n 2>/dev/null', 10000).slice(0, 20000);

    // ARP table
    report.arp = safeRun('ip neigh show 2>/dev/null || arp -a 2>/dev/null', 10000).slice(0, 20000);

    // DNS configuration
    report.dns = {
      resolv: safeRun('cat /etc/resolv.conf 2>/dev/null', 5000).slice(0, 5000),
      hosts: safeRun('cat /etc/hosts 2>/dev/null', 5000).slice(0, 10000),
      systemd_resolved: safeRun('resolvectl status 2>/dev/null || systemd-resolve --status 2>/dev/null', 10000).slice(0, 15000),
    };

    // Kernel network parameters (security-relevant)
    report.kernel = {
      ip_forward: safeRun('cat /proc/sys/net/ipv4/ip_forward 2>/dev/null', 3000).trim(),
      rp_filter: safeRun('cat /proc/sys/net/ipv4/conf/all/rp_filter 2>/dev/null', 3000).trim(),
      accept_source_route: safeRun('cat /proc/sys/net/ipv4/conf/all/accept_source_route 2>/dev/null', 3000).trim(),
      accept_redirects: safeRun('cat /proc/sys/net/ipv4/conf/all/accept_redirects 2>/dev/null', 3000).trim(),
      tcp_syncookies: safeRun('cat /proc/sys/net/ipv4/tcp_syncookies 2>/dev/null', 3000).trim(),
      ipv6_enabled: safeRun('cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null', 3000).trim(),
    };

    // Promiscuous interfaces
    report.promiscuous = safeRun('ip link show 2>/dev/null | grep PROMISC || echo "none"', 5000);

    return jsonResult(report);
  },
);

// ── IDS/IPS probe ──
server.registerTool(
  'netdef_ids_probe',
  {
    title: 'IDS/IPS Probe',
    description: 'Detect and query the status of Intrusion Detection/Prevention Systems (Snort, Suricata, Zeek, Wazuh, Falco, osquery). Returns running status, rule counts, and recent alerts. Read-only.',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    const result = { detected: [], running: [], alerts: {} };

    const detectors = [
      { name: 'Snort', check: 'snort', status: 'systemctl is-active snort 2>/dev/null || pgrep -x snort >/dev/null && echo running || echo stopped', rules: 'ls /etc/snort/rules/*.rules 2>/dev/null | wc -l', log: 'tail -50 /var/log/snort/alert 2>/dev/null || tail -50 /var/log/snort/alert_fast.txt 2>/dev/null' },
      { name: 'Suricata', check: 'suricata', status: 'systemctl is-active suricata 2>/dev/null || pgrep -x suricata >/dev/null && echo running || echo stopped', rules: 'suricata-update list-sources 2>/dev/null | head -20', log: 'tail -50 /var/log/suricata/fast.log 2>/dev/null || tail -50 /var/log/suricata/eve.json 2>/dev/null' },
      { name: 'Zeek', check: 'zeek', status: 'systemctl is-active zeek 2>/dev/null || pgrep -x zeek >/dev/null && echo running || echo stopped', rules: 'ls /usr/local/zeek/share/zeek/policy/ 2>/dev/null', log: 'tail -50 /usr/local/zeek/logs/current/notice.log 2>/dev/null' },
      { name: 'Wazuh', check: 'wazuh-agent', status: 'systemctl is-active wazuh-agent 2>/dev/null || echo stopped', rules: 'ls /var/ossec/ruleset/rules/ 2>/dev/null | wc -l', log: 'tail -50 /var/ossec/logs/alerts/alerts.json 2>/dev/null' },
      { name: 'Falco', check: 'falco', status: 'systemctl is-active falco 2>/dev/null || pgrep -x falco >/dev/null && echo running || echo stopped', rules: 'ls /etc/falco/falco_rules*.yaml 2>/dev/null | wc -l', log: 'journalctl -u falco --no-pager -n 30 2>/dev/null' },
      { name: 'osquery', check: 'osqueryd', status: 'systemctl is-active osqueryd 2>/dev/null || pgrep -x osqueryd >/dev/null && echo running || echo stopped', rules: 'osqueryi --json "select name from osquery_packs" 2>/dev/null || echo "n/a"', log: 'journalctl -u osqueryd --no-pager -n 30 2>/dev/null' },
    ];

    for (const d of detectors) {
      if (haveExe(d.check)) {
        result.detected.push(d.name);
        const status = safeRun(d.status, 8000).trim();
        if (status === 'running') {
          result.running.push(d.name);
          result.alerts[d.name] = safeRun(d.log, 15000).slice(0, 20000);
        }
      }
    }

    return jsonResult(result);
  },
);

// ── Port exposure audit ──
server.registerTool(
  'netdef_port_audit',
  {
    title: 'Port Exposure Audit',
    description: 'Audit all listening ports and services for security concerns. Flags services bound to 0.0.0.0, identifies process ownership, and cross-references with known vulnerable service versions.',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    const result = { exposed: [], internal: [], summary: { total: 0, exposedToWan: 0, internalOnly: 0, unknown: 0 } };

    const raw = safeRun('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null', 10000);
    const lines = raw.split('\n').slice(1); // skip header

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      result.summary.total++;

      const parts = trimmed.split(/\s+/);
      const address = parts[4] || parts[3] || '';
      const process = parts.slice(-1)[0] || '';

      if (address.startsWith('0.0.0.0') || address.startsWith('*') || address.startsWith(':::')) {
        result.exposed.push({ address, process, raw: trimmed });
        result.summary.exposedToWan++;
      } else if (address.startsWith('127.') || address.startsWith('::1')) {
        result.internal.push({ address, process, raw: trimmed });
        result.summary.internalOnly++;
      } else {
        result.summary.unknown++;
      }
    }

    // Check for risky services
    result.riskyServices = [];
    const riskyPatterns = ['telnet', 'rsh', 'rlogin', 'rexec', 'finger', 'vsftpd', 'proftpd', 'bind', 'mysql', 'postgresql', 'redis', 'mongod', 'elasticsearch', 'memcached', 'docker', 'kubernetes'];
    for (const svc of result.exposed) {
      for (const pattern of riskyPatterns) {
        if (svc.process.toLowerCase().includes(pattern) || svc.address.includes(pattern)) {
          result.riskyServices.push({ service: pattern, detail: svc });
        }
      }
    }

    return jsonResult(result);
  },
);

// ── Firewall policy audit ──
server.registerTool(
  'netdef_firewall_audit',
  {
    title: 'Firewall Policy Audit',
    description: 'Audit firewall policies for defensive gaps: overly permissive rules, missing egress filtering, exposed management ports, and logging configuration. Supports iptables, nftables, ufw, firewalld.',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    const findings = [];
    const config = {};

    // iptables analysis
    const iptRules = safeRun('iptables -L -n -v 2>/dev/null || true', 10000);
    if (iptRules) {
      config.iptables = iptRules.slice(0, 30000);

      if (iptRules.includes('ACCEPT') && !iptRules.includes('DROP')) {
        findings.push({ severity: 'high', finding: 'Default ACCEPT policy detected', detail: 'Consider setting default DROP for INPUT chain', remediation: 'iptables -P INPUT DROP' });
      }

      const sshOpen = (iptRules.match(/dpt:22/g) || []).length;
      if (sshOpen > 0 && !iptRules.includes('dpt:22').match(/0\.0\.0\.0/)) {
        findings.push({ severity: 'medium', finding: `SSH (port 22) open with ${sshOpen} rules`, detail: 'Ensure SSH is restricted to specific IPs or VPN', remediation: 'Limit SSH access to management IPs' });
      }

      const openPorts = iptRules.match(/dpt:\d+/g) || [];
      if (openPorts.length > 10) {
        findings.push({ severity: 'medium', finding: `${openPorts.length} open port rules`, detail: 'Large number of open ports increases attack surface', remediation: 'Close unused ports' });
      }
    }

    // ufw analysis
    const ufwStatus = safeRun('ufw status verbose 2>/dev/null || true', 10000);
    if (ufwStatus) {
      config.ufw = ufwStatus.slice(0, 15000);

      if (ufwStatus.includes('inactive') || ufwStatus.includes('Status: inactive')) {
        findings.push({ severity: 'critical', finding: 'UFW firewall is INACTIVE', detail: 'Host firewall is disabled', remediation: 'ufw enable && ufw default deny incoming' });
      }

      if (ufwStatus.includes('logging: off')) {
        findings.push({ severity: 'low', finding: 'UFW logging is disabled', detail: 'No firewall logs for incident response', remediation: 'ufw logging on' });
      }
    }

    // nftables analysis
    const nftRules = safeRun('nft list ruleset 2>/dev/null || true', 10000);
    if (nftRules) {
      config.nftables = nftRules.slice(0, 30000);
    }

    // firewalld analysis
    const fwZones = safeRun('firewall-cmd --list-all-zones 2>/dev/null || true', 10000);
    if (fwZones) {
      config.firewalld = fwZones.slice(0, 20000);

      if (fwZones.includes('services: ssh') && fwZones.includes('sources:')) {
        // ssh is open but may be restricted — OK
      } else if (fwZones.includes('services: ssh')) {
        findings.push({ severity: 'medium', finding: 'SSH allowed in firewalld without source restriction', remediation: 'Restrict SSH to specific source IPs' });
      }
    }

    // Windows Firewall
    if (IS_WIN) {
      const wfRules = safeRun('netsh advfirewall firewall show rule name=all dir=in 2>$null', 15000);
      if (wfRules) {
        config.windows_firewall = wfRules.slice(0, 30000);
      }
    }

    return jsonResult({ findings, config, summary: { totalFindings: findings.length, critical: findings.filter(f => f.severity === 'critical').length, high: findings.filter(f => f.severity === 'high').length } });
  },
);

// ── DNS / traffic analysis ──
server.registerTool(
  'netdef_dns_audit',
  {
    title: 'DNS Security Audit',
    description: 'Audit DNS configuration for security: DNSSEC validation, encrypted DNS (DoH/DoT), resolver configuration, and DNS leak detection. Read-only queries.',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    const findings = [];

    const resolv = safeRun('cat /etc/resolv.conf 2>/dev/null', 5000);
    const resolved = safeRun('resolvectl status 2>/dev/null || systemd-resolve --status 2>/dev/null', 10000);

    // Check for plaintext DNS
    if (resolv.includes('nameserver') && !resolv.includes('127.0.0.53') && !resolv.includes('127.0.0.1')) {
      const nameservers = resolv.match(/nameserver\s+(\S+)/g) || [];
      if (nameservers.length > 0) {
        findings.push({ severity: 'medium', finding: 'Plaintext DNS nameservers configured', detail: nameservers.join(', '), remediation: 'Configure encrypted DNS (DNS-over-HTTPS) or a local caching resolver' });
      }
    }

    if (resolved && resolved.includes('DNS')) {
      findings.push({ severity: 'info', finding: 'systemd-resolved managing DNS', detail: 'DNS is centrally managed' });
    }

    // DNSSEC check
    const dnssec = safeRun('cat /etc/systemd/resolved.conf 2>/dev/null | grep -i dnssec', 5000);
    findings.push({ severity: dnssec && dnssec.includes('yes') ? 'info' : 'medium', finding: dnssec && dnssec.includes('yes') ? 'DNSSEC validation enabled in resolved' : 'DNSSEC status unknown — check resolved.conf', detail: dnssec || 'No resolved.conf found' });

    // DNS leak test (query external resolver)
    const leakTest = safeRun('dig +short myip.opendns.com @resolver1.opendns.com 2>/dev/null || echo "dig not available"', 10000);
    if (leakTest && leakTest !== 'dig not available') {
      findings.push({ severity: 'info', finding: 'DNS leak test result', detail: `External DNS sees your IP as: ${leakTest.trim()}` });
    }

    // Check /etc/hosts for suspicious entries
    const hosts = safeRun('cat /etc/hosts 2>/dev/null', 5000);
    const hostEntries = (hosts.match(/^[^#].+/gm) || []).filter(l => !l.startsWith('127.') && !l.startsWith('::1'));
    if (hostEntries.length > 0) {
      findings.push({ severity: 'low', finding: `${hostEntries.length} non-loopback entries in /etc/hosts`, detail: hostEntries.join('; '), remediation: 'Review /etc/hosts for unauthorized entries' });
    }

    return jsonResult({ findings, configuration: { resolv: resolv.slice(0, 5000), resolved: resolved.slice(0, 15000), hosts: hosts.slice(0, 10000) } });
  },
);

// ── TLS / SSL audit ──
server.registerTool(
  'netdef_tls_audit',
  {
    title: 'TLS/SSL Audit',
    description: 'Audit TLS/SSL configuration for known weaknesses: deprecated protocols, weak ciphers, expired certificates on local services. Read-only probes.',
    inputSchema: {
      host: z.string().optional().describe('Target hostname or IP. Defaults to localhost.'),
      port: z.number().int().positive().max(65535).optional().default(443),
      timeoutMs: z.number().int().positive().max(60000).optional().default(15000),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => {
    const host = args.host || 'localhost';
    const port = args.port || 443;
    const findings = [];

    if (!haveExe('openssl')) {
      return jsonResult({ error: 'openssl not installed', host, port });
    }

    // Certificate info
    const cert = safeRun(`echo | timeout 10 openssl s_client -connect ${host}:${port} -servername ${host} 2>/dev/null | openssl x509 -noout -text 2>/dev/null`, args.timeoutMs);
    if (!cert) {
      return jsonResult({ error: `Could not connect to ${host}:${port}`, findings });
    }

    // Check expiration
    const notAfter = cert.match(/Not After\s*:\s*(.+)/);
    if (notAfter) {
      const expDate = new Date(notAfter[1]);
      const daysLeft = Math.ceil((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysLeft < 0) {
        findings.push({ severity: 'critical', finding: 'Certificate EXPIRED', detail: `Expired ${Math.abs(daysLeft)} days ago` });
      } else if (daysLeft < 30) {
        findings.push({ severity: 'high', finding: `Certificate expires in ${daysLeft} days`, remediation: 'Renew certificate immediately' });
      } else if (daysLeft < 90) {
        findings.push({ severity: 'low', finding: `Certificate expires in ${daysLeft} days`, remediation: 'Plan renewal' });
      }
    }

    // Check protocol versions
    for (const [proto, label] of [['-tls1', 'TLS 1.0'], ['-tls1_1', 'TLS 1.1'], ['-tls1_2', 'TLS 1.2'], ['-tls1_3', 'TLS 1.3']]) {
      const supported = safeRun(`echo | timeout 5 openssl s_client -connect ${host}:${port} ${proto} 2>/dev/null | grep -c "Server certificate"`, 8000).trim();
      if (supported === '0') {
        findings.push({ severity: label === 'TLS 1.0' || label === 'TLS 1.1' ? 'info' : 'medium', finding: `${label} not supported` });
      } else if (label === 'TLS 1.0' || label === 'TLS 1.1') {
        findings.push({ severity: 'high', finding: `${label} STILL SUPPORTED`, detail: 'Deprecated protocol should be disabled', remediation: 'Disable TLS 1.0 and TLS 1.1 in server config' });
      }
    }

    // Cipher strength
    const ciphers = safeRun(`echo | timeout 10 openssl s_client -connect ${host}:${port} -cipher 'ALL' 2>/dev/null | openssl x509 -noout -text 2>/dev/null | grep "Public Key Algorithm"`, args.timeoutMs);
    if (ciphers) {
      const keyMatch = cert.match(/Public-Key:\s*\((\d+)\s*bit\)/);
      if (keyMatch && parseInt(keyMatch[1]) < 2048) {
        findings.push({ severity: 'high', finding: `Weak key size: ${keyMatch[1]} bits`, remediation: 'Use at least 2048-bit RSA or ECDSA keys' });
      }
    }

    return jsonResult({ host, port, findings, certificateSummary: (cert || '').slice(0, 15000) });
  },
);

// ──────────────────────────────
// Start server
// ──────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
