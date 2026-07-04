/* eslint-disable @typescript-eslint/no-namespace */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type JSONSchemaObject,
  type ProviderId,
  type ProviderToolDefinition,
  type ToolCallRequest,
} from './types.js';
import {
  ToolArgumentValidationError,
  coerceToolArguments,
  validateToolArguments,
} from './schemaValidator.js';
import { ContextManager } from './contextManager.js';

import { validateToolPreconditions, validateAIFlowPatterns, EDIT_WITHOUT_READ, type PreflightWarning } from './toolPreconditions.js';
import { safeTruncate } from './resultVerification.js';
import { logDebug } from '../utils/debugLogger.js';
import { loadHooksConfig, runPreToolUseHooks, runPostToolUseHooks, type HooksConfig } from './hooks.js';

/**
 * Execution context for tool operations with strict TypeScript typing
 */
export interface ToolExecutionContext {
  readonly profileName: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly workspaceContext?: string | null;
}

/**
 * Type-safe tool observer with generic parameter inference for AI flow monitoring
 */
export interface ToolRuntimeObserver<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Called when tool execution begins */
  onToolStart?(call: ToolCallRequest & { args: T }): void;
  
  /** Called when tool execution completes successfully */
  onToolResult?(call: ToolCallRequest & { args: T }, output: string): void;
  
  /** Called when tool execution fails */
  onToolError?(call: ToolCallRequest & { args: T }, error: string): void;
  
  /** Called when cached result is used instead of execution */
  onCacheHit?(call: ToolCallRequest & { args: T }): void;
  
  /** Called for progress updates during long-running operations */
  onToolProgress?(call: ToolCallRequest & { args: T }, progress: ToolProgressUpdate): void;
  
  /** Called for pre-flight warnings before tool execution */
  onToolWarning?(call: ToolCallRequest & { args: T }, warning: PreflightWarning | string): void;
}

interface ToolRuntimeOptions {
  readonly observer?: ToolRuntimeObserver;
  readonly contextManager?: ContextManager;
  readonly enableCache?: boolean;
  readonly cacheTTLMs?: number;
  /**
   * Working directory used to load `.vigil/settings.json` hooks.
   * If unset, hooks are loaded from `~/.vigil/settings.json`
   * only (user-global) and the project-local file is skipped.
   */
  readonly workingDir?: string;
}

/**
 * Generic tool handler with parameter type inference for AI flow execution
 */
type ToolHandler<T extends Record<string, unknown> = Record<string, unknown>> = (
  args: T
) => Promise<string> | string;

/**
 * Enhanced tool definition with parameter type safety for AI software engineering
 */
export interface ToolDefinition<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique identifier for the tool */
  readonly name: string;
  
  /** Human-readable description for AI understanding */
  readonly description: string;
  
  /** JSON Schema defining the tool's parameter structure */
  readonly parameters?: JSONSchemaObject;
  
  /** Function that implements the tool's behavior */
  readonly handler: ToolHandler<T>;
  
  /** Whether results can be cached for performance optimization */
  readonly cacheable?: boolean;

  /** Optional per-tool cache TTL in milliseconds (falls back to runtime default) */
  readonly cacheTtlMs?: number;
}

/**
 * Collection of related tools grouped by functionality
 */
export interface ToolSuite {
  /** Unique identifier for the tool suite */
  readonly id: string;
  
  /** Human-readable description of the suite's purpose */
  readonly description?: string;
  
  /** Array of tool definitions in this suite */
  readonly tools: readonly ToolDefinition[];
}

interface ToolRecord {
  suiteId: string;
  definition: ToolDefinition;
}

interface CacheEntry {
  result: string;
  timestamp: number;
}

export interface ToolHistoryEntry {
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
  success: boolean;
  hasOutput: boolean;
  error?: string;
}

export interface DiffSnapshotRecord {
  command: string;
  output: string;
  timestamp: number;
}

export interface ToolProgressUpdate {
  current: number;
  total?: number;
  message?: string;
}

interface ToolExecutionStore {
  call: ToolCallRequest & { args: Record<string, unknown> };
  observer?: ToolRuntimeObserver;
}

