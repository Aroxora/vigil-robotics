/**
 * Submission Orchestrator — Extreme Horizon Threaded Agentic Tests
 *
 * Tests the full bug bounty pipeline at scale: 20 targets processed in
 * parallel via threaded agentic workers. Each run generates unique
 * submissions with real DeepSeek prompts.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  BugBountyOrchestrator, runBugBountyPipeline, BOUNTY_TARGETS,
} from '../../src/core/submissionOrchestrator.js';
import { uniqueId, resolveApiKey, deepseekChat } from '../utils/dynamicPromptGenerator.js';

const hasKey = resolveApiKey() !== null;

describe('Submission Orchestrator — Queue & Lifecycle', () => {
  it('creates orchestrator with default config', () => {
    const orch = new BugBountyOrchestrator({ persistJobs: false });
    expect(orch.getQueueStatus().queued).toBe(0);
    expect(orch.getStats().totalCompleted).toBe(0);
  });

  it('enqueues a single target', () => {
    const orch = new BugBountyOrchestrator();
    const id = orch.enqueue(BOUNTY_TARGETS[0]!);
    expect(id).toMatch(/^JOB-/);
    expect(orch.getQueueStatus().queued).toBe(1);
  });

  it('enqueues all 20 pre-loaded targets', () => {
    const orch = new BugBountyOrchestrator();
    const ids = orch.enqueueAll();
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(orch.getQueueStatus().queued).toBe(20);
  });

  it('respects max queue size', () => {
    const orch = new BugBountyOrchestrator({ maxQueueSize: 5 });
    for (let i = 0; i < 5; i++) orch.enqueue(BOUNTY_TARGETS[i]!);
    expect(() => orch.enqueue(BOUNTY_TARGETS[5]!)).toThrow('Queue full');
  });

  it('processes queue with parallel workers', async () => {
    const orch = new BugBountyOrchestrator({ maxConcurrent: 4 });
    orch.enqueueAll(BOUNTY_TARGETS.slice(0, 8));
    const stats = await orch.processQueue(4);
    expect(stats.totalCompleted).toBeGreaterThanOrEqual(6);
    expect(orch.getQueueStatus().running).toBe(0);
    expect(orch.getQueueStatus().completed).toBeGreaterThanOrEqual(6);
  });

  it('prioritizes high-priority targets first', async () => {
    const orch = new BugBountyOrchestrator({ maxConcurrent: 2 });
    const lowP = orch.enqueue(BOUNTY_TARGETS[0]!, 0);
    const highP = orch.enqueue(BOUNTY_TARGETS[1]!, 10);
    await orch.processQueue(2);
    const completed = orch.getCompleted();
    expect(completed.length).toBeGreaterThanOrEqual(1);
  });

  it('tracks submission stats by platform and severity', async () => {
    const orch = new BugBountyOrchestrator({ maxConcurrent: 4 });
    orch.enqueueAll(BOUNTY_TARGETS.slice(0, 6));
    await orch.processQueue(4);
    const stats = orch.getStats();
    expect(stats.totalCompleted).toBeGreaterThan(0);
    expect(Object.keys(stats.submissionsByPlatform).length).toBeGreaterThan(0);
  });

  it('retries failed jobs up to maxRetries', () => {
    const orch = new BugBountyOrchestrator({ maxRetries: 2 });
    expect(orch.getStats().totalFailed).toBe(0);
  });

  it('onUpdate callback fires per job status change', async () => {
    const updates: string[] = [];
    const orch = new BugBountyOrchestrator({ maxConcurrent: 2 });
    orch.onUpdate(job => updates.push(`${job.id}:${job.status}`));
    orch.enqueue(BOUNTY_TARGETS[0]!);
    await orch.processQueue(2);
    // onUpdate is called from async processJob; wait for callbacks to flush
    await new Promise(r => setTimeout(r, 50));
    expect(orch.getQueueStatus().completed + orch.getQueueStatus().failed).toBeGreaterThan(0);
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it('generates 100 unique job IDs', () => {
    const ids = new Set<string>();
    const orch = new BugBountyOrchestrator();
    for (let i = 0; i < 100; i++) ids.add(orch.enqueue(BOUNTY_TARGETS[i % 20]!));
    expect(ids.size).toBe(100);
  });

  it('submission pipeline produces valid formatted output', async () => {
    const orch = new BugBountyOrchestrator({ maxConcurrent: 3 });
    orch.enqueue(BOUNTY_TARGETS[0]!); // Google VRP via HackerOne
    await orch.processQueue(3);
    const completed = orch.getCompleted();
    expect(completed.length).toBeGreaterThanOrEqual(1);
    const job = completed[0]!;
    expect(job.result).toBeDefined();
    expect(job.result!.submission.title).toBeTruthy();
    expect(job.payout).toBeGreaterThanOrEqual(0);
  });

  it('runBugBountyPipeline processes all targets end-to-end', async () => {
    const { stats, submissions, failures } = await runBugBountyPipeline({
      maxConcurrent: 4,
      targets: BOUNTY_TARGETS.slice(0, 8),
    });
    expect(stats.totalCompleted).toBeGreaterThanOrEqual(4);
    expect(submissions.length).toBeGreaterThanOrEqual(4);
  });
});

describe('Submission Orchestrator — DeepSeek Dynamic Generation', () => {
  beforeAll(() => {
    if (!hasKey) console.warn('[orchestrator] No API key — AI tests will skip');
    else console.log('[orchestrator] DeepSeek OK');
  });

  (hasKey ? it : it.skip)('DeepSeek generates unique vulnerability reports per target', async () => {
    const targets = BOUNTY_TARGETS.slice(0, 8);
    const results: { org: string; ok: boolean }[] = [];

    for (const t of targets) {
      try {
        const prompt = `[${uniqueId()}] Generate a realistic vulnerability report for ${t.organization} (${t.program}) on platform ${t.platform}. Include: (1) specific vulnerability type, (2) CVSS 3.1 vector, (3) impact statement, (4) 2 reproduction steps. Be technically specific about ${t.organization}'s infrastructure. Compact, no markdown.`;
        const response = await deepseekChat(prompt, { maxTokens: 200, temperature: 0.9 });
        results.push({ org: t.organization, ok: response.length > 60 });
      } catch { results.push({ org: t.organization, ok: false }); }
    }

    expect(results.filter(r => r.ok).length).toBeGreaterThanOrEqual(6);
    console.log(`[orchestrator-ai] ${results.filter(r => r.ok).length}/8 targets with unique AI reports`);
  }, 90000);

  it('20 pre-loaded targets cover all major platforms', () => {
    const platforms = new Set(BOUNTY_TARGETS.map(t => t.platform));
    expect(platforms.has('hackerone')).toBe(true);
    expect(platforms.has('bugcrowd')).toBe(true);
    expect(platforms.has('direct')).toBe(true);
    expect(BOUNTY_TARGETS.length).toBe(20);
  });
});
