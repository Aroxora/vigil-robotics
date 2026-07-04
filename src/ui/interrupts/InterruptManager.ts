/**
 * InterruptManager - Manages user interruptions with priority queuing
 * Handles interrupt prioritization, deferred execution, and smooth transitions
 */

import { EventEmitter } from 'events';

export enum InterruptPriority {
  CRITICAL = 100,  // System errors, critical failures
  HIGH = 75,       // User cancellation requests, important alerts
  NORMAL = 50,     // Standard user input, questions
  LOW = 25,        // Hints, suggestions
  BACKGROUND = 0,  // Non-urgent notifications
}

export type InterruptType =
  | 'user-cancel'
  | 'user-input'
  | 'system-error'
  | 'confirmation'
  | 'hint'
  | 'alert'
  | 'question'
  | 'menu-selection';

export interface InterruptConfig {
  id: string;
  type: InterruptType;
  priority: InterruptPriority;
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
  ttl?: number; // Time to live in milliseconds
  deferrable?: boolean; // Can be deferred if higher priority arrives
  blocking?: boolean; // Blocks all lower priority interrupts
  handler?: (interrupt: Interrupt) => void | Promise<void>;
}

export interface Interrupt extends InterruptConfig {
  status: 'pending' | 'active' | 'deferred' | 'completed' | 'expired' | 'cancelled';
  activatedAt?: number;
  completedAt?: number;
  deferredCount: number;
}

export interface InterruptPolicy {
  maxQueueSize: number;
  maxDeferrals: number;
  defaultTTL: number;
  allowConcurrent: boolean;
  transitionDuration: number; // ms for smooth transitions
}

export class InterruptManager extends EventEmitter {
  private pendingQueue: Interrupt[] = [];
  private activeInterrupts: Map<string, Interrupt> = new Map();
  private deferredInterrupts: Map<string, Interrupt> = new Map();
  private policy: InterruptPolicy;
  private isProcessing: boolean = false;
  private transitionTimer: NodeJS.Timeout | null = null;
  private expiryTimers: Map<string, NodeJS.Timeout> = new Map();
  private completionPollers: Map<string, NodeJS.Timeout> = new Map();
  private disposed = false;

  constructor(policy: Partial<InterruptPolicy> = {}) {
    super();
    this.policy = {
      maxQueueSize: 100,
      maxDeferrals: 3,
      defaultTTL: 30000, // 30 seconds default TTL
      allowConcurrent: false,
      transitionDuration: 200,
      ...policy,
    };
  }

  /**
   * Queue a new interrupt
   */
  queue(config: Omit<InterruptConfig, 'id' | 'timestamp'>): string {
    const id = this.generateId();
    const interrupt: Interrupt = {
      ...config,
      id,
      timestamp: Date.now(),
      ttl: config.ttl || this.policy.defaultTTL,
      deferrable: config.deferrable ?? true,
      blocking: config.blocking ?? false,
      status: 'pending',
      deferredCount: 0,
    };

    // Check queue size limit
    if (this.pendingQueue.length >= this.policy.maxQueueSize) {
      // Remove lowest priority expired or old interrupts
      this.pruneQueue();

      if (this.pendingQueue.length >= this.policy.maxQueueSize) {
        this.emit('interrupt:rejected', {
          interrupt,
          reason: 'queue-full',
        });
        return '';
      }
    }

    // Insert based on priority
    const insertIndex = this.findInsertIndex(interrupt.priority);
    this.pendingQueue.splice(insertIndex, 0, interrupt);

    this.emit('interrupt:queued', interrupt);

    // Start expiry timer if TTL is set
    if (interrupt.ttl && interrupt.ttl > 0) {
      this.scheduleExpiry(interrupt);
    }

    // Process queue
    this.processQueue();

    return id;
  }