const toolExecutionContext = new AsyncLocalStorage<ToolExecutionStore>();

/**
 * Report incremental progress for the currently executing tool.
 * Tools can call this to surface live status updates (e.g., indexing files).
 */
export function reportToolProgress(progress: ToolProgressUpdate): void {
  const context = toolExecutionContext.getStore();
  if (!context?.observer?.onToolProgress) {
    return;
  }

  const current = Number.isFinite(progress.current) ? Math.max(0, progress.current) : 0;
  const total = progress.total !== undefined ? Math.max(current, progress.total) : current;

  try {
    context.observer.onToolProgress(context.call, {
      current,
      total,
      message: progress.message,
    });
  } catch {
    // Swallow observer errors so they don't break tool execution
  }
}

// Idempotent tools that can be safely cached
const CACHEABLE_TOOLS = new Set([
  'Read',
  'read_file',
  'Glob',
  'glob_search',
  'Grep',
  'grep_search',
  'find_definition',
  'analyze_code_quality',
  'extract_exports',
]);

function buildOptimizationHint(
  warning: PreflightWarning | { code?: string; suggestion?: string; message: string }
): string | null {
  const code = warning.code;
  const suggestion = warning.suggestion || warning.message;

  switch (code) {
    case 'SEARCH_BROAD_PATTERN':
    case 'SEARCH_CONTEXT_OVERFLOW_RISK':
      return (
        `\n\n<optimization-hint>\n` +
        `⚡ SEARCH: ${suggestion}\n` +
        `</optimization-hint>`
      );
    case EDIT_WITHOUT_READ:
    case 'EDIT_PLACEHOLDER':
      return (
        `\n\n<optimization-hint>\n` +
        `⚡ EDIT: Read the file first to copy exact whitespace. ${suggestion}\n` +
        `</optimization-hint>`
      );
    case 'NPM_INCOMPLETE_WORKFLOW':
      return (
        `\n\n<optimization-hint>\n` +
        `⚡ PUBLISH: ${suggestion}\n` +
        `</optimization-hint>`
      );
    default:
      return null;
  }
}

/**
 * Type-safe utility functions for tool runtime operations
 */
export namespace ToolRuntimeUtils {
  /**
   * Creates a type-safe tool definition with inferred parameter types
   */
  export function createToolDefinition<T extends Record<string, unknown>>(
    definition: ToolDefinition<T>
  ): ToolDefinition<T> {
    return definition;
  }

  /**
   * Creates a type-safe tool suite with inferred tool types
   */
  export function createToolSuite(
    suite: ToolSuite
  ): ToolSuite {
    return suite;
  }

  /**
   * Type guard to check if a tool definition matches expected parameter schema
   */
  export function isToolDefinition(
    __tool: ToolDefinition,
    expectedSchema?: JSONSchemaObject
  ): boolean {
    if (!expectedSchema) return true;
    // In a real implementation, this would validate against the schema
    return true;
  }
}

/**
 * Interface describing the public API of ToolRuntime.
 * Used by wrapper implementations like RestrictedToolRuntime.
 */
export interface IToolRuntime {
  listProviderTools(): ProviderToolDefinition[];
  execute(call: ToolCallRequest, context?: { profileName?: string; provider?: string; model?: string }): Promise<string>;
  registerSuite(suite: ToolSuite): void;
  unregisterSuite(id: string): void;
  clearCache(): void;
  getCacheStats(): { size: number; entries: number };
  clearToolHistory(): void;
  getToolHistory(): readonly ToolHistoryEntry[];
  clearDiffSnapshots(): void;
  getDiffSnapshots(): readonly DiffSnapshotRecord[];
}

export class ToolRuntime implements IToolRuntime {
  private readonly registry = new Map<string, ToolRecord>();
  private readonly registrationOrder: string[] = [];
  private readonly observer: ToolRuntimeObserver | null;
  private readonly contextManager: ContextManager | null;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly enableCache: boolean;
  private readonly cacheTTLMs: number;
  private readonly toolHistory: ToolHistoryEntry[] = [];
  private readonly maxHistorySize = 50; // Keep last 50 tool calls for AI flow pattern detection
  private readonly diffSnapshots: DiffSnapshotRecord[] = [];
  private readonly maxDiffSnapshots = 5; // Keep only the most recent git diff outputs
  private readonly maxDiffSnapshotLength = 4000;

