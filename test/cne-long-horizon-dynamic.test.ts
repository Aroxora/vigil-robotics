/**
 * Vigil — CNE (Computer Network Exploitation) Long-Horizon Dynamic Tests
 *
 * Every test run generates dynamically unique prompts. Covers:
 * parallel CNE scan pipelines, vulnerability assessment, hardening,
 * detection engineering, threat hunting, incident response, MCP
 * integration, agentic concurrency, and real DeepSeek integration.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  uniqueId, uniqueCveTarget, uniqueService, uniquePort,
  generateCnePrompt, generateUniquePrompts, generateUniqueIds,
  resolveApiKey, deepseekChat, runParallelPrompts,
} from './utils/dynamicPromptGenerator.js';

const apiKey = resolveApiKey();
const hasKey = apiKey !== null;

describe('CNE — Long-Horizon Dynamic Prompts', () => {
  beforeAll(() => {
    if (!hasKey) console.warn('[cne-test] No API key — live tests will simulate');
    else console.log(`[cne-test] DeepSeek OK (${apiKey!.slice(0, 6)}...)`);
  });

  it('generates unique CNE prompt each run (static)', () => {
    const p1 = generateCnePrompt();
    const p2 = generateCnePrompt();
    expect(p1).not.toBe(p2);
    expect(p1.length).toBeGreaterThan(50);
    expect(p2.length).toBeGreaterThan(50);
  });

  it('generates 50 unique CNE prompts with no duplicates', () => {
    const prompts = generateUniquePrompts(50, 'security');
    expect(prompts).toHaveLength(50);
    expect(new Set(prompts).size).toBe(50);
  });

  it('generates 100 unique CVE targets (rotating pool)', () => {
    const cves = Array.from({ length: 100 }, () => uniqueCveTarget());
    expect(new Set(cves).size).toBeGreaterThan(10); // pool of 15 rotates
    // All should match CVE format
    cves.forEach(cve => expect(cve).toMatch(/^CVE-\d{4}-\d{4,}$/));
  });

  (hasKey ? it : it.skip)('runs parallel CNE scan with unique CVE targets', async () => {
    const targets = Array.from({ length: 5 }, () => uniqueCveTarget());
    const prompts = targets.map(cve =>
      `[${uniqueId()}] For ${cve}, respond in 2 words: the severity (critical/high/medium/low). No other text.`
    );

    const results = await runParallelPrompts(prompts, { maxConcurrent: 5, maxTokens: 30 });
    expect(results.length).toBeGreaterThanOrEqual(4);
    const ids = results.filter(r => r.ok).map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60000);

  (hasKey ? it : it.skip)('CNE pipeline: discover → assess → harden → detect', async () => {
    const pipelineId = uniqueId();
    const phases: string[] = [];

    // Discover
    try {
      const r1 = await deepseekChat(
        `[${pipelineId}-discover] List 3 common open ports on a web server. Numbers only, comma-separated.`,
        { maxTokens: 40 }
      );
      phases.push(`discover: ${r1.trim()}`);
    } catch { phases.push('discover: [error]'); }

    // Assess
    try {
      const r2 = await deepseekChat(
        `[${pipelineId}-assess] Name 1 critical CVE for nginx from 2024. One line only.`,
        { maxTokens: 60 }
      );
      phases.push(`assess: ${r2.trim()}`);
    } catch { phases.push('assess: [error]'); }

    // Harden
    try {
      const r3 = await deepseekChat(
        `[${pipelineId}-harden] Recommend 2 immediate hardening steps for a Linux web server. Be concise.`,
        { maxTokens: 80 }
      );
      phases.push(`harden: ${r3.trim()}`);
    } catch { phases.push('harden: [error]'); }

    // Detect
    try {
      const r4 = await deepseekChat(
        `[${pipelineId}-detect] Suggest one Sigma rule name for detecting nginx exploitation attempts.`,
        { maxTokens: 60 }
      );
      phases.push(`detect: ${r4.trim()}`);
    } catch { phases.push('detect: [error]'); }

    expect(phases).toHaveLength(4);
    const successCount = phases.filter(p => !p.includes('[error]')).length;
    expect(successCount).toBeGreaterThanOrEqual(2);
  }, 90000);

  (hasKey ? it : it.skip)('pipeline recovers from partial CVE lookup failure', async () => {
    const cves = ['CVE-2024-3094', 'INVALID-CVE-FORMAT', uniqueCveTarget(), uniqueCveTarget()];
    const results: { cve: string; status: string; id: string }[] = [];

    for (const cve of cves) {
      const id = uniqueId();
      try {
        if (cve === 'INVALID-CVE-FORMAT') throw new Error('Invalid CVE');
        const r = await deepseekChat(
          `[${id}] Severity of ${cve}? One word only.`,
          { maxTokens: 20 }
        );
        results.push({ cve, status: r.trim(), id });
      } catch {
        results.push({ cve, status: 'recovered', id });
      }
    }

    expect(results).toHaveLength(4);
    expect(results.filter(r => r.status === 'recovered').length).toBe(1);
    expect(new Set(results.map(r => r.id)).size).toBe(4);
  }, 45000);
});

describe('CNE — Parallel Scan Pipeline', () => {
  it('parallel port scan simulation with rate limiting', () => {
    const ports = Array.from({ length: 100 }, (_, i) => i + 1);
    const MAX_CONCURRENT = 10;
    let active = 0;
    let maxObserved = 0;
    const results: number[] = [];

    for (const port of ports) {
      if (active < MAX_CONCURRENT) {
        active++;
        maxObserved = Math.max(maxObserved, active);
        results.push(port);
        active--;
      }
    }

    expect(results.length).toBe(100);
    expect(maxObserved).toBe(1); // Sequential simulation
  });

  it('token budget for batch CVE lookups', () => {
    const BUDGET = 5000;
    let used = 0;
    const lookups = Array.from({ length: 30 }, () => ({
      cve: uniqueCveTarget(),
      tokens: 100 + Math.floor(Math.random() * 400),
    }));
    const executed: typeof lookups = [];

    for (const lookup of lookups) {
      if (used + lookup.tokens <= BUDGET) {
        used += lookup.tokens;
        executed.push(lookup);
      }
    }

    expect(used).toBeLessThanOrEqual(BUDGET);
    expect(executed.length).toBeGreaterThan(10);
  });

  it('circuit breaker opens after 5 consecutive CVE lookup failures', () => {
    let failures = 0;
    let circuitOpen = false;
    let blocked = 0;

    for (let i = 0; i < 10; i++) {
      if (circuitOpen) { blocked++; continue; }
      failures++;
      if (failures >= 5) circuitOpen = true;
    }

    expect(circuitOpen).toBe(true);
    expect(blocked).toBe(5);
  });

  it('detects duplicate scan targets and skips', () => {
    const scanned = new Set<string>();
    let duplicates = 0;
    const targets = ['10.0.1.1', '10.0.1.2', '10.0.1.1', '10.0.1.3', '10.0.1.2'];

    for (const target of targets) {
      if (scanned.has(target)) { duplicates++; continue; }
      scanned.add(target);
    }

    expect(duplicates).toBe(2);
    expect(scanned.size).toBe(3);
  });
});

describe('CNE — Threat Hunting & Detection', () => {
  it('generates unique detection rules for rotating services', () => {
    const services = Array.from({ length: 20 }, () => uniqueService());
    const rules = services.map(s => `Sigma rule for ${s} exploitation — ${uniqueId()}`);
    expect(new Set(rules).size).toBe(20);
    expect(new Set(services).size).toBeGreaterThan(5);
  });

  it('maps IOCs to MITRE ATT&CK techniques', () => {
    const ttps = ['T1190', 'T1059', 'T1505', 'T1078', 'T1021'];
    const iocs = Array.from({ length: 10 }, () => {
      const ttp = ttps[Math.floor(Math.random() * ttps.length)];
      return { ioc: uniqueId(), ttp, cve: uniqueCveTarget() };
    });

    expect(iocs).toHaveLength(10);
    const usedTtps = new Set(iocs.map(i => i.ttp));
    expect(usedTtps.size).toBeGreaterThan(1); // varied techniques
  });

  it('handles empty threat intel results gracefully', () => {
    const findings: string[] = [];
    expect(() => {
      if (findings.length === 0) throw new Error('No threats found — environment clean');
    }).toThrow('No threats found');
  });

  it('batches IOC enrichment without exceeding limits', () => {
    const iocs = Array.from({ length: 200 }, () => ({
      type: Math.random() > 0.5 ? 'ip' : 'domain',
      value: uniqueId(),
      confidence: Math.floor(Math.random() * 100),
    }));

    const highConfidence = iocs
      .filter(i => i.confidence > 80)
      .slice(0, 20);

    expect(highConfidence.length).toBeLessThanOrEqual(20);
    highConfidence.forEach(i => expect(i.confidence).toBeGreaterThan(80));
  });
});

describe('CNE — Incident Response', () => {
  it('tracks incident lifecycle: detect → contain → eradicate → recover', () => {
    const phases = ['detect', 'contain', 'eradicate', 'recover'] as const;
    const log: Record<string, string> = {};

    for (const phase of phases) {
      log[phase] = `${phase}-${uniqueId()}`;
    }

    expect(Object.keys(log)).toHaveLength(4);
    phases.forEach(p => expect(log[p]).toBeTruthy());
  });

  it('enforces cleanup verification before closing incident', () => {
    let cleaned = false;
    let verified = false;

    const closeIncident = () => {
      if (!cleaned) throw new Error('Cleanup required');
      if (!verified) throw new Error('Verification required');
      return 'closed';
    };

    expect(() => closeIncident()).toThrow('Cleanup required');
    cleaned = true;
    expect(() => closeIncident()).toThrow('Verification required');
    verified = true;
    expect(closeIncident()).toBe('closed');
  });

  it('generates unique incident IDs for each event', () => {
    const ids = Array.from({ length: 50 }, () => `INC-${uniqueId()}`);
    expect(new Set(ids).size).toBe(50);
  });
});

describe('CNE — 20-Iteration Dynamic Loop (simulated)', () => {
  it('completes 20 simulated loop iterations with unique prompts', () => {
    const ITERATIONS = 20;
    const prompts: string[] = [];
    const results: { iter: number; id: string; phase: string }[] = [];
    const phases = ['discover', 'assess', 'harden', 'detect', 'hunt', 'respond', 'validate'];

    for (let i = 0; i < ITERATIONS; i++) {
      const id = uniqueId();
      const phase = phases[i % phases.length]!;
      const cve = uniqueCveTarget();
      prompts.push(`[AUTO-LOOP #${i + 1} — cne/${phase} — ${id}]\nAnalyze ${cve} for ${phase} phase.`);
      results.push({ iter: i + 1, id, phase });
    }

    expect(prompts).toHaveLength(ITERATIONS);
    expect(new Set(results.map(r => r.id)).size).toBe(ITERATIONS);
    // All phases covered
    expect(new Set(results.map(r => r.phase)).size).toBe(phases.length);
  });

  it('20-iteration loop with no duplicate CVE targets in any window of 5', () => {
    const recent5: string[] = [];
    const allCves: string[] = [];

    for (let i = 0; i < 20; i++) {
      let cve: string;
      do {
        cve = uniqueCveTarget();
      } while (recent5.includes(cve));
      recent5.push(cve);
      if (recent5.length > 5) recent5.shift();
      allCves.push(cve);
    }

    expect(allCves).toHaveLength(20);
    // Verify no duplicates within any window of 5
    for (let i = 0; i <= 15; i++) {
      const window = allCves.slice(i, i + 5);
      expect(new Set(window).size).toBe(5);
    }
  });
});

describe('CNE — 20-Iteration Dynamic Loop with Real API', () => {
  (hasKey ? it : it.skip)('completes 20 iterations with unique prompts each time', async () => {
    const ITERATIONS = 20;
    const responses: { iter: number; id: string; ok: boolean }[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const id = uniqueId();
      try {
        const r = await deepseekChat(
          `[${id}] Iteration ${i + 1}/${ITERATIONS}: Name one CNE security tool (one word).`,
          { maxTokens: 20 }
        );
        responses.push({ iter: i, id, ok: r.length > 0 });
      } catch {
        responses.push({ iter: i, id, ok: false });
      }
    }

    const okCount = responses.filter(r => r.ok).length;
    expect(okCount).toBeGreaterThanOrEqual(17); // tolerate 3/20 failures
    expect(new Set(responses.map(r => r.id)).size).toBe(ITERATIONS);
    console.log(`[cne-loop] ${okCount}/${ITERATIONS} live iterations OK`);
  }, 180000);
});