  /**
   * Process the interrupt queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.pendingQueue.length > 0) {
        const interrupt = this.pendingQueue[0];
        if (!interrupt) break;

        // Check if interrupt has expired
        if (this.isExpired(interrupt)) {
          this.expireInterrupt(interrupt);
          continue;
        }

        // Check if we can activate this interrupt
        if (!this.canActivate(interrupt)) {
          // If it's deferrable and hasn't exceeded max deferrals, defer it
          if (interrupt.deferrable && interrupt.deferredCount < this.policy.maxDeferrals) {
            this.deferInterrupt(interrupt);
          }
          break; // Wait for active interrupts to complete
        }

        // Remove from queue and activate
        this.pendingQueue.shift();
        await this.activateInterrupt(interrupt);

        // If this interrupt is blocking, wait for it to complete
        if (interrupt.blocking) {
          await this.waitForCompletion(interrupt.id);
        }
      }
    } finally {
      this.isProcessing = false;
    }

    // Process deferred interrupts if queue is empty
    if (this.pendingQueue.length === 0 && this.deferredInterrupts.size > 0) {
      this.restoreDeferredInterrupts();
      this.processQueue();
    }
  }

  /**
   * Check if interrupt can be activated
   */
  private canActivate(interrupt: Interrupt): boolean {
    // If no concurrent interrupts allowed and there are active ones
    if (!this.policy.allowConcurrent && this.activeInterrupts.size > 0) {
      // Check if this interrupt has higher priority than all active ones
      for (const active of this.activeInterrupts.values()) {
        if (active.priority >= interrupt.priority) {
          return false;
        }
      }

      // Higher priority interrupt can preempt if active ones are deferrable
      for (const active of this.activeInterrupts.values()) {
        if (!active.deferrable) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Activate an interrupt
   */
  private async activateInterrupt(interrupt: Interrupt): Promise<void> {
    interrupt.status = 'active';
    interrupt.activatedAt = Date.now();
    this.activeInterrupts.set(interrupt.id, interrupt);

    // Handle smooth transition
    if (this.policy.transitionDuration > 0) {
      await this.smoothTransition('in', interrupt);
    }

    this.emit('interrupt:activated', interrupt);

    // Execute handler if provided
    if (interrupt.handler) {
      try {
        await interrupt.handler(interrupt);
        this.completeInterrupt(interrupt.id);
      } catch (error) {
        this.emit('interrupt:error', {
          interrupt,
          error,
        });
        this.cancelInterrupt(interrupt.id);
      }
    }
  }

  /**
   * Complete an interrupt
   */
  completeInterrupt(id: string): void {
    const interrupt = this.activeInterrupts.get(id);
    if (!interrupt) return;

    // Clean up timers for this interrupt
    this.clearExpiryTimer(id);
    this.clearCompletionPoller(id);

    interrupt.status = 'completed';
    interrupt.completedAt = Date.now();
    this.activeInterrupts.delete(id);

    // Handle smooth transition
    if (this.policy.transitionDuration > 0) {
      this.smoothTransition('out', interrupt);
    }

    this.emit('interrupt:completed', interrupt);

    // Process next in queue
    this.processQueue();
  }

  /**
   * Cancel an interrupt
   */
  cancelInterrupt(id: string): void {
    // Clean up timers for this interrupt regardless of where it is
    this.clearExpiryTimer(id);
    this.clearCompletionPoller(id);

    // Check in queue
    const queueIndex = this.pendingQueue.findIndex((i) => i.id === id);
    if (queueIndex !== -1) {
      const interrupt = this.pendingQueue[queueIndex];
      if (interrupt) {
        interrupt.status = 'cancelled';
        this.pendingQueue.splice(queueIndex, 1);
        this.emit('interrupt:cancelled', interrupt);
      }
      return;
    }

    // Check in active
    const active = this.activeInterrupts.get(id);
    if (active) {
      active.status = 'cancelled';
      this.activeInterrupts.delete(id);
      this.emit('interrupt:cancelled', active);
      this.processQueue();
      return;
    }

    // Check in deferred
    const deferred = this.deferredInterrupts.get(id);
    if (deferred) {
      deferred.status = 'cancelled';
      this.deferredInterrupts.delete(id);
      this.emit('interrupt:cancelled', deferred);
    }
  }

  /**
   * Defer an interrupt
   */
  private deferInterrupt(interrupt: Interrupt): void {
    this.pendingQueue.shift(); // Remove from queue
    interrupt.status = 'deferred';
    interrupt.deferredCount++;
    this.deferredInterrupts.set(interrupt.id, interrupt);

    this.emit('interrupt:deferred', interrupt);
  }

  /**
   * Restore deferred interrupts to queue
   */
  private restoreDeferredInterrupts(): void {
    const deferred = Array.from(this.deferredInterrupts.values());
    this.deferredInterrupts.clear();

    for (const interrupt of deferred) {
      interrupt.status = 'pending';
      const insertIndex = this.findInsertIndex(interrupt.priority);
      this.pendingQueue.splice(insertIndex, 0, interrupt);

      this.emit('interrupt:restored', interrupt);
    }
  }

  /**
   * Expire an interrupt
   */
  private expireInterrupt(interrupt: Interrupt): void {
    interrupt.status = 'expired';
    this.pendingQueue.shift();

    this.emit('interrupt:expired', interrupt);
  }

  /**
   * Check if interrupt has expired
   */
  private isExpired(interrupt: Interrupt): boolean {
    if (!interrupt.ttl || interrupt.ttl <= 0) {
      return false;
    }

    const age = Date.now() - interrupt.timestamp;
    return age > interrupt.ttl;
  }

  /**
   * Schedule interrupt expiry
   */
  private scheduleExpiry(interrupt: Interrupt): void {
    if (!interrupt.ttl || interrupt.ttl <= 0) return;

    // Clear any existing timer for this interrupt
    this.clearExpiryTimer(interrupt.id);

    const timer = setTimeout(() => {
      this.expiryTimers.delete(interrupt.id);
      if (this.disposed) return;
      if (interrupt.status === 'pending') {
        const index = this.pendingQueue.indexOf(interrupt);
        if (index !== -1) {
          this.expireInterrupt(interrupt);
          this.processQueue();
        }
      }
    }, interrupt.ttl);

    this.expiryTimers.set(interrupt.id, timer);
  }

  /**
   * Clear expiry timer for an interrupt
   */
  private clearExpiryTimer(id: string): void {
    const timer = this.expiryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(id);
    }
  }

  /**
   * Wait for interrupt completion with timeout
   */
  private waitForCompletion(id: string, maxWaitMs = 30000): Promise<void> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const checkCompletion = (): void => {
        // Check for disposal or timeout
        if (this.disposed || Date.now() - startTime > maxWaitMs) {
          this.clearCompletionPoller(id);
          resolve();
          return;
        }
        if (!this.activeInterrupts.has(id)) {
          this.clearCompletionPoller(id);
          resolve();
        } else {
          const timer = setTimeout(checkCompletion, 50);
          this.completionPollers.set(id, timer);
        }
      };
      checkCompletion();
    });
  }

  /**
   * Clear completion poller for an interrupt
   */
  private clearCompletionPoller(id: string): void {
    const timer = this.completionPollers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.completionPollers.delete(id);
    }
  }

  /**
   * Handle smooth transitions
   */
  private async smoothTransition(
    direction: 'in' | 'out',
    interrupt: Interrupt
  ): Promise<void> {
    return new Promise((resolve) => {
      this.emit('interrupt:transition', {
        direction,
        interrupt,
        duration: this.policy.transitionDuration,
      });

      setTimeout(resolve, this.policy.transitionDuration);
    });
  }

  /**
   * Find insertion index based on priority
   */
  private findInsertIndex(priority: number): number {
    for (let i = 0; i < this.pendingQueue.length; i++) {
      const item = this.pendingQueue[i];
      if (item && item.priority < priority) {
        return i;
      }
    }
    return this.pendingQueue.length;
  }

  /**
   * Prune expired and low-priority interrupts from queue
   */
  private pruneQueue(): void {
    // Remove expired interrupts
    this.pendingQueue = this.pendingQueue.filter((interrupt) => {
      if (this.isExpired(interrupt)) {
        interrupt.status = 'expired';
        this.emit('interrupt:expired', interrupt);
        return false;
      }
      return true;
    });

    // If still over limit, remove lowest priority
    while (this.pendingQueue.length >= this.policy.maxQueueSize) {
      const removed = this.pendingQueue.pop();
      if (removed) {
        removed.status = 'cancelled';
        this.emit('interrupt:cancelled', removed);
      }
    }
  }

  /**
   * Generate unique interrupt ID
   */
  private generateId(): string {
    return `interrupt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get interrupt by ID
   */
  getInterrupt(id: string): Interrupt | undefined {
    // Check active
    if (this.activeInterrupts.has(id)) {
      return this.activeInterrupts.get(id);
    }

    // Check queue
    const queued = this.pendingQueue.find((i) => i.id === id);
    if (queued) return queued;

    // Check deferred
    return this.deferredInterrupts.get(id);
  }

  /**
   * Get all interrupts with a specific status
   */
  getInterruptsByStatus(status: Interrupt['status']): Interrupt[] {
    const results: Interrupt[] = [];

    if (status === 'active') {
      results.push(...this.activeInterrupts.values());
    } else if (status === 'pending') {
      results.push(...this.pendingQueue);
    } else if (status === 'deferred') {
      results.push(...this.deferredInterrupts.values());
    }

    return results;
  }

  /**
   * Get queue statistics
   */
  getStatistics(): {
    queueLength: number;
    activeCount: number;
    deferredCount: number;
    averagePriority: number;
    oldestTimestamp: number | null;
  } {
    const allInterrupts = [
      ...this.pendingQueue,
      ...this.activeInterrupts.values(),
      ...this.deferredInterrupts.values(),
    ];

    const avgPriority =
      allInterrupts.length > 0
        ? allInterrupts.reduce((sum, i) => sum + i.priority, 0) / allInterrupts.length
        : 0;

    const oldestTimestamp =
      allInterrupts.length > 0
        ? Math.min(...allInterrupts.map((i) => i.timestamp))
        : null;

    return {
      queueLength: this.pendingQueue.length,
      activeCount: this.activeInterrupts.size,
      deferredCount: this.deferredInterrupts.size,
      averagePriority: avgPriority,
      oldestTimestamp,
    };
  }

  /**
   * Clear all interrupts
   */
  clearAll(): void {
    // Cancel all active
    for (const interrupt of this.activeInterrupts.values()) {
      interrupt.status = 'cancelled';
      this.emit('interrupt:cancelled', interrupt);
    }
    this.activeInterrupts.clear();

    // Cancel all queued
    for (const interrupt of this.pendingQueue) {
      interrupt.status = 'cancelled';
      this.emit('interrupt:cancelled', interrupt);
    }
    this.pendingQueue = [];

    // Cancel all deferred
    for (const interrupt of this.deferredInterrupts.values()) {
      interrupt.status = 'cancelled';
      this.emit('interrupt:cancelled', interrupt);
    }
    this.deferredInterrupts.clear();

    this.emit('interrupt:cleared');
  }

  /**
   * Update interrupt policy
   */
  updatePolicy(policy: Partial<InterruptPolicy>): void {
    this.policy = {
      ...this.policy,
      ...policy,
    };

    this.emit('policy:updated', this.policy);
  }

  /**
   * Dispose of the manager
   */
  dispose(): void {
    this.disposed = true;

    // Clear all expiry timers
    for (const timer of this.expiryTimers.values()) {
      clearTimeout(timer);
    }
    this.expiryTimers.clear();

    // Clear all completion pollers
    for (const timer of this.completionPollers.values()) {
      clearTimeout(timer);
    }
    this.completionPollers.clear();

    // Clear transition timer
    if (this.transitionTimer) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = null;
    }

    this.clearAll();
    this.removeAllListeners();
  }

  /**
   * Check if the manager has been disposed
   */
  isDisposed(): boolean {
    return this.disposed;
  }
}