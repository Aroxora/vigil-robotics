/**
 * Vigil Bug Bounty Engine — Extreme Horizon Tests
 *
 * Tests automated vulnerability discovery → bounty submission pipeline.
 * Every test generates uniquely via deepseek-v4-pro where applicable.
 * Covers: CVSS scoring, payout estimation, platform templates, chain→bounty formatting.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  createBugBountySubmission, createBountyStats,
  formatHackerOneSubmission, formatBugcrowdSubmission, formatDirectDisclosure,
  estimatePayout,
} from '../../src/core/bugBounty.js';
import {
  normalizePrimitive, computeChainability, buildAttackGraph, searchChains, minimizeChain,
} from '../../src/core/exploitChaining.js';
import { uniqueId, resolveApiKey, deepseekChat } from '../utils/dynamicPromptGenerator.js';

const hasKey = resolveApiKey() !== null;

const TEST_TARGET: BountyTarget = {
  organization: 'ExampleCorp',
  program: 'ExampleCorp Bug Bounty',
  scope: ['example.com', '*.example.com', 'api.example.com'],
  platform: 'hackerone',
  platformUrl: 'https://hackerone.com/examplecorp',
  maxPayout: 50000,
};

function makeChain(impact: string = 'high'): ExploitChain {
  const p1 = normalizePrimitive({ id: uniqueId(), class: 'information_disclosure', source: 'CVE-2024-3094', conditions: {}, effects: { disclosesObjectMetadata: true, repeatable: true }, evidence: 4, confidence: 0.95, reproduced: true });
  const p2 = normalizePrimitive({ id: uniqueId(), class: 'identity_authorization', source: 'CVE-2024-6387', conditions: { requiresKnownObjectId: true }, effects: { crossesPrivilegeBoundary: true, repeatable: true }, evidence: 4, confidence: 0.9, reproduced: true });
  const p3 = normalizePrimitive({ id: uniqueId(), class: 'isolation_escape', source: 'CVE-2024-4577', conditions: {}, effects: { crossesIsolationBoundary: true, repeatable: true }, evidence: 3, confidence: 0.85, reproduced: true });
  return {
    id: `CHAIN-${uniqueId()}`, primitives: [p1, p2, p3],
    edges: [computeChainability(p1, p2), computeChainability(p2, p3)],
    status: 'end_to_end_reproduced', totalConfidence: 0.73, assumptionDebt: 1,
    impactLevel: impact as any, minimizedFrom: 3, patchPoints: ['fix:shared_precondition:requiresKnownObjectId'],
  };
}

describe('Bug Bounty Engine — Submission Formatting', () => {
  it('creates a valid bug bounty submission from an exploit chain', () => {
    const chain = makeChain('critical');
    const result = createBugBountySubmission({ target: TEST_TARGET, chain });
    expect(result.ready).toBe(true);
    expect(result.validationErrors).toHaveLength(0);
    expect(result.submission.severity).toBe('critical');
    expect(result.submission.title).toContain('ExampleCorp');
    expect(result.submission.cvss.score).toBeGreaterThan(8);
    expect(result.submission.stepsToReproduce.length).toBe(3);
  });

  it('validates missing target fields', () => {
    const result = createBugBountySubmission({
      target: { organization: '', program: '', scope: [], platform: 'hackerone' },
      chain: makeChain(),
    });
    expect(result.ready).toBe(false);
    expect(result.validationErrors.length).toBeGreaterThan(0);
  });

  it('requires minimum 2 primitives for chain', () => {
    const p1 = normalizePrimitive({ id: uniqueId(), class: 'information_disclosure', source: 'CVE-X', conditions: {}, effects: { repeatable: true }, evidence: 1, confidence: 0.5 });
    const chain: ExploitChain = { id: uniqueId(), primitives: [p1], edges: [], status: 'conceptual', totalConfidence: 0.5, assumptionDebt: 0, impactLevel: 'low', minimizedFrom: 1, patchPoints: [] };
    const result = createBugBountySubmission({ target: TEST_TARGET, chain });
    expect(result.ready).toBe(false);
    expect(result.validationErrors).toContain('Valid exploit chain required (minimum 2 primitives)');
  });

  it('generates PoC text for exploit chain', () => {
    const result = createBugBountySubmission({ target: TEST_TARGET, chain: makeChain(), includePoC: true });
    expect(result.submission.proofOfConcept).toContain('Proof of Concept');
    expect(result.submission.proofOfConcept).toContain('information_disclosure');
  });

  it('respects includePoC flag', () => {
    const result = createBugBountySubmission({ target: TEST_TARGET, chain: makeChain(), includePoC: false });
    expect(result.submission.proofOfConcept).toBe('');
  });
});

describe('Bug Bounty Engine — CVSS & Payout Estimation', () => {
  it('estimates payouts per severity and platform', () => {
    const critical = estimatePayout('critical', 'hackerone');
    expect(critical.typical).toBe(15000);
    expect(critical.max).toBe(100000);

    const high = estimatePayout('high', 'bugcrowd');
    expect(high.typical).toBe(3000);

    const medium = estimatePayout('medium', 'intigriti');
    expect(medium.typical).toBe(600);

    const low = estimatePayout('low', 'direct');
    expect(low.typical).toBe(50);
  });

  it('CVSS scoring maps correctly to severity', () => {
    const critical = createBugBountySubmission({ target: { ...TEST_TARGET }, chain: makeChain('critical') });
    expect(critical.submission.cvss.score).toBeGreaterThanOrEqual(9.0);
    expect(critical.submission.severity).toBe('critical');

    const high = createBugBountySubmission({ target: { ...TEST_TARGET }, chain: makeChain('high') });
    expect(high.submission.cvss.score).toBeGreaterThanOrEqual(7.0);

    const medium = createBugBountySubmission({ target: { ...TEST_TARGET }, chain: makeChain('medium') });
    expect(medium.submission.cvss.score).toBeGreaterThanOrEqual(4.0);
  });

  it('estimated payout included in result', () => {
    const result = createBugBountySubmission({ target: TEST_TARGET, chain: makeChain('critical') });
    expect(result.estimatedPayout.typical).toBeGreaterThan(0);
    expect(result.estimatedPayout.min).toBeGreaterThan(0);
    expect(result.estimatedPayout.max).toBeGreaterThan(result.estimatedPayout.min);
  });
});

describe('Bug Bounty Engine — Platform Templates', () => {
  it('formats HackerOne submission', () => {
    const result = createBugBountySubmission({ target: TEST_TARGET, chain: makeChain() });
    const h1 = formatHackerOneSubmission(result.submission);
    expect(h1.title).toContain('ExampleCorp');
    expect(h1.body).toContain('## Description');
    expect(h1.body).toContain('## Impact');
    expect(h1.body).toContain('## Steps to Reproduce');
    expect(h1.body).toContain('## Remediation');
  });

  it('formats Bugcrowd submission with priority', () => {
    const result = createBugBountySubmission({ target: { ...TEST_TARGET, platform: 'bugcrowd' }, chain: makeChain('critical') });
    const bc = formatBugcrowdSubmission(result.submission);
    expect(bc.priority).toBe('P1');
  });

  it('formats direct disclosure email', () => {
    const result = createBugBountySubmission({ target: { ...TEST_TARGET, platform: 'direct' }, chain: makeChain() });
    const direct = formatDirectDisclosure(result.submission);
    expect(direct.subject).toContain('[SECURITY]');
    expect(direct.body).toContain('security vulnerability');
    expect(direct.to).toContain('security@');
  });

  it('platform template contains all required sections', () => {
    const result = createBugBountySubmission({ target: TEST_TARGET, chain: makeChain() });
    const template = result.platformTemplate;
    expect(template).toContain('Description');
    expect(template).toContain('Impact');
    expect(template).toContain('Steps to Reproduce');
    expect(template).toContain('Proof of Concept');
    expect(template).toContain('Remediation');
    expect(template).toContain('Affected Versions');
  });
});

describe('Bug Bounty Engine — Stats & Tracking', () => {
  it('computes bounty stats from submissions', () => {
    const submissions: BugBountySubmission[] = [
      { ...createBugBountySubmission({ target: TEST_TARGET, chain: makeChain() }).submission, status: 'rewarded', payoutAmount: 15000 },
      { ...createBugBountySubmission({ target: { ...TEST_TARGET, platform: 'bugcrowd' }, chain: makeChain('high') }).submission, status: 'accepted' },
      { ...createBugBountySubmission({ target: TEST_TARGET, chain: makeChain('medium') }).submission, status: 'triaged' },
      { ...createBugBountySubmission({ target: TEST_TARGET, chain: makeChain() }).submission, status: 'closed' },
    ];
    const stats = createBountyStats(submissions);
    expect(stats.totalSubmitted).toBe(4);
    expect(stats.totalRewarded).toBe(1);
    expect(stats.totalPayout).toBe(15000);
    expect(stats.pendingPayout).toBeGreaterThan(0);
  });

  it('tracks per-platform submission counts', () => {
    const sub1 = createBugBountySubmission({ target: TEST_TARGET, chain: makeChain() });
    const sub2 = createBugBountySubmission({ target: { ...TEST_TARGET, platform: 'bugcrowd' }, chain: makeChain() });
    const stats = createBountyStats([sub1.submission, sub2.submission]);
    expect(stats.byPlatform['hackerone']).toBe(1);
    expect(stats.byPlatform['bugcrowd']).toBe(1);
  });
});

describe('Bug Bounty Engine — DeepSeek Dynamic Generation', () => {
  beforeAll(() => {
    if (!hasKey) console.warn('[bugbounty] No API key — AI tests will skip');
    else console.log(`[bugbounty] DeepSeek OK`);
  });

  (hasKey ? it : it.skip)('DeepSeek generates 10 unique bug bounty reports', async () => {
    const targets = ['Google', 'Meta', 'Microsoft', 'Apple', 'Amazon', 'GitHub', 'Cloudflare', 'Netflix', 'Spotify', 'Shopify'];
    const results: { company: string; ok: boolean }[] = [];

    for (const company of targets) {
      try {
        const prompt = `[${uniqueId()}] You are Vigil's bug bounty engine. Generate a realistic vulnerability report for ${company}. Include: (1) vulnerability type (SSRF/XSS/SQLi/RCE/auth_bypass), (2) severity (critical/high/medium), (3) 3-line impact statement, (4) 2 reproduction steps. Be technically plausible, reference real company services. Compact, no markdown.`;
        const response = await deepseekChat(prompt, { maxTokens: 200, temperature: 0.9 });
        results.push({ company, ok: response.length > 60 });
      } catch { results.push({ company, ok: false }); }
    }

    expect(results.filter(r => r.ok).length).toBeGreaterThanOrEqual(8);
    console.log(`[bugbounty-ai] ${results.filter(r => r.ok).length}/10 AI reports generated`);
  }, 90000);

  it('generates 100 unique bounty submission IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uniqueId()));
    expect(ids.size).toBe(100);
  });

  it('all platform templates produce non-empty output', () => {
    const result = createBugBountySubmission({ target: TEST_TARGET, chain: makeChain() });
    const sub = result.submission;
    expect(formatHackerOneSubmission(sub).body.length).toBeGreaterThan(200);
    expect(formatBugcrowdSubmission(sub).body.length).toBeGreaterThan(200);
    expect(formatDirectDisclosure(sub).body.length).toBeGreaterThan(200);
  });
});
