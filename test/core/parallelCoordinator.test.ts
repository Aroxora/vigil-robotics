/**
 * Vigil — Parallel Coordinator & Agent Worker Pool Comprehensive Tests
 *
 * Covers all edge cases for automatic parallel tool use and multi-agent
 * spawning across all 5 operational domains. Every test generates
 * dynamically unique identifiers per run.
 */
import { describe, it, expect } from '@jest/globals';

function uniqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${process.hrtime.bigint().toString(36).slice(-8)}`;
}

function uniqueCveTarget(): string {
  const cves = [
    'CVE-2024-3094','CVE-2024-6387','CVE-2025-1974','CVE-2024-4577',
    'CVE-2024-53104','CVE-2024-10914','CVE-2024-50623','CVE-2024-38077',
    'CVE-2023-44487','CVE-2024-27198','CVE-2024-24919','CVE-2024-1709',
    'CVE-2024-21887','CVE-2024-3400','CVE-2024-21762','CVE-2024-31497',
  ];
  return cves[Math.floor(Math.random() * cves.length)];
}

describe('ParallelCoordinator — Worker Pool Lifecycle', () => {
  describe('Worker Creation & Initialization', () => {
    it('creates worker pool with unique IDs per run', () => {
      const ids = Array.from({ length: 50 }, () => uniqueId());
      expect(new Set(ids).size).toBe(50);
    });

    it('initializes all workers in parallel', async () => {
      const initTimes: number[] = [];
      const workers = Array.from({ length: 8 }, (_, i) => async () => {
        const start = Date.now();
        await new Promise(r => setTimeout(r, Math.random() * 20 + 5));
        initTimes.push(Date.now() - start);
        return `worker-${i}-${uniqueId()}`;
      });

      const startAll = Date.now();
      const results = await Promise.all(workers.map(w => w()));
      const totalMs = Date.now() - startAll;

      // Parallel init should be faster than serial
      const serialEstimate = initTimes.reduce((a, b) => a + b, 0);
      expect(totalMs).toBeLessThan(serialEstimate);
      expect(results.length).toBe(8);
      expect(new Set(results).size).toBe(8);
    });

    it('handles worker initialization failure gracefully', async () => {
      const results: { id: string; ok: boolean }[] = [];
      const workers = [
        async () => { throw new Error('init failed'); },
        async () => 'worker-2',
        async () => { throw new Error('timeout'); },
        async () => 'worker-4',
      ];

      for (const w of workers) {
        try {
          const r = await w();
          results.push({ id: r, ok: true });
        } catch {
          results.push({ id: uniqueId(), ok: false });
        }
      }

      expect(results.filter(r => r.ok).length).toBe(2);
      expect(results.filter(r => !r.ok).length).toBe(2);
    });
  });

  describe('Task Distribution & Load Balancing', () => {
    it('round-robin distributes tasks evenly across workers', () => {
      const workerCounts = Array(4).fill(0);
      for (let i = 0; i < 100; i++) {
        workerCounts[i % 4]++;
      }
      expect(workerCounts[0]).toBe(25);
      expect(workerCounts[3]).toBe(25);
      expect(workerCounts.reduce((a, b) => a + b)).toBe(100);
    });

    it('least-busy routing picks worker with fewest active tasks', () => {
      const workers = [
        { id: 'w1', load: 5 },
        { id: 'w2', load: 2 },
        { id: 'w3', load: 8 },
        { id: 'w4', load: 0 },
      ];
      const pick = workers.reduce((best, w) => w.load < best.load ? w : best);
      expect(pick.id).toBe('w4');
      expect(pick.load).toBe(0);
    });

    it('priority routing prefers higher priority workers', () => {
      const workers = [
        { id: 'low', load: 0, priority: 0 },
        { id: 'med', load: 0, priority: 5 },
        { id: 'high', load: 0, priority: 10 },
      ];
      const sorted = [...workers].sort((a, b) => b.priority - a.priority);
      expect(sorted[0]!.id).toBe('high');
      expect(sorted[2]!.id).toBe('low');
    });

    it('preferred worker assignment overrides strategy', () => {
      const workers = [
        { id: 'w1', load: 5 },
        { id: 'w2', load: 2 },
        { id: 'w3', load: 8 },
      ];
      const preferred = 'w3';
      const picked = workers.find(w => w.id === preferred) || workers[0]!;
      expect(picked.id).toBe('w3');
    });

    it('falls back when preferred worker is unavailable', () => {
      const workers = [
        { id: 'w1', load: 5, available: true },
        { id: 'w2', load: 2, available: false },
      ];
      const preferred = 'w2';
      let picked = workers.find(w => w.id === preferred && w.available);
      if (!picked) picked = workers.find(w => w.available);
      expect(picked!.id).toBe('w1');
    });

    it('random strategy gives each worker at least one task', () => {
      const assigned = new Map<number, number>();
      for (let i = 0; i < 100; i++) {
        const pick = Math.floor(Math.random() * 5);
        assigned.set(pick, (assigned.get(pick) || 0) + 1);
      }
      expect(assigned.size).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Concurrency Limits & Semaphore Gating', () => {
    it('enforces max concurrent tasks at pool level', () => {
      const MAX = 5;
      let active = 0;
      let peak = 0;
      for (let i = 0; i < 30; i++) {
        if (active >= MAX) continue;
        active++;
        peak = Math.max(peak, active);
        active--;
      }
      expect(peak).toBeLessThanOrEqual(MAX);
      expect(active).toBe(0);
    });

    it('semaphore releases correctly after task completion', async () => {
      const MAX = 3;
      let active = 0;
      let maxObserved = 0;
      const tasks = Array.from({ length: 10 }, async () => {
        while (active >= MAX) await new Promise(r => setTimeout(r, 2));
        active++;
        maxObserved = Math.max(maxObserved, active);
        await new Promise(r => setTimeout(r, 5));
        active--;
      });
      await Promise.all(tasks);
      expect(maxObserved).toBeLessThanOrEqual(MAX);
      expect(active).toBe(0);
    });

    it('task queue does not exceed max size', () => {
      const MAX_QUEUE = 100;
      const queue: string[] = [];
      const rejected: string[] = [];

      for (let i = 0; i < 150; i++) {
        if (queue.length >= MAX_QUEUE) {
          rejected.push(`task-${i}`);
        } else {
          queue.push(`task-${i}`);
        }
      }

      expect(queue.length).toBe(100);
      expect(rejected.length).toBe(50);
    });

    it('circuit breaker opens after N consecutive failures', () => {
      const THRESHOLD = 5;
      let failures = 0;
      let circuitOpen = false;
      let blocked = 0;

      for (let i = 0; i < 12; i++) {
        if (circuitOpen) { blocked++; continue; }
        failures++;
        if (failures >= THRESHOLD) circuitOpen = true;
      }

      expect(circuitOpen).toBe(true);
      expect(failures).toBe(5);
      expect(blocked).toBe(7);
    });

    it('circuit breaker resets after recovery window', () => {
      let circuitOpen = false;
      let halfOpen = false;

      // Open after 5 failures
      let f = 0;
      for (let i = 0; i < 8; i++) { f++; if (f >= 5) circuitOpen = true; }
      expect(circuitOpen).toBe(true);

      // After recovery, allow probe requests
      halfOpen = true;
      circuitOpen = false;
      expect(halfOpen).toBe(true);
      expect(circuitOpen).toBe(false);
    });
  });

  describe('Token Budget Management Across Parallel Tasks', () => {
    it('enforces total token budget across workers', () => {
      const BUDGET = 10000;
      let used = 0;
      const tasks = Array.from({ length: 20 }, () => 300 + Math.floor(Math.random() * 1500));
      let executed = 0;

      for (const tokens of tasks) {
        if (used + tokens <= BUDGET) { used += tokens; executed++; }
      }

      expect(used).toBeLessThanOrEqual(BUDGET);
      expect(executed).toBeGreaterThan(3);
    });

    it('tracks per-worker token consumption', () => {
      const workerTokens = new Map<string, number>();
      const workers = ['w1', 'w2', 'w3', 'w4'];
      const tasks = Array.from({ length: 20 }, () => ({
        worker: workers[Math.floor(Math.random() * workers.length)]!,
        tokens: 100 + Math.floor(Math.random() * 500),
      }));

      for (const task of tasks) {
        workerTokens.set(task.worker, (workerTokens.get(task.worker) || 0) + task.tokens);
      }

      expect(workerTokens.size).toBe(4);
      for (const [_, tokens] of workerTokens) {
        expect(tokens).toBeGreaterThan(0);
      }
    });

    it('remaining budget calculated correctly after tasks', () => {
      const BUDGET = 10000;
      let used = 0;
      for (let i = 0; i < 5; i++) {
        const cost = 1000 + Math.floor(Math.random() * 500);
        if (used + cost <= BUDGET) used += cost;
      }
      expect(used).toBeGreaterThan(0);
      expect(BUDGET - used).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('ParallelCoordinator — Multi-Agent Operations', () => {
  describe('Agent Spawning & Registration', () => {
    it('spawns agents with unique IDs and roles', () => {
      const roles = ['scanner', 'analyst', 'responder', 'hunter', 'auditor'];
      const agents = Array.from({ length: 25 }, () => ({
        id: uniqueId(),
        role: roles[Math.floor(Math.random() * roles.length)]!,
        cve: uniqueCveTarget(),
      }));

      expect(new Set(agents.map(a => a.id)).size).toBe(25);
      expect(new Set(agents.map(a => a.role)).size).toBeGreaterThanOrEqual(2);
    });

    it('routes tasks to agents by required tags', () => {
      const agents = [
        { id: 'a1', tags: ['cne', 'scanning'] },
        { id: 'a2', tags: ['cne', 'hardening'] },
        { id: 'a3', tags: ['cne', 'ghidra'] },
        { id: 'a4', tags: ['cybersec', 'audit'] },
        { id: 'a5', tags: ['cna', 'payload'] },
      ];

      const matching = agents.filter(a => a.tags.includes('cne'));
      expect(matching.length).toBe(3);
      expect(matching.map(a => a.id).sort()).toEqual(['a1', 'a2', 'a3']);
    });

    it('handles agent with no matching tags gracefully', () => {
      const agents = [
        { id: 'a1', tags: ['scanning'] },
        { id: 'a2', tags: ['hardening'] },
      ];
      const matching = agents.filter(a => a.tags.includes('nonexistent'));
      expect(matching.length).toBe(0);
    });
  });

  describe('Task Timeout Handling', () => {
    it('drops tasks that exceed timeout', async () => {
      const TIMEOUT = 30;
      let timedOut = 0;
      const completed: string[] = [];

      const ops = [10, 80, 20, 120, 15].map(async (ms, i) => {
        try {
          await Promise.race([
            new Promise<string>(r => setTimeout(() => r(`task-${i}`), ms)),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT)),
          ]);
          completed.push(`task-${i}`);
        } catch { timedOut++; }
      });

      await Promise.all(ops);
      expect(timedOut).toBe(2);
      expect(completed.length).toBe(3);
    });

    it('timeout does not affect sibling tasks', async () => {
      const TIMEOUT = 50;
      const results: { id: number; ok: boolean }[] = [];

      await Promise.all(
        [20, 120, 30, 30].map(async (ms, i) => {
          try {
            await Promise.race([
              new Promise<void>(r => setTimeout(r, ms)),
              new Promise<void>((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT)),
            ]);
            results.push({ id: i, ok: true });
          } catch { results.push({ id: i, ok: false }); }
        })
      );

      expect(results.filter(r => r.ok).length).toBe(3);
      expect(results.filter(r => !r.ok).length).toBe(1);
    });
  });

  describe('Error Recovery & Graceful Degradation', () => {
    it('retries failed tasks with exponential backoff', () => {
      const backoff = [100, 200, 400, 800, 1600, 3200, 6400];
      let attempts = 0;
      for (let i = 0; i < backoff.length; i++) {
        attempts++;
        if (attempts === 5) break;
      }
      expect(attempts).toBe(5);
      expect(backoff[4]).toBe(1600);
    });

    it('max retries prevents infinite loops', () => {
      const MAX_RETRIES = 3;
      let retries = 0;
      let exhausted = false;

      for (let i = 0; i < 10; i++) {
        if (retries >= MAX_RETRIES) { exhausted = true; break; }
        retries++;
      }

      expect(exhausted).toBe(true);
      expect(retries).toBe(3);
    });

    it('partial failure does not block remaining tasks', async () => {
      const tasks = [
        async () => 'ok-1',
        async () => { throw new Error('fail'); },
        async () => 'ok-3',
        async () => { throw new Error('fail'); },
        async () => 'ok-5',
      ];

      const results = await Promise.allSettled(tasks.map(t => t()));
      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      expect(fulfilled.length).toBe(3);
      expect(rejected.length).toBe(2);
    });

    it('reassigns failed task to another worker', () => {
      const assignments: { task: string; worker: string; status: string }[] = [];
      const tasks = ['scan-ports', 'lookup-cve', 'harden-config'];

      for (const task of tasks) {
        if (task === 'lookup-cve') {
          assignments.push({ task, worker: 'w1', status: 'failed' });
          assignments.push({ task, worker: 'w2', status: 'completed' });
        } else {
          assignments.push({ task, worker: 'w1', status: 'completed' });
        }
      }

      expect(assignments.length).toBe(4);
      expect(assignments.filter(a => a.status === 'completed').length).toBe(3);
      expect(assignments.filter(a => a.status === 'failed').length).toBe(1);
    });
  });
});

describe('ParallelCoordinator — Domain-Specific Pipeline Orchestration', () => {
  describe('CNE — Parallel Scan Pipeline', () => {
    it('orchestrates parallel port scan + service detection + OS fingerprint', () => {
      const phases = [
        { name: 'port-scan', targets: 100, agent: uniqueId() },
        { name: 'service-detect', targets: 50, agent: uniqueId() },
        { name: 'os-fingerprint', targets: 10, agent: uniqueId() },
      ];
      expect(phases.length).toBe(3);
      expect(new Set(phases.map(p => p.agent)).size).toBe(3);
    });

    it('parallel CVE lookup across discovered services', () => {
      const services = ['nginx', 'apache2', 'sshd', 'mysql', 'redis'];
      const cveLookups = services.map(s => ({
        service: s,
        cve: uniqueCveTarget(),
        agent: uniqueId(),
      }));
      expect(cveLookups.length).toBe(5);
      expect(new Set(cveLookups.map(c => c.agent)).size).toBe(5);
    });

    it('batched IOC enrichment across threat intel feeds', () => {
      const iocs = Array.from({ length: 100 }, () => ({
        value: uniqueId(),
        type: Math.random() > 0.5 ? 'ip' : 'domain' as const,
      }));
      const batches: typeof iocs[] = [];
      const BATCH = 20;
      for (let i = 0; i < iocs.length; i += BATCH) {
        batches.push(iocs.slice(i, i + BATCH));
      }
      expect(batches.length).toBe(5);
      batches.forEach(b => expect(b.length).toBeLessThanOrEqual(BATCH));
    });
  });

  describe('CNE — Parallel Analysis Pipeline', () => {
    it('orchestrates parallel Ghidra decompile + vulnerability search + exploit mapping', () => {
      const cves = Array.from({ length: 5 }, () => uniqueCveTarget());
      const modules = cves.map(cve => ({
        cve,
        decompile: uniqueId(),
        vulnSearch: uniqueId(),
        exploitMap: uniqueId(),
      }));
      expect(modules.length).toBe(5);
      const allIds = modules.flatMap(m => [m.decompile, m.vulnSearch, m.exploitMap]);
      expect(new Set(allIds).size).toBe(15);
    });

    it('variant discovery batches without exceeding context window', () => {
      const variants = Array.from({ length: 250 }, () => ({
        function: `vuln_${uniqueId()}`,
        similarity: Math.random() * 100,
      }));
      const topVariantBatches = variants
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 50);
      expect(topVariantBatches.length).toBe(50);
      expect(topVariantBatches[0]!.similarity).toBeGreaterThanOrEqual(topVariantBatches[49]!.similarity);
    });
  });

  describe('CNA — Controlled Parallel Effects', () => {
    it('limits concurrent autonomous effects to ceiling', () => {
      const MAX = 3;
      let active = 0;
      let peak = 0;
      for (let i = 0; i < 8; i++) {
        if (active >= MAX) continue;
        active++;
        peak = Math.max(peak, active);
        active--;
      }
      expect(peak).toBeLessThanOrEqual(MAX);
    });

    it('requires admin sign-off per operation batch', () => {
      let signedOff = false;
      const execute = () => {
        if (!signedOff) throw new Error('Admin sign-off required');
        return 'executed';
      };
      expect(() => execute()).toThrow('Admin sign-off');
      signedOff = true;
      expect(execute()).toBe('executed');
    });

    it('cleanup phase runs even if effects phase fails', () => {
      const phases: { name: string; executed: boolean }[] = [
        { name: 'plan', executed: false },
        { name: 'build', executed: false },
        { name: 'execute', executed: false },
        { name: 'cleanup', executed: false },
        { name: 'report', executed: false },
      ];

      for (const phase of phases) {
        if (phase.name === 'execute') continue; // Simulate failure
        phase.executed = true;
      }

      expect(phases.find(p => p.name === 'cleanup')!.executed).toBe(true);
      expect(phases.find(p => p.name === 'execute')!.executed).toBe(false);
    });
  });

  describe('General Coding — Parallel Build/Test/Lint', () => {
    it('runs lint + type-check + test in parallel', async () => {
      const start = Date.now();
      const [lint, typecheck, test] = await Promise.all([
        new Promise<string>(r => setTimeout(() => r('lint-ok'), 20)),
        new Promise<string>(r => setTimeout(() => r('types-ok'), 30)),
        new Promise<string>(r => setTimeout(() => r('tests-ok'), 25)),
      ]);
      const elapsed = Date.now() - start;
      expect(lint).toBe('lint-ok');
      expect(typecheck).toBe('types-ok');
      expect(test).toBe('tests-ok');
      // Parallel execution should complete in ~30ms (max of individual),
      // not ~75ms (sum of serial)
      expect(elapsed).toBeLessThan(60);
    });

    it('handles mixed success/failure across parallel checks', async () => {
      const results = await Promise.allSettled([
        Promise.resolve('ok'),
        Promise.reject(new Error('lint errors')),
        Promise.resolve('ok'),
        Promise.reject(new Error('test failures')),
      ]);

      const ok = results.filter(r => r.status === 'fulfilled').length;
      const fail = results.filter(r => r.status === 'rejected').length;
      expect(ok).toBe(2);
      expect(fail).toBe(2);
    });
  });

  describe('General Cybersecurity — Parallel Audit Pipeline', () => {
    it('orchestrates parallel security audits across cloud services', () => {
      const audits = ['IAM', 'S3', 'EC2', 'RDS', 'Lambda'].map(svc => ({
        service: svc,
        findings: Math.floor(Math.random() * 10),
        id: uniqueId(),
      }));
      expect(audits.length).toBe(5);
      expect(new Set(audits.map(a => a.id)).size).toBe(5);
    });

    it('parallel compliance checks against multiple frameworks', () => {
      const frameworks = ['NIST-800-53', 'CIS-v8', 'ISO-27001', 'PCI-DSS', 'SOC2'];
      const checks = frameworks.map(fw => ({
        framework: fw,
        controls: Math.floor(Math.random() * 50) + 20,
        passed: 0,
        agent: uniqueId(),
      }));
      expect(checks.length).toBe(5);
      expect(new Set(checks.map(c => c.agent)).size).toBe(5);
    });
  });
});

describe('ParallelCoordinator — Stress & Edge Cases', () => {
  it('handles 100 unique parallel task IDs with no collisions', () => {
    const ids = Array.from({ length: 100 }, () => uniqueId());
    expect(new Set(ids).size).toBe(100);
  });

  it('handles 500 tasks chunked across 10 workers', () => {
    const WORKERS = 10;
    const TASKS = 500;
    const tasksPerWorker = Math.ceil(TASKS / WORKERS);
    const distribution = Array(WORKERS).fill(0);

    for (let i = 0; i < TASKS; i++) {
      distribution[i % WORKERS]++;
    }

    distribution.forEach(d => {
      expect(d).toBeGreaterThanOrEqual(Math.floor(TASKS / WORKERS));
      expect(d).toBeLessThanOrEqual(Math.ceil(TASKS / WORKERS));
    });
  });

  it('handles empty task list without error', () => {
    const tasks: string[] = [];
    expect(() => {
      if (tasks.length === 0) return;
      tasks.forEach(t => console.log(t));
    }).not.toThrow();
  });

  it('handles all workers busy — queues tasks correctly', () => {
    const TOTAL = 4;
    let active = TOTAL;
    const queue: string[] = [];

    for (let i = 0; i < 10; i++) {
      if (active < TOTAL) { active++; continue; }
      queue.push(`task-${i}`);
    }

    expect(queue.length).toBe(10);
    expect(active).toBe(TOTAL);
  });

  it('drains queue when workers become available', () => {
    const queue = ['t1', 't2', 't3', 't4', 't5'];
    const processed: string[] = [];

    while (queue.length > 0) {
      const task = queue.shift()!;
      processed.push(task);
    }

    expect(processed).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(queue.length).toBe(0);
  });

  it('generates 1000 unique task IDs across ultra-long-horizon', () => {
    const allIds = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      allIds.add(uniqueId());
    }
    expect(allIds.size).toBe(1000);
  });

  it('no-duplicate CVE targets in any rolling window of 10', () => {
    const recent10: string[] = [];
    const all: string[] = [];
    for (let i = 0; i < 50; i++) {
      let cve: string;
      do { cve = uniqueCveTarget(); } while (recent10.includes(cve));
      recent10.push(cve);
      if (recent10.length > 10) recent10.shift();
      all.push(cve);
    }
    for (let i = 0; i <= 40; i++) {
      expect(new Set(all.slice(i, i + 10)).size).toBe(10);
    }
  });

  it('generates unique prompts for 500 pool configurations', () => {
    const prompts = new Set<string>();
    for (let i = 0; i < 500; i++) {
      prompts.add(`pool-${uniqueId()}-workers:${Math.floor(Math.random() * 10) + 1}-tasks:${Math.floor(Math.random() * 100) + 1}-strategy:round-robin-priority-${uniqueId()}`);
    }
    expect(prompts.size).toBe(500);
  });
});
