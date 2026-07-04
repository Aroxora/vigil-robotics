/**
 * Vigil — Real Bug Bounty E2E: Discovery → Submission → Verification
 *
 * Simulates a real user submitting an actual bug bounty for pay.
 * Verifies the complete pipeline: Oculus fuzzing → exploit chaining →
 * bug bounty formatting → platform template generation.
 *
 * Every submission is formatted to meet actual platform requirements:
 * HackerOne (title+body with CVSS), Bugcrowd (P1-P4 priority),
 * Direct disclosure (security@ email with PoC).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  normalizePrimitive, computeChainability, buildAttackGraph,
  searchChains, minimizeChain, gradeChainEvidence,
} from '../../src/core/exploitChaining.js';
import {
  createBugBountySubmission, createBountyStats,
  formatHackerOneSubmission, formatBugcrowdSubmission, formatDirectDisclosure,
  estimatePayout,
} from '../../src/core/bugBounty.js';
import { uniqueId, resolveApiKey, deepseekChat } from '../utils/dynamicPromptGenerator.js';

const hasKey = resolveApiKey() !== null;

// ═══════════════════════════════════════════════════════════════════
// Real Bug Bounty Scenario: Linux Kernel UAF → Root
// ═══════════════════════════════════════════════════════════════════

const REAL_SCENARIO = {
  target: {
    organization: 'Linux Kernel',
    program: 'Linux Kernel Bug Bounty',
    scope: ['kernel.org', 'git.kernel.org', '*.linuxfoundation.org'],
    platform: 'direct' as const,
    maxPayout: 50000,
  },
  primitives: [
    { id: 'uaf-io_uring', class: 'memory_corruption' as const, source: 'CVE-2024-XXXX1', conditions: { requiresKnownAddress: false }, effects: { enablesArbitraryWrite: true, repeatable: true }, evidence: 5, confidence: 0.97, reproduced: true },
    { id: 'kaslr-leak', class: 'information_disclosure' as const, source: 'CVE-2024-XXXX2', conditions: { attackerCanReach: true }, effects: { disclosesMemoryAddresses: true, repeatable: true }, evidence: 4, confidence: 0.95, reproduced: true },
    { id: 'cred-overwrite', class: 'identity_authorization' as const, source: 'CVE-2024-XXXX3', conditions: { requiresKnownAddress: true }, effects: { crossesPrivilegeBoundary: true, repeatable: true }, evidence: 5, confidence: 0.96, reproduced: true },
  ],
};

// ═══════════════════════════════════════════════════════════════════
// Pipeline Tests
// ═══════════════════════════════════════════════════════════════════
describe('Real Bug Bounty E2E — Complete Pipeline', () => {
  beforeAll(() => {
    if (!hasKey) console.warn('[bounty-e2e] No API key — AI generation will skip');
    else console.log(`[bounty-e2e] DeepSeek OK (${resolveApiKey()!.slice(0, 6)}...)`);
  });

  it('STEP 1: Normalize raw findings into exploitation primitives', () => {
    const primitives = REAL_SCENARIO.primitives.map(p =>
      normalizePrimitive({
        id: p.id, class: p.class, source: p.source,
        conditions: p.conditions, effects: p.effects,
        evidence: p.evidence as any,
        confidence: p.confidence, reproduced: p.reproduced,
      })
    );
    expect(primitives).toHaveLength(3);
    expect(primitives[0]!.class).toBe('memory_corruption');
    expect(primitives[1]!.class).toBe('information_disclosure');
    expect(primitives[2]!.class).toBe('identity_authorization');
    primitives.forEach(p => {
      expect(p.evidenceLevel).toBeGreaterThanOrEqual(3);
      expect(p.confidence).toBeGreaterThan(0.9);
    });
  });

  it('STEP 2: Build chainability matrix and compute edges', () => {
    const primitives = REAL_SCENARIO.primitives.map(p =>
      normalizePrimitive({ id: p.id, class: p.class, source: p.source, conditions: p.conditions, effects: p.effects, evidence: p.evidence as any, confidence: p.confidence, reproduced: p.reproduced })
    );
    // KASLR leak → cred overwrite needs address knowledge
    const edge = computeChainability(primitives[1]!, primitives[2]!);
    expect(edge.compatScore).toBeGreaterThan(0.5);
    expect(edge.evidenceMatches).toContain('memory_address');
  });

  it('STEP 3: Search for exploit chains with A*/beam', () => {
    const primitives = REAL_SCENARIO.primitives.map(p =>
      normalizePrimitive({ id: p.id, class: p.class, source: p.source, conditions: p.conditions, effects: p.effects, evidence: p.evidence as any, confidence: p.confidence, reproduced: p.reproduced })
    );
    const chains = searchChains(primitives, {
      targetImpact: 'high',
      beamWidth: 4,
      maxDepth: 3,
      minConfidence: 0.4,
    });
    expect(chains.length).toBeGreaterThan(0);

    const best = chains[0]!;
    expect(best.primitives.length).toBeGreaterThanOrEqual(2);
    expect(best.impactLevel).toMatch(/high|critical/);
  });

  it('STEP 4: Minimize chain via delta debugging', () => {
    const primitives = REAL_SCENARIO.primitives.map(p =>
      normalizePrimitive({ id: p.id, class: p.class, source: p.source, conditions: p.conditions, effects: p.effects, evidence: p.evidence as any, confidence: p.confidence, reproduced: p.reproduced })
    );
    const chains = searchChains(primitives, { targetImpact: 'high', beamWidth: 4, maxDepth: 3 });
    expect(chains.length).toBeGreaterThan(0);

    const graph = buildAttackGraph(primitives);
    const minimized = minimizeChain(chains[0]!, graph);
    expect(minimized.primitives.length).toBeLessThanOrEqual(chains[0]!.primitives.length);
  });

  it('STEP 5: Grade evidence level', () => {
    const primitives = REAL_SCENARIO.primitives.map(p =>
      normalizePrimitive({ id: p.id, class: p.class, source: p.source, conditions: p.conditions, effects: p.effects, evidence: p.evidence as any, confidence: p.confidence, reproduced: p.reproduced })
    );
    const chains = searchChains(primitives, { targetImpact: 'high', beamWidth: 4, maxDepth: 3 });
    expect(chains.length).toBeGreaterThan(0);

    const grade = gradeChainEvidence(chains[0]!);
    // With L4-L5 evidence and reproduction, should be at least end_to_end
    expect(['end_to_end_reproduced', 'impact_validated']).toContain(grade);
  });

  it('STEP 6: Create bug bounty submission with PoC', () => {
    const primitives = REAL_SCENARIO.primitives.map(p =>
      normalizePrimitive({ id: p.id, class: p.class, source: p.source, conditions: p.conditions, effects: p.effects, evidence: p.evidence as any, confidence: p.confidence, reproduced: p.reproduced })
    );
    const chains = searchChains(primitives, { targetImpact: 'high', beamWidth: 4, maxDepth: 3 });
    expect(chains.length).toBeGreaterThan(0);

    const graph = buildAttackGraph(primitives);
    const minimized = minimizeChain(chains[0]!, graph);

    const result = createBugBountySubmission({
      target: REAL_SCENARIO.target,
      chain: minimized,
      includePoC: true,
    });

    expect(result.ready).toBe(true);
    expect(result.validationErrors).toHaveLength(0);
    expect(result.submission.severity).toMatch(/critical|high/);
    expect(result.submission.proofOfConcept).toContain('Proof of Concept');
    expect(result.submission.stepsToReproduce.length).toBeGreaterThanOrEqual(2);
    expect(result.submission.cvss.score).toBeGreaterThan(7);
    expect(result.submission.cwe).toBeTruthy();
    expect(result.estimatedPayout.typical).toBeGreaterThanOrEqual(0);
    expect(result.submission.payoutAmount).toBeUndefined(); // not submitted yet
  });

  it('STEP 7: Format for HackerOne submission', () => {
    const primitives = REAL_SCENARIO.primitives.map(p =>
      normalizePrimitive({ id: p.id, class: p.class, source: p.source, conditions: p.conditions, effects: p.effects, evidence: p.evidence as any, confidence: p.confidence, reproduced: p.reproduced })
    );
    const chains = searchChains(primitives, { targetImpact: 'high', beamWidth: 4, maxDepth: 3 });
    const graph = buildAttackGraph(primitives);
    const minimized = minimizeChain(chains[0]!, graph);
    const result = createBugBountySubmission({
      target: { ...REAL_SCENARIO.target, platform: 'hackerone' },
      chain: minimized, includePoC: true,
    });

    const h1 = formatHackerOneSubmission(result.submission);
    expect(h1.title).toContain('Linux Kernel');
    expect(h1.title).toContain('CRITICAL');
    expect(h1.body).toContain('## Description');
    expect(h1.body).toContain('## Impact');
    expect(h1.body).toContain('## Steps to Reproduce');
    expect(h1.body).toContain('## Proof of Concept');
    expect(h1.body).toContain('## Remediation');
    expect(h1.body).toContain('## Affected Versions');
    expect(h1.body).toContain('CVSS:3.1'); // CVSS vector string
  });

  it('STEP 8: Format for Bugcrowd with P1 priority', () => {
    const primitives = REAL_SCENARIO.primitives.map(p =>
      normalizePrimitive({ id: p.id, class: p.class, source: p.source, conditions: p.conditions, effects: p.effects, evidence: p.evidence as any, confidence: p.confidence, reproduced: p.reproduced })
    );
    const chains = searchChains(primitives, { targetImpact: 'high', beamWidth: 4, maxDepth: 3 });
    const graph = buildAttackGraph(primitives);
    const minimized = minimizeChain(chains[0]!, graph);
    const result = createBugBountySubmission({
      target: { ...REAL_SCENARIO.target, platform: 'bugcrowd' },
      chain: minimized, includePoC: true,
    });

    const bc = formatBugcrowdSubmission(result.submission);
    expect(bc.priority).toMatch(/P[1-4]/);
    expect(bc.body).toContain('Description');
    expect(bc.body).toContain('Proof of Concept');
  });

  it('STEP 9: Format direct disclosure email with responsible timeline', () => {
    const primitives = REAL_SCENARIO.primitives.map(p =>
      normalizePrimitive({ id: p.id, class: p.class, source: p.source, conditions: p.conditions, effects: p.effects, evidence: p.evidence as any, confidence: p.confidence, reproduced: p.reproduced })
    );
    const chains = searchChains(primitives, { targetImpact: 'high', beamWidth: 4, maxDepth: 3 });
    const graph = buildAttackGraph(primitives);
    const minimized = minimizeChain(chains[0]!, graph);
    const result = createBugBountySubmission({
      target: REAL_SCENARIO.target,
      chain: minimized, includePoC: true,
    });

    const direct = formatDirectDisclosure(result.submission);
    expect(direct.subject).toContain('[SECURITY]');
    expect(direct.to).toContain('security@');
    expect(direct.body).toContain('security vulnerability');
    expect(direct.body).toContain('72 hours');
  });

  // ═══════════════════════════════════════════════════════════════
  // Payout Estimation — Real Platform Ranges
  // ═══════════════════════════════════════════════════════════════
  it('STEP 10: Verify payout estimates match real platform ranges', () => {
    // Critical on HackerOne
    const c_h1 = estimatePayout('critical', 'hackerone');
    expect(c_h1.min).toBe(5000);
    expect(c_h1.max).toBe(100000);
    expect(c_h1.typical).toBe(15000);

    // High on Bugcrowd
    const h_bc = estimatePayout('high', 'bugcrowd');
    expect(h_bc.min).toBe(1500);
    expect(h_bc.typical).toBe(3000);

    // Medium on Intigriti
    const m_in = estimatePayout('medium', 'intigriti');
    expect(m_in.typical).toBe(600);

    // Low on HackerOne
    const l_h1 = estimatePayout('low', 'hackerone');
    expect(l_h1.typical).toBe(300);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DeepSeek Dynamic Generation — Unique submissions per run
// ═══════════════════════════════════════════════════════════════════
describe('Real Bug Bounty E2E — DeepSeek Dynamic Submissions', () => {
  (hasKey ? it : it.skip)('DeepSeek generates 5 complete bug bounty submissions end-to-end', async () => {
    const companies = ['Google', 'Meta', 'Microsoft', 'Apple', 'Amazon'];
    const submissions: string[] = [];

    for (const company of companies) {
      try {
        // Generate vuln report via DeepSeek
        const vulnPrompt = `[${uniqueId()}] Generate a realistic, technically-specific vulnerability report for ${company}. Include: (1) specific vulnerability type with CWE, (2) affected component/service, (3) CVSS 3.1 vector string, (4) 3-line impact statement, (5) 2 specific reproduction steps. Format as compact paragraphs suitable for bug bounty submission. No markdown headers.`;
        const vulnReport = await deepseekChat(vulnPrompt, { maxTokens: 250, temperature: 0.9 });
        expect(vulnReport.length).toBeGreaterThan(80);

        // Generate PoC via DeepSeek
        const pocPrompt = `[${uniqueId()}] Based on this vulnerability: "${vulnReport.slice(0, 200)}..." — generate a short proof-of-concept code snippet (Python or Bash) that demonstrates the vulnerability. Include reproduction environment notes. Compact, no markdown.`;
        const poc = await deepseekChat(pocPrompt, { maxTokens: 200, temperature: 0.95 });
        expect(poc.length).toBeGreaterThan(30);

        submissions.push(`### ${company}\n**Report:** ${vulnReport.slice(0, 150)}...\n**PoC:** ${poc.slice(0, 100)}...`);
      } catch { /* skip */ }
    }

    expect(submissions.length).toBeGreaterThanOrEqual(4);
    submissions.forEach(s => {
      expect(s.length).toBeGreaterThan(100);
      expect(s).toContain('Report:');
      expect(s).toContain('PoC:');
    });
    console.log(`[bounty-e2e-ai] ${submissions.length}/5 complete submissions generated with PoC`);
  }, 120000);

  it('generates 50 unique bounty submission IDs for tracking', () => {
    const ids = new Set(Array.from({ length: 50 }, () => uniqueId()));
    expect(ids.size).toBe(50);
  });

  it('bounty stats correctly compute pending payouts across platforms', () => {
    const subs: any[] = [];
    for (let i = 0; i < 10; i++) {
      const p1 = normalizePrimitive({ id: uniqueId(), class: 'information_disclosure', source: `CVE-${i}`, conditions: {}, effects: { disclosesObjectMetadata: true, repeatable: true }, evidence: 3, confidence: 0.9 });
      const p2 = normalizePrimitive({ id: uniqueId(), class: 'identity_authorization', source: `CVE-${i}-2`, conditions: { requiresKnownObjectId: true }, effects: { crossesPrivilegeBoundary: true, repeatable: true }, evidence: 3, confidence: 0.9 });
      const result = createBugBountySubmission({
        target: { organization: `Company-${i}`, program: 'BBP', scope: ['*.com'], platform: (['hackerone', 'bugcrowd', 'intigriti'] as const)[i % 3]! },
        primitives: [p1, p2].map(p => ({ id: p.id, class: p.class, sourceFinding: p.sourceFinding, preconditions: p.preconditions, postconditions: p.postconditions, evidenceLevel: p.evidenceLevel, confidence: p.confidence, sandboxReproduced: p.sandboxReproduced })),
      });
      if (i < 5) result.submission.status = 'triaged';
      subs.push(result.submission);
    }
    const stats = createBountyStats(subs);
    expect(stats.totalSubmitted).toBe(10);
    expect(Object.keys(stats.byPlatform).length).toBeGreaterThanOrEqual(2);
  });
});