  private readonly hooks: HooksConfig;

  constructor(baseTools: ToolDefinition[] = [], options: ToolRuntimeOptions = {}) {
    this.observer = options.observer ?? null;
    this.contextManager = options.contextManager ?? null;
    this.enableCache = options.enableCache ?? true;
    this.cacheTTLMs = options.cacheTTLMs ?? 5 * 60 * 1000; // 5 minutes default
    // Load hook config eagerly. Hot-reloading on every tool call would
    // give the user faster feedback but at the cost of file I/O on
    // every step — we accept "edit settings → restart CLI" as the
    // tradeoff (matches Claude Code).
    try {
      this.hooks = loadHooksConfig(options.workingDir ?? process.cwd());
    } catch (err) {
      logDebug('[hooks] config load failed: ' + (err as Error).message);
      this.hooks = {};
    }
    if (baseTools.length) {
      this.registerSuite({
        id: 'runtime.core',
        description: 'Core runtime metadata tools',
        tools: baseTools,
      });
    }
  }

  registerSuite(suite: ToolSuite): void {
    if (!suite?.id?.trim()) {
      throw new Error('Tool suite id cannot be blank.');
    }
    this.unregisterSuite(suite.id);
    for (const definition of suite.tools ?? []) {
      this.addTool(definition, suite.id);
    }
  }

  unregisterSuite(id: string): void {
    if (!id?.trim()) {
      return;
    }
    for (const [name, record] of this.registry.entries()) {
      if (record.suiteId === id) {
        this.registry.delete(name);
        this.removeFromOrder(name);
      }
    }
  }

  listProviderTools(): ProviderToolDefinition[] {
    return this.registrationOrder
      .map((name) => this.registry.get(name))
      .filter((record): record is ToolRecord => Boolean(record))
      .map(({ definition }) => ({
        name: definition.name,
        description: definition.description,
        ...(definition.parameters && { parameters: definition.parameters }),
      }));
  }

  async execute(call: ToolCallRequest, _context?: { profileName?: string; provider?: string; model?: string }): Promise<string> {
    const record = this.registry.get(call.name);
    const rawArgs = normalizeToolArguments(call.arguments);
    const args = coerceToolArguments(record?.definition.parameters, rawArgs);
    const augmentedCall = { ...call, args };

    if (!record) {
      const message = `Tool "${call.name}" is not available.`;
      this.observer?.onToolError?.(augmentedCall, message);
      // Performance monitoring removed - no legacy components
      return message;
    }

    // Check if tool is cacheable
    const isCacheable = record.definition.cacheable ?? CACHEABLE_TOOLS.has(call.name);
    const cacheTtl =
      typeof record.definition.cacheTtlMs === 'number' && Number.isFinite(record.definition.cacheTtlMs)
        ? Math.max(0, Math.floor(record.definition.cacheTtlMs))
        : this.cacheTTLMs;
    const canUseCache = this.enableCache && isCacheable && cacheTtl > 0;

    // Try to get from cache
    if (canUseCache) {
      const cacheKey = this.getCacheKey({ ...call, arguments: args });
      const cached = this.cache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < cacheTtl) {
        this.observer?.onCacheHit?.(augmentedCall);
        this.observer?.onToolResult?.(augmentedCall, cached.result);

        // Record cache hit as successful execution with 0ms time
        // Performance monitoring removed - no legacy components
        this.recordToolHistory({
          toolName: call.name,
          args,
          timestamp: Date.now(),
          success: true,
          hasOutput: hasNonEmptyOutput(cached.result),
        });
        return cached.result;
      }
    }

    this.observer?.onToolStart?.(augmentedCall);

    // Performance monitoring removed - no legacy components

