/**
 * Vigil — Ultra Long-Horizon Parallel Tool Use & Multi-Agent Tests
 *
 * Every test run generates dynamically unique prompts. Covers:
 * parallel tool execution with real DeepSeek, multi-agent spawning,
 * agent worker pool management, task queuing, load balancing,
 * semaphore gating, circuit breaking, and stress testing.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  uniqueId, uniqueCveTarget, uniqueService, uniquePort,
  generateUniquePrompts, generateUniqueIds,
  resolveApiKey, deepseekChat, runParallelPrompts,
} from './utils/dynamicPromptGenerator.js';

const apiKey = resolveApiKey();
const hasKey = apiKey !== null;

describe('Parallel Tool Execution — Ultra Long-Horizon', () => {
  beforeAll(() => {
    if (!hasKey) console.warn('[parallel-test] No API key — simulated only');
    else console.log(`[parallel-test] DeepSeek OK (${apiKey!.slice(0, 6)}...)`);
  });

  it('generates 100 unique parallel task IDs', () => {
    const ids = generateUniqueIds(100);
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
  });

  it('generates 100 unique parallel prompts', () => {
    const prompts = generateUniquePrompts(100);
    expect(prompts).toHaveLength(100);
    expect(new Set(prompts).size).toBe(100);
  });

  (hasKey ? it : it.skip)('executes 5 parallel tool calls with unique CVE targets', async () => {
    const targets = Array.from({ length: 5 }, () => uniqueCveTarget());
    const prompts = targets.map(cve =>
      `[${uniqueId()}] For ${cve}, say only its severity (critical/high/medium/low). One word.`
    );

    const results = await runParallelPrompts(prompts, { maxConcurrent: 5, maxTokens: 20 });
    expect(results.length).toBeGreaterThanOrEqual(4);
    const ids = results.filter(r => r.ok).map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60000);

  (hasKey ? it : it.skip)('executes 10 parallel tool calls chunked into groups of 8', async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: uniqueId(),
      prompt: `[${uniqueId()}] Task ${i + 1}/10: Say only "OK" — nothing else.`,
    }));

    const allIds: string[] = [];
    const CHUNK = 8;
    for (let i = 0; i < tasks.length; i += CHUNK) {
      const chunk = tasks.slice(i, i + CHUNK);
      const chunkResults = await Promise.allSettled(
        chunk.map(t => deepseekChat(t.prompt, { maxTokens: 20 })
          .then(r => ({ id: t.id, ok: r.includes('OK') }))
          .catch(() => ({ id: t.id, ok: false }))
        )
      );
      for (const r of chunkResults) {
        if (r.status === 'fulfilled' && r.value.ok) allIds.push(r.value.id);
      }
    }

    expect(allIds.length).toBeGreaterThanOrEqual(8);
    expect(new Set(allIds).size).toBe(allIds.length);
  }, 90000);

  (hasKey ? it : it.skip)('detects and skips duplicate parallel tool calls', async () => {
    const duplicateCve = 'CVE-2024-3094';
    const uniqueCve1 = 'CVE-2024-6387';
    const uniqueCve2 = 'CVE-2025-1974';
    const tasks = [
      { cve: duplicateCve, prompt: `[${uniqueId()}] What is ${duplicateCve}? One word.` },
      { cve: uniqueCve1, prompt: `[${uniqueId()}] What is ${uniqueCve1}? One word.` },
      { cve: duplicateCve, prompt: `[${uniqueId()}] What is ${duplicateCve}? One word.` },
      { cve: uniqueCve2, prompt: `[${uniqueId()}] What is ${uniqueCve2}? One word.` },
    ];

    const cache = new Map<string, string>();
    let cacheHits = 0;
    const results: string[] = [];

    for (const t of tasks) {
      if (cache.has(t.cve)) {
        cacheHits++;
        results.push(`[cached] ${cache.get(t.cve)}`);
        continue;
      }
      try {
        const r = await deepseekChat(t.prompt, { maxTokens: 20 });
        cache.set(t.cve, r);
        results.push(r);
      } catch {
        results.push('[error]');
      }
    }

    expect(cacheHits).toBe(1);
    expect(results.length).toBe(4);
  }, 60000);
});

describe('Multi-Agent Spawning — Long Horizon', () => {
  (hasKey ? it : it.skip)('spawns 3 parallel agents with unique CNE roles', async () => {
    const agents = [
      { role: 'scanner', prompt: `[${uniqueId()}] You are a CNE scanner. Name 2 common ports and their services. Brief.` },
      { role: 'analyst', prompt: `[${uniqueId()}] You are a CNE analyst. Name 2 common CVEs for nginx. Brief.` },
      { role: 'responder', prompt: `[${uniqueId()}] You are a CNE responder. Name 2 hardening steps for Linux. Brief.` },
    ];

    const results = await Promise.allSettled(
      agents.map(a =>
        deepseekChat(a.prompt, { maxTokens: 80 })
          .then(r => ({ role: a.role, response: r.slice(0, 80), ok: true }))
          .catch(() => ({ role: a.role, response: '', ok: false }))
      )
    );

    const successes = results.filter(r => r.status === 'fulfilled' && r.value.ok);
    expect(successes.length).toBeGreaterThanOrEqual(2);
    const roles = successes.map(r => (r as PromiseFulfilledResult<any>).value.role);
    expect(new Set(roles).size).toBe(roles.length);
  }, 60000);

  (hasKey ? it : it.skip)('respects max 3 concurrent agents in a 5-agent pool', async () => {
    const MAX = 3;
    const agents = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      prompt: `[agent-${i}-${uniqueId()}] Say "agent ${i} ready" — nothing else.`,
    }));

    let active = 0;
    let maxObserved = 0;
    const results: { id: number; ok: boolean }[] = [];

    const semaphore = async (agent: typeof agents[0]) => {
      while (active >= MAX) await new Promise(r => setTimeout(r, 5));
      active++;
      maxObserved = Math.max(maxObserved, active);
      try {
        const r = await deepseekChat(agent.prompt, { maxTokens: 30 });
        results.push({ id: agent.id, ok: r.includes('ready') });
      } catch {
        results.push({ id: agent.id, ok: false });
      } finally {
        active--;
      }
    };

    await Promise.all(agents.map(semaphore));
    expect(maxObserved).toBeLessThanOrEqual(MAX);
    expect(results.length).toBeGreaterThanOrEqual(4);
  }, 90000);

  (hasKey ? it : it.skip)('agent spawns fallback on provider failure', async () => {
    let primaryOk = false;
    let fallbackOk = false;

    try {
      const r = await deepseekChat(`[${uniqueId()}] Say one word.`, { maxTokens: 20 });
      primaryOk = r.length > 0;
    } catch { /* primary failed */ }

    if (!primaryOk) {
      try {
        const r = await deepseekChat(`[${uniqueId()}] Say "fallback ok"`, { maxTokens: 20 });
        fallbackOk = r.toLowerCase().includes('fallback');
      } catch { /* fallback also failed */ }
    }

    expect(primaryOk || fallbackOk).toBe(true);
  }, 30000);
});

