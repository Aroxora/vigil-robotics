/**
 * Intelligent Task Completion Detector
 *
 * This module provides robust detection of whether a continuous task is truly complete,
 * rather than just pattern-matching keywords like "done" in responses.
 *
 * Key features:
 * - Multi-signal analysis (tool usage, response content, state changes)
 * - AI verification round before final completion
 * - Confidence scoring
 * - Work-in-progress detection
 *
 * @license MIT
 * @author Trenchwork
 */

export interface ToolActivity {
  toolName: string;
  timestamp: number;
  success: boolean;
  hasOutput: boolean;
}

export interface CompletionSignals {
  // Response content signals
  hasExplicitCompletionStatement: boolean;
  hasIncompleteWorkIndicators: boolean;
  hasPendingActionIndicators: boolean;
  hasErrorIndicators: boolean;
  hasFollowUpQuestions: boolean;
  hasDocumentationSpam: boolean;  // Creating MD files instead of doing real work

  // Activity signals
  toolsUsedInLastResponse: number;
  lastToolWasReadOnly: boolean;
  consecutiveResponsesWithoutTools: number;
  hasRecentFileWrites: boolean;
  hasRecentCommits: boolean;

  // Context signals
  todoItemsPending: number;
  todoItemsCompleted: number;
  mentionsFutureWork: boolean;

  // Calculated confidence (0-1)
  completionConfidence: number;
}

export interface CompletionAnalysis {
  isComplete: boolean;
  confidence: number;
  signals: CompletionSignals;
  reason: string;
  shouldVerify: boolean;
  verificationPrompt?: string;
}

/**
 * Patterns that conclusively show a test or build is currently
 * failing in the response/tool output. When ANY of these match the
 * task is NOT complete — even if the model claims otherwise. This
 * mirrors what a human reviewer would catch: "you said done but
 * jest is reporting 3 failures right above your message".
 *
 * Patterns are intentionally narrow — they must require the FAILURE
 * be currently happening, not historical context like "we fixed
 * the test that was failing".
 */
const FAILING_TEST_BUILD_PATTERNS: { name: string; re: RegExp }[] = [
  // Jest/Vitest summary lines
  { name: 'jest test count', re: /Tests:\s+\d+\s+failed/i },
  { name: 'jest suite count', re: /Test Suites:\s+\d+\s+failed/i },
  { name: 'jest fail line', re: /^\s*FAIL\s+[\w./-]+\.(test|spec)\.[jt]sx?\s*$/m },
  // Vitest
  { name: 'vitest fail count', re: /\b\d+\s+failed\s*\|\s*\d+\s+passed/i },
  // Mocha / generic
  { name: 'failing tests count', re: /\b\d+\s+failing\b/i },
  // TypeScript / build errors
  { name: 'tsc error', re: /\berror\s+TS\d{4,5}\b:/i },
  { name: 'webpack failed', re: /webpack[^\n]*failed/i },
  { name: 'compilation failed', re: /(Compilation|Build)\s+failed\b/i },
  // Generic exit-code 1 from a recent command. Matches both
  // "exited with code 1" and "exited 2" / "exit code 1".
  { name: 'exited non-zero', re: /\bexit(?:ed)?\s+(?:with\s+)?(?:code\s+)?[1-9]\d*\b/i },
  // Linter/formatter blocking
  { name: 'eslint error', re: /\b\d+\s+errors?\b\s*(?:and\s+\d+\s+warnings?\b)?[\s\S]{0,40}eslint/i },
];

/**
 * Returns the name of the matched failure pattern, or null.
 * Used to FORCE the auto-loop to continue when tests are red.
 */
export function detectFailingTestOrBuild(text: string): string | null {
  if (!text || !text.trim()) return null;
  // Only scan the last ~6KB of the response — failing tests appear
  // in the recent tool output, and scanning the whole transcript
  // can match historical context ("the test we fixed was failing").
  const tail = text.length > 6000 ? text.slice(-6000) : text;
  for (const { name, re } of FAILING_TEST_BUILD_PATTERNS) {
    if (re.test(tail)) return name;
  }
  return null;
}

