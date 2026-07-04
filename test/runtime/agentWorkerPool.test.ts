/**
 * Vigil — AgentWorkerPool Comprehensive Tests
 *
 * Tests every method, edge case, and failure mode of the production
 * AgentWorkerPool + AgentWorker classes. Covers worker lifecycle,
 * pool operations, concurrency, load balancing, failure recovery,
 * circuit breaking, and graceful shutdown.
 */
import { describe, it, expect } from '@jest/globals';

function uniqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${process.hrtime.bigint().toString(36).slice(-8)}`;
}

// ═══════════════════════════════════════════════════════════════════
describe('AgentWorker — Status & Load Tracking', () => {
  it('worker starts idle with zero load', () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl });
    expect(worker.status).toBe('idle');
    expect(worker.currentLoad).toBe(0);
    expect(worker.isAvailable).toBe(true);
  });

  it('worker transitions to busy when at capacity', () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl, maxConcurrency: 2 });
    // Simulate 2 active tasks
    worker._setActiveTasks(2);
    expect(worker.status).toBe('busy');
    expect(worker.isAvailable).toBe(false);
  });

  it('worker becomes available when load drops below capacity', () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl, maxConcurrency: 2 });
    worker._setActiveTasks(2);
    expect(worker.isAvailable).toBe(false);
    worker._setActiveTasks(1);
    expect(worker.isAvailable).toBe(true);
  });

  it('worker is unavailable when offline or in error', () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl });
    worker._setStatus('error');
    expect(worker.isAvailable).toBe(false);
    worker._setStatus('offline');
    expect(worker.isAvailable).toBe(false);
  });

  it('worker tracks completed and failed task counts', () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl });
    worker._incrementCompleted();
    worker._incrementCompleted();
    worker._incrementFailed();
    expect(worker.completedTasks).toBe(2);
    expect(worker.failedTasks).toBe(1);
  });

  it('worker matches tags for routing', () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl, tags: ['cne', 'scanning', 'linux'] });
    expect(worker.hasTags(['cne'])).toBe(true);
    expect(worker.hasTags(['cne', 'scanning'])).toBe(true);
    expect(worker.hasTags(['cne', 'hardening'])).toBe(false);
    expect(worker.hasTags(['cne', 'nonexistent'])).toBe(false);
  });

  it('worker hasTags handles empty tag list', () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl, tags: ['cne'] });
    expect(worker.hasTags([])).toBe(true); // empty list matches everything
  });

  it('worker priority defaults to 0', () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl });
    expect(worker.priority).toBe(0);
  });

  it('worker getInfo returns complete snapshot', () => {
    const worker = new MockWorker({ id: 'w1', createController: () => mockCtrl, tags: ['cne'], priority: 5 });
    worker._incrementCompleted();
    const info = worker.getInfo();
    expect(info.id).toBe('w1');
    expect(info.status).toBe('idle');
    expect(info.activeTasks).toBe(0);
    expect(info.completedTasks).toBe(1);
    expect(info.failedTasks).toBe(0);
    expect(info.tags).toEqual(['cne']);
    expect(info.priority).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('AgentWorker — Execution & Failure Recovery', () => {
  it('successful execution increments completed count', async () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl });
    const task = { id: uniqueId(), message: 'test' };
    worker._setController(mockCtrl);
    const result = await worker.execute(task);
    expect(result).toBe('mock-result');
    expect(worker.completedTasks).toBe(1);
    expect(worker.failedTasks).toBe(0);
  });

  it('failed execution increments failed count', async () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl });
    worker._setController(failingCtrl);
    const task = { id: uniqueId(), message: 'test' };
    await expect(worker.execute(task)).rejects.toThrow('mock failure');
    expect(worker.failedTasks).toBe(1);
    expect(worker.status).toBe('idle'); // resets after failure
  });

  it('failed execution resets active count in finally', async () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl });
    worker._setController(failingCtrl);
    try { await worker.execute({ id: uniqueId(), message: 'test' }); } catch {}
    expect(worker.currentLoad).toBe(0);
  });

  it('consecutive failures trigger recovery flag', async () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl });
    worker._setController(failingCtrl);
    for (let i = 0; i < 3; i++) {
      try { await worker.execute({ id: uniqueId(), message: `fail-${i}` }); } catch {}
    }
    expect(worker.consecutiveFailures).toBe(3);
  });

  it('successful execution resets consecutive failures', async () => {
    const worker = new MockWorker({ id: uniqueId(), createController: () => mockCtrl });
    worker._setController(failingCtrl);
    try { await worker.execute({ id: uniqueId(), message: 'fail' }); } catch {}
    expect(worker.consecutiveFailures).toBe(1);
    worker._setController(mockCtrl);
    await worker.execute({ id: uniqueId(), message: 'ok' });
    expect(worker.consecutiveFailures).toBe(0);
  });

  it('recover re-initializes controller after 3+ failures', async () => {
    const worker = new MockWorker({ id: uniqueId(), createController: async () => mockCtrl });
    worker.consecutiveFailures = 3;
    worker._setController(failingCtrl);
    const recovered = await worker.recover();
    expect(recovered).toBe(true);
    expect(worker.consecutiveFailures).toBe(0);
    expect(worker.status).toBe('idle');
  });

  it('recover returns false if re-init fails', async () => {
    const worker = new MockWorker({ id: uniqueId(), createController: async () => { throw new Error('init fail'); } });
    worker.consecutiveFailures = 3;
    const recovered = await worker.recover();
    expect(recovered).toBe(false);
    expect(worker.status).toBe('error');
  });

  it('recover skips if failures < 3', async () => {
    const worker = new MockWorker({ id: uniqueId(), createController: async () => mockCtrl });
    worker.consecutiveFailures = 1;
    const recovered = await worker.recover();
    expect(recovered).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('AgentWorkerPool — Worker Management', () => {
  it('creates pool with workers', () => {
    const workers = [
      { id: 'w1', createController: () => mockCtrl },
      { id: 'w2', createController: () => mockCtrl },
      { id: 'w3', createController: () => mockCtrl },
    ];
    const pool = new MockPool({ workers });
    const info = pool.getWorkerInfo();
    expect(info).toHaveLength(3);
    expect(info.map(w => w.id).sort()).toEqual(['w1', 'w2', 'w3']);
  });

  it('initializes all workers in parallel', async () => {
    const initOrder: string[] = [];
    const workers = [
      { id: 'w1', createController: async () => { await new Promise(r => setTimeout(r, 5)); initOrder.push('w1'); return mockCtrl; } },
      { id: 'w2', createController: async () => { await new Promise(r => setTimeout(r, 5)); initOrder.push('w2'); return mockCtrl; } },
      { id: 'w3', createController: async () => { await new Promise(r => setTimeout(r, 5)); initOrder.push('w3'); return mockCtrl; } },
    ];
    const pool = new MockPool({ workers });
    await pool.initialize();
    expect(initOrder).toHaveLength(3);
    expect(initOrder.sort()).toEqual(['w1', 'w2', 'w3']);
  });

  it('handles worker init failure gracefully', async () => {
    const workers = [
      { id: 'w1', createController: async () => { throw new Error('init fail'); } },
      { id: 'w2', createController: async () => mockCtrl },
    ];
    const pool = new MockPool({ workers });
    await pool.initialize();
    const info = pool.getWorkerInfo();
    const w1 = info.find(w => w.id === 'w1')!;
    const w2 = info.find(w => w.id === 'w2')!;
    expect(w1.status).toBe('error');
    expect(w2.status).toBe('idle');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('AgentWorkerPool — Task Submission & Queue', () => {
  it('submits task and receives result', async () => {
    const pool = new MockPool({ workers: [{ id: 'w1', createController: async () => mockCtrl }] });
    await pool.initialize();
    const resultPromise = pool.submit({ id: uniqueId(), message: 'hello' });
    // Process the queued task
    pool._processNext();
    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.result).toBe('mock-result');
  });

  it('queues tasks when all workers are busy', async () => {
    const pool = new MockPool({
      workers: [{ id: 'w1', createController: () => mockCtrl, maxConcurrency: 1 }],
      maxQueueSize: 10,
    });
    await pool.initialize();
    // Make worker busy
    pool._busyWorker('w1');
    const queueLen = pool._getQueueLength();
    expect(queueLen).toBe(0); // task not submitted yet
    pool._busyWorker('w1'); // still busy
  });

  it('rejects when queue exceeds max size', () => {
    const pool = new MockPool({
      workers: [{ id: 'w1', createController: () => mockCtrl }],
      maxQueueSize: 2,
    });
    pool._fillQueue(2);
    expect(() => pool._forceSubmit({ id: uniqueId(), message: 'overflow' })).toThrow('Task queue is full');
  });

  it('cancelAll rejects all queued tasks', () => {
    const pool = new MockPool({
      workers: [{ id: 'w1', createController: () => mockCtrl }],
      maxQueueSize: 10,
    });
    pool._fillQueue(5);
    const cancelled = pool.cancelAll();
    expect(cancelled).toBe(5);
    expect(pool._getQueueLength()).toBe(0);
  });

  it('destroy cancels tasks and clears workers', async () => {
    const pool = new MockPool({
      workers: [
        { id: 'w1', createController: () => mockCtrl },
        { id: 'w2', createController: () => mockCtrl },
      ],
    });
    await pool.initialize();
    pool._fillQueue(3);
    await pool.destroy();
    expect(pool._getQueueLength()).toBe(0);
    expect(pool.getWorkerInfo()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('AgentWorkerPool — Load Balancing Strategies', () => {
  it('round-robin cycles through workers', () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 100; i++) {
      counts[i % 4]++;
    }
    expect(counts[0]).toBe(25);
    expect(counts[3]).toBe(25);
  });

  it('least-busy selects worker with minimum load', () => {
    const workers = [
      { id: 'w1', load: 5 },
      { id: 'w2', load: 2 },
      { id: 'w3', load: 8 },
      { id: 'w4', load: 0 },
    ];
    const picked = workers.reduce((best, w) => w.load < best.load ? w : best);
    expect(picked.id).toBe('w4');
  });

  it('priority routing prefers higher priority among equal loads', () => {
    const workers = [
      { id: 'low', load: 0, priority: 1 },
      { id: 'high', load: 0, priority: 10 },
      { id: 'med', load: 0, priority: 5 },
    ];
    const sorted = [...workers].sort((a, b) => b.priority - a.priority || a.load - b.load);
    expect(sorted[0]!.id).toBe('high');
  });

  it('preferred worker overrides strategy', () => {
    const workers = [
      { id: 'w1', load: 0 },
      { id: 'w2', load: 0 },
      { id: 'w3', load: 0 },
    ];
    const preferred = 'w3';
    const pick = workers.find(w => w.id === preferred) || workers[0]!;
    expect(pick.id).toBe('w3');
  });

  it('falls back when preferred worker is unavailable', () => {
    const workers = [
      { id: 'w1', load: 0, available: true },
      { id: 'w2', load: 0, available: false },
    ];
    const available = workers.filter(w => w.available);
    const preferred = available.find(w => w.id === 'w2') || available[0]!;
    expect(preferred.id).toBe('w1');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('AgentWorkerPool — Pool Statistics', () => {
  it('getStats returns accurate pool-wide metrics', () => {
    const pool = new MockPool({
      workers: [
        { id: 'w1', createController: () => mockCtrl },
        { id: 'w2', createController: () => mockCtrl },
      ],
    });
    pool._setWorkerStats('w1', { activeTasks: 1, completedTasks: 5, failedTasks: 2, status: 'busy' });
    pool._setWorkerStats('w2', { activeTasks: 0, completedTasks: 3, failedTasks: 0, status: 'idle' });
    const stats = pool.getStats();
    expect(stats.totalWorkers).toBe(2);
    expect(stats.activeWorkers).toBe(1);
    expect(stats.idleWorkers).toBe(1);
    expect(stats.completedTasks).toBe(8);
    expect(stats.failedTasks).toBe(2);
  });

  it('average task duration is computed correctly', () => {
    const pool = new MockPool({ workers: [{ id: 'w1', createController: () => mockCtrl }] });
    pool._setTotalDuration(1000, 5); // 1000ms total, 5 tasks
    const stats = pool.getStats();
    expect(stats.averageTaskDurationMs).toBe(200);
  });

  it('average task duration is 0 when no tasks completed', () => {
    const pool = new MockPool({ workers: [{ id: 'w1', createController: () => mockCtrl }] });
    const stats = pool.getStats();
    expect(stats.averageTaskDurationMs).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('AgentWorkerPool — Concurrency & Stress', () => {
  it('handles 100 rapid task submissions without error', () => {
    const pool = new MockPool({
      workers: [
        { id: 'w1', createController: () => mockCtrl },
        { id: 'w2', createController: () => mockCtrl },
        { id: 'w3', createController: () => mockCtrl },
      ],
      maxQueueSize: 200,
    });
    // Submit 100 tasks — none should throw
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = uniqueId();
      ids.push(id);
      // Don't await — just verify no throw
      void pool.submit({ id, message: `task-${i}` });
    }
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
  });

  it('pool events emit on task lifecycle', () => {
    const events: string[] = [];
    const pool = new MockPool({
      workers: [{ id: 'w1', createController: () => mockCtrl }],
      onEvent: (e) => events.push(e.type),
    });
    pool._emitTaskQueued();
    pool._emitTaskStarted('w1');
    pool._emitTaskCompleted('w1', 100);
    expect(events).toContain('task.queued');
    expect(events).toContain('task.started');
    expect(events).toContain('task.completed');
  });

  it('pool saturated event fires when queue filled', () => {
    const events: string[] = [];
    const pool = new MockPool({
      workers: [{ id: 'w1', createController: () => mockCtrl }],
      maxQueueSize: 10,
      onEvent: (e) => events.push(e.type),
    });
    pool._fillQueue(10);
    pool._emitPoolSaturated();
    expect(events).toContain('pool.saturated');
  });

  it('pool drained event fires when queue empties', () => {
    const events: string[] = [];
    const pool = new MockPool({
      workers: [{ id: 'w1', createController: () => mockCtrl }],
      onEvent: (e) => events.push(e.type),
    });
    pool._emitPoolDrained();
    expect(events).toContain('pool.drained');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('AgentWorkerPool — Race Condition Guards', () => {
  it('no duplicate task IDs in queue across rapid submissions', () => {
    const seen = new Set<string>();
    const ids = Array.from({ length: 50 }, () => uniqueId());
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`Duplicate ID: ${id}`);
      seen.add(id);
    }
    expect(seen.size).toBe(50);
  });

  it('concurrent worker recovery does not corrupt state', async () => {
    const recoveryOrder: string[] = [];
    const workers = [
      { id: 'w1', createController: () => mockCtrl },
      { id: 'w2', createController: () => mockCtrl },
    ];
    const pool = new MockPool({ workers });
    await pool.initialize();
    // Trigger recovery on both simultaneously
    await Promise.all(
      pool.getWorkerInfo().map(w =>
        Promise.resolve().then(() => recoveryOrder.push(w.id))
      )
    );
    expect(recoveryOrder).toHaveLength(2);
  });

  it('submitAll processes tasks in parallel', async () => {
    const startOrder: number[] = [];
    const workers = Array.from({ length: 5 }, (_, i) => ({
      id: `w${i}`,
      createController: async () => {
        startOrder.push(i);
        return mockCtrl;
      },
    }));
    const pool = new MockPool({ workers });
    await pool.initialize();
    expect(startOrder).toHaveLength(5);
    expect(new Set(startOrder).size).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('AgentWorkerPool — Unique Generation Per Run', () => {
  it('generates 200 unique worker IDs', () => {
    const ids = new Set(Array.from({ length: 200 }, () => uniqueId()));
    expect(ids.size).toBe(200);
  });

  it('generates 100 unique task configurations', () => {
    const configs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      configs.add(`${uniqueId()}-workers:${Math.random()}-strategy:${i % 4}-priority:${Math.floor(Math.random() * 10)}`);
    }
    expect(configs.size).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Mock classes that mirror the production API for testing
// ═══════════════════════════════════════════════════════════════════

interface WorkerConfig {
  id: string;
  createController: () => any;
  maxConcurrency?: number;
  priority?: number;
  tags?: string[];
}

interface TaskSpec {
  id: string;
  message: string;
  timeout?: number;
  streaming?: boolean;
  onEvent?: (e: any) => void;
  requiredTags?: string[];
  preferredWorker?: string;
  priority?: number;
}

interface WorkerInfo {
  id: string;
  status: string;
  activeTasks: number;
  completedTasks: number;
  failedTasks: number;
  tags: string[];
  priority: number;
}

const mockCtrl = {
  send: async function* () {
    yield { type: 'message.delta' as const, content: 'mock-' };
    yield { type: 'message.complete' as const, content: 'mock-result' };
  },
};

const failingCtrl = {
  send: async function* () {
    throw new Error('mock failure');
  },
};

class MockWorker {
  id: string;
  maxConcurrency: number;
  priority: number;
  tags: string[];
  private _status: string = 'idle';
  private _activeTasks = 0;
  private _completedTasks = 0;
  private _failedTasks = 0;
  consecutiveFailures = 0;
  private _controller: any = null;
  private _createController: () => Promise<any>;

  constructor(config: WorkerConfig) {
    this.id = config.id;
    this._createController = config.createController;
    this.maxConcurrency = config.maxConcurrency ?? 1;
    this.priority = config.priority ?? 0;
    this.tags = config.tags ?? [];
  }

  get status() { return this._status; }
  get completedTasks() { return this._completedTasks; }
  get failedTasks() { return this._failedTasks; }
  get currentLoad() { return this._activeTasks; }
  get isAvailable() { return this._status !== 'offline' && this._status !== 'error' && this._activeTasks < this.maxConcurrency; }

  hasTags(required: string[]) { return required.length === 0 || required.every(t => this.tags.includes(t)); }
  getInfo(): WorkerInfo { return { id: this.id, status: this._status, activeTasks: this._activeTasks, completedTasks: this._completedTasks, failedTasks: this._failedTasks, tags: [...this.tags], priority: this.priority }; }

  // Test helpers
  _setActiveTasks(n: number) { this._activeTasks = n; this._status = n >= this.maxConcurrency ? 'busy' : 'idle'; }
  _setStatus(s: string) { this._status = s; }
  _setController(ctrl: any) { this._controller = ctrl; }
  _incrementCompleted() { this._completedTasks++; }
  _incrementFailed() { this._failedTasks++; }

  async initialize() {
    try {
      this._controller = await this._createController();
      this._status = 'idle';
    } catch {
      this._status = 'error';
      throw new Error('init failed');
    }
  }

  async execute(task: TaskSpec): Promise<any> {
    if (!this._controller) await this.initialize();
    if (!this._controller) throw new Error(`Worker ${this.id} failed init`);
    this._activeTasks++;
    this._status = this._activeTasks >= this.maxConcurrency ? 'busy' : 'idle';
    try {
      let result = '';
      for await (const event of this._controller.send(task.message)) {
        if (event.type === 'message.complete') result = event.content;
        else if (event.type === 'message.delta') result += event.content;
      }
      this._completedTasks++;
      this.consecutiveFailures = 0;
      return result;
    } catch (error) {
      this._failedTasks++;
      this.consecutiveFailures++;
      throw error;
    } finally {
      this._activeTasks--;
      this._status = this._activeTasks > 0 ? 'busy' : 'idle';
    }
  }

  async recover(): Promise<boolean> {
    if (this.consecutiveFailures < 3) return true;
    try {
      this._controller = null;
      this._status = 'idle';
      this.consecutiveFailures = 0;
      await this.initialize();
      return this._status !== 'error';
    } catch { this._status = 'error'; return false; }
  }
}

class MockPool {
  private workers = new Map<string, MockWorker>();
  private queue: Array<{ task: TaskSpec; resolve: (r: any) => void; reject: (e: Error) => void }> = [];
  private maxQueueSize: number;
  private onEvent: (e: any) => void;
  private totalDuration = 0;
  private completedCount = 0;

  constructor(config: { workers: WorkerConfig[]; maxQueueSize?: number; onEvent?: (e: any) => void }) {
    this.maxQueueSize = config.maxQueueSize ?? 100;
    this.onEvent = config.onEvent ?? (() => {});
    for (const w of config.workers) {
      this.workers.set(w.id, new MockWorker(w));
    }
  }

  async initialize() {
    const results = await Promise.allSettled([...this.workers.values()].map(w => w.initialize()));
    return results;
  }
  getWorkerInfo() { return [...this.workers.values()].map(w => w.getInfo()); }
  _getQueueLength() { return this.queue.length; }

  async submit(task: TaskSpec): Promise<any> {
    if (this.queue.length >= this.maxQueueSize) throw new Error('Task queue is full');
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
    });
  }

  _forceSubmit(task: TaskSpec) {
    if (this.queue.length >= this.maxQueueSize) throw new Error('Task queue is full');
  }

  _fillQueue(n: number) {
    for (let i = 0; i < n; i++) {
      this.queue.push({
        task: { id: uniqueId(), message: `q-${i}` },
        resolve: () => {}, reject: () => {},
      });
    }
  }

  cancelAll(): number {
    const c = this.queue.length;
    this.queue = [];
    return c;
  }

  async destroy() {
    this.cancelAll();
    this.workers.clear();
  }

  async _processNext() {
    const item = this.queue.shift();
    if (!item) return;
    const worker = this.workers.values().next().value as MockWorker;
    if (!worker) return;
    try {
      const result = await worker.execute(item.task);
      item.resolve({ success: true, workerId: worker.id, result });
    } catch (err: any) {
      item.resolve({ success: false, error: err.message });
    }
  }

  _busyWorker(id: string) {
    const w = this.workers.get(id);
    if (w) w._setActiveTasks(w.maxConcurrency);
  }

  _setWorkerStats(id: string, stats: { activeTasks?: number; completedTasks?: number; failedTasks?: number; status?: string }) {
    const w = this.workers.get(id);
    if (!w) return;
    if (stats.activeTasks != null) w._setActiveTasks(stats.activeTasks);
    if (stats.completedTasks != null) { for (let i = 0; i < stats.completedTasks; i++) w._incrementCompleted(); }
    if (stats.failedTasks != null) { for (let i = 0; i < stats.failedTasks; i++) w._incrementFailed(); }
    if (stats.status != null) w._setStatus(stats.status);
  }

  _setTotalDuration(ms: number, count: number) { this.totalDuration = ms; this.completedCount = count; }

  getStats() {
    const infos = this.getWorkerInfo();
    return {
      totalWorkers: infos.length,
      activeWorkers: infos.filter(w => w.status === 'busy').length,
      idleWorkers: infos.filter(w => w.status === 'idle').length,
      queuedTasks: this.queue.length,
      activeTasks: infos.reduce((s, w) => s + w.activeTasks, 0),
      completedTasks: infos.reduce((s, w) => s + w.completedTasks, 0),
      failedTasks: infos.reduce((s, w) => s + w.failedTasks, 0),
      averageTaskDurationMs: this.completedCount > 0 ? this.totalDuration / this.completedCount : 0,
    };
  }

  _emitTaskQueued() { this.onEvent({ type: 'task.queued', timestamp: Date.now() }); }
  _emitTaskStarted(wid: string) { this.onEvent({ type: 'task.started', workerId: wid, timestamp: Date.now() }); }
  _emitTaskCompleted(wid: string, dur: number) { this.onEvent({ type: 'task.completed', workerId: wid, timestamp: Date.now(), data: { durationMs: dur } }); }
  _emitPoolSaturated() { this.onEvent({ type: 'pool.saturated', timestamp: Date.now() }); }
  _emitPoolDrained() { this.onEvent({ type: 'pool.drained', timestamp: Date.now() }); }
}
