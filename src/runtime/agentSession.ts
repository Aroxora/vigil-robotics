import { resolveProfileConfig, type ProfileName, type ResolvedProfileConfig } from '../config.js';
import {
  createDefaultToolRuntime,
  type ToolExecutionContext,
  type ToolRuntime,
  type IToolRuntime,
  type ToolRuntimeObserver,
  type ToolSuite,
} from '../core/toolRuntime.js';
import type { ProviderId, ReasoningEffortLevel, TextVerbosityLevel, ConversationMessage, ThinkingBudgetConfig, ThinkingLevel } from '../core/types.js';
import { createProvider, type ProviderConfig } from '../providers/providerFactory.js';
import { AgentRuntime, type AgentCallbacks } from '../core/agent.js';
import { registerDefaultProviderPlugins } from '../plugins/providers/index.js';
import { createDefaultContextManager, ContextManager, type SummarizationCallback } from '../core/contextManager.js';
/**
 * System prompt for context summarization
 * Instructs the LLM to create concise summaries of conversation history
 */
const CONTEXT_CLEANUP_SYSTEM_PROMPT = `Summarize earlier conversation logs to preserve context while staying within token limits.
- Merge any prior summary with the new chunk.
- Capture decisions, tasks, file changes/paths, tool observations, and open questions.
- Separate completed work from follow-ups; keep it under ~180 words with tight bullets.
- Respond in plain Markdown only (no tool or command calls).`;

// Cowork addendum + helper removed in 2026-05 alongside the cowork
// extraction. The coding CLI no longer references productivity-
// assistant tooling at all. The original COWORK_ADDENDUM lives in
// the placeholder repo at ~/GitHub/vigil-cowork next to the tools
// it documents, ready to ride along when that surface ships as its
// own product. See CLAUDE.md "Capability separation".

export interface AgentSessionOptions {
  profile: ProfileName;
  workspaceContext: string | null;
  toolSuites?: ToolSuite[];
  toolObserver?: ToolRuntimeObserver;
  /** Used to locate `.vigil/settings.json` for hooks. Defaults to process.cwd(). */
  workingDir?: string;
}

export interface ModelSelection {
  provider: ProviderId;
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  reasoningEffort?: ReasoningEffortLevel;
  textVerbosity?: TextVerbosityLevel;
  /** Extended thinking configuration for supported models (Anthropic Claude 4/3.7, Gemini 2.5+) */
  thinking?: ThinkingBudgetConfig;
  /** Thinking level for models that support discrete intensities (Gemini 3 Pro) */
  thinkingLevel?: ThinkingLevel;
}

interface AgentSessionState {
  readonly profile: ProfileName;
  workspaceContext: string | null;
  profileConfig: ResolvedProfileConfig;
  toolContext: ToolExecutionContext; // Mutable - updated during model switching
  toolRuntime: ToolRuntime;
  readonly toolSuites: ToolSuite[];
  readonly toolObserver?: ToolRuntimeObserver;
  readonly contextManager: ContextManager;
}

export class AgentSession {
  private readonly state: AgentSessionState;

  constructor(options: AgentSessionOptions) {
    registerDefaultProviderPlugins();
    const profileConfig = resolveProfileConfig(options.profile, options.workspaceContext);
    const toolContext: ToolExecutionContext = {
      profileName: profileConfig.profile,
      provider: profileConfig.provider,
      model: profileConfig.model,
      workspaceContext: options.workspaceContext,
    };

    // Create context manager with LLM-based summarization callback
    const contextManager = this.createContextManagerWithSummarization(profileConfig);

    const toolSuites = options.toolSuites ? [...options.toolSuites] : [];
    const toolRuntime = createDefaultToolRuntime(
      toolContext,
      toolSuites,
      {
        observer: options.toolObserver,
        contextManager, // Pass context manager for output truncation
        workingDir: options.workingDir, // Used to load .vigil/settings.json hooks
      }
    );

    this.state = {
      profile: options.profile,
      workspaceContext: options.workspaceContext,
      profileConfig,
      toolContext,
      toolRuntime,
      toolSuites,
      toolObserver: options.toolObserver,
      contextManager,
    };
  }