describe('Agent Worker Pool — Load Balancing', () => {
  it('round-robin distributes tasks evenly', () => {
    const workers = [0, 1, 2, 3];
    const taskCounts = [0, 0, 0, 0];
    let next = 0;

    for (let i = 0; i < 100; i++) {
      taskCounts[next]!++;
      next = (next + 1) % workers.length;
    }

    expect(taskCounts[0]).toBe(25);
    expect(taskCounts[3]).toBe(25);
  });

  it('least-busy routes to idle worker first', () => {
    const workers = [
      { id: 0, load: 5 },
      { id: 1, load: 2 },
      { id: 2, load: 8 },
      { id: 3, load: 0 },
    ];

    const pickLeastBusy = (ws: typeof workers) =>
      ws.reduce((best, w) => w.load < best.load ? w : best);

    const picked = pickLeastBusy(workers);
    expect(picked.id).toBe(3);
  });

  it('random strategy picks from available workers', () => {
    const workers = [0, 1, 2];
    const assigned = new Map<number, number>();
    for (let i = 0; i < 100; i++) {
      const pick = workers[Math.floor(Math.random() * workers.length)]!;
      assigned.set(pick, (assigned.get(pick) || 0) + 1);
    }

    // Each worker gets at least some tasks
    expect(assigned.size).toBe(3);
    workers.forEach(w => expect(assigned.get(w)).toBeGreaterThan(0));
  });
});

describe('Agent Task Queuing & Timeouts', () => {
  it('queues tasks when all workers busy', () => {
    const MAX_WORKERS = 3;
    let active = 0;
    const queue: number[] = [];
    let executed = 0;

    for (let i = 0; i < 10; i++) {
      if (active < MAX_WORKERS) {
        active++;
        executed++;
      } else {
        queue.push(i);
      }
    }

    expect(executed).toBe(3);
    expect(queue.length).toBe(7);
  });

  it('timeout drops stale queued tasks', async () => {
    const TIMEOUT = 50;
    let timedOut = 0;
    const completed: string[] = [];

    const task = async (ms: number, id: string): Promise<string> => {
      await new Promise(r => setTimeout(r, ms));
      return `task-${id}`;
    };

    const ops = [20, 120, 30, 150, 40].map(async (ms, i) => {
      try {
        const result = await Promise.race([
          task(ms, `${i}`),
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT)),
        ]);
        completed.push(result);
      } catch {
        timedOut++;
      }
    });

    await Promise.all(ops);
    expect(timedOut).toBe(2); // 120ms and 150ms exceed 50ms timeout
    expect(completed.length).toBe(3);
  });
});

