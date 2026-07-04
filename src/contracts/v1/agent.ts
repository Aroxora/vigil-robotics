/**
 * Agent Contract v1.0
 * 
 * Stable interface for agent interaction across all frontends.
 * Breaking changes require a new version (v2/).
 */

export const AGENT_CONTRACT_VERSION = '1.0.0';

/**
 * Event types emitted during agent execution
 */
export type AgentEventType =
  | 'message.start'
  | 'message.delta'
  | 'message.complete'
  | 'tool.start'
  | 'tool.complete'
  | 'tool.error'
  | 'edit.explanation'
  | 'reasoning'
  | 'error'
  | 'usage'
  | 'provider.fallback';

/**
 * Base event structure
 */
export interface AgentEvent {
  type: AgentEventType;
  timestamp: number;
}

/**
 * Message events
 */
export interface MessageStartEvent extends AgentEvent {
  type: 'message.start';
}

export interface MessageDeltaEvent extends AgentEvent {
  type: 'message.delta';
  content: string;
  isFinal: boolean;
}

export interface MessageCompleteEvent extends AgentEvent {
  type: 'message.complete';
  content: string;
  elapsedMs: number;
}

/**
 * Tool execution events
 */
export interface ToolStartEvent extends AgentEvent {
  type: 'tool.start';
  toolName: string;
  toolCallId: string;
  parameters: Record<string, unknown>;
}

export interface ToolCompleteEvent extends AgentEvent {
  type: 'tool.complete';
  toolName: string;
  toolCallId: string;
  result: string;
}

export interface ToolErrorEvent extends AgentEvent {
  type: 'tool.error';
  toolName: string;
  toolCallId: string;
  error: string;
}

export interface EditExplanationEvent extends AgentEvent {
  type: 'edit.explanation';
  content: string;
  files?: string[];
  toolName?: string;
  toolCallId?: string;
}

/**
 * Reasoning/thought event - model's internal thinking process
 */
export interface ReasoningEvent extends AgentEvent {
  type: 'reasoning';
  content: string;
}

/**
 * Error and usage events
 */
export interface ErrorEvent extends AgentEvent {
  type: 'error';
  error: string;
  code?: string;
}

export interface UsageEvent extends AgentEvent {
  type: 'usage';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * Provider fallback event - emitted when switching to another provider due to error
 */
export interface ProviderFallbackEvent extends AgentEvent {
  type: 'provider.fallback';
  /** Provider that failed */
  fromProvider: string;
  /** Model that failed */
  fromModel: string;
  /** Provider being switched to */
  toProvider: string;
  /** Model being switched to */
  toModel: string;
  /** Reason for fallback */
  reason: string;
  /** Original error message */
  error: string;
}

/**
 * Union of all event types
 */
export type AgentEventUnion =
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageCompleteEvent
  | ToolStartEvent
  | ToolCompleteEvent
  | ToolErrorEvent
  | EditExplanationEvent
  | ReasoningEvent
  | ErrorEvent
  | UsageEvent
  | ProviderFallbackEvent;

/**
 * Model selection configuration
 */
export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Capability manifest
 */
export interface CapabilityManifest {
  contractVersion: string;
  profile: string;
  model: ModelConfig;
  tools: ToolCapability[];
  features: string[];
}

export interface ToolCapability {
  name: string;
  description: string;
  category: string;
}

/**
 * Core agent controller interface
 * 
 * This is the stable contract that all frontends depend on.
 */
export interface IAgentController {
  /**
   * Send a message and receive streaming events
   */
  send(message: string): AsyncIterableIterator<AgentEventUnion>;

  /**
   * Switch the active model
   */
  switchModel(config: ModelConfig): Promise<void>;

  /**
   * Get current capabilities
   */
  getCapabilities(): CapabilityManifest;

  /**
   * Register a tool suite
   */
  registerToolSuite(suiteId: string, suite: unknown): void;

  /**
   * Unregister a tool suite
   */
  unregisterToolSuite(suiteId: string): void;

  /**
   * Get conversation history
   */
  getHistory(): ConversationMessage[];

  /**
   * Clear conversation history
   */
  clearHistory(): void;
}

/**
 * Conversation message structure
 */
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  toolCallId?: string;
  name?: string;
}