  /**
   * Creates a context manager with LLM-based summarization support
   */
  private createContextManagerWithSummarization(profileConfig: ResolvedProfileConfig): ContextManager {
    // Create summarization callback that doesn't reference this.state
    const summarizationCallback: SummarizationCallback = async (messages: ConversationMessage[]) => {
      try {
        // Create a lightweight agent for summarization
        const provider = createProvider({
          provider: profileConfig.provider,
          model: profileConfig.model,
          temperature: 0, // Use deterministic summarization
          maxTokens: 500, // Keep summaries concise
        });

        // Create empty tool context for summarization (no tools needed)
        const emptyToolContext: ToolExecutionContext = {
          profileName: profileConfig.profile,
          provider: profileConfig.provider,
          model: profileConfig.model,
          workspaceContext: null,
        };

        const summarizer = new AgentRuntime({
          provider,
          toolRuntime: createDefaultToolRuntime(emptyToolContext, []), // No tools for summarization
          systemPrompt: CONTEXT_CLEANUP_SYSTEM_PROMPT,
          callbacks: {}, // No callbacks needed for summarization
        });

        // Serialize messages into chunks
        const serialized = messages.map((msg) => serializeMessage(msg)).filter((text) => text.length > 0);

        if (!serialized.length) {
          return '[No content to summarize]';
        }

        // Chunk messages to avoid overwhelming the summarizer
        const chunks = chunkMessages(serialized, 6000);

        // Iteratively summarize chunks
        let runningSummary = '';
        for (const chunk of chunks) {
          const prompt = runningSummary
            ? `Existing summary:\n${runningSummary}\n\nNew conversation chunk:\n${chunk}\n\nMerge the chunk into the running summary, keeping it concise (<200 words).`
            : `Summarize this conversation concisely (<200 words):\n\n${chunk}`;

          runningSummary = (await summarizer.send(prompt)).trim();
        }

        return runningSummary || '[Summary generation failed]';
      } catch (error) {
        // If summarization fails, return a fallback message
        return `[Summarization failed: ${error instanceof Error ? error.message : 'Unknown error'}]`;
      }
    };

    return createDefaultContextManager({
      useLLMSummarization: true,
      summarizationCallback,
    }, profileConfig.model);
  }


  get profile(): ProfileName {
    return this.state.profile;
  }

  get profileConfig(): ResolvedProfileConfig {
    return this.state.profileConfig;
  }

  get workspaceContext(): string | null {
    return this.state.workspaceContext ?? null;
  }

  get toolRuntime(): ToolRuntime {
    return this.state.toolRuntime;
  }

  get toolContext(): ToolExecutionContext {
    return this.state.toolContext;
  }

  createAgent(
    selection: ModelSelection,
    callbacks?: AgentCallbacks,
    toolRuntimeOverride?: IToolRuntime,
    options?: { explainEdits?: boolean }
  ): AgentRuntime {
    const provider = createProvider(asProviderConfig(selection));
    const systemPrompt = (selection.systemPrompt ?? this.state.profileConfig.systemPrompt).trim();

    return new AgentRuntime({
      provider,
      toolRuntime: toolRuntimeOverride ?? this.state.toolRuntime,
      systemPrompt,
      callbacks,
      contextManager: this.state.contextManager, // Pass context manager for history pruning
      explainEdits: options?.explainEdits,
    });
  }

  updateToolContext(selection: ModelSelection): void {
    // Create new context with updated provider/model (properties are readonly)
    this.state.toolContext = {
      ...this.state.toolContext,
      provider: selection.provider,
      model: selection.model,
    };
  }

  refreshWorkspaceContext(workspaceContext: string | null): ResolvedProfileConfig {
    const resolved = resolveProfileConfig(this.state.profile, workspaceContext);
    this.state.workspaceContext = workspaceContext;
    // Create new context with updated workspace (properties are readonly)
    this.state.toolContext = {
      ...this.state.toolContext,
      workspaceContext,
    };
    this.state.profileConfig = {
      ...this.state.profileConfig,
      systemPrompt: resolved.systemPrompt,
      rulebook: resolved.rulebook,
    };
    this.state.toolRuntime = createDefaultToolRuntime(
      this.state.toolContext,
      this.state.toolSuites,
      {
        observer: this.state.toolObserver,
        contextManager: this.state.contextManager, // Preserve context manager
      }
    );
    return this.state.profileConfig;
  }

  get contextManager(): ContextManager {
    return this.state.contextManager;
  }

  get toolSuites(): ToolSuite[] {
    return this.state.toolSuites;
  }
}

/**
 * Serialize a message for summarization
 */
function serializeMessage(message: ConversationMessage): string {
  switch (message.role) {
    case 'user':
      return `User: ${message.content}`;
    case 'assistant':
      return `Assistant: ${message.content}`;
    case 'tool':
      return `Tool(${message.name ?? 'unknown'}): ${message.content}`;
    case 'system':
      return `System: ${message.content}`;
    default:
      return '';
  }
}

/**
 * Chunk messages by character count
 */
function chunkMessages(serialized: string[], maxCharsPerChunk: number): string[] {
  const chunks: string[] = [];
  let buffer = '';

  for (const entry of serialized) {
    const segment = buffer ? `\n\n${entry}` : entry;
    if (buffer && buffer.length + segment.length > maxCharsPerChunk) {
      chunks.push(buffer.trim());
      buffer = entry;
      continue;
    }
    buffer += buffer ? `\n\n${entry}` : entry;
  }

  if (buffer) {
    chunks.push(buffer.trim());
  }

  return chunks;
}

function asProviderConfig(selection: ModelSelection): ProviderConfig {
  return {
    provider: selection.provider,
    model: selection.model,
    temperature: selection.temperature,
    maxTokens: selection.maxTokens,
    reasoningEffort: selection.reasoningEffort,
    textVerbosity: selection.textVerbosity,
    // Pass thinking configuration for extended thinking models
    thinking: selection.thinking,
    thinkingLevel: selection.thinkingLevel,
  };
}

// Re-exported so the agentController can build providers on demand
// (e.g., for parallel sub-agents that spawn their own LeanAgent
// per task — they need to construct a fresh provider matching the
// user's current model selection without coupling to the session).
export function selectionToProviderConfig(selection: ModelSelection): ProviderConfig {
  return asProviderConfig(selection);
}