// Keywords that strongly indicate task completion
const STRONG_COMPLETION_PATTERNS = [
  /^(all\s+)?tasks?\s+(are\s+)?(now\s+)?(complete|done|finished)/im,
  /^(i('ve|'m|\s+have|\s+am)\s+)?(successfully\s+)?(completed?|finished|done)\s+(all|the|with|everything)/im,
  /^everything\s+(is\s+)?(now\s+)?(complete|done|finished)/im,
  /^the\s+requested?\s+(task|work|changes?)\s+(is|are|has been)\s+(complete|done|finished)/im,
  /^i\s+have\s+(now\s+)?(successfully\s+)?(completed?|finished|done)\s+(all|the|everything)/im,
  /no\s+(more|further)\s+(tasks?|work|actions?|changes?)\s+(are\s+)?(needed|required|necessary)/im,
];

// Keywords that indicate work is still in progress
const INCOMPLETE_WORK_PATTERNS = [
  /\b(next|then|now\s+I('ll|\s+will)|let\s+me|I('ll|\s+will)|going\s+to|about\s+to)\b/i,
  /\b(continue|continuing|proceed|proceeding|working\s+on)\b/i,
  /\b(TODO|FIXME|WIP|in\s+progress)\b/i,
  /\b(still\s+need|remaining|left\s+to\s+do|more\s+to\s+do)\b/i,
  /\b(step\s+\d+|phase\s+\d+|iteration\s+\d+)\b/i,
  /\b(haven'?t\s+(yet|finished)|not\s+yet\s+(done|complete|finished))\b/i,
];

// Patterns that indicate documentation spam instead of real work
const DOCUMENTATION_SPAM_PATTERNS = [
  /creat(ed?|ing)\s+.{0,30}?\.(md|markdown)\b/i,
  /writ(e|ing|ten)\s+.{0,30}?(summary|report|documentation|readme)/i,
  /\b(FINAL|COMPLETE|ULTIMATE|MASTER)_.*\.(md|markdown)\b/i,
  /\b(DEPLOYMENT|HANDOVER|SUMMARY|REPORT).*\.(md|markdown)\b/i,
  /generat(ed?|ing)\s+.{0,30}?(documentation|summary|report)/i,
];

// Keywords that indicate pending actions
const PENDING_ACTION_PATTERNS = [
  /\b(need\s+to|should|must|have\s+to|requires?)\b/i,
  /\b(waiting|pending|queued)\b/i,
  /\b(before\s+I\s+can|after\s+that|once\s+that)\b/i,
  /\b(running|executing|processing)\b/i,
];

// Keywords that indicate errors or issues
const ERROR_PATTERNS = [
  /\b(error|failed|failure|exception|issue|problem|bug)\b/i,
  /\b(can'?t|cannot|couldn'?t|unable\s+to)\b/i,
  /\b(fix|fixing|resolve|resolving|debug|debugging)\b/i,
];

// Keywords that indicate follow-up questions
const FOLLOWUP_QUESTION_PATTERNS = [
  /\b(would\s+you\s+like|do\s+you\s+want|shall\s+I|should\s+I)\b/i,
  /\b(let\s+me\s+know|please\s+(confirm|tell|let))\b/i,
  /\?$/m,
];

// Keywords that indicate future work
const FUTURE_WORK_PATTERNS = [
  /\b(could\s+also|might\s+want\s+to|consider|recommend)\b/i,
  /\b(future|later|eventually|when\s+you\s+have\s+time)\b/i,
  /\b(improvement|enhancement|optimization)\b/i,
];

// Read-only tool names
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'Read',
  'list_dir',
  'list_files',
  'search_text',
  'grep',
  'Grep',
  'glob',
  'Glob',
  'git_status',
  'git_log',
  'git_diff',
]);

// Write/action tool names - exported for use in completion detection
export const WRITE_TOOLS = new Set([
  'edit_file',
  'Edit',
  'write_file',
  'Write',
  'bash',
  'Bash',
  'execute_command',
  'git_commit',
  'git_push',
  'NotebookEdit',
]);

export class TaskCompletionDetector {
  private toolHistory: ToolActivity[] = [];
  private responseHistory: string[] = [];
  private lastToolNames: string[] = [];
  private consecutiveNoTools = 0;
  private todoStats = { pending: 0, completed: 0 };

  constructor() {
    this.reset();
  }

  /**
   * Reset the detector state for a new task
   */
  reset(): void {
    this.toolHistory = [];
    this.responseHistory = [];
    this.lastToolNames = [];
    this.consecutiveNoTools = 0;
    this.todoStats = { pending: 0, completed: 0 };
  }

  /**
   * Record a tool call
   */
  recordToolCall(toolName: string, success: boolean, hasOutput: boolean): void {
    this.toolHistory.push({
      toolName,
      timestamp: Date.now(),
      success,
      hasOutput,
    });
    this.lastToolNames.push(toolName);

    // Keep only recent history
    if (this.toolHistory.length > 100) {
      this.toolHistory = this.toolHistory.slice(-100);
    }
    if (this.lastToolNames.length > 20) {
      this.lastToolNames = this.lastToolNames.slice(-20);
    }
  }

  /**
   * Record a response (call after each AI response)
   */
  recordResponse(response: string, toolsUsed: string[]): void {
    this.responseHistory.push(response);

    if (toolsUsed.length === 0) {
      this.consecutiveNoTools++;
    } else {
      this.consecutiveNoTools = 0;
      this.lastToolNames = toolsUsed;
    }

    // Keep only recent history
    if (this.responseHistory.length > 20) {
      this.responseHistory = this.responseHistory.slice(-20);
    }
  }

  /**
   * Update todo statistics
   */
  updateTodoStats(pending: number, completed: number): void {
    this.todoStats = { pending, completed };
  }

  /**
   * Analyze the current state and determine if the task is complete
   */
  analyzeCompletion(currentResponse: string, toolsUsedThisRound: string[]): CompletionAnalysis {
    this.recordResponse(currentResponse, toolsUsedThisRound);

    const signals = this.gatherSignals(currentResponse, toolsUsedThisRound);
    const confidence = this.calculateConfidence(signals);

    signals.completionConfidence = confidence;

    // OVERRIDE: if the response or recent tool output shows visible
    // test/build failures, the task is NEVER complete — even if the
    // model claims otherwise. This is the single highest-leverage
    // upgrade for Claude-Code-grade auto-loop behavior: the model
    // can't accidentally (or confidently) declare victory while
    // tests are red.
    const failingSignal = detectFailingTestOrBuild(currentResponse);
    if (failingSignal) {
      return {
        isComplete: false,
        confidence,
        signals,
        reason: `Test/build failure visible in response: ${failingSignal}. Override: continue until green.`,
        shouldVerify: false,
        verificationPrompt: undefined,
      };
    }

    // Determine completion status
    let isComplete = false;
    let reason = '';
    let shouldVerify = false;
    let verificationPrompt: string | undefined;

    // High confidence completion
    if (confidence >= 0.85 && signals.hasExplicitCompletionStatement && !signals.hasIncompleteWorkIndicators) {
      isComplete = true;
      reason = 'High confidence explicit completion statement with no incomplete work indicators';
    }
    // Medium confidence - needs verification
    else if (confidence >= 0.6 && signals.hasExplicitCompletionStatement) {
      shouldVerify = true;
      reason = 'Medium confidence completion - AI verification recommended';
      verificationPrompt = this.generateVerificationPrompt(signals);
    }
    // Low confidence - likely not complete
    else if (confidence < 0.4) {
      isComplete = false;
      reason = this.getLowConfidenceReason(signals);
    }
    // Ambiguous case - check for stagnation
    else if (this.consecutiveNoTools >= 3 && !signals.hasIncompleteWorkIndicators) {
      shouldVerify = true;
      reason = 'No tool activity for multiple rounds - verification needed';
      verificationPrompt = this.generateStagnationVerificationPrompt();
    }
    // Default: not complete
    else {
      isComplete = false;
      reason = 'Active work indicators detected or low completion confidence';
    }

    return {
      isComplete,
      confidence,
      signals,
      reason,
      shouldVerify,
      verificationPrompt,
    };
  }

  /**
   * Gather all completion signals from the current state
   */
  private gatherSignals(response: string, toolsUsed: string[]): CompletionSignals {
    const hasExplicitCompletionStatement = STRONG_COMPLETION_PATTERNS.some((p) => p.test(response));
    const hasIncompleteWorkIndicators = INCOMPLETE_WORK_PATTERNS.some((p) => p.test(response));
    const hasPendingActionIndicators = PENDING_ACTION_PATTERNS.some((p) => p.test(response));
    const hasErrorIndicators = ERROR_PATTERNS.some((p) => p.test(response));
    const hasFollowUpQuestions = FOLLOWUP_QUESTION_PATTERNS.some((p) => p.test(response));
    const mentionsFutureWork = FUTURE_WORK_PATTERNS.some((p) => p.test(response));
    const hasDocumentationSpam = DOCUMENTATION_SPAM_PATTERNS.some((p) => p.test(response));

    const lastToolWasReadOnly =
      toolsUsed.length > 0 && toolsUsed.every((t) => READ_ONLY_TOOLS.has(t));

    const recentTools = this.toolHistory.filter(
      (t) => t.success && Date.now() - t.timestamp < 60000
    );
    const hasRecentFileWrites = recentTools.some(
      (t) => t.toolName === 'edit_file' || t.toolName === 'Edit' ||
             t.toolName === 'write_file' || t.toolName === 'Write'
    );
    const hasRecentCommits = recentTools.some(
      (t) => t.toolName === 'bash' || t.toolName === 'Bash'
    ) && this.responseHistory.some((r) => r.includes('git commit') || r.includes('committed'));

    return {
      hasExplicitCompletionStatement,
      hasIncompleteWorkIndicators,
      hasPendingActionIndicators,
      hasErrorIndicators,
      hasFollowUpQuestions,
      hasDocumentationSpam,
      toolsUsedInLastResponse: toolsUsed.length,
      lastToolWasReadOnly,
      consecutiveResponsesWithoutTools: this.consecutiveNoTools,
      hasRecentFileWrites,
      hasRecentCommits,
      todoItemsPending: this.todoStats.pending,
      todoItemsCompleted: this.todoStats.completed,
      mentionsFutureWork,
      completionConfidence: 0, // Will be calculated
    };
  }

  /**
   * Calculate confidence score for task completion
   */
  private calculateConfidence(signals: CompletionSignals): number {
    let score = 0.5; // Start at neutral

    // Strong positive signals
    if (signals.hasExplicitCompletionStatement) score += 0.25;
    if (signals.hasRecentCommits) score += 0.1;
    if (signals.todoItemsPending === 0 && signals.todoItemsCompleted > 0) score += 0.15;

    // Strong negative signals
    if (signals.hasIncompleteWorkIndicators) score -= 0.3;
    if (signals.hasPendingActionIndicators) score -= 0.2;
    if (signals.hasErrorIndicators) score -= 0.25;
    if (signals.todoItemsPending > 0) score -= 0.15;
    // Documentation spam is a VERY strong negative signal - it means the AI is
    // creating summary files instead of doing actual work
    if (signals.hasDocumentationSpam) score -= 0.4;

    // Moderate signals
    if (signals.toolsUsedInLastResponse > 0 && !signals.lastToolWasReadOnly) score -= 0.1;
    if (signals.consecutiveResponsesWithoutTools >= 2) score += 0.1;
    if (signals.hasFollowUpQuestions) score -= 0.1;
    if (signals.mentionsFutureWork && signals.hasExplicitCompletionStatement) score += 0.05;

    // Clamp to 0-1 range
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Generate a verification prompt to ask the AI if the task is truly complete
   */
  private generateVerificationPrompt(signals: CompletionSignals): string {
    const concerns: string[] = [];

    if (signals.hasDocumentationSpam) {
      concerns.push('you created documentation/summary files instead of completing actual work');
    }
    if (signals.todoItemsPending > 0) {
      concerns.push(`there are ${signals.todoItemsPending} todo items still pending`);
    }
    if (signals.hasFollowUpQuestions) {
      concerns.push('you asked follow-up questions');
    }
    if (signals.mentionsFutureWork) {
      concerns.push('you mentioned potential future improvements');
    }

    const concernsText =
      concerns.length > 0 ? `However, ${concerns.join(' and ')}. ` : '';

    return `You indicated the task might be complete. ${concernsText}Please confirm:

1. Have ALL the originally requested changes been implemented in actual code files?
2. Are there any remaining errors or issues that need to be fixed?
3. Is there anything else you need to do to fully complete this task?

IMPORTANT: Creating markdown documentation files does NOT count as completing a task.
Focus on the actual code/implementation work requested.

If everything is truly done, respond with exactly: "TASK_FULLY_COMPLETE"
If there's more work to do, describe what remains and continue working.`;
  }

  /**
   * Generate a verification prompt for stagnation cases
   */
  private generateStagnationVerificationPrompt(): string {
    return `I notice you haven't used any tools for several responses. Let me check:

1. Is the task complete? If so, summarize what was accomplished.
2. Are you blocked on something? If so, what do you need?
3. Is there more work to do? If so, please continue.

If everything is done, respond with exactly: "TASK_FULLY_COMPLETE"
Otherwise, please continue with the next action.`;
  }

  /**
   * Get a human-readable reason for low confidence
   */
  private getLowConfidenceReason(signals: CompletionSignals): string {
    const reasons: string[] = [];

    if (signals.hasDocumentationSpam) {
      reasons.push('creating documentation instead of actual work');
    }
    if (signals.hasIncompleteWorkIndicators) {
      reasons.push('incomplete work indicators detected');
    }
    if (signals.hasPendingActionIndicators) {
      reasons.push('pending action indicators found');
    }
    if (signals.hasErrorIndicators) {
      reasons.push('error indicators present');
    }
    if (signals.toolsUsedInLastResponse > 0 && !signals.lastToolWasReadOnly) {
      reasons.push('write operations performed');
    }
    if (signals.todoItemsPending > 0) {
      reasons.push(`${signals.todoItemsPending} todo items still pending`);
    }

    return reasons.length > 0 ? reasons.join(', ') : 'no clear completion signals';
  }

  /**
   * Check if a verification response confirms completion
   */
  isVerificationConfirmed(verificationResponse: string): boolean {
    const hasCompletionMarker = (
      verificationResponse.includes('TASK_FULLY_COMPLETE') ||
      /^(yes|confirmed?|all\s+done|everything\s+(is\s+)?complete)/im.test(verificationResponse.trim())
    );

    // Even if completion marker is present, check for contradictions
    if (hasCompletionMarker && this.responseContainsIncompleteIndicators(verificationResponse)) {
      return false;
    }

    return hasCompletionMarker;
  }

  /**
   * Check if a response contradicts itself by saying "complete" but also indicating incomplete work.
   * This comprehensive list catches many ways AI might admit work isn't done while claiming completion.
   */
  private responseContainsIncompleteIndicators(response: string): boolean {
    const incompletePatterns = [
      // === INTEGRATION/DEPLOYMENT STATE ===
      /hasn'?t\s+been\s+(integrated|implemented|connected|deployed|added|completed|tested|verified)\s*(yet|still)?/i,
      /not\s+(yet\s+)?(integrated|implemented|connected|deployed|functional|working|complete|tested|verified)/i,
      /ready\s+(for|to\s+be)\s+(integration|integrated|connected|deployed|testing|review)/i,
      /needs?\s+to\s+be\s+(integrated|connected|deployed|added|hooked|wired|tested|reviewed|merged)/i,
      /was\s+not\s+(performed|completed|implemented|deployed|integrated|tested)/i,
      /the\s+\w+\s+(service|module|component|feature)\s+hasn'?t\s+been/i,

      // === PARTIAL/INCOMPLETE STATE ===
      /still\s+(stores?|uses?|has|contains?|needs?|requires?|missing|lacks?|broken)/i,
      /\b(partially|mostly|almost|nearly|not\s+fully)\s+(complete|done|finished|implemented|working)/i,
      /\b(only\s+)?(part|some|half|portion)\s+of\s+(the\s+)?(task|work|feature|implementation)/i,

      // === QUALIFIER WORDS (uncertain completion) ===
      /\b(should|might|may|could|appears?\s+to)\s+be\s+(complete|done|working|functional)/i,
      /\btheoretically\s+(complete|done|working|functional)/i,
      /\b(assuming|provided|if)\s+(everything|it|this|that)\s+(works?|is\s+correct)/i,

      // === SELF-CONTRADICTION PHRASES ===
      /\b(done|complete|finished)\s+(but|except|however|although|though)/i,
      /however[,\s].{0,50}?(hasn'?t|not\s+yet|still\s+needs?|pending|remains?|missing|broken|failing)/i,
      /\bbut\s+.{0,30}?(not|hasn'?t|won'?t|can'?t|doesn'?t|isn'?t|wasn'?t)/i,

      // === FUTURE TENSE / DEFERRED WORK ===
      /will\s+(need\s+to|require|have\s+to)\s+(integrate|connect|deploy|complete|implement|test|fix)/i,
      /\b(left\s+as|deferred|postponed|out\s+of\s+scope|for\s+later|in\s+a\s+future)/i,
      /\b(after\s+(restart|reboot|redeploy)|takes?\s+effect\s+after|once\s+you)/i,

      // === REMAINING WORK INDICATORS ===
      /\b(remaining|outstanding|pending|leftover)\s+(tasks?|items?|work|issues?|steps?)/i,
      /\b(more\s+to\s+do|still\s+have\s+to|yet\s+to\s+be\s+done)/i,
      /\b(blocker|blocked\s+by|waiting\s+(for|on)|depends?\s+on)/i,

      // === ERROR/FAILURE STATE ===
      /\b(failing|broken|erroring)\s+(tests?|builds?|checks?|validations?)/i,
      /\btests?\s+(are\s+)?(still\s+)?failing/i,
      /\b(errors?|warnings?|issues?)\s+to\s+(address|fix|resolve)/i,
      /\b(doesn'?t|isn'?t|not)\s+(work|working|functional|functioning)/i,

      // === MANUAL STEPS REQUIRED ===
      /\b(you('ll|\s+will)\s+need\s+to|manually\s+(run|configure|set|update)|requires?\s+user)/i,
      /\b(run\s+this|execute\s+the\s+following|apply\s+the\s+migration)/i,

      // === TODO/FIXME IN PROSE ===
      /\b(todo|fixme|hack|xxx):\s/i,
      /\b(need\s+to|should|must)\s+(add|implement|create|write|build|fix)\b/i,

      // === SCOPE LIMITATIONS ===
      /\b(didn'?t|did\s+not)\s+have\s+(time|chance|opportunity)/i,
      /\b(beyond|outside)\s+(the\s+)?scope/i,
      /\b(for\s+now|at\s+this\s+point|currently)\s*.{0,20}?(not|without|lacks?|missing)/i,

      // === SIMULATION/FAKE OUTPUT INDICATORS ===
      // These indicate the task wasn't actually completed - just simulated
      /\bsimulat(?:ed?|ion|ing)\b/i,
      /\bhypothetical\b/i,
      /\btheoretical(?:ly)?\s+(result|output|outcome|report)/i,
      /\bfake\s+(?:data|report|result|output)/i,
      /\bmock(?:ed|ing)?\s+(?:data|report|result|output)/i,
      /\bfor\s+(?:demonstration|demo)\s+purposes?\s+only/i,
      /\bnot\s+(?:a\s+)?real\s+(?:result|output|execution)/i,
      /\bwould\s+(?:have\s+)?be(?:en)?\s+(?:the\s+)?result/i,
      /\bif\s+(?:this|we|you)\s+(?:were|had)\s+(?:actually|really)/i,

      // === DOCUMENTATION SPAM INDICATORS ===
      // Creating markdown files instead of doing actual work
      /creat(?:ed?|ing)\s+.{0,30}?\.(md|markdown)\b/i,
      /writ(?:e|ing|ten)\s+.{0,30}?(summary|report|documentation|readme)/i,
      /\b(FINAL|COMPLETE|ULTIMATE|MASTER)_.*\.(md|markdown)\b/i,
      /\b(DEPLOYMENT|HANDOVER|SUMMARY|REPORT).*\.(md|markdown)\b/i,
      /generat(?:ed?|ing)\s+.{0,30}?(documentation|summary|report)/i,
    ];

    for (const pattern of incompletePatterns) {
      if (pattern.test(response)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if response contains simulation/fake indicators that should prevent completion.
   * Simulated results mean the task was NOT actually completed.
   */
  containsSimulationIndicators(response: string): boolean {
    const simulationPatterns = [
      /\bsimulat(?:ed?|ion|ing)\b/i,
      /\bhypothetical\b/i,
      /\btheoretical(?:ly)?\s+(?:result|output|outcome|complete)/i,
      /\bfake\s+(?:data|report|result|output)/i,
      /\bmock(?:ed|ing)?\s+(?:data|report|result|output|exercise)/i,
      /\bdummy\s+(?:data|report|result|output)/i,
      /\bpretend(?:ed|ing)?\b/i,
      /\bimaginary\b/i,
      /\bfictional\b/i,
      /\bfor\s+(?:demonstration|demo)\s+purposes?\s+only/i,
      /\bnot\s+(?:a\s+)?real\b/i,
      /\bwould\s+(?:have\s+)?be(?:en)?\s+(?:the\s+)?result/i,
      /\bsecurity\s+(?:simulation|exercise)\b/i,
    ];

    return simulationPatterns.some(pattern => pattern.test(response));
  }
}

/**
 * Create a singleton instance for the shell to use
 */
let detectorInstance: TaskCompletionDetector | null = null;

export function getTaskCompletionDetector(): TaskCompletionDetector {
  if (!detectorInstance) {
    detectorInstance = new TaskCompletionDetector();
  }
  return detectorInstance;
}

export function resetTaskCompletionDetector(): void {
  if (detectorInstance) {
    detectorInstance.reset();
  }
}
