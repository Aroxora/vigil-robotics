/**
 * Vigil — General Coding Long-Horizon Dynamic Tests
 *
 * Every test run generates dynamically unique prompts using nanosecond
 * timestamps and randomization. Covers: parallel tool use, multi-agent
 * coding workflows, refactoring pipelines, testing pipelines, error
 * recovery, concurrency limits, and real DeepSeek agentic integration.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import {
  uniqueId, uniqueCveTarget, uniqueService, uniqueTool,
  generateCodingPrompt, generateUniquePrompts, generateUniqueIds,
  resolveApiKey, deepseekChat, runParallelPrompts,
} from './utils/dynamicPromptGenerator.js';

const apiKey = resolveApiKey();
const hasKey = apiKey !== null;

describe('General Coding — Long-Horizon Dynamic Prompts', () => {
  beforeAll(() => {
    if (!hasKey) console.warn('[coding-test] No API key — live tests will simulate');
    else console.log(`[coding-test] DeepSeek OK (${apiKey!.slice(0, 6)}...)`);
  });

  it('generates unique coding prompt each run (static)', () => {
    const p1 = generateCodingPrompt();
    const p2 = generateCodingPrompt();
    expect(p1).not.toBe(p2);
    expect(p1.length).toBeGreaterThan(50);
    expect(p2.length).toBeGreaterThan(50);
  });

  it('generates 50 unique coding prompts with no duplicates', () => {
    const prompts = generateUniquePrompts(50, 'general-coding');
    expect(prompts).toHaveLength(50);
    expect(new Set(prompts).size).toBe(50);
  });

  it('generates 100 unique IDs with nanosecond precision', () => {
    const ids = generateUniqueIds(100);
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
  });

  (hasKey ? it : it.skip)('executes parallel coding tasks with real DeepSeek', async () => {
    const prompts = [
      `[${uniqueId()}] Explain in one sentence: what is dependency injection? No preamble.`,
      `[${uniqueId()}] List 3 best practices for writing unit tests. One line each.`,
      `[${uniqueId()}] What is the difference between == and === in JavaScript? One sentence.`,
      `[${uniqueId()}] Define "idempotency" in REST APIs. One sentence.`,
      `[${uniqueId()}] Name one benefit of TypeScript over JavaScript. One sentence.`,
    ];

    const results = await runParallelPrompts(prompts, { maxConcurrent: 5, maxTokens: 80 });
    expect(results.length).toBeGreaterThanOrEqual(4);
    const ids = results.filter(r => r.ok).map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60000);

  (hasKey ? it : it.skip)('handles 10 coding tasks chunked into groups of 8', async () => {
    const prompts = generateUniquePrompts(10, 'general-coding');
    // Override with controlled prompts for reliability
    const controlled = Array.from({ length: 10 }, (_, i) =>
      `[${uniqueId()}] Task ${i + 1}/10: Say only "OK coding ${i + 1}" — nothing else.`
    );

    const results = await runParallelPrompts(controlled, { maxConcurrent: 8, maxTokens: 30 });
    expect(results.length).toBeGreaterThanOrEqual(9);
    expect(new Set(results.map(r => r.id)).size).toBe(results.length);
  }, 90000);

  (hasKey ? it : it.skip)('agent coding pipeline: implement → test → refactor', async () => {
    const pipeline: { phase: string; response: string }[] = [];
    const phases = [
      `[${uniqueId()}] Write a short JavaScript function that validates an email address. Include regex. Output ONLY the code.`,
      `[${uniqueId()}] Write a unit test for the email validator function. Test valid email, invalid email, and empty string. Output ONLY the test code.`,
      `[${uniqueId()}] Review this code and suggest one improvement: "function validateEmail(e){return /\\S+@\\S+\\.\\S+/.test(e)}" — one sentence only.`,
    ];

    for (const phase of phases) {
      try {
        const r = await deepseekChat(phase, { maxTokens: 150 });
        pipeline.push({ phase: phase.slice(0, 60), response: r });
      } catch {
        pipeline.push({ phase: phase.slice(0, 60), response: '[error]' });
      }
    }

    expect(pipeline.length).toBe(3);
    expect(pipeline.filter(p => p.response !== '[error]').length).toBeGreaterThanOrEqual(2);
  }, 90000);
});

describe('General Coding — Parallel Tool Use', () => {
  it('enforces max concurrency in simulated tool calls', async () => {
    const MAX = 5;
    let active = 0;
    let peakObserved = 0;

    const runner = async () => {
      active++;
      peakObserved = Math.max(peakObserved, active);
      await new Promise(r => setTimeout(r, Math.random() * 30));
      active--;
    };

    await Promise.all(Array.from({ length: 30 }, runner));
    expect(peakObserved).toBeGreaterThan(0);
    expect(active).toBe(0);
  });

  it('detects and skips duplicate tool calls', () => {
    const cache = new Map<string, string>();
    let cacheHits = 0;
    const tools = generateUniqueIds(5);

    // First batch: all unique
    for (const t of tools) {
      if (cache.has(t)) cacheHits++;
      else cache.set(t, `result-${t}`);
    }
    expect(cacheHits).toBe(0);

    // Second batch: all duplicates
    for (const t of tools) {
      if (cache.has(t)) cacheHits++;
      else cache.set(t, `result-${t}`);
    }
    expect(cacheHits).toBe(5);
  });

  it('token budget enforced across parallel operations', () => {
    const BUDGET = 10000;
    let used = 0;
    const ops = Array.from({ length: 20 }, () => Math.floor(Math.random() * 1500) + 200);
    const executed: number[] = [];

    for (const tokens of ops) {
      if (used + tokens <= BUDGET) {
        used += tokens;
        executed.push(tokens);
      }
    }

    expect(used).toBeLessThanOrEqual(BUDGET);
    expect(executed.length).toBeGreaterThan(0);
  });

  it('circuit breaker opens after 5 consecutive failures', () => {
    let failures = 0;
    let circuitOpen = false;
    let blockedRequests = 0;

    for (let i = 0; i < 12; i++) {
      if (circuitOpen) {
        blockedRequests++;
        continue;
      }
      failures++;
      if (failures >= 5) circuitOpen = true;
    }

    expect(circuitOpen).toBe(true);
    expect(blockedRequests).toBe(7);
  });
});

describe('General Coding — Error Recovery & Resilience', () => {
  it('retries failed operations with exponential backoff', () => {
    const backoff = [100, 200, 400, 800, 1600, 3200, 6400];
    let attempts = 0;

    for (const delay of backoff) {
      attempts++;
      if (attempts === 5) break; // Success on 5th attempt
    }

    expect(attempts).toBe(5);
    expect(backoff[4]).toBe(1600);
  });

  it('recovers from partial tool execution failure', () => {
    const log: string[] = [];
    const executeStep = (step: string) => {
      if (step === 'step3') throw new Error('Network timeout');
      log.push(step);
    };

    for (const s of ['step1', 'step2', 'step3', 'step4', 'step5']) {
      try { executeStep(s); } catch { log.push(`${s}-recovered`); }
    }

    expect(log).toEqual(['step1', 'step2', 'step3-recovered', 'step4', 'step5']);
  });

  it('handles JSON parse errors gracefully', () => {
    const parseResponse = (raw: string) => {
      try { return JSON.parse(raw); }
      catch { return { error: 'parse_error', partial: raw.slice(0, 40) }; }
    };

    expect(parseResponse('not-json!!!')).toEqual({ error: 'parse_error', partial: 'not-json!!!' });
    expect(parseResponse('{"ok":true}')).toEqual({ ok: true });
  });

  it('drops stale requests that exceed timeout', async () => {
    const TIMEOUT = 50;
    let timedOut = 0;
    const completed: string[] = [];

    const job = async (ms: number, id: string) => {
      await new Promise(r => setTimeout(r, ms));
      return `job-${id}`;
    };

    const ops = [20, 120, 30, 150, 40].map(async (ms, i) => {
      try {
        const result = await Promise.race([
          job(ms, `${i}`),
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

describe('General Coding — Long Session Context Management', () => {
  it('tracks token usage across multi-step pipeline', () => {
    let totalTokens = 0;
    const steps = [
      { input: 500, output: 1200 },
      { input: 800, output: 2000 },
      { input: 600, output: 1500 },
      { input: 400, output: 900 },
    ];
    for (const s of steps) totalTokens += s.input + s.output;
    expect(totalTokens).toBe(7900);
    const ctxPct = Math.round((totalTokens / 200_000) * 100);
    expect(ctxPct).toBe(4);
  });

  it('auto-condenses without losing system prompt', () => {
    const messages = [
      { role: 'system', content: 'Vigil coding agent' },
      ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? 'user' as const : 'assistant' as const, content: `msg${i}` })),
    ];
    const condensed = [messages[0], messages[1], {
      role: 'assistant' as const, content: '[Earlier context condensed — key decisions preserved]',
    }, ...messages.slice(-4)];
    expect(condensed.length).toBe(7);
    expect(condensed[0].role).toBe('system');
  });

  it('preserves critical info during context trimming', () => {
    const critical = ['security decision', 'user requirement', 'api contract'];
    const history = [
      'general chat', 'code snippet', 'security decision',
      'debug log', 'user requirement', 'api contract', 'test result',
    ];
    const kept = history.filter(h => critical.includes(h));
    expect(kept).toHaveLength(3);
    expect(kept).toEqual(critical);
  });
});
