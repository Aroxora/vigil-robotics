/**
 * UITelemetry - Collects and tracks UI performance metrics and user interactions
 * Provides insights into UI responsiveness, user behavior, and system performance
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';

export interface UIEvent {
  type: string;
  timestamp: number;
  duration?: number;
  metadata?: any;
}

export interface PerformanceMetric {
  name: string;
  value: number;
  unit: string;
  timestamp: number;
}

export interface UserInteraction {
  type: 'command' | 'keypress' | 'menu-selection' | 'cancel' | 'confirm';
  target?: string;
  timestamp: number;
  responseTime?: number;
  completed: boolean;
}

export interface RenderMetric {
  component: string;
  renderTime: number;
  frameCount: number;
  dropped: number;
  timestamp: number;
}

export interface TelemetrySnapshot {
  timestamp: number;
  period: {
    start: number;
    end: number;
  };
  events: {
    total: number;
    byType: Record<string, number>;
  };
  performance: {
    avgRenderTime: number;
    avgResponseTime: number;
    framerate: number;
    memoryUsage: NodeJS.MemoryUsage;
    cpuUsage: NodeJS.CpuUsage;
  };
  interactions: {
    total: number;
    completed: number;
    cancelled: number;
    avgResponseTime: number;
  };
  errors: {
    total: number;
    byType: Record<string, number>;
  };
}

export interface TelemetryConfig {
  enabled: boolean;
  bufferSize: number;
  flushInterval: number;
  captureStackTraces: boolean;
  anonymize: boolean;
  performanceThresholds: {
    renderTime: number;
    responseTime: number;
    framerate: number;
    memory: number;
  };
}

export class UITelemetry extends EventEmitter {
  private config: TelemetryConfig;
  private events: UIEvent[] = [];
  private metrics: PerformanceMetric[] = [];
  private interactions: UserInteraction[] = [];
  private renderMetrics: RenderMetric[] = [];
  private errors: Array<{ error: any; timestamp: number; context?: any }> = [];
  private sessionStart: number;
  private marks: Map<string, number> = new Map();
  private measures: Map<string, number[]> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  private frameCounter: {
    frames: number;
    dropped: number;
    lastFrame: number;
  } = {
    frames: 0,
    dropped: 0,
    lastFrame: performance.now(),
  };

  constructor(config: Partial<TelemetryConfig> = {}) {
    super();
    this.config = {
      enabled: true,
      bufferSize: 10000,
      flushInterval: 60000, // 1 minute
      captureStackTraces: false,
      anonymize: true,
      performanceThresholds: {
        renderTime: 16, // 60 FPS target
        responseTime: 100, // 100ms max response time
        framerate: 30, // Minimum acceptable framerate
        memory: 500 * 1024 * 1024, // 500MB memory threshold
      },
      ...config,
    };

    this.sessionStart = Date.now();

    if (this.config.enabled) {
      this.startCollection();
    }
  }

  /**
   * Start telemetry collection
   */
  private startCollection(): void {
    // Set up flush timer
    if (this.config.flushInterval > 0) {
      this.flushTimer = setInterval(
        () => this.flush(),
        this.config.flushInterval
      );
    }

    // Monitor memory usage
    setInterval(() => {
      this.recordMemoryUsage();
    }, 10000); // Every 10 seconds

    this.emit('telemetry:started');
  }

  /**
   * Record a UI event
   */
  recordEvent(type: string, eventMetadata?: any): void {
    if (!this.config.enabled) return;

    const event: UIEvent = {
      type,
      timestamp: Date.now(),
      metadata: this.config.anonymize ? this.anonymizeData(eventMetadata) : eventMetadata,
    };

    this.events.push(event);
    this.trimBuffer('events');

    this.emit('event:recorded', event);
  }

  /**
   * Start a performance mark
   */
  markStart(name: string): void {
    if (!this.config.enabled) return;
    this.marks.set(name, performance.now());
  }

  /**
   * End a performance mark and record the duration
   */
  markEnd(name: string, _metadata?: any): number {
    if (!this.config.enabled) return 0;

    const start = this.marks.get(name);
    if (!start) {
      console.warn(`No start mark found for: ${name}`);
      return 0;
    }

    const duration = performance.now() - start;
    this.marks.delete(name);

    // Store measure
    if (!this.measures.has(name)) {
      this.measures.set(name, []);
    }
    this.measures.get(name)!.push(duration);

    // Record metric
    const metric: PerformanceMetric = {
      name,
      value: duration,
      unit: 'ms',
      timestamp: Date.now(),
    };

    this.metrics.push(metric);
    this.trimBuffer('metrics');

    // Check threshold
    this.checkPerformanceThreshold(name, duration);

    this.emit('metric:recorded', metric);
    return duration;
  }

  /**
   * Record a user interaction
   */
  recordInteraction(
    type: UserInteraction['type'],
    target?: string
  ): {
    complete: () => void;
    cancel: () => void;
  } {
    if (!this.config.enabled) {
      return {
        complete: () => {},
        cancel: () => {},
      };
    }

    const interaction: UserInteraction = {
      type,
      target,
      timestamp: Date.now(),
      completed: false,
    };

    this.interactions.push(interaction);

    return {
      complete: () => {
        interaction.completed = true;
        interaction.responseTime = Date.now() - interaction.timestamp;
        this.checkResponseTimeThreshold(interaction.responseTime);
        this.emit('interaction:completed', interaction);
      },
      cancel: () => {
        interaction.completed = false;
        this.emit('interaction:cancelled', interaction);
      },
    };
  }

  /**
   * Record render metrics
   */
  recordRender(component: string, renderTime: number): void {
    if (!this.config.enabled) return;

    // Update frame counter
    const now = performance.now();
    const timeSinceLastFrame = now - this.frameCounter.lastFrame;

    if (timeSinceLastFrame > 33.33) { // More than 2 frames at 60fps
      this.frameCounter.dropped++;
    }

    this.frameCounter.frames++;
    this.frameCounter.lastFrame = now;

    const metric: RenderMetric = {
      component,
      renderTime,
      frameCount: this.frameCounter.frames,
      dropped: this.frameCounter.dropped,
      timestamp: Date.now(),
    };

    this.renderMetrics.push(metric);
    this.trimBuffer('renderMetrics');

    // Check render time threshold
    if (renderTime > this.config.performanceThresholds.renderTime) {
      this.emit('performance:slow-render', {
        component,
        renderTime,
        threshold: this.config.performanceThresholds.renderTime,
      });
    }

    this.emit('render:recorded', metric);
  }

  /**
   * Record an error
   */
  recordError(error: any, context?: any): void {
    if (!this.config.enabled) return;

    const errorRecord = {
      error: {
        message: error.message || String(error),
        type: error.constructor?.name || 'Error',
        stack: this.config.captureStackTraces ? error.stack : undefined,
      },
      timestamp: Date.now(),
      context: this.config.anonymize ? this.anonymizeData(context) : context,
    };

    this.errors.push(errorRecord);
    this.trimBuffer('errors');

    this.emit('error:recorded', errorRecord);
  }

  /**
   * Record memory usage
   */
  private recordMemoryUsage(): void {
    const usage = process.memoryUsage();
    const metric: PerformanceMetric = {
      name: 'memory.heapUsed',
      value: usage.heapUsed,
      unit: 'bytes',
      timestamp: Date.now(),
    };

    this.metrics.push(metric);

    // Check memory threshold
    if (usage.heapUsed > this.config.performanceThresholds.memory) {
      this.emit('performance:high-memory', {
        usage: usage.heapUsed,
        threshold: this.config.performanceThresholds.memory,
      });
    }
  }

  /**
   * Check performance threshold
   */
  private checkPerformanceThreshold(name: string, duration: number): void {
    if (name.includes('render') &&
        duration > this.config.performanceThresholds.renderTime) {
      this.emit('performance:threshold-exceeded', {
        type: 'render',
        name,
        duration,
        threshold: this.config.performanceThresholds.renderTime,
      });
    }
  }

  /**
   * Check response time threshold
   */
  private checkResponseTimeThreshold(responseTime: number): void {
    if (responseTime > this.config.performanceThresholds.responseTime) {
      this.emit('performance:threshold-exceeded', {
        type: 'response',
        responseTime,
        threshold: this.config.performanceThresholds.responseTime,
      });
    }
  }

  /**
   * Trim buffer to prevent memory issues
   */
  private trimBuffer(
    bufferName: 'events' | 'metrics' | 'interactions' | 'renderMetrics' | 'errors'
  ): void {
    const buffer = this[bufferName];
    if (Array.isArray(buffer) && buffer.length > this.config.bufferSize) {
      // Keep most recent items
      const toRemove = buffer.length - this.config.bufferSize;
      buffer.splice(0, toRemove);
    }
  }

  /**
   * Anonymize sensitive data
   */
  private anonymizeData(data: any): any {
    if (!data) return data;
    if (typeof data !== 'object') return data;

    const anonymized = { ...data };

    // Remove or hash sensitive fields
    const sensitiveFields = ['password', 'token', 'key', 'secret', 'email', 'username'];

    for (const field of sensitiveFields) {
      if (field in anonymized) {
        anonymized[field] = '[REDACTED]';
      }
    }

    // Recursively anonymize nested objects
    for (const key in anonymized) {
      if (typeof anonymized[key] === 'object' && anonymized[key] !== null) {
        anonymized[key] = this.anonymizeData(anonymized[key]);
      }
    }

    return anonymized;
  }

  /**
   * Get current telemetry snapshot
   */
  getSnapshot(): TelemetrySnapshot {
    const now = Date.now();
    const period = {
      start: this.sessionStart,
      end: now,
    };

    // Calculate event statistics
    const eventsByType: Record<string, number> = {};
    for (const event of this.events) {
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
    }

    // Calculate performance metrics
    const renderTimes = this.renderMetrics.map(m => m.renderTime);
    const avgRenderTime = renderTimes.length > 0
      ? renderTimes.reduce((a, b) => a + b, 0) / renderTimes.length
      : 0;

    const responseTimes = this.interactions
      .filter(i => i.responseTime !== undefined)
      .map(i => i.responseTime!);
    const avgResponseTime = responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : 0;

    const framerate = this.frameCounter.frames > 0
      ? (this.frameCounter.frames - this.frameCounter.dropped) /
        ((now - this.sessionStart) / 1000)
      : 0;

    // Calculate interaction statistics
    const completedInteractions = this.interactions.filter(i => i.completed).length;
    const cancelledInteractions = this.interactions.filter(i => !i.completed).length;

    // Calculate error statistics
    const errorsByType: Record<string, number> = {};
    for (const error of this.errors) {
      const type = error.error.type || 'Unknown';
      errorsByType[type] = (errorsByType[type] || 0) + 1;
    }

    return {
      timestamp: now,
      period,
      events: {
        total: this.events.length,
        byType: eventsByType,
      },
      performance: {
        avgRenderTime,
        avgResponseTime,
        framerate,
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
      },
      interactions: {
        total: this.interactions.length,
        completed: completedInteractions,
        cancelled: cancelledInteractions,
        avgResponseTime,
      },
      errors: {
        total: this.errors.length,
        byType: errorsByType,
      },
    };
  }

  /**
   * Get performance summary
   */
  getPerformanceSummary(): {
    measures: Record<string, { avg: number; min: number; max: number; count: number }>;
    slowestOperations: Array<{ name: string; duration: number }>;
  } {
    const summary: Record<string, { avg: number; min: number; max: number; count: number }> = {};

    for (const [name, durations] of this.measures) {
      if (durations.length === 0) continue;

      summary[name] = {
        avg: durations.reduce((a, b) => a + b, 0) / durations.length,
        min: Math.min(...durations),
        max: Math.max(...durations),
        count: durations.length,
      };
    }

    // Find slowest operations
    const allOperations: Array<{ name: string; duration: number }> = [];
    for (const metric of this.metrics) {
      if (metric.unit === 'ms') {
        allOperations.push({ name: metric.name, duration: metric.value });
      }
    }

    const slowestOperations = allOperations
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);

    return {
      measures: summary,
      slowestOperations,
    };
  }

  /**
   * Flush telemetry data
   */
  flush(): void {
    const snapshot = this.getSnapshot();
    this.emit('telemetry:flush', snapshot);

    // Clear old data based on buffer size
    const cutoff = Date.now() - this.config.flushInterval;

    this.events = this.events.filter(e => e.timestamp > cutoff);
    this.metrics = this.metrics.filter(m => m.timestamp > cutoff);
    this.interactions = this.interactions.filter(i => i.timestamp > cutoff);
    this.renderMetrics = this.renderMetrics.filter(m => m.timestamp > cutoff);
    this.errors = this.errors.filter(e => e.timestamp > cutoff);
  }

  /**
   * Enable or disable telemetry
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;

    if (!enabled) {
      this.stop();
    } else {
      this.startCollection();
    }

    this.emit('telemetry:status-changed', { enabled });
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<TelemetryConfig>): void {
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, ...config };

    if (wasEnabled !== this.config.enabled) {
      this.setEnabled(this.config.enabled);
    }

    this.emit('telemetry:config-updated', this.config);
  }

  /**
   * Reset all telemetry data
   */
  reset(): void {
    this.events = [];
    this.metrics = [];
    this.interactions = [];
    this.renderMetrics = [];
    this.errors = [];
    this.marks.clear();
    this.measures.clear();
    this.frameCounter = {
      frames: 0,
      dropped: 0,
      lastFrame: performance.now(),
    };
    this.sessionStart = Date.now();

    this.emit('telemetry:reset');
  }

  /**
   * Stop telemetry collection
   */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.emit('telemetry:stopped');
  }

  /**
   * Dispose of telemetry
   */
  dispose(): void {
    this.stop();
    this.removeAllListeners();
    this.reset();
  }
}