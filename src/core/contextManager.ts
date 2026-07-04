/**
 * ContextManager - Manages conversation context to prevent token limit leaks
 *
 * Responsibilities:
 * - Truncate tool outputs intelligently
 * - Prune old conversation history with LLM summarization
 * - Track and estimate token usage
 * - Keep conversation within budget based on model context windows
 * - Proactively shrink context before hitting limits
 */

import type { ConversationMessage } from './types.js';
import { calculateContextThresholds } from './contextWindow.js';

/**
 * Callback for LLM-based summarization of conversation history
 * Takes messages to summarize and returns a concise summary string
 */
export type SummarizationCallback = (
  messages: ConversationMessage[]
) => Promise<string>;

/**
 * Signals that indicate a good compaction point in the conversation
 */
export interface CompactionSignal {
  type: 'task_boundary' | 'topic_shift' | 'milestone' | 'context_saturation' | 'user_pivot' | 'ai_flow_pattern';
  confidence: number; // 0-1
  messageIndex: number;
  reason: string;
  metadata?: Record<string, unknown>;
}

/**
 * AI Flow Patterns for intelligent context management
 */
export interface AIFlowPattern {
  patternId: string;
  description: string;
  toolSequence: string[];
  contextImpact: number; // Estimated token impact
  compactionOpportunity: boolean;
  preservationPriority: number; // 1-10, higher = preserve more
}

/**
 * Enhanced compaction analysis with AI flow awareness
 */
export interface EnhancedCompactionAnalysis {
  shouldCompact: boolean;
  signals: CompactionSignal[];
  recommendedCompactionPoint: number | null;
  urgency: 'none' | 'low' | 'medium' | 'high' | 'critical';
  preserveFromIndex: number;
  aiFlowPatterns: AIFlowPattern[];
  estimatedTokenSavings: number;
  riskAssessment: {
    informationLossRisk: 'low' | 'medium' | 'high';
    continuityRisk: 'low' | 'medium' | 'high';
    recoveryDifficulty: 'easy' | 'moderate' | 'hard';
  };
}

/**
 * Result of intelligent compaction analysis
 */
export interface CompactionAnalysis {
  shouldCompact: boolean;
  signals: CompactionSignal[];
  recommendedCompactionPoint: number | null;
  urgency: 'none' | 'low' | 'medium' | 'high' | 'critical';
  preserveFromIndex: number;
}

/**
 * Summarization prompt template
 */
export const SUMMARIZATION_PROMPT = `Create a compact but reliable summary of the earlier conversation.

Keep:
- Decisions, preferences, and open questions
- File paths, function/class names, APIs, and error messages with fixes
- What was completed vs. still pending (tests, TODOs)

Format:
## Key Context
- ...
## Work Completed
- ...
## Open Items
- ...

Conversation:
{conversation}`;

export interface ContextManagerConfig {
  maxTokens: number; // Maximum tokens allowed in conversation
  targetTokens: number; // Target to stay under (70% of max - triggers pruning)
  warningTokens?: number; // Show warning threshold (60% of max)
  criticalTokens?: number; // Critical warning threshold (85% of max)
  maxToolOutputLength: number; // Max characters for tool outputs
  preserveRecentMessages: number; // Number of recent exchanges to always keep
  estimatedCharsPerToken: number; // Rough estimation (usually ~4 for English)
  useLLMSummarization?: boolean; // Whether to use LLM-based summarization (default: true if callback provided)
  summarizationCallback?: SummarizationCallback; // Optional LLM summarization callback
  model?: string; // Current model name for context window lookup
  // Intelligent compaction settings
  enableIntelligentCompaction?: boolean; // Auto-detect optimal compaction points (default: true)
  compactionThreshold?: number; // Token % to start looking for compaction points (default: 0.5)
  minSignalConfidence?: number; // Minimum confidence to trigger compaction (default: 0.6)
  taskBoundaryPatterns?: string[]; // Custom patterns indicating task completion
  topicShiftSensitivity?: number; // 0-1, how sensitive to topic changes (default: 0.7)
  // AI Flow Pattern Detection
  enableAIFlowPatternDetection?: boolean; // Detect AI software engineering patterns (default: true)
  aiFlowPatterns?: AIFlowPattern[]; // Custom AI flow patterns for context optimization
}

/**
 * Pre-defined AI Flow Patterns for intelligent context management
 */
export const DEFAULT_AI_FLOW_PATTERNS: AIFlowPattern[] = [
  {
    patternId: 'read_edit_workflow',
    description: 'Standard file modification workflow',
    toolSequence: ['read', 'edit'],
    contextImpact: 1500,
    compactionOpportunity: true,
    preservationPriority: 8,
  },
  {
    patternId: 'analysis_phase',
    description: 'Code analysis and exploration phase',
    toolSequence: ['read', 'grep', 'glob', 'search'],
    contextImpact: 3000,
    compactionOpportunity: true,
    preservationPriority: 6,
  },
  {
    patternId: 'implementation_phase',
    description: 'Active code implementation phase',
    toolSequence: ['edit', 'write'],
    contextImpact: 2000,
    compactionOpportunity: false, // Preserve implementation context
    preservationPriority: 9,
  },
  {
    patternId: 'validation_phase',
    description: 'Code validation and testing phase',
    toolSequence: ['run_tests', 'run_build', 'run_repo_checks'],
    contextImpact: 1000,
    compactionOpportunity: true,
    preservationPriority: 5,
  },
  {
    patternId: 'parallel_execution',
    description: 'Efficient parallel tool usage',
    toolSequence: ['read', 'read', 'read'], // Multiple parallel reads
    contextImpact: 2500,
    compactionOpportunity: true,
    preservationPriority: 7,
  },
  {
    patternId: 'git_workflow',
    description: 'Git operations workflow',
    toolSequence: ['git_smart_commit', 'git_sync', 'git_create_pr'],
    contextImpact: 1200,
    compactionOpportunity: true,
    preservationPriority: 6,
  },
];

export interface TruncationResult {
  content: string;
  wasTruncated: boolean;
  originalLength: number;
  truncatedLength: number;
}

export class ContextManager {
  private config: ContextManagerConfig;

  private sessionStartTime: number = Date.now();
  private toolCallHistory: string[] = [];

  constructor(config: Partial<ContextManagerConfig> = {}) {
    this.config = {
      maxTokens: 130000, // Leave room below 131072 limit
      targetTokens: 100000, // Target to trigger pruning
      maxToolOutputLength: 10000, // 10k chars max per tool output
      preserveRecentMessages: 10, // Keep last 10 user/assistant exchanges
      estimatedCharsPerToken: 4,
      ...config,
    };
  }

  /**
   * Record a tool call for context-aware summarization
   */
  recordToolCall(toolName: string): void {
    this.toolCallHistory.push(toolName);
    // Keep only recent history
    if (this.toolCallHistory.length > 50) {
      this.toolCallHistory.shift();
    }
  }

  /**
   * Truncate tool output intelligently using the smart summarizer
   */
  truncateToolOutput(output: string, toolName: string, _args?: Record<string, unknown>): TruncationResult {
    const originalLength = output.length;

    // First check if we even need to truncate
    if (originalLength <= this.config.maxToolOutputLength) {
      return {
        content: output,
        wasTruncated: false,
        originalLength,
        truncatedLength: originalLength,
      };
    }

    // Intelligent truncation based on tool type
    const truncated = this.intelligentTruncate(output, toolName);
    const truncatedLength = truncated.length;

    return {
      content: truncated,
      wasTruncated: true,
      originalLength,
      truncatedLength,
    };
  }

  /**
   * Intelligent truncation based on tool type
   */
  private intelligentTruncate(output: string, toolName: string): string {
    const maxLength = this.config.maxToolOutputLength;

    // For file reads, show beginning and end
    if (toolName === 'Read' || toolName === 'read_file') {
      return this.truncateFileOutput(output, maxLength);
    }

    // For search results, keep first N results
    if (toolName === 'Grep' || toolName === 'grep_search' || toolName === 'Glob') {
      return this.truncateSearchOutput(output, maxLength);
    }

    // For bash/command output, keep end (usually most relevant)
    if (toolName === 'Bash' || toolName === 'bash' || toolName === 'execute_bash') {
      return this.truncateBashOutput(output, maxLength);
    }

    // Default: show beginning with truncation notice
    return this.truncateDefault(output, maxLength);
  }

  private truncateFileOutput(output: string, maxLength: number): string {
    const lines = output.split('\n');
    if (lines.length <= 100) {
      // For small files, just truncate text
      return this.truncateDefault(output, maxLength);
    }

    // Show first 50 and last 50 lines
    const keepLines = Math.floor(maxLength / 100); // Rough estimate
    const headLines = lines.slice(0, keepLines);
    const tailLines = lines.slice(-keepLines);

    const truncatedCount = lines.length - (keepLines * 2);

    return [
      ...headLines,
      `\n... [${truncatedCount} lines truncated for context management] ...\n`,
      ...tailLines,
    ].join('\n');
  }

  private truncateSearchOutput(output: string, maxLength: number): string {
    const lines = output.split('\n');
    const keepLines = Math.floor(maxLength / 80); // Rough average line length

    if (lines.length <= keepLines) {
      return output;
    }

    const truncatedCount = lines.length - keepLines;
    return [
      ...lines.slice(0, keepLines),
      `\n... [${truncatedCount} more results truncated for context management] ...`,
    ].join('\n');
  }

  private truncateBashOutput(output: string, maxLength: number): string {
    if (output.length <= maxLength) {
      return output;
    }

    // For command output, the end is usually most important (errors, final status)
    const keepChars = Math.floor(maxLength * 0.8); // 80% at end
    const prefixChars = maxLength - keepChars - 100; // Small prefix

    const prefix = output.slice(0, prefixChars);
    const suffix = output.slice(-keepChars);
    const truncatedChars = output.length - prefixChars - keepChars;

    return `${prefix}\n\n... [${truncatedChars} characters truncated for context management] ...\n\n${suffix}`;
  }

  private truncateDefault(output: string, maxLength: number): string {
    if (output.length <= maxLength) {
      return output;
    }

    const truncatedChars = output.length - maxLength + 100; // Account for notice
    return `${output.slice(0, maxLength - 100)}\n\n... [${truncatedChars} characters truncated for context management] ...`;
  }

  /**
   * Estimate tokens in a message
   */
  estimateTokens(message: ConversationMessage): number {
    let charCount = 0;

    if (message.content) {
      charCount += message.content.length;
    }

    if (message.role === 'assistant' && message.toolCalls) {
      // Tool calls add overhead
      for (const call of message.toolCalls) {
        charCount += call.name.length;
        charCount += JSON.stringify(call.arguments).length;
      }
    }

    return Math.ceil(charCount / this.config.estimatedCharsPerToken);
  }

  /**
   * Detect context overflow risk from recent tool usage patterns
   */
  detectContextOverflowRisk(toolCalls: string[]): boolean {
    const recentTools = toolCalls.slice(-10); // Last 10 tools
    
    // Check for broad search patterns without limits
    const broadSearches = recentTools.filter(tool => 
      tool.includes('Glob') && !tool.includes('head_limit')
    );
    
    // Check for multiple large file reads
    const fileReads = recentTools.filter(tool => 
      tool.includes('Read') || tool.includes('read_file')
    );
    
    // Check for redundant context_snapshot calls
    const contextSnapshots = recentTools.filter(tool => 
      tool.includes('context_snapshot')
    );
    
    // Risk threshold: 2+ broad searches OR 5+ file reads OR 1+ context_snapshot
    return broadSearches.length >= 2 || 
           fileReads.length >= 5 || 
           contextSnapshots.length >= 1;
  }

  /**
   * Estimate total tokens in conversation
   */
  estimateTotalTokens(messages: ConversationMessage[]): number {
    return messages.reduce((sum, msg) => sum + this.estimateTokens(msg), 0);
  }

  /**
   * Prune old messages when approaching limit
   *
   * Synchronously removes old messages to stay within budget.
   * If LLM summarization is available and enabled, this method will be async.
   */
  pruneMessages(messages: ConversationMessage[]): {
    pruned: ConversationMessage[];
    removed: number;
  } {
    const totalTokens = this.estimateTotalTokens(messages);

    // Only prune if we're above target
    if (totalTokens < this.config.targetTokens) {
      return { pruned: messages, removed: 0 };
    }

    // Always keep system message (first)
    const firstMessage = messages[0];
    const systemMessage = firstMessage?.role === 'system' ? firstMessage : null;
    const conversationMessages = systemMessage ? messages.slice(1) : messages;

    // Group messages into "turns" to maintain tool call/result pairing
    // A turn is: [user] or [assistant + all its tool results]
    const turns: ConversationMessage[][] = [];
    let currentTurn: ConversationMessage[] = [];

    for (const msg of conversationMessages) {
      if (msg.role === 'user') {
        if (currentTurn.length > 0) {
          turns.push(currentTurn);
        }
        currentTurn = [msg];
      } else if (msg.role === 'assistant') {
        if (currentTurn.length > 0) {
          turns.push(currentTurn);
        }
        currentTurn = [msg];
      } else if (msg.role === 'tool') {
        // Tool results belong with the current assistant turn
        currentTurn.push(msg);
      }
    }
    if (currentTurn.length > 0) {
      turns.push(currentTurn);
    }

    // Keep recent turns based on preserveRecentMessages (count user turns)
    const recentTurns: ConversationMessage[][] = [];
    let exchangeCount = 0;

    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (!turn || turn.length === 0) continue;

      recentTurns.unshift(turn);

      // Count user messages as exchanges
      if (turn[0]?.role === 'user') {
        exchangeCount++;
        if (exchangeCount >= this.config.preserveRecentMessages) {
          break;
        }
      }
    }

    // IMPORTANT: Ensure we don't start with orphaned tool messages
    // The first kept turn must start with user or assistant (not tool)
    let startIndex = 0;
    while (startIndex < recentTurns.length) {
      const firstTurn = recentTurns[startIndex];
      if (firstTurn && firstTurn.length > 0 && firstTurn[0]?.role === 'tool') {
        startIndex++;
        continue;
      }
      // Also check for assistant turns with missing tool results
      if (firstTurn && firstTurn[0]?.role === 'assistant') {
        const assistantMsg = firstTurn[0];
        if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
          // PERF: Pre-compute tool call IDs once, use direct Set lookup
          const toolCallIds = assistantMsg.toolCalls.map(tc => tc.id);
          const presentToolResultIds = new Set(
            firstTurn.filter(m => m.role === 'tool').map(m => (m as { toolCallId?: string }).toolCallId)
          );
          // If NOT all tool calls have results, skip this turn
          // PERF: Direct has() calls instead of spread + every()
          let allPresent = true;
          for (const id of toolCallIds) {
            if (!presentToolResultIds.has(id)) {
              allPresent = false;
              break;
            }
          }
          if (!allPresent) {
            startIndex++;
            continue;
          }
        }
      }
      break;
    }

    const validTurns = recentTurns.slice(startIndex);

    // Flatten turns back to messages
    const recentMessages = validTurns.flat();

    // Build pruned message list
    const pruned: ConversationMessage[] = [];
    if (systemMessage) {
      pruned.push(systemMessage);
    }

    // Add a context summary message if we removed messages
    const removedCount = conversationMessages.length - recentMessages.length;
    if (removedCount > 0) {
      pruned.push({
        role: 'system',
        content: `[Context Manager: Removed ${removedCount} old messages to stay within token budget. Recent conversation history preserved.]`,
      });
    }

    pruned.push(...recentMessages);

    return {
      pruned,
      removed: removedCount,
    };
  }

  /**
   * Prune messages with LLM-based summarization
   *
   * This is an async version that uses the LLM to create intelligent summaries
   * instead of just removing old messages. Should be called BEFORE generation.
   */
  async pruneMessagesWithSummary(
    messages: ConversationMessage[],
    options?: { force?: boolean }
  ): Promise<{
    pruned: ConversationMessage[];
    removed: number;
    summarized: boolean;
  }> {
    const totalTokens = this.estimateTotalTokens(messages);

    // Only prune if we're above target
    if (!options?.force && totalTokens < this.config.targetTokens) {
      return { pruned: messages, removed: 0, summarized: false };
    }

    // If no summarization callback or disabled, fall back to simple pruning
    if (!this.config.summarizationCallback || !this.config.useLLMSummarization) {
      const result = this.pruneMessages(messages);
      return { ...result, summarized: false };
    }

    // Partition messages
    const firstMessage = messages[0];
    const systemMessage = firstMessage?.role === 'system' ? firstMessage : null;
    const conversationMessages = systemMessage ? messages.slice(1) : messages;

    // Group messages into "turns" to maintain tool call/result pairing
    const turns: ConversationMessage[][] = [];
    let currentTurn: ConversationMessage[] = [];

    for (const msg of conversationMessages) {
      if (msg.role === 'user') {
        if (currentTurn.length > 0) {
          turns.push(currentTurn);
        }
        currentTurn = [msg];
      } else if (msg.role === 'assistant') {
        if (currentTurn.length > 0) {
          turns.push(currentTurn);
        }
        currentTurn = [msg];
      } else if (msg.role === 'tool') {
        currentTurn.push(msg);
      }
    }
    if (currentTurn.length > 0) {
      turns.push(currentTurn);
    }

    // Keep recent turns based on preserveRecentMessages
    const recentTurns: ConversationMessage[][] = [];
    let exchangeCount = 0;

    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i];
      if (!turn || turn.length === 0) continue;

      recentTurns.unshift(turn);

      if (turn[0]?.role === 'user') {
        exchangeCount++;
        if (exchangeCount >= this.config.preserveRecentMessages) {
          break;
        }
      }
    }

    // Ensure we don't start with orphaned tool messages
    let startIndex = 0;
    while (startIndex < recentTurns.length) {
      const firstTurn = recentTurns[startIndex];
      if (firstTurn && firstTurn.length > 0 && firstTurn[0]?.role === 'tool') {
        startIndex++;
        continue;
      }
      if (firstTurn && firstTurn[0]?.role === 'assistant') {
        const assistantMsg = firstTurn[0];
        if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
          // PERF: Pre-compute tool call IDs once, use direct Set lookup
          const toolCallIds = assistantMsg.toolCalls.map(tc => tc.id);
          const presentToolResultIds = new Set(
            firstTurn.filter(m => m.role === 'tool').map(m => (m as { toolCallId?: string }).toolCallId)
          );
          // PERF: Direct has() calls instead of spread + every()
          let allPresent = true;
          for (const id of toolCallIds) {
            if (!presentToolResultIds.has(id)) {
              allPresent = false;
              break;
            }
          }
          if (!allPresent) {
            startIndex++;
            continue;
          }
        }
      }
      break;
    }

    const validTurns = recentTurns.slice(startIndex);
    const recentMessages = validTurns.flat();

    // Determine which turns to summarize
    const keepTurnCount = validTurns.length;
    const summarizeTurns = turns.slice(0, turns.length - keepTurnCount - startIndex);
    const toSummarize = summarizeTurns.flat();

    // If nothing to summarize, return as-is
    if (toSummarize.length === 0) {
      return { pruned: messages, removed: 0, summarized: false };
    }

    try {
      // Call the LLM to summarize old messages
      const summary = await this.config.summarizationCallback(toSummarize);

      // Build pruned message list with summary
      const pruned: ConversationMessage[] = [];
      if (systemMessage) {
        pruned.push(systemMessage);
      }

      // Add intelligent summary
      pruned.push({
        role: 'system',
        content: [
          '=== Context Summary (Auto-generated) ===',
          summary.trim(),
          '',
          `[Summarized ${toSummarize.length} earlier messages. Recent ${recentMessages.length} messages preserved below.]`,
        ].join('\n'),
      });

      pruned.push(...recentMessages);

      return {
        pruned,
        removed: toSummarize.length,
        summarized: true,
      };
    } catch (error) {
      // If summarization fails, fall back to simple pruning
      const result = this.pruneMessages(messages);
      return { ...result, summarized: false };
    }
  }

  /**
   * Check if we're approaching the limit
   */
  isApproachingLimit(messages: ConversationMessage[]): boolean {
    const totalTokens = this.estimateTotalTokens(messages);
    return totalTokens >= this.config.targetTokens;
  }

  /**
   * Get warning level for current context usage
   * Returns: null (no warning), 'info' (<70%), 'warning' (70-90%), 'danger' (>90%)
   */
  getWarningLevel(messages: ConversationMessage[]): 'info' | 'warning' | 'danger' | null {
    const totalTokens = this.estimateTotalTokens(messages);
    const percentage = (totalTokens / this.config.maxTokens) * 100;

    if (percentage > 90) {
      return 'danger';
    } else if (percentage > 70) {
      return 'warning';
    } else if (percentage > 50) {
      return 'info';
    }

    return null;
  }

  /**
   * Get a human-readable warning message
   */
  getWarningMessage(messages: ConversationMessage[]): string | null {
    const stats = this.getStats(messages);
    const warningLevel = this.getWarningLevel(messages);

    if (warningLevel === 'danger') {
      return `⚠️ Context usage critical (${stats.percentage}%). Consider starting a new session or the next request may fail.`;
    } else if (warningLevel === 'warning') {
      return `Context usage high (${stats.percentage}%). Automatic cleanup will occur soon.`;
    }

    return null;
  }

  /**
   * Get context stats
   */
  getStats(messages: ConversationMessage[]): {
    totalTokens: number;
    percentage: number;
    isOverLimit: boolean;
    isApproachingLimit: boolean;
  } {
    const totalTokens = this.estimateTotalTokens(messages);
    const percentage = Math.round((totalTokens / this.config.maxTokens) * 100);

    return {
      totalTokens,
      percentage,
      isOverLimit: totalTokens >= this.config.maxTokens,
      isApproachingLimit: totalTokens >= this.config.targetTokens,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ContextManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============================================================================
  // INTELLIGENT COMPACTION SYSTEM
  // Automatically detects optimal points for conversation compaction
  // ============================================================================

  /**
   * Default patterns that indicate task boundaries
   */
  private static readonly DEFAULT_TASK_BOUNDARY_PATTERNS = [
    // Completion indicators
    /\b(done|completed|finished|fixed|resolved|implemented|added|created|updated)\b/i,
    /\b(all\s+(?:tests?\s+)?pass(?:ing|ed)?)\b/i,
    /\b(successfully|works?\s+(?:now|correctly))\b/i,
    // Transition indicators
    /\b(next|now\s+(?:let's|we\s+can)|moving\s+on)\b/i,
    /\b(that's\s+(?:it|all|done))\b/i,
    // Acknowledgment patterns
    /^(?:great|perfect|thanks|thank\s+you|got\s+it|understood)\b/i,
  ];

  /**
   * Patterns indicating topic/task shifts
   */
  private static readonly TOPIC_SHIFT_PATTERNS = [
    /\b(different|another|new|separate|unrelated)\s+(?:task|thing|topic|issue|question)\b/i,
    /\b(can\s+you|could\s+you|please|now|let's)\s+(?:also|help|do|make|create|fix|add)\b/i,
    /\b(switching|changing|moving)\s+to\b/i,
    /\b(forget|ignore|never\s*mind)\s+(?:that|the|about)\b/i,
    /^(?:ok|okay|alright|anyway|so)\s*[,.]?\s*(?:can|could|now|let|please)/i,
  ];

  /**
   * Patterns indicating user pivots (abandoning current direction)
   */
  private static readonly USER_PIVOT_PATTERNS = [
    /\b(actually|wait|hold\s+on|stop|cancel|scratch\s+that)\b/i,
    /\b(let's\s+(?:try|do)\s+(?:something|it)\s+(?:else|differently))\b/i,
    /\b(go\s+back|revert|undo|start\s+over)\b/i,
    /\b(wrong|not\s+(?:what|right)|that's\s+not)\b/i,
  ];

  /**
   * Analyze the conversation to detect intelligent compaction points
   */
  analyzeCompactionPoints(messages: ConversationMessage[]): CompactionAnalysis {
    const signals: CompactionSignal[] = [];
    const totalTokens = this.estimateTotalTokens(messages);
    const tokenPercentage = totalTokens / this.config.maxTokens;
    const compactionThreshold = this.config.compactionThreshold ?? 0.5;
    const minConfidence = this.config.minSignalConfidence ?? 0.6;

    // Don't analyze if below threshold
    if (tokenPercentage < compactionThreshold) {
      return {
        shouldCompact: false,
        signals: [],
        recommendedCompactionPoint: null,
        urgency: 'none',
        preserveFromIndex: 0,
      };
    }

    // Analyze each message for compaction signals
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;

      // Detect task boundaries
      const taskBoundary = this.detectTaskBoundary(msg, i, messages);
      if (taskBoundary && taskBoundary.confidence >= minConfidence) {
        signals.push(taskBoundary);
      }

      // Detect topic shifts
      const topicShift = this.detectTopicShift(msg, i, messages);
      if (topicShift && topicShift.confidence >= minConfidence) {
        signals.push(topicShift);
      }

      // Detect user pivots
      const userPivot = this.detectUserPivot(msg, i);
      if (userPivot && userPivot.confidence >= minConfidence) {
        signals.push(userPivot);
      }

      // Detect context saturation (tool output heavy regions)
      const saturation = this.detectContextSaturation(msg, i, messages);
      if (saturation && saturation.confidence >= minConfidence) {
        signals.push(saturation);
      }

      // Detect milestones
      const milestone = this.detectMilestone(msg, i, messages);
      if (milestone && milestone.confidence >= minConfidence) {
        signals.push(milestone);
      }
    }

    // Determine urgency based on token percentage
    const urgency = this.calculateUrgency(tokenPercentage);

    // Find the best compaction point
    const recommendedPoint = this.findBestCompactionPoint(signals, messages, urgency);

    // Calculate preserve index (everything after this should be kept)
    const preserveFromIndex = recommendedPoint !== null
      ? this.findSafePreservePoint(recommendedPoint, messages)
      : messages.length;

    return {
      shouldCompact: signals.length > 0 && urgency !== 'none',
      signals,
      recommendedCompactionPoint: recommendedPoint,
      urgency,
      preserveFromIndex,
    };
  }

  /**
   * Detect task boundary signals
   */
  private detectTaskBoundary(
    msg: ConversationMessage,
    index: number,
    messages: ConversationMessage[]
  ): CompactionSignal | null {
    if (msg.role !== 'user' && msg.role !== 'assistant') return null;

    const content = msg.content || '';
    const patterns = this.config.taskBoundaryPatterns
      ? this.config.taskBoundaryPatterns.map(p => new RegExp(p, 'i'))
      : ContextManager.DEFAULT_TASK_BOUNDARY_PATTERNS;

    let matchCount = 0;
    const reasons: string[] = [];

    for (const pattern of patterns) {
      if (pattern.test(content)) {
        matchCount++;
        reasons.push(pattern.source.slice(0, 30));
      }
    }

    if (matchCount === 0) return null;

    // Higher confidence if followed by a new user message with different intent
    let confidence = Math.min(0.4 + matchCount * 0.2, 0.9);

    // Boost confidence if this looks like a conclusion
    if (msg.role === 'assistant' && this.looksLikeConclusion(content)) {
      confidence = Math.min(confidence + 0.2, 0.95);
    }

    // Boost if next user message starts a new topic
    const nextUserMsg = messages.slice(index + 1).find(m => m.role === 'user');
    if (nextUserMsg && this.isNewTopic(content, nextUserMsg.content || '')) {
      confidence = Math.min(confidence + 0.15, 0.95);
    }

    return {
      type: 'task_boundary',
      confidence,
      messageIndex: index,
      reason: `Task completion detected: ${reasons.slice(0, 2).join(', ')}`,
    };
  }

  /**
   * Detect topic shift signals
   */
  private detectTopicShift(
    msg: ConversationMessage,
    index: number,
    messages: ConversationMessage[]
  ): CompactionSignal | null {
    if (msg.role !== 'user') return null;

    const content = msg.content || '';
    const sensitivity = this.config.topicShiftSensitivity ?? 0.7;

    // Check explicit shift patterns
    for (const pattern of ContextManager.TOPIC_SHIFT_PATTERNS) {
      if (pattern.test(content)) {
        return {
          type: 'topic_shift',
          confidence: 0.7 + sensitivity * 0.2,
          messageIndex: index,
          reason: 'Explicit topic shift language detected',
        };
      }
    }

    // Check semantic shift from previous context
    const prevMessages = messages.slice(Math.max(0, index - 5), index);
    const prevContent = prevMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => m.content || '')
      .join(' ');

    if (prevContent && this.isNewTopic(prevContent, content)) {
      return {
        type: 'topic_shift',
        confidence: 0.6 + sensitivity * 0.2,
        messageIndex: index,
        reason: 'Semantic topic shift detected',
      };
    }

    return null;
  }

  /**
   * Detect user pivot signals (abandoning current direction)
   */
  private detectUserPivot(msg: ConversationMessage, index: number): CompactionSignal | null {
    if (msg.role !== 'user') return null;

    const content = msg.content || '';

    for (const pattern of ContextManager.USER_PIVOT_PATTERNS) {
      if (pattern.test(content)) {
        return {
          type: 'user_pivot',
          confidence: 0.85,
          messageIndex: index,
          reason: 'User pivot/direction change detected',
        };
      }
    }

    return null;
  }

  /**
   * Detect context saturation (heavy tool output regions)
   */
  private detectContextSaturation(
    msg: ConversationMessage,
    index: number,
    messages: ConversationMessage[]
  ): CompactionSignal | null {
    if (msg.role !== 'tool') return null;

    // Look at the surrounding region
    const windowStart = Math.max(0, index - 10);
    const windowEnd = Math.min(messages.length, index + 5);
    const window = messages.slice(windowStart, windowEnd);

    // Count tool messages and their sizes
    let toolCount = 0;
    let totalToolSize = 0;

    for (const m of window) {
      if (m.role === 'tool') {
        toolCount++;
        totalToolSize += (m.content || '').length;
      }
    }

    // High saturation if many tool outputs with large content
    if (toolCount >= 5 && totalToolSize > 20000) {
      // Find the last tool message in this cluster as compaction point
      let lastToolIndex = index;
      for (let i = index + 1; i < windowEnd; i++) {
        if (messages[i]?.role === 'tool') {
          lastToolIndex = i;
        } else if (messages[i]?.role === 'user') {
          break; // Stop at next user message
        }
      }

      return {
        type: 'context_saturation',
        confidence: Math.min(0.5 + toolCount * 0.05, 0.85),
        messageIndex: lastToolIndex,
        reason: `Heavy tool output region (${toolCount} tools, ${Math.round(totalToolSize / 1000)}k chars)`,
      };
    }

    return null;
  }

  /**
   * Detect milestone signals (significant accomplishments)
   */
  private detectMilestone(
    msg: ConversationMessage,
    index: number,
    _messages: ConversationMessage[]
  ): CompactionSignal | null {
    if (msg.role !== 'assistant') return null;

    const content = msg.content || '';

    // Look for milestone indicators
    const milestonePatterns = [
      /\b(commit(?:ted)?|pushed|deployed|merged|released)\b/i,
      /\b(all\s+tests?\s+pass(?:ing|ed)?)\b/i,
      /\b(build\s+(?:succeed|success|pass))\b/i,
      /\b(feature\s+(?:complete|done|ready))\b/i,
      /\b(pr\s+(?:created|opened|merged))\b/i,
    ];

    for (const pattern of milestonePatterns) {
      if (pattern.test(content)) {
        return {
          type: 'milestone',
          confidence: 0.9,
          messageIndex: index,
          reason: 'Significant milestone achieved',
        };
      }
    }

    return null;
  }

  /**
   * Check if content looks like a task conclusion
   */
  private looksLikeConclusion(content: string): boolean {
    const conclusionPatterns = [
      /\b(let\s+me\s+know|feel\s+free|if\s+you\s+(?:need|have|want))\b/i,
      /\b(anything\s+else|other\s+questions?)\b/i,
      /\b(should\s+be\s+(?:good|working|ready|done))\b/i,
      /\b(that\s+should|this\s+(?:should|will))\s+(?:fix|solve|work)/i,
    ];

    return conclusionPatterns.some(p => p.test(content));
  }

  /**
   * Check if two contents represent different topics (simple heuristic)
   */
  private isNewTopic(prevContent: string, newContent: string): boolean {
    // Extract key terms (simple tokenization)
    const extractTerms = (text: string): Set<string> => {
      const words = text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3);
      return new Set(words);
    };

    const prevTerms = extractTerms(prevContent);
    const newTerms = extractTerms(newContent);

    if (prevTerms.size === 0 || newTerms.size === 0) return false;

    // Calculate overlap
    let overlap = 0;
    for (const term of newTerms) {
      if (prevTerms.has(term)) overlap++;
    }

    const overlapRatio = overlap / Math.min(prevTerms.size, newTerms.size);

    // Low overlap suggests new topic
    return overlapRatio < 0.2;
  }

  /**
   * Calculate urgency level based on token percentage
   */
  private calculateUrgency(tokenPercentage: number): 'none' | 'low' | 'medium' | 'high' | 'critical' {
    if (tokenPercentage >= 0.9) return 'critical';
    if (tokenPercentage >= 0.75) return 'high';
    if (tokenPercentage >= 0.6) return 'medium';
    if (tokenPercentage >= 0.5) return 'low';
    return 'none';
  }

  /**
   * Find the best compaction point from signals
   */
  private findBestCompactionPoint(
    signals: CompactionSignal[],
    messages: ConversationMessage[],
    urgency: 'none' | 'low' | 'medium' | 'high' | 'critical'
  ): number | null {
    if (signals.length === 0) return null;

    // Score each signal based on type priority and confidence
    const typePriority: Record<CompactionSignal['type'], number> = {
      milestone: 1.0,
      task_boundary: 0.9,
      user_pivot: 0.85,
      ai_flow_pattern: 0.82, // AI flow patterns like thinking/tool use cycles
      topic_shift: 0.8,
      context_saturation: 0.7,
    };

    // Urgency affects how far back we're willing to compact
    const urgencyDepth: Record<string, number> = {
      none: 0,
      low: 0.3, // Compact only recent 30%
      medium: 0.5,
      high: 0.7,
      critical: 0.9,
    };

    const maxDepth = urgencyDepth[urgency] ?? 0.5;
    const minIndex = Math.floor(messages.length * (1 - maxDepth));

    // Find highest scoring signal within allowed depth
    let bestSignal: CompactionSignal | null = null;
    let bestScore = 0;

    for (const signal of signals) {
      if (signal.messageIndex < minIndex) continue;

      const score = signal.confidence * typePriority[signal.type];
      if (score > bestScore) {
        bestScore = score;
        bestSignal = signal;
      }
    }

    return bestSignal?.messageIndex ?? null;
  }

  /**
   * Find a safe preservation point that doesn't break tool call chains
   */
  private findSafePreservePoint(compactionPoint: number, messages: ConversationMessage[]): number {
    // Start from compaction point and move forward to find a safe break
    for (let i = compactionPoint + 1; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;

      // Safe if it's a user message
      if (msg.role === 'user') {
        return i;
      }

      // Safe if it's an assistant without pending tool calls
      if (msg.role === 'assistant' && !msg.toolCalls?.length) {
        return i;
      }
    }

    // If no safe point found, keep more messages
    return Math.min(compactionPoint + 1, messages.length);
  }

  /**
   * Perform intelligent compaction based on analysis
   * This method analyzes the conversation and compacts at the optimal point
   */
  async intelligentCompact(messages: ConversationMessage[]): Promise<{
    compacted: ConversationMessage[];
    analysis: CompactionAnalysis;
    summarized: boolean;
  }> {
    // Analyze for compaction points
    const analysis = this.analyzeCompactionPoints(messages);

    // If no compaction needed or no good point found
    if (!analysis.shouldCompact || analysis.recommendedCompactionPoint === null) {
      return {
        compacted: messages,
        analysis,
        summarized: false,
      };
    }

    // Separate messages to summarize and preserve
    const firstMessage = messages[0];
    const systemMessage = firstMessage?.role === 'system' ? firstMessage : null;
    const startIndex = systemMessage ? 1 : 0;

    const toSummarize = messages.slice(startIndex, analysis.preserveFromIndex);
    const toPreserve = messages.slice(analysis.preserveFromIndex);

    // If nothing to summarize, return as-is
    if (toSummarize.length === 0) {
      return {
        compacted: messages,
        analysis,
        summarized: false,
      };
    }

    // Build result
    const compacted: ConversationMessage[] = [];
    if (systemMessage) {
      compacted.push(systemMessage);
    }

    // Try LLM summarization if available
    if (this.config.summarizationCallback && this.config.useLLMSummarization !== false) {
      try {
        const summary = await this.config.summarizationCallback(toSummarize);

        compacted.push({
          role: 'system',
          content: [
            '=== Intelligent Context Summary ===',
            `Compaction triggered: ${analysis.signals[0]?.reason || 'Context optimization'}`,
            '',
            summary.trim(),
            '',
            `[Summarized ${toSummarize.length} messages. ${toPreserve.length} recent messages preserved.]`,
          ].join('\n'),
        });

        compacted.push(...toPreserve);

        return {
          compacted,
          analysis,
          summarized: true,
        };
      } catch {
        // Fall through to simple compaction
      }
    }

    // Simple compaction without LLM
    compacted.push({
      role: 'system',
      content: `[Context Manager: Intelligently compacted ${toSummarize.length} messages at "${analysis.signals[0]?.reason || 'optimal point'}". ${toPreserve.length} recent messages preserved.]`,
    });

    compacted.push(...toPreserve);

    return {
      compacted,
      analysis,
      summarized: false,
    };
  }

  /**
   * Check if intelligent compaction should be triggered
   * Call this before generation to proactively manage context
   */
  shouldTriggerCompaction(messages: ConversationMessage[]): {
    shouldCompact: boolean;
    urgency: CompactionAnalysis['urgency'];
    reason: string | null;
  } {
    if (this.config.enableIntelligentCompaction === false) {
      return { shouldCompact: false, urgency: 'none', reason: null };
    }

    const analysis = this.analyzeCompactionPoints(messages);

    if (!analysis.shouldCompact) {
      return { shouldCompact: false, urgency: analysis.urgency, reason: null };
    }

    const topSignal = analysis.signals
      .sort((a, b) => b.confidence - a.confidence)[0];

    return {
      shouldCompact: true,
      urgency: analysis.urgency,
      reason: topSignal?.reason || 'Context optimization recommended',
    };
  }
}

/**
 * Create a default context manager instance with model-aware limits
 */
export function createDefaultContextManager(
  overrides?: Partial<ContextManagerConfig>,
  model?: string
): ContextManager {
  // Get model-specific thresholds
  const thresholds = calculateContextThresholds(model);

  return new ContextManager({
    maxTokens: thresholds.maxTokens,
    targetTokens: thresholds.targetTokens,  // Start pruning at 60%
    warningTokens: thresholds.warningTokens,  // Warn at 50%
    criticalTokens: thresholds.criticalTokens,  // Critical at 75%
    maxToolOutputLength: 5000, // 5k chars max per tool (reduced for safety)
    preserveRecentMessages: 5, // Keep last 5 exchanges
    estimatedCharsPerToken: 3.5, // More aggressive estimate (accounts for special tokens, JSON overhead)
    useLLMSummarization: true, // Enable LLM summarization by default
    // Intelligent compaction defaults
    enableIntelligentCompaction: true,
    compactionThreshold: 0.5, // Start analyzing at 50% context usage
    minSignalConfidence: 0.6, // Require 60% confidence for compaction signals
    topicShiftSensitivity: 0.7, // Moderately sensitive to topic changes
    model,
    ...overrides,
  });
}

/**
 * Format conversation messages into readable text for summarization
 */
export function formatMessagesForSummary(messages: ConversationMessage[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push(`USER: ${msg.content}`);
    } else if (msg.role === 'assistant') {
      let content = msg.content || '';
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolNames = msg.toolCalls.map(tc => tc.name);
        content += ` [Called tools: ${toolNames.join(', ')}]`;
      }
      lines.push(`ASSISTANT: ${content}`);
    } else if (msg.role === 'tool') {
      // Truncate long tool outputs for summarization
      const output = msg.content.length > 500
        ? `${msg.content.slice(0, 500)  }...`
        : msg.content;
      lines.push(`TOOL (${msg.name}): ${output}`);
    }
    // Skip system messages in summary input
  }

  return lines.join('\n\n');
}

/**
 * Create a summarization callback using the given provider
 */
export function createSummarizationCallback(
  provider: { generate: (messages: ConversationMessage[], tools: unknown[]) => Promise<{ content?: string }> }
): SummarizationCallback {
  return async (messages: ConversationMessage[]): Promise<string> => {
    // Format messages into readable conversation
    const conversationText = formatMessagesForSummary(messages);

    // Create summarization prompt
    const prompt = SUMMARIZATION_PROMPT.replace('{conversation}', conversationText);

    // Call provider to generate summary (no tools needed)
    const response = await provider.generate(
      [{ role: 'user', content: prompt }],
      []
    );

    return response.content || '';
  };
}
