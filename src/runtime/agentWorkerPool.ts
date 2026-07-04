/**
 * Agent Worker Pool Module
 *
 * Provides multi-agent parallelism with automatic load balancing,
 * work distribution, and result aggregation for AGI workflows.
 *
 * Worker pool for parallel agent operations.
 * Framework: agi-cli
 */

import type { AgentController } from './agentController.js';
import type { AgentEventUnion } from '../contracts/v1/agent.js';

// ============================================================================
// Types
// ============================================================================

export type WorkerStatus = 'idle' | 'busy' | 'error' | 'offline';
export type BalanceStrategy = 'round-robin' | 'least-busy' | 'random' | 'priority';

export interface AgentWorkerConfig {
  /** Unique worker identifier */
  id: string;
  /** Agent controller factory or instance */
  createController: () => Promise<AgentController> | AgentController;
  /** Maximum concurrent tasks this worker can handle (default: 1) */
  maxConcurrency?: number;
  /** Priority for task assignment (higher = preferred) */
  priority?: number;
  /** Tags for routing specific task types */
  tags?: string[];
}

export interface AgentTask<T = string> {
  /** Unique task identifier */
  id: string;
  /** The message/prompt to send to the agent */
  message: string;
  /** Optional transformer for the result */
  transform?: (result: string) => T;
  /** Required worker tags (task routed to workers with all these tags) */
  requiredTags?: string[];
  /** Preferred worker ID (soft preference) */
  preferredWorker?: string;
  /** Task priority (higher = processed first) */
  priority?: number;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Whether to stream events */
  streaming?: boolean;
  /** Callback for streaming events */
  onEvent?: (event: AgentEventUnion) => void;
}

export interface TaskResult<T = string> {
  taskId: string;
  workerId: string;
  success: boolean;
  result?: T;
  error?: Error;
  durationMs: number;
  startedAt: number;
  completedAt: number;
}

export interface AgentWorkerPoolConfig {
  /** Worker configurations */
  workers: AgentWorkerConfig[];
  /** Load balancing strategy (default: 'least-busy') */
  balanceStrategy?: BalanceStrategy;
  /** Default task timeout in ms (default: 24 hours - 86400000ms) */
  defaultTimeout?: number;
  /** Maximum queue size before rejecting tasks (default: 100) */
  maxQueueSize?: number;
  /** Callback for pool events */
  onEvent?: (event: PoolEvent) => void;
}

export interface PoolEvent {
  type: 'worker.ready' | 'worker.busy' | 'worker.idle' | 'worker.error' |
        'task.queued' | 'task.started' | 'task.completed' | 'task.failed' |
        'pool.saturated' | 'pool.drained';
  timestamp: number;
  workerId?: string;
  taskId?: string;
  data?: Record<string, unknown>;
}

export interface WorkerInfo {
  id: string;
  status: WorkerStatus;
  activeTasks: number;
  completedTasks: number;
  failedTasks: number;
  tags: string[];
  priority: number;
}

export interface PoolStats {
  totalWorkers: number;
  activeWorkers: number;
  idleWorkers: number;
  queuedTasks: number;
  activeTasks: number;
  completedTasks: number;
  failedTasks: number;
  averageTaskDurationMs: number;
}

// ============================================================================
// Agent Worker
// ============================================================================

class AgentWorker {
  readonly id: string;
  readonly maxConcurrency: number;
  readonly priority: number;
  readonly tags: Set<string>;

  private controller: AgentController | null = null;
  private readonly createController: () => Promise<AgentController> | AgentController;
  private activeTasks = 0;
  private _completedTasks = 0;
  private _failedTasks = 0;
  private _status: WorkerStatus = 'idle';

  constructor(config: AgentWorkerConfig) {
    this.id = config.id;
    this.createController = config.createController;
    this.maxConcurrency = config.maxConcurrency ?? 1;
    this.priority = config.priority ?? 0;
    this.tags = new Set(config.tags ?? []);
  }

  get status(): WorkerStatus {
    return this._status;
  }

  get completedTasks(): number {
    return this._completedTasks;
  }

  get failedTasks(): number {
    return this._failedTasks;
  }