    try {
      validateToolArguments(record.definition.name, record.definition.parameters, args);

      // Pre-flight AI flow validation - catch common tool usage failures
      const preflightWarnings = validateToolPreconditions(call.name, args);
      for (const warning of preflightWarnings) {
        this.observer?.onToolWarning?.(augmentedCall, warning);
      }

      // Advanced AI flow pattern validation using tool history
      const aiFlowWarnings = validateAIFlowPatterns(call.name, args, this.toolHistory);
      for (const warning of aiFlowWarnings) {
        this.observer?.onToolWarning?.(augmentedCall, warning);
      }

      // Collect optimization hints to inject into result
      const optimizationHints: string[] = [];
      const seenOptimizationCodes = new Set<string>();
      for (const warning of [...preflightWarnings, ...aiFlowWarnings]) {
        if (warning.code && seenOptimizationCodes.has(warning.code)) {
          continue;
        }
        const hint = buildOptimizationHint(warning);
        if (hint) {
          if (warning.code) {
            seenOptimizationCodes.add(warning.code);
          }
          optimizationHints.push(hint);
        }
      }

      // PreToolUse hooks: run user-configured shell commands that
      // can block this tool call. Best-effort — if the hook errors,
      // times out, or returns malformed output, we pass through.
      try {
        const blocked = await runPreToolUseHooks(this.hooks, call.name, args);
        if (blocked) {
          const reason = blocked.reason || 'Blocked by hook';
          const message = `Error: ${call.name} blocked by user hook: ${reason}`;
          this.observer?.onToolError?.(augmentedCall, message);
          this.recordToolHistory({
            toolName: call.name,
            args,
            timestamp: Date.now(),
            success: false,
            hasOutput: false,
          });
          return message;
        }
      } catch (err) {
        // A buggy hook should never crash the agent. Log + continue.
        logDebug('[hooks] PreToolUse error: ' + (err as Error).message);
      }

      const result = await toolExecutionContext.run(
        { call: augmentedCall, observer: this.observer ?? undefined },
        async () => record.definition.handler(args)
      );
      let output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);

      // PostToolUse hooks: append text from each matching hook so
      // the model sees the augmentation. Useful for "lint after every
      // edit" / "echo every Bash command to a log" patterns.
      try {
        const post = await runPostToolUseHooks(this.hooks, call.name, args, output);
        if (post?.appendToResult) {
          output = `${output}\n\n[hook] ${post.appendToResult}`;
        }
      } catch (err) {
        logDebug('[hooks] PostToolUse error: ' + (err as Error).message);
      }
      let snapshotCandidate = output;

      // Truncate output if context manager is available
      if (this.contextManager) {
        const truncated = this.contextManager.truncateToolOutput(output, call.name);
        if (truncated.wasTruncated) {
          output = truncated.content;
          // Log truncation for debugging
          if (process.env['DEBUG_CONTEXT']) {
            logDebug(
              `[Context Manager] Truncated ${call.name} output: ${truncated.originalLength} -> ${truncated.truncatedLength} chars`
            );
          }
        }
        snapshotCandidate = output;
      }

      this.recordDiffSnapshot(args, snapshotCandidate);

      // Cache the result if cacheable
      if (canUseCache) {
        const cacheKey = this.getCacheKey({ ...call, arguments: args });
        this.cache.set(cacheKey, {
          result: output,
          timestamp: Date.now(),
        });
      }

      // Append optimization hints to guide future LLM behavior
      if (optimizationHints.length > 0) {
        output = output + optimizationHints.join('');
      }

      this.observer?.onToolResult?.(augmentedCall, output);

      this.recordToolHistory({
        toolName: call.name,
        args,
        timestamp: Date.now(),
        success: true,
        hasOutput: hasNonEmptyOutput(output),
      });

