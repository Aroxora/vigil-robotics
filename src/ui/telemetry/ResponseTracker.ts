import type { UITelemetry } from './UITelemetry.js';

export interface AssistantResponseMetadata {
  thought?: string | null;
  responseId?: number;
  usage?: unknown;
  source?: 'final' | 'stream' | 'narrative';
}

/**
 * Tracks assistant thought/response pairs as single events.
 * Ensures multi-line messages are counted once per response.
 */
export class ResponseTracker {
  private nextId = 0;
  private activeId: number | null = null;
  private pendingThought: string | null = null;

  constructor(private readonly telemetry: UITelemetry) {}

  recordThought(thought: string): number | null {
    const normalized = thought.trim();
    if (!normalized) return null;

    if (!this.activeId) {
      this.activeId = this.nextId + 1;
      this.nextId = this.activeId;
    }

    this.pendingThought = this.pendingThought
      ? `${this.pendingThought}\n${normalized}`
      : normalized;

    this.telemetry.recordEvent('assistant.thought', {
      id: this.activeId,
      phase: 'thought',
      summary: this.truncate(normalized),
      length: normalized.length,
    });

    return this.activeId;
  }

  recordResponse(response: string, metadata: AssistantResponseMetadata = {}): number | null {
    const normalized = response.trim();
    if (!normalized) return null;

    const id = metadata.responseId ?? this.activeId ?? this.nextId + 1;
    if (id > this.nextId) {
      this.nextId = id;
    }

    const thought = metadata.thought?.trim() || this.pendingThought || null;

    this.telemetry.recordEvent('assistant.response', {
      id,
      phase: 'response',
      summary: this.truncate(normalized),
      length: normalized.length,
      thoughtSummary: thought ? this.truncate(thought) : undefined,
      source: metadata.source ?? 'final',
      usage: metadata.usage ?? null,
    });

    this.pendingThought = null;
    this.activeId = null;
    return id;
  }

  private truncate(value: string, max: number = 240): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max - 3).trimEnd()}...`;
  }
}