  get currentLoad(): number {
    return this.activeTasks;
  }

  get isAvailable(): boolean {
    return this._status !== 'offline' && this._status !== 'error' && this.activeTasks < this.maxConcurrency;
  }

  hasTags(requiredTags: string[]): boolean {
    return requiredTags.every(tag => this.tags.has(tag));
  }

  async initialize(): Promise<void> {
    if (this.controller) return;
    try {
      this.controller = await this.createController();
      this._status = 'idle';
    } catch (error) {
      this._status = 'error';
      throw error;
    }
  }

  async execute<T>(task: AgentTask<T>): Promise<T> {
    if (!this.controller) {
      await this.initialize();
    }
    if (!this.controller) {
      throw new Error(`Worker ${this.id} failed to initialize`);
    }

    this.activeTasks++;
    this._status = this.activeTasks >= this.maxConcurrency ? 'busy' : 'idle';

    try {
      let result = '';

      if (task.streaming && task.onEvent) {
        // Streaming mode: collect events and final result
        for await (const event of this.controller.send(task.message)) {
          task.onEvent(event);
          if (event.type === 'message.complete') {
            result = event.content;
          } else if (event.type === 'message.delta') {
            result += event.content;
          }
        }
      } else {
        // Non-streaming: collect complete response
        for await (const event of this.controller.send(task.message)) {
          if (event.type === 'message.complete') {
            result = event.content;
          } else if (event.type === 'message.delta') {
            result += event.content;
          }
        }
      }

      this._completedTasks++;
      this.consecutiveFailures = 0;
      return task.transform ? task.transform(result) : (result as unknown as T);
    } catch (error) {
      this._failedTasks++;
      this.consecutiveFailures++;
      throw error;
    } finally {
      this.activeTasks--;
      this._status = this.activeTasks > 0 ? 'busy' : 'idle';
    }
  }

  /**
   * Attempt to recover a failing worker by re-initializing its controller.
   * Returns true if recovery succeeded.
   */
  async recover(): Promise<boolean> {
    if (this.consecutiveFailures < 3) return true;
    try {
      this.controller = null;
      this._status = 'idle';
      this.consecutiveFailures = 0;
      await this.initialize();
      return (this._status as string) !== 'error';
    } catch {
      this._status = 'error';
      return false;
    }
  }

  private consecutiveFailures = 0;

  getInfo(): WorkerInfo {
    return {
      id: this.id,
      status: this._status,
      activeTasks: this.activeTasks,
      completedTasks: this._completedTasks,
      failedTasks: this._failedTasks,
      tags: Array.from(this.tags),
      priority: this.priority,
    };
  }
}

// ============================================================================
// Agent Worker Pool
// ============================================================================

export class AgentWorkerPool {
  private readonly workers = new Map<string, AgentWorker>();
  private readonly taskQueue: Array<{
    task: AgentTask;
    resolve: (result: TaskResult) => void;
    reject: (error: Error) => void;
    queuedAt: number;
  }> = [];
  private readonly balanceStrategy: BalanceStrategy;
  private readonly defaultTimeout: number;
  private readonly maxQueueSize: number;
  private readonly onEvent: (event: PoolEvent) => void;
  private roundRobinIndex = 0;
  private totalTaskDuration = 0;
  private completedTaskCount = 0;
  private processing = false;

  constructor(config: AgentWorkerPoolConfig) {
    this.balanceStrategy = config.balanceStrategy ?? 'least-busy';
    this.defaultTimeout = config.defaultTimeout ?? 24 * 60 * 60 * 1000; // 24 hours default timeout
    this.maxQueueSize = config.maxQueueSize ?? 100;
    this.onEvent = config.onEvent ?? (() => {});

    for (const workerConfig of config.workers) {
      const worker = new AgentWorker(workerConfig);
      this.workers.set(worker.id, worker);
    }
  }

  /**
   * Initialize all workers
   */
  async initialize(): Promise<void> {
    const initPromises = Array.from(this.workers.values()).map(async (worker) => {
      try {
        await worker.initialize();
        this.emit({ type: 'worker.ready', workerId: worker.id, timestamp: Date.now() });
      } catch (error) {
        this.emit({
          type: 'worker.error',
          workerId: worker.id,
          timestamp: Date.now(),
          data: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    });

    await Promise.allSettled(initPromises);
  }

  /**
   * Submit a task to the pool
   */
  async submit<T>(task: AgentTask<T>): Promise<TaskResult<T>> {
    if (this.taskQueue.length >= this.maxQueueSize) {
      throw new Error('Task queue is full');
    }

    return new Promise((resolve, reject) => {
      this.taskQueue.push({
        task: task as AgentTask,
        resolve: resolve as (result: TaskResult) => void,
        reject,
        queuedAt: Date.now(),
      });

      this.emit({
        type: 'task.queued',
        taskId: task.id,
        timestamp: Date.now(),
        data: { queueLength: this.taskQueue.length },
      });

      if (this.taskQueue.length >= this.maxQueueSize) {
        this.emit({ type: 'pool.saturated', timestamp: Date.now() });
      }

      // Trigger processing
      this.processQueue();
    });
  }

  /**
   * Submit multiple tasks and wait for all results
   */
  async submitAll<T>(tasks: AgentTask<T>[]): Promise<TaskResult<T>[]> {
    const promises = tasks.map(task => this.submit(task));
    return Promise.all(promises);
  }

  /**
   * Submit multiple tasks and process results as they complete
   */
  async *submitStream<T>(tasks: AgentTask<T>[]): AsyncGenerator<TaskResult<T>> {
    const pending = tasks.map(task => this.submit(task));

    while (pending.length > 0) {
      const result = await Promise.race(
        pending.map((p, i) => p.then(r => ({ result: r, index: i })))
      );
      pending.splice(result.index, 1);
      yield result.result;
    }
  }

  /**
   * Process queued tasks
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.taskQueue.length > 0) {
        const worker = this.selectWorker(this.taskQueue[0]?.task);
        if (!worker) {
          // No available workers, wait and retry
          await this.sleep(50);
          continue;
        }

        const item = this.taskQueue.shift();
        if (!item) break;

        // Execute task asynchronously (don't await)
        this.executeTask(worker, item.task, item.resolve, item.reject, item.queuedAt);
      }

      if (this.taskQueue.length === 0) {
        this.emit({ type: 'pool.drained', timestamp: Date.now() });
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Execute a task on a worker
   */
  private async executeTask<T>(
    worker: AgentWorker,
    task: AgentTask<T>,
    resolve: (result: TaskResult<T>) => void,
    reject: (error: Error) => void,
    queuedAt: number
  ): Promise<void> {
    const startedAt = Date.now();

    this.emit({
      type: 'task.started',
      taskId: task.id,
      workerId: worker.id,
      timestamp: startedAt,
      data: { queueWaitMs: startedAt - queuedAt },
    });

    this.emit({ type: 'worker.busy', workerId: worker.id, timestamp: startedAt });

    try {
      const timeout = task.timeout ?? this.defaultTimeout;
      const result = await Promise.race([
        worker.execute(task),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`Task ${task.id} timed out after ${timeout}ms`)), timeout)
        ),
      ]);

      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;
      this.totalTaskDuration += durationMs;
      this.completedTaskCount++;

      this.emit({
        type: 'task.completed',
        taskId: task.id,
        workerId: worker.id,
        timestamp: completedAt,
        data: { durationMs },
      });

      resolve({
        taskId: task.id,
        workerId: worker.id,
        success: true,
        result,
        durationMs,
        startedAt,
        completedAt,
      });
    } catch (error) {
      const completedAt = Date.now();
      const err = error instanceof Error ? error : new Error(String(error));

      // Attempt worker recovery on failure — re-initialize the
      // controller so the worker can serve future tasks instead of
      // staying broken permanently.
      void worker.recover();

      this.emit({
        type: 'task.failed',
        taskId: task.id,
        workerId: worker.id,
        timestamp: completedAt,
        data: { error: err.message },
      });

      resolve({
        taskId: task.id,
        workerId: worker.id,
        success: false,
        error: err,
        durationMs: completedAt - startedAt,
        startedAt,
        completedAt,
      });
    } finally {
      if (worker.isAvailable) {
        this.emit({ type: 'worker.idle', workerId: worker.id, timestamp: Date.now() });
      }

      // Continue processing queue
      this.processQueue();
    }
  }

  /**
   * Select a worker based on the balancing strategy
   */
  private selectWorker(task?: AgentTask): AgentWorker | null {
    const available = this.getAvailableWorkers(task);
    if (available.length === 0) return null;

    // Check for preferred worker
    if (task?.preferredWorker) {
      const preferred = available.find(w => w.id === task.preferredWorker);
      if (preferred) return preferred;
    }

    switch (this.balanceStrategy) {
      case 'round-robin': {
        const worker = available[this.roundRobinIndex % available.length]!;
        this.roundRobinIndex++;
        return worker;
      }
      case 'random': {
        const idx = Math.floor(Math.random() * available.length);
        return available[idx]!;
      }
      case 'priority': {
        // Sort by priority (descending) then by load (ascending)
        available.sort((a, b) => {
          if (b.priority !== a.priority) return b.priority - a.priority;
          return a.currentLoad - b.currentLoad;
        });
        return available[0]!;
      }
      case 'least-busy':
      default: {
        // Sort by current load (ascending)
        available.sort((a, b) => a.currentLoad - b.currentLoad);
        return available[0]!;
      }
    }
  }

  /**
   * Get available workers filtered by task requirements
   */
  private getAvailableWorkers(task?: AgentTask): AgentWorker[] {
    const workers = Array.from(this.workers.values()).filter(w => w.isAvailable);

    if (task?.requiredTags && task.requiredTags.length > 0) {
      return workers.filter(w => w.hasTags(task.requiredTags!));
    }

    return workers;
  }

  /**
   * Get information about all workers
   */
  getWorkerInfo(): WorkerInfo[] {
    return Array.from(this.workers.values()).map(w => w.getInfo());
  }

  /**
   * Get pool statistics
   */
  getStats(): PoolStats {
    const workerInfos = this.getWorkerInfo();
    const activeWorkers = workerInfos.filter(w => w.status === 'busy').length;
    const activeTasks = workerInfos.reduce((sum, w) => sum + w.activeTasks, 0);
    const completedTasks = workerInfos.reduce((sum, w) => sum + w.completedTasks, 0);
    const failedTasks = workerInfos.reduce((sum, w) => sum + w.failedTasks, 0);

    return {
      totalWorkers: workerInfos.length,
      activeWorkers,
      idleWorkers: workerInfos.length - activeWorkers,
      queuedTasks: this.taskQueue.length,
      activeTasks,
      completedTasks,
      failedTasks,
      averageTaskDurationMs: this.completedTaskCount > 0
        ? this.totalTaskDuration / this.completedTaskCount
        : 0,
    };
  }

  /**
   * Cancel all queued tasks
   */
  cancelAll(): number {
    const cancelled = this.taskQueue.length;
    while (this.taskQueue.length > 0) {
      const item = this.taskQueue.shift();
      if (item) {
        item.reject(new Error('Task cancelled'));
      }
    }
    return cancelled;
  }

  /**
   * Gracefully shut down the pool: cancel all queued tasks, wait for
   * in-flight tasks to complete, then clear worker state. Call before
   * discarding the pool to prevent resource leaks.
   */
  async destroy(): Promise<void> {
    this.cancelAll();
    // Give in-flight tasks a brief window to finish, then force-stop.
    await this.sleep(500);
    this.workers.clear();
    this.taskQueue.length = 0;
  }

  private emit(event: PoolEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Ignore callback errors
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Create an agent worker pool with the given configuration
 */
export function createAgentWorkerPool(config: AgentWorkerPoolConfig): AgentWorkerPool {
  return new AgentWorkerPool(config);
}

/**
 * Create a simple agent task
 */
export function createAgentTask<T = string>(
  id: string,
  message: string,
  options?: Partial<Omit<AgentTask<T>, 'id' | 'message'>>
): AgentTask<T> {
  return {
    id,
    message,
    ...options,
  };
}

// ============================================================================
// Exports
// ============================================================================

export default {
  AgentWorkerPool,
  createAgentWorkerPool,
  createAgentTask,
};