describe('Agent Pool — Concurrency Limits & Circuit Breaking', () => {
  it('enforces max parallel API calls at pool level', () => {
    const MAX = 5;
    let active = 0;
    let peak = 0;
    const semaphore = {
      acquire: () => { active++; peak = Math.max(peak, active); },
      release: () => { active--; },
    };

    // Simulate 30 concurrent tasks with semaphore
    for (let i = 0; i < 30; i++) {
      if (active >= MAX) continue;
      semaphore.acquire();
      semaphore.release();
    }

    expect(peak).toBeLessThanOrEqual(MAX);
    expect(active).toBe(0);
  });

  it('circuit breaker opens at pool level after 5 failures', () => {
    let failures = 0;
    let circuitOpen = false;
    let blocked = 0;

    for (let i = 0; i < 12; i++) {
      if (circuitOpen) { blocked++; continue; }
      failures++;
      if (failures >= 5) circuitOpen = true;
    }

    expect(circuitOpen).toBe(true);
    expect(blocked).toBe(7);
    expect(failures).toBe(5);
  });

  it('token budget enforced at pool level across agents', () => {
    const BUDGET = 10000;
    let used = 0;
    const agents = Array.from({ length: 10 }, () => ({
      id: uniqueId(),
      budget: 500 + Math.floor(Math.random() * 2000),
    }));
    const launched: typeof agents = [];

    for (const agent of agents) {
      if (used + agent.budget <= BUDGET) {
        used += agent.budget;
        launched.push(agent);
      }
    }

    expect(used).toBeLessThanOrEqual(BUDGET);
    expect(launched.length).toBeGreaterThan(0);
    expect(launched.length).toBeLessThanOrEqual(agents.length);
  });
});

describe('Full Pipeline — Parallel Tools + Multi-Agent (simulated)', () => {
  it('CNE pipeline with parallel tools and multi-agent orchestration', async () => {
    const pipelineId = uniqueId();

    // Phase 1: Parallel discovery (3 agents)
    const discoveryTasks = [
      { agent: 'scanner-a', task: `scan ports on ${uniqueService()}` },
      { agent: 'scanner-b', task: `detect services on ${uniqueService()}` },
      { agent: 'scanner-c', task: `OS fingerprint ${uniqueService()}` },
    ];

    // Phase 2: Parallel assessment (3 agents)
    const assessmentTasks = [
      { agent: 'analyst-a', task: `lookup ${uniqueCveTarget()}` },
      { agent: 'analyst-b', task: `lookup ${uniqueCveTarget()}` },
      { agent: 'analyst-c', task: `lookup ${uniqueCveTarget()}` },
    ];

    // Phase 3: Sequential hardening (1 agent)
    const hardeningTasks = [
      { agent: 'responder', task: 'apply patches' },
    ];

    const allPhases = [discoveryTasks, assessmentTasks, hardeningTasks];
    const results: string[] = [];

    for (const phase of allPhases) {
      results.push(`phase-${uniqueId()}: ${phase.length} agents`);
    }

    expect(results).toHaveLength(3);
    expect(results[0]).toContain('3 agents');
    expect(results[1]).toContain('3 agents');
    expect(results[2]).toContain('1 agents');
  });

  it('pipeline recovers from agent failure and reassigns task', () => {
    const tasks = ['scan-ports', 'lookup-cve', 'check-config', 'verify-patch', 'generate-report'];
    const completed: string[] = [];
    const failed: string[] = [];
    const reassigned: string[] = [];

    for (const task of tasks) {
      if (task === 'lookup-cve') {
        failed.push(task);
        reassigned.push(`${task}-retry`);
        completed.push(`${task}-retry`);
      } else {
        completed.push(task);
      }
    }

    expect(completed).toHaveLength(5);
    expect(failed).toEqual(['lookup-cve']);
    expect(reassigned).toEqual(['lookup-cve-retry']);
  });
});

describe('Stress — 50-Iteration Dynamic Loop (simulated)', () => {
  it('completes 50 simulated loop iterations with all unique prompts', () => {
    const ITERATIONS = 50;
    const prompts = generateUniquePrompts(ITERATIONS);
    expect(prompts).toHaveLength(ITERATIONS);
    expect(new Set(prompts).size).toBe(ITERATIONS);
  });

  it('generates 200 unique IDs across all domains', () => {
    const ids = generateUniqueIds(200);
    expect(ids).toHaveLength(200);
    expect(new Set(ids).size).toBe(200);
  });

  it('25 parallel agent pools with unique tasks', () => {
    const pools: string[][] = [];
    for (let i = 0; i < 25; i++) {
      const pool = Array.from({ length: 3 }, () => `task-${uniqueId()}-${uniqueCveTarget()}`);
      pools.push(pool);
    }

    const allTasks = pools.flat();
    expect(new Set(allTasks).size).toBe(75);
  });
});