      // Record successful execution
      // Performance monitoring removed - no legacy components
      return output;
    } catch (error) {
      let formatted: string;
      if (error instanceof ToolArgumentValidationError) {
        formatted = error.message;
      } else {
        const message = error instanceof Error ? error.message : String(error);
        formatted = `Failed to run "${call.name}": ${message}`;
      }
      this.observer?.onToolError?.(augmentedCall, formatted);
      this.recordToolHistory({
        toolName: call.name,
        args,
        timestamp: Date.now(),
        success: false,
        hasOutput: hasNonEmptyOutput(formatted),
        error: formatted,
      });
      
      // Record failed execution - no legacy performance monitoring
      return formatted;
    }
  }

  private getCacheKey(call: ToolCallRequest): string {
    return `${call.name}:${JSON.stringify(call.arguments)}`;
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheStats(): { size: number; entries: number } {
    let totalSize = 0;
    for (const entry of this.cache.values()) {
      totalSize += entry.result.length;
    }
    return {
      size: totalSize,
      entries: this.cache.size,
    };
  }

  clearToolHistory(): void {
    this.toolHistory.length = 0;
  }

  getToolHistory(): readonly ToolHistoryEntry[] {
    return this.toolHistory;
  }

  private recordToolHistory(entry: ToolHistoryEntry): void {
    this.toolHistory.push(entry);
    if (this.toolHistory.length > this.maxHistorySize) {
      this.toolHistory.shift();
    }
  }

  clearDiffSnapshots(): void {
    this.diffSnapshots.length = 0;
  }

  getDiffSnapshots(): readonly DiffSnapshotRecord[] {
    return this.diffSnapshots;
  }

  private addTool(definition: ToolDefinition, suiteId: string): void {
    if (!definition?.name?.trim()) {
      throw new Error(`Tool names cannot be blank (suite "${suiteId}").`);
    }
    if (this.registry.has(definition.name)) {
      const owner = this.registry.get(definition.name)?.suiteId ?? 'unknown';
      throw new Error(`Tool "${definition.name}" already registered by suite "${owner}".`);
    }
    this.registry.set(definition.name, {
      suiteId,
      definition,
    });
    this.registrationOrder.push(definition.name);
  }

  private removeFromOrder(name: string): void {
    const index = this.registrationOrder.indexOf(name);
    if (index >= 0) {
      this.registrationOrder.splice(index, 1);
    }
  }

  private recordDiffSnapshot(args: Record<string, unknown>, output: string): void {
    const command = this.findGitDiffCommand(args);
    if (!command || !output) {
      return;
    }

    this.diffSnapshots.push({
      command,
      output: safeTruncate(output, this.maxDiffSnapshotLength, 'git-diff'),
      timestamp: Date.now(),
    });

    if (this.diffSnapshots.length > this.maxDiffSnapshots) {
      this.diffSnapshots.shift();
    }
  }

  private findGitDiffCommand(args: Record<string, unknown>): string | null {
    for (const command of this.extractCommands(args)) {
      if (this.isGitDiffCommand(command)) {
        return command;
      }
    }
    return null;
  }

  private extractCommands(args: Record<string, unknown>): string[] {
    const commands: string[] = [];

    const command = args['command'];
    if (typeof command === 'string' && command.trim()) {
      commands.push(command.trim());
    }

    const commandList = args['commands'];
    if (Array.isArray(commandList)) {
      for (const value of commandList) {
        if (typeof value === 'string' && value.trim()) {
          commands.push(value.trim());
        }
      }
    }

    return commands;
  }

  private isGitDiffCommand(command: string): boolean {
    return /\bgit\s+(?:--no-pager\s+)?(?:diff|show)\b/i.test(command);
  }
}

export function createDefaultToolRuntime(
  context: ToolExecutionContext,
  toolSuites: ToolSuite[] = [],
  options: ToolRuntimeOptions = {}
): ToolRuntime {
  // Start with no default introspection tools - they waste tokens
  // Model knows its capabilities from tool definitions
  const runtime = new ToolRuntime([], options);

  for (const suite of toolSuites) {
    runtime.registerSuite(suite);
  }

  return runtime;
}

// Removed unused introspection tools (context_snapshot, capabilities_overview, profile_details)
// Model already knows capabilities from tool definitions; these just wasted tokens

function hasNonEmptyOutput(output: string): boolean {
  return typeof output === 'string' && output.trim().length > 0;
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (value instanceof Map) {
    return Object.fromEntries(value.entries());
  }
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
