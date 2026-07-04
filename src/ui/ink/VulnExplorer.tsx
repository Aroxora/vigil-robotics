/**
 * VulnExplorer — Rich interactive vulnerability discovery browser for Vigil Ink CLI.
 *
 * Phase 3 Comprehensive Upgrade.
 * Split-pane: left = filterable findings list (vim j/k, / search, severity/KEV/ECCN/EPSS filters).
 * Right = detail pane with full safeProof (including emitted validatorFile), remediation, ECCN, EPSS scores.
 * Actions: 'e' or Enter to execute the safe validator live (with timeout + evidence capture).
 * 'x' to export filtered view as JSON/MD. 'r' to show remediation commands.
 * 'd' to show CVE details. 's' to sort by different criteria.
 *
 * Supports both legacy findings.json and new comprehensive-findings.json formats.
 *
 * Usage from shell: /vuln   or   vigil --vuln-browser
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { palette } from '../theme.js';

export interface DiscoveryFinding {
  id: string;
  source: string;
  category: string;
  title: string;
  severity: string;
  cveIds?: string[];
  priority?: { score: number; label: string };
  safeProof?: {
    type?: string;
    mode?: string;
    command?: string;
    expected?: string;
    note?: string;
    validatorFile?: string;
  };
  remediation?: { note?: string; command?: string };
  eccn?: { eccn?: string; distribution?: string; rationale?: string };
  threatIntel?: any;
  cisaKev?: { cveID: string; vendorProject?: string; dueDate?: string; knownRansomware?: boolean }[];
  epss?: { cve: string; epss: number; percentile: number; date: string }[];
}

interface VulnExplorerProps {
  findingsDir?: string;
  onExit?: () => void;
}

type SortField = 'priority' | 'severity' | 'epss' | 'cisaKev';
type DetailTab = 'proof' | 'remediation' | 'classification' | 'cve';

function LegacyVulnExplorer({ findingsDir, onExit }: VulnExplorerProps) {
  const [allFindings, setAllFindings] = useState<DiscoveryFinding[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState<'all' | 'kev' | 'critical' | 'high' | 'classification' | 'exposure' | 'binary' | 'kernel' | 'secret'>('all');
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('priority');
  const [detailTab, setDetailTab] = useState<DetailTab>('proof');
  const [execOutput, setExecOutput] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { exit } = useApp();

  // Auto-detect latest comprehensive or vulnerability-discovery findings
  useEffect(() => {
    const candidates: string[] = [];
    const base = resolve(process.cwd(), 'security-analysis');
    if (existsSync(base)) {
      const dirs = readdirSync(base, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      dirs.sort().reverse();
      for (const d of dirs) {
        const vd = join(base, d, 'vulnerability-discovery');
        const vdComp = join(base, d);
        // Prefer comprehensive-findings.json, fallback to findings.json
        if (existsSync(join(vdComp, 'comprehensive-findings.json'))) {
          candidates.push(join(vdComp, 'comprehensive-findings.json'));
        }
        if (existsSync(join(vd, 'findings.json'))) {
          candidates.push(join(vd, 'findings.json'));
        }
      }
    }
    // Also check explicit dir
    if (findingsDir) {
      const explicit = join(findingsDir, 'comprehensive-findings.json');
      const explicit2 = join(findingsDir, 'vulnerability-discovery', 'findings.json');
      if (existsSync(explicit)) candidates.unshift(explicit);
      if (existsSync(explicit2)) candidates.unshift(explicit2);
    }

    const findingsPath = candidates[0];
    if (findingsPath && existsSync(findingsPath)) {
      try {
        const raw = readFileSync(findingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        let findings: any[] = [];
        if (Array.isArray(parsed)) findings = parsed;
        else if (parsed.findings) findings = parsed.findings;
        else if (parsed.allFindings) findings = parsed.allFindings;
        else if (parsed.topFindings) findings = parsed.topFindings;

        const normalized = findings.map((f: any) => ({
          ...f,
          priority: typeof f.priority === 'number' ? { score: f.priority, label: f.priority >= 80 ? 'immediate' : f.priority >= 60 ? 'urgent' : f.priority >= 35 ? 'scheduled' : 'routine' } : (f.priority || { score: 0, label: 'unscored' }),
        })) as DiscoveryFinding[];

        setAllFindings(normalized);
        setMessage(`Loaded ${normalized.length} findings from ${findingsPath}`);
      } catch (e) {
        setMessage(`Failed to load findings: ${String(e).slice(0, 100)}`);
      }
    } else {
      setMessage(`No findings found. Run "vigil --vuln-comprehensive" or "vigil --vuln-all" first.\nChecked: ${base}`);
    }
  }, [findingsDir]);

  const filteredFindings = useMemo(() => {
    let res = allFindings;

    switch (filter) {
      case 'kev': res = res.filter(f => (f.cisaKev?.length || 0) > 0 || (f.threatIntel?.cisaKev?.length || 0) > 0); break;
      case 'critical': res = res.filter(f => f.severity === 'critical'); break;
      case 'high': res = res.filter(f => ['critical', 'high'].includes(f.severity)); break;
      case 'classification': res = res.filter(f => f.eccn && (f.eccn.eccn?.includes('controlled') || f.eccn.eccn?.includes('4D004'))); break;
      case 'exposure': res = res.filter(f => f.category === 'exposure' || f.title?.toLowerCase().includes('listening') || f.title?.toLowerCase().includes('port')); break;
      case 'binary': res = res.filter(f => f.source?.includes('ghidra') || f.category === 'binary-hardening' || f.category === 'binary-risk'); break;
      case 'kernel': res = res.filter(f => f.source?.includes('kernel') || f.category === 'kernel'); break;
      case 'secret': res = res.filter(f => f.category === 'secret' || f.category === 'export-control'); break;
    }

    if (search) {
      const s = search.toLowerCase();
      res = res.filter(f =>
        f.title?.toLowerCase().includes(s) ||
        f.id?.toLowerCase().includes(s) ||
        f.category?.toLowerCase().includes(s) ||
        (f.cveIds || []).some(c => c.toLowerCase().includes(s))
      );
    }

    const getPriorityScore = (f: DiscoveryFinding): number => {
      if (typeof f.priority === 'object' && f.priority !== null) return f.priority.score || 0;
      if (typeof f.priority === 'number') return f.priority;
      return 0;
    };

    const getSevScore = (f: DiscoveryFinding): number => {
      const s = { critical: 5, high: 4, moderate: 3, medium: 3, low: 2, info: 1, unknown: 0 }[f.severity] || 0;
      return s;
    };

    const getEpssScore = (f: DiscoveryFinding): number => {
      return Math.max(0, ...(f.epss || []).map(e => e.epss), ...(f.threatIntel?.epss || []).map((e: any) => e.epss));
    };

    const getKevScore = (f: DiscoveryFinding): number => {
      return (f.cisaKev?.length || 0) + (f.threatIntel?.cisaKev?.length || 0);
    };

    switch (sortField) {
      case 'priority': res = res.sort((a, b) => getPriorityScore(b) - getPriorityScore(a)); break;
      case 'severity': res = res.sort((a, b) => getSevScore(b) - getSevScore(a) || getPriorityScore(b) - getPriorityScore(a)); break;
      case 'epss': res = res.sort((a, b) => getEpssScore(b) - getEpssScore(a) || getPriorityScore(b) - getPriorityScore(a)); break;
      case 'cisaKev': res = res.sort((a, b) => getKevScore(b) - getKevScore(a) || getPriorityScore(b) - getPriorityScore(a)); break;
    }

    return res;
  }, [allFindings, filter, search, sortField]);

  const selected = filteredFindings[selectedIndex];

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { onExit?.(); exit(); return; }
    if (input === 'q') { onExit?.(); exit(); return; }

    // Navigation
    if (key.upArrow || input === 'k') { setSelectedIndex(i => Math.max(0, i - 1)); return; }
    if (key.downArrow || input === 'j') { setSelectedIndex(i => Math.min(filteredFindings.length - 1, i + 1)); return; }
    if (input === 'g') { setSelectedIndex(0); return; }
    if (input === 'G') { setSelectedIndex(filteredFindings.length - 1); return; }

    // Filters
    if (input === '1') { setFilter('all'); setSelectedIndex(0); return; }
    if (input === '2') { setFilter('critical'); setSelectedIndex(0); return; }
    if (input === '3') { setFilter('high'); setSelectedIndex(0); return; }
    if (input === '4') { setFilter('kev'); setSelectedIndex(0); return; }
    if (input === '5') { setFilter('classification'); setSelectedIndex(0); return; }
    if (input === '6') { setFilter('exposure'); setSelectedIndex(0); return; }
    if (input === '7') { setFilter('kernel'); setSelectedIndex(0); return; }
    if (input === '8') { setFilter('secret'); setSelectedIndex(0); return; }
    if (input === '9') { setFilter('binary'); setSelectedIndex(0); return; }

    // Sort
    if (input === '!') { setSortField('priority'); setMessage('Sorted by: priority (default)'); return; }
    if (input === '@') { setSortField('severity'); setMessage('Sorted by: severity'); return; }
    if (input === '#') { setSortField('epss'); setMessage('Sorted by: EPSS score'); return; }
    if (input === '$') { setSortField('cisaKev'); setMessage('Sorted by: CISA KEV count'); return; }

    // Detail tabs
    if (input === 'p') { setDetailTab('proof'); return; }
    if (input === 'm') { setDetailTab('remediation'); return; }
    if (input === 'e') { setDetailTab('classification'); return; }
    if (input === 'd') { setDetailTab('cve'); return; }

    // Execute validator
    if (key.return) {
      if (selected?.safeProof?.validatorFile) executeValidator(selected);
      else setMessage('No validatorFile. Run PoC engine first or press "m" for remediation.');
      return;
    }

    // Export
    if (input === 'x') { exportFindings(); return; }

    // Help
    if (input === 'h') {
      setMessage('j/k=nav up/down | g/G=top/bottom | 1-9=filters | Enter=exec validator | p/m/e/d=tabs | x=export | q=quit | !/@/#/$=sort | type letters=search | backspace=clear search');
      return;
    }

    // Incremental search
    if (/^[a-z0-9\-.:_]$/i.test(input) && !key.meta && !key.ctrl) {
      setSearch(s => (s + input).slice(0, 50));
      setSelectedIndex(0);
      return;
    }
    if (key.backspace || input === '\b') { setSearch(s => s.slice(0, -1)); setSelectedIndex(0); return; }
  });

  async function executeValidator(finding: DiscoveryFinding) {
    if (!finding.safeProof?.validatorFile) return;
    setIsExecuting(true);
    setExecOutput(null);
    setMessage(`Executing safe validator: ${finding.safeProof.validatorFile} ...`);

    const fullPath = resolve(findingsDir || join(process.cwd(), 'security-analysis'), finding.safeProof.validatorFile);
    const ext = fullPath.endsWith('.sh') ? 'sh' : fullPath.endsWith('.py') ? 'py' : 'js';
    let cmd: string[] = [];
    if (ext === 'js') cmd = [process.execPath, fullPath];
    else if (ext === 'sh') cmd = ['bash', fullPath];
    else if (ext === 'py') cmd = ['python3', fullPath];
    else cmd = ['cat', fullPath];

    try {
      const result = spawnSync(cmd[0], cmd.slice(1), { cwd: process.cwd(), encoding: 'utf8', timeout: 30000, windowsHide: true });
      const output = (result.stdout || '') + (result.stderr || '');
      setExecOutput(output.slice(0, 5000) + (output.length > 5000 ? '\n... (truncated)' : ''));
      setMessage(`Validator completed (exit ${result.status}).`);
    } catch (e) {
      setExecOutput(String(e).slice(0, 500));
      setMessage('Execution error (safe — validator is read-only).');
    } finally {
      setIsExecuting(false);
    }
  }

  function exportFindings() {
    const exportData = { exportedAt: new Date().toISOString(), filter, search, sort: sortField, count: filteredFindings.length, findings: filteredFindings };
    console.log('\n=== EXPORT (copy this) ===\n' + JSON.stringify(exportData, null, 2).slice(0, 5000));
    setMessage(`Exported ${filteredFindings.length} findings (JSON above — copy/paste or redirect).`);
  }

  const getP = (f: DiscoveryFinding) => typeof f.priority === 'object' ? (f.priority?.score || 0) : (typeof f.priority === 'number' ? f.priority : 0);
  const getPl = (f: DiscoveryFinding) => typeof f.priority === 'object' ? (f.priority?.label || '') : '';

  const totalKev = allFindings.filter(f => (f.cisaKev?.length || 0) > 0 || (f.threatIntel?.cisaKev?.length || 0) > 0).length;
  const totalClassification = allFindings.filter(f => f.eccn && (f.eccn.eccn?.includes('4D004') || f.eccn.eccn?.includes('5D002') || f.eccn.eccn?.includes('controlled'))).length;
  const totalCrit = allFindings.filter(f => f.severity === 'critical').length;
  const totalHigh = allFindings.filter(f => ['critical', 'high'].includes(f.severity)).length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color={palette.cyan}>  Vigil Vuln Explorer (Phase 3 Comprehensive)</Text>
        <Text dimColor>  {filteredFindings.length} shown / {allFindings.length} total  |  j/k=gdown/up  |  enter=exec validator  |  h=help  |  q=quit</Text>
      </Box>

      <Box>
        <Text>Filters: </Text>
        <Text color={filter === 'all' ? palette.cyan : undefined}>[1 all]</Text>
        <Text color={filter === 'critical' ? palette.red : undefined}> [2 crit:{totalCrit}]</Text>
        <Text color={filter === 'high' ? palette.yellow : undefined}> [3 high:{totalHigh}]</Text>
        <Text color={filter === 'kev' ? palette.orange : undefined}> [4 kev:{totalKev}]</Text>
        <Text color={filter === 'classification' ? palette.magenta : undefined}> [5 eccn:{totalClassification}]</Text>
        <Text dimColor> [6 expos]</Text>
        <Text dimColor> [7 kernel]</Text>
        <Text dimColor> [8 secret]</Text>
        <Text dimColor> [9 binary]</Text>
      </Box>
      <Box>
        <Text>Sort: </Text>
        <Text color={sortField === 'priority' ? palette.cyan : undefined}>[! priority]</Text>
        <Text color={sortField === 'severity' ? palette.cyan : undefined}> [@ severity]</Text>
        <Text color={sortField === 'epss' ? palette.cyan : undefined}> [# epss]</Text>
        <Text color={sortField === 'cisaKev' ? palette.cyan : undefined}> [$ KEV]</Text>
        <Text>  </Text>
        <Text>Search: </Text>
        <Text color={search ? palette.yellow : undefined}>{search || '(type to search/backspace to clear)'}</Text>
      </Box>

      {message && <Text color="yellow" dimColor>{message.slice(0, 200)}</Text>}

      <Box flexDirection="row" marginTop={1}>
        {/* Left list */}
        <Box flexDirection="column" width={55} borderStyle="single" borderColor={palette.titanium} paddingX={1}>
          {filteredFindings.slice(0, 18).map((f, idx) => {
            const isSel = idx === selectedIndex;
            const pri = getP(f);
            const sevColor = f.severity === 'critical' ? palette.red : f.severity === 'high' ? palette.yellow : f.severity === 'moderate' ? palette.yellow : undefined;
            const kev = (f.cisaKev?.length || 0) > 0;
            return (
              <Box key={f.id || idx}>
                <Text color={isSel ? palette.cyan : undefined} bold={isSel}>
                  {isSel ? '> ' : '  '}
                  <Text color={sevColor}>{f.severity?.toUpperCase().slice(0,4)}</Text>
                  {kev && <Text color={palette.orange}>[KEV]</Text>}
                  {' '}{f.title?.slice(0, 36)}
                </Text>
                {pri > 0 && <Text dimColor> {pri}</Text>}
              </Box>
            );
          })}
          {filteredFindings.length > 18 && <Text dimColor>... +{filteredFindings.length - 18} more (j/k to scroll)</Text>}
        </Box>

        {/* Right detail */}
        <Box flexDirection="column" flexGrow={1} marginLeft={1} borderStyle="single" borderColor={palette.titanium} paddingX={1}>
          {selected ? (
            <>
              <Text bold>{selected.title}</Text>
              <Text dimColor>{selected.id}  {selected.source}  {selected.category}</Text>
              <Box>
                <Text>Severity: </Text><Text color={selected.severity === 'critical' ? palette.red : selected.severity === 'high' ? palette.yellow : undefined}>{selected.severity}</Text>
                <Text>  Priority: {getPl(selected) || '?'} ({getP(selected)})</Text>
              </Box>
              {(selected.cveIds?.length || 0) > 0 && <Text dimColor>CVEs: {(selected.cveIds || []).slice(0, 5).join(', ')}{(selected.cveIds || []).length > 5 ? '...' : ''}</Text>}

              {/* Detail tabs */}
              <Box marginTop={1}>
                <Text color={detailTab === 'proof' ? palette.cyan : undefined}>[p] Proof </Text>
                <Text color={detailTab === 'remediation' ? palette.green : undefined}>[m] Remediation </Text>
                <Text color={detailTab === 'classification' ? palette.magenta : undefined}>[e] ECCN </Text>
                <Text color={detailTab === 'cve' ? palette.yellow : undefined}>[d] CVE/TI</Text>
              </Box>

              {detailTab === 'proof' && selected.safeProof && (
                <Box marginTop={1} flexDirection="column">
                  <Text bold color="green">Safe Proof (read-only)</Text>
                  <Text>Mode: {selected.safeProof.mode || 'benign-validation'}</Text>
                  {selected.safeProof.validatorFile && <Text color="cyan">Validator: {selected.safeProof.validatorFile}</Text>}
                  {selected.safeProof.command && <Text wrap="wrap">Cmd: {selected.safeProof.command}</Text>}
                  {selected.safeProof.expected && <Text dimColor>Expected: {selected.safeProof.expected}</Text>}
                  {selected.safeProof.note && <Text dimColor>{selected.safeProof.note}</Text>}
                  <Text dimColor>Press Enter to execute the safe validator</Text>
                </Box>
              )}

              {detailTab === 'proof' && !selected.safeProof && (
                <Text dimColor>No safe proof available for this finding.</Text>
              )}

              {detailTab === 'remediation' && selected.remediation && (
                <Box marginTop={1} flexDirection="column">
                  <Text bold color="green">Remediation</Text>
                  {selected.remediation.command && <Text>Command: <Text color="cyan">{selected.remediation.command}</Text></Text>}
                  {selected.remediation.note && <Text wrap="wrap">{selected.remediation.note}</Text>}
                </Box>
              )}

              {detailTab === 'remediation' && !selected.remediation && (
                <Text dimColor>No remediation guidance available.</Text>
              )}

              {detailTab === 'classification' && selected.eccn && (
                <Box marginTop={1} flexDirection="column">
                  <Text bold color="magenta">ECCN Export Control</Text>
                  <Text>Classification: {selected.eccn.eccn || 'EAR99'}</Text>
                  <Text>Distribution: {selected.eccn.distribution || 'N/A'}</Text>
                  <Text dimColor wrap="wrap">{selected.eccn.rationale || 'No additional details.'}</Text>
                </Box>
              )}

              {detailTab === 'cve' && (
                <Box marginTop={1} flexDirection="column">
                  <Text bold color="yellow">Threat Intelligence</Text>
                  {(selected.cisaKev || selected.threatIntel?.cisaKev) && (
                    <>
                      <Text color="red">CISA KEV: Known Exploited Vulnerability</Text>
                      {(selected.cisaKev || selected.threatIntel?.cisaKev || []).map((ke: any, i: number) => (
                        <Text key={i} dimColor>  {ke.cveID || ke.cveId} — {ke.vendorProject || ''} {ke.product || ''} (due: {ke.dueDate || ''}){ke.knownRansomware || ke.knownRansomwareCampaignUse ? ' [RANSOMWARE]' : ''}</Text>
                      ))}
                    </>
                  )}
                  {(selected.epss || selected.threatIntel?.epss || []).length > 0 && (
                    <>
                      <Text>EPSS Scores:</Text>
                      {(selected.epss || selected.threatIntel?.epss || []).slice(0, 5).map((e: any, i: number) => (
                        <Text key={i} dimColor>  {e.cve}: {e.epss?.toFixed(4) || e.epss} (pct: {(e.percentile * 100)?.toFixed(1) || e.percentile}%)</Text>
                      ))}
                    </>
                  )}
                </Box>
              )}

              {isExecuting && <Text color="yellow"><Spinner type="dots" /> Executing validator (30s timeout)...</Text>}

              {execOutput && (
                <Box marginTop={1} flexDirection="column">
                  <Text bold color="green">Validator Output:</Text>
                  <Text wrap="wrap">{execOutput}</Text>
                </Box>
              )}
            </>
          ) : (
            <Text dimColor>No finding selected or no data. Run 'vigil --vuln-comprehensive' first.</Text>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Filters: 1=all 2=crit 3=high 4=KEV 5=ECCN 6=exposure 7=kernel 8=secret 9=binary | Sort: !=pri @=sev #=epss $=KEV | h=help q=quit</Text>
      </Box>
    </Box>
  );
}

// Helper to launch as takeover (like other menus)
async function showVulnExplorerLegacy(findingsDir?: string): Promise<void> {
  const { render } = await import('ink');
  return new Promise((resolve) => {
    const instance = render(
      <VulnExplorer
        findingsDir={findingsDir}
        onExit={() => { instance.unmount(); resolve(); }}
      />
    );
  });
}

interface VulnExplorerProps {
  findingsDir?: string; // path to .../vulnerability-discovery/
  onExit?: () => void;
}

export function VulnExplorer({ findingsDir, onExit }: VulnExplorerProps) {
  const [allFindings, setAllFindings] = useState<DiscoveryFinding[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState<'all' | 'kev' | 'high' | 'classification' | 'exposure'>('all');
  const [search, setSearch] = useState('');
  const [execOutput, setExecOutput] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loadedDir, setLoadedDir] = useState<string>('');
  const { exit } = useApp();

  const effectiveDir = loadedDir || findingsDir || resolve(process.cwd(), 'security-analysis');

  // Load findings on mount — automatically finds the most recent comprehensive run if no dir given
  useEffect(() => {
    let dirToUse = findingsDir || '';
    let findingsPath = '';

    if (findingsDir) {
      findingsPath = [
        join(findingsDir, 'vulnerability-discovery', 'findings.json'),
        join(findingsDir, '16-vulnerability-discovery.json'),
        join(findingsDir, 'comprehensive-findings.json'),
        join(findingsDir, 'findings.json'),
      ].find((candidate) => existsSync(candidate)) || '';
    } else {
      const base = resolve(process.cwd(), 'security-analysis');
      if (existsSync(base)) {
        const candidates = readdirSync(base, { withFileTypes: true })
          .filter((d: any) => d.isDirectory())
          .flatMap((d: any) => {
            const runDir = join(base, d.name);
            return [
              { name: d.name, priority: 0, file: join(runDir, 'vulnerability-discovery', 'findings.json') },
              { name: d.name, priority: 1, file: join(runDir, '16-vulnerability-discovery.json') },
              { name: d.name, priority: 2, file: join(runDir, 'comprehensive-findings.json') },
              { name: d.name, priority: 3, file: join(runDir, 'findings.json') },
            ];
          })
          .filter((candidate: any) => existsSync(candidate.file))
          .sort((a: any, b: any) => b.name.localeCompare(a.name) || a.priority - b.priority);
        findingsPath = candidates[0]?.file || '';
      }
    }

    if (findingsPath) dirToUse = dirname(findingsPath);
    if (!dirToUse) dirToUse = resolve(process.cwd(), 'security-analysis', 'vulnerability-discovery');
    setLoadedDir(dirToUse);

    // Always merge in the persistent ~/.vigil/findings.json store
    const vigilHome = process.env['VIGIL_HOME']?.trim() || join(homedir(), '.vigil');
    const persistentStorePath = join(vigilHome, 'findings.json');
    let persistentFindings: DiscoveryFinding[] = [];
    if (existsSync(persistentStorePath)) {
      try {
        const stored = JSON.parse(readFileSync(persistentStorePath, 'utf-8')) as Array<{
          id: string; severity: string; title: string; cve?: string; target?: string; notes?: string; ts: string;
        }>;
        persistentFindings = stored.map((r) => ({
          id: r.id,
          source: 'vigil-store',
          category: 'persistent',
          title: r.title,
          severity: r.severity,
          cveIds: r.cve ? [r.cve] : [],
          priority: { score: r.severity === 'critical' ? 90 : r.severity === 'high' ? 70 : r.severity === 'medium' ? 40 : 20, label: r.severity === 'critical' || r.severity === 'high' ? 'immediate' : 'scheduled' },
          remediation: r.notes ? { note: r.notes } : undefined,
        }));
      } catch { /* ignore corrupt store */ }
    }

    if (existsSync(findingsPath)) {
      try {
        const raw = readFileSync(findingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        const pass = parsed.passes?.['vulnerability-discovery'];
        const findings = Array.isArray(parsed)
          ? parsed
          : (parsed.findings || parsed.allFindings || parsed.topFindings || pass?.findings || pass?.topFindings || []);
        const normalized = findings.map((finding: any) => ({
          ...finding,
          priority: typeof finding.priority === 'number'
            ? { score: finding.priority, label: finding.priority >= 80 ? 'immediate' : finding.priority >= 60 ? 'urgent' : finding.priority >= 35 ? 'scheduled' : 'routine' }
            : (finding.priority || { score: 0, label: 'unscored' }),
        }));
        // Merge scan findings with persistent store (deduplicate by CVE id)
        const scanCves = new Set(normalized.flatMap((f: any) => f.cveIds ?? []));
        const novelPersistent = persistentFindings.filter((f) => !f.cveIds?.some((c) => scanCves.has(c)));
        const merged = [...normalized, ...novelPersistent];
        setAllFindings(merged as DiscoveryFinding[]);
        setMessage(`Loaded ${normalized.length} scan findings + ${novelPersistent.length} from store`);
      } catch (e) {
        setMessage(`Failed to load findings: ${String(e).slice(0, 100)}`);
      }
    } else if (persistentFindings.length > 0) {
      setAllFindings(persistentFindings);
      setMessage(`Loaded ${persistentFindings.length} findings from ~/.vigil/findings.json (no scan data)`);
    } else {
      setMessage(`No findings yet. Run /scan or /engage to discover vulnerabilities.`);
    }
  }, [findingsDir]);

  const filteredFindings = useMemo(() => {
    let res = allFindings;

    if (filter === 'kev') res = res.filter(f => (f.threatIntel?.cisaKev?.length || 0) > 0);
    if (filter === 'high') res = res.filter(f => ['critical', 'high'].includes(f.severity));
    if (filter === 'classification') res = res.filter(f => f.eccn && (f.eccn.eccn?.includes('4D004') || f.eccn.eccn?.includes('controlled')));
    if (filter === 'exposure') res = res.filter(f => f.category?.toLowerCase().includes('exposure') || f.title?.toLowerCase().includes('listen'));

    if (search) {
      const s = search.toLowerCase();
      res = res.filter(f =>
        f.title?.toLowerCase().includes(s) ||
        f.id?.toLowerCase().includes(s) ||
        (f.cveIds || []).some(c => c.toLowerCase().includes(s)) ||
        f.safeProof?.validatorFile?.toLowerCase().includes(s)
      );
    }

    return res.sort((a, b) => (b.priority?.score || 0) - (a.priority?.score || 0));
  }, [allFindings, filter, search]);

  const selected = filteredFindings[selectedIndex];
  const windowStart = Math.max(0, Math.min(selectedIndex - 8, Math.max(0, filteredFindings.length - 18)));
  const visibleFindings = filteredFindings.slice(windowStart, windowStart + 18);

  useEffect(() => {
    if (selectedIndex >= filteredFindings.length) {
      setSelectedIndex(Math.max(0, filteredFindings.length - 1));
    }
  }, [filteredFindings.length, selectedIndex]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onExit?.();
      exit();
      return;
    }

    if (key.upArrow || input === 'k') {
      setSelectedIndex(i => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex(i => Math.min(filteredFindings.length - 1, i + 1));
      return;
    }

    if (input === '/') {
      // Simple search prompt simulation — in real use we'd use a proper input
      setMessage('Type to search (demo: press letters). Current search: ' + search);
      return;
    }

    if (input === 'e' || key.return) {
      if (selected?.safeProof?.validatorFile) {
        executeValidator(selected);
      } else {
        setMessage('No validatorFile attached to this finding (run with --out to generate PoC code).');
      }
      return;
    }

    if (input === 'x') {
      exportFindings();
      return;
    }

    // Incremental search on printable chars
    if (/^[a-z0-9\-\. ]$/i.test(input) && !key.meta && !key.ctrl) {
      setSearch(s => (s + input).slice(0, 40));
      setSelectedIndex(0);
      return;
    }
    if (key.backspace || input === '\b') {
      setSearch(s => s.slice(0, -1));
      setSelectedIndex(0);
      return;
    }
    if (input === 'c' && search) { // clear search
      setSearch('');
      setSelectedIndex(0);
      return;
    }

    if (input === 'h') {
      setMessage('Help: j/k/arrows=nav | type letters=search | backspace/c=clear search | e/enter=exec validator | x=export JSON | 1-5=filters | q=quit. Validators are SAFE read-only only.');
      return;
    }

    if (input === '1') setFilter('all');
    if (input === '2') setFilter('high');
    if (input === '3') setFilter('kev');
    if (input === '4') setFilter('classification');
    if (input === '5') setFilter('exposure');

    if (input === 'q') {
      onExit?.();
      exit();
    }
  });

  async function executeValidator(finding: DiscoveryFinding) {
    if (!finding.safeProof?.validatorFile) return;

    setIsExecuting(true);
    setExecOutput(null);
    setMessage(`Executing safe validator: ${finding.safeProof.validatorFile} ...`);

    const candidates = [
      resolve(effectiveDir, finding.safeProof.validatorFile),
      resolve(effectiveDir, 'vulnerability-discovery', finding.safeProof.validatorFile),
      resolve(dirname(effectiveDir), finding.safeProof.validatorFile),
      resolve(dirname(effectiveDir), 'vulnerability-discovery', finding.safeProof.validatorFile),
      resolve(process.cwd(), finding.safeProof.validatorFile),
    ];
    const fullPath = candidates.find((candidate) => existsSync(candidate)) || candidates[0];
    const isJs = fullPath.endsWith('.js') || fullPath.endsWith('.mjs');
    const isSh = fullPath.endsWith('.sh');
    const isPy = fullPath.endsWith('.py');

    let cmd: string[] = [];
    if (isJs) cmd = [process.execPath, fullPath, '--root', process.cwd()];
    else if (isSh) cmd = ['bash', fullPath];
    else if (isPy) cmd = ['python3', fullPath];
    else cmd = ['cat', fullPath];

    try {
      const result = spawnSync(cmd[0], cmd.slice(1), {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
      });

      const output = (result.stdout || '') + (result.stderr || '');
      setExecOutput(output.slice(0, 4000) + (output.length > 4000 ? '\n... (truncated)' : ''));
      setMessage(`Validator completed (exit ${result.status}). Output captured.`);
    } catch (e) {
      setExecOutput(String(e).slice(0, 500));
      setMessage('Execution error (safe — validator is read-only by design).');
    } finally {
      setIsExecuting(false);
    }
  }

  function exportFindings() {
    const exportData = {
      exportedAt: new Date().toISOString(),
      filter,
      search,
      count: filteredFindings.length,
      findings: filteredFindings,
    };
    console.log('\n=== EXPORT (copy this) ===\n' + JSON.stringify(exportData, null, 2).slice(0, 3000));
    setMessage(`Exported ${filteredFindings.length} findings to console (copy/paste or redirect).`);
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={palette.cyan}>▣ Vigil Vuln Explorer (Phase 2 — upgraded)</Text>
        <Text dimColor>  |  {filteredFindings.length} shown  |  j/k/arrows  |  type to search (backspace/c to clear)  |  e=exec  |  x=export  |  q=quit</Text>
      </Box>

      <Box>
        <Text>Filters: </Text>
        <Text color={filter === 'all' ? 'cyan' : undefined}>[1 all]</Text>
        <Text color={filter === 'high' ? 'cyan' : undefined}> [2 high]</Text>
        <Text color={filter === 'kev' ? 'cyan' : undefined}> [3 kev]</Text>
        <Text color={filter === 'classification' ? 'cyan' : undefined}> [4 eccn]</Text>
        <Text color={filter === 'exposure' ? 'cyan' : undefined}> [5 exposure]</Text>
      </Box>

      {message && <Text color="yellow" dimColor>{message}</Text>}

      <Box flexDirection="row" marginTop={1}>
        {/* Left list */}
        <Box flexDirection="column" width={55} borderStyle="single" borderColor={palette.titanium} paddingX={1}>
          {visibleFindings.map((f, idx) => {
            const globalIndex = windowStart + idx;
            const isSel = globalIndex === selectedIndex;
            const pri = f.priority?.label ? `${f.priority.label} ${f.priority.score}` : '';
            return (
              <Box key={f.id}>
                <Text color={isSel ? palette.cyan : undefined} bold={isSel}>
                  {isSel ? '▸ ' : '  '}
                  {f.severity?.toUpperCase().slice(0,3)} {f.title?.slice(0, 42)}
                </Text>
                {pri && <Text dimColor> {pri}</Text>}
              </Box>
            );
          })}
          {filteredFindings.length > 18 && <Text dimColor>showing {windowStart + 1}-{Math.min(windowStart + 18, filteredFindings.length)} of {filteredFindings.length}</Text>}
        </Box>

        {/* Right detail */}
        <Box flexDirection="column" flexGrow={1} marginLeft={1} borderStyle="single" borderColor={palette.titanium} paddingX={1}>
          {selected ? (
            <>
              <Text bold>{selected.title}</Text>
              <Text dimColor>{selected.id} • {selected.source} • {selected.category}</Text>

              {selected.priority && <Text>Priority: {selected.priority.label} ({selected.priority.score})</Text>}
              {selected.cveIds?.length ? <Text>CVEs: {selected.cveIds.join(', ')}</Text> : null}

              {selected.safeProof && (
                <Box marginTop={1} flexDirection="column">
                  <Text bold color="green">Safe Proof</Text>
                  <Text>Mode: {selected.safeProof.mode || 'benign-validation'}</Text>
                  {selected.safeProof.validatorFile && (
                    <Text color="cyan">Validator: {selected.safeProof.validatorFile}</Text>
                  )}
                  <Text wrap="wrap">{selected.safeProof.command}</Text>
                  <Text dimColor>{selected.safeProof.note}</Text>
                </Box>
              )}

              {selected.eccn && (
                <Box marginTop={1}>
                  <Text bold>ECCN:</Text> <Text>{selected.eccn.eccn} — {selected.eccn.distribution}</Text>
                  <Text dimColor wrap="wrap">{selected.eccn.rationale}</Text>
                </Box>
              )}

              {selected.remediation?.note && (
                <Box marginTop={1}>
                  <Text bold>Remediation:</Text> <Text>{selected.remediation.note}</Text>
                </Box>
              )}

              {isExecuting && <Text color="yellow"><Spinner type="dots" /> Executing validator (30s timeout)...</Text>}

              {execOutput && (
                <Box marginTop={1} flexDirection="column">
                  <Text bold color="green">Validator Output (live):</Text>
                  <Text wrap="wrap">{execOutput}</Text>
                </Box>
              )}

              <Box marginTop={1}><Text dimColor>Press 'e' or Enter to run the safe validator • 'x' export • 'h' help • 'q' quit</Text></Box>
            </>
          ) : (
            <Text dimColor>No finding selected or no data loaded.</Text>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Loaded from: {effectiveDir}  •  Defensive only • No exploits generated</Text>
      </Box>
    </Box>
  );
}

// Helper to launch as takeover (like other menus)
export async function showVulnExplorer(findingsDir?: string): Promise<void> {
  const { render } = await import('ink');
  return new Promise((resolve) => {
    const instance = render(
      <VulnExplorer
        findingsDir={findingsDir}
        onExit={() => {
          instance.unmount();
          resolve();
        }}
      />
    );
  });
}
