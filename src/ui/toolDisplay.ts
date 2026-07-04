/**
 * Tool Display Formatter - Vigil CLI style
 *
 * Implements the clean, informative tool execution display that Vigil CLI uses:
 * - Tool call indicators with inline args
 * - Result summaries with status indicators
 * - Expandable content with previews
 * - Diff formatting with colors
 * - Advanced progress indicators
 * - Compact same-line displays
 */

import { formatPlan, normalizePlanItems, resolvePlanWidth, wrapPlanText } from '../utils/planFormatter.js';
import { theme, icons, progressChars, formatToolName, getToolColor } from './theme.js';
import {
  TRUNCATE,
  ELLIPSIS,
  PROGRESS,
  DISPLAY_LIMITS,
  UI_STRINGS,
  truncateString,
  calculatePercentage,
  clampPercentage,
  getCoverageColor,
  formatDurationMs,
} from './uiConstants.js';

export interface ToolCallDisplay {
  name: string;
  args: Record<string, unknown>;
  timestamp?: number;
}

export interface ToolResultDisplay {
  summary: string;
  fullOutput?: string;
  linesShown?: number;
  totalLines?: number;
  status: 'success' | 'error' | 'warning';
  duration?: number;
}

export interface DiffLine {
  lineNumber?: number;
  type: 'add' | 'remove' | 'context' | 'info';
  content: string;
}

/**
 * Format tool call display (Vigil CLI style)
 *
 * Example output:
 * ⏺ [Read] src/core/agent.ts
 * ⏺ [Search] pattern: "TODO|FIXME", output_mode: "content", head_limit: 15
 */
export function formatToolCall(
  call: ToolCallDisplay,
  options: { includePrefix?: boolean } = {}
): string {
  const includePrefix = options.includePrefix ?? true;
  const symbol = includePrefix ? `${theme.info('⏺')} ` : '';
  // Use category-specific coloring for tool names
  const toolNameDisplay = formatToolName(call.name);

  // Format args inline (only show relevant ones)
  const argsDisplay = formatInlineArgs(call.args);

  return `${symbol}${toolNameDisplay}${argsDisplay ? ` ${argsDisplay}` : ''}`;
}

/**
 * Format tool result display (Vigil CLI style)
 *
 * Example output:
 * ⎿  Read 340 lines
 * ⎿  Found 15 lines
 * ⎿  Completed
 */
export function formatToolResult(
  result: ToolResultDisplay,
  options: { includePrefix?: boolean } = {}
): string {
  const includePrefix = options.includePrefix ?? true;
  const prefix = includePrefix
    ? result.status === 'error'
      ? `${theme.error('⎿')}  `
      : `${theme.success('⎿')}  `
    : '';

  const output = `${prefix}${result.summary}`;

  return output;
}

/**
 * Format inline args for tool call display
 * Keeps it concise, shows only non-default values
 * Prioritizes important args like paths, patterns, commands
 */
function formatInlineArgs(args: Record<string, unknown>): string {
  // Priority order for different argument types
  const priorityArgs = [
    'file_path', 'path', 'pattern', 'command', 'query', 'url',
    'timeout', 'output_mode', 'glob', 'type', 'head_limit', 'offset',
  ];

  // Special handling for specific args
  const skipDefaults = new Set([
    'dangerouslyDisableSandbox',
    'run_in_background',
    'description',
  ]);

  const formattedArgs: Array<{ key: string; value: string; priority: number }> = [];

  for (const [key, value] of Object.entries(args)) {
    // Skip empty/null/undefined
    if (value === null || value === undefined || value === '') continue;

    // Skip common defaults
    if (skipDefaults.has(key)) continue;
    if (key === 'path' && value === '.') continue;
    if (key === 'format' && value === 'plain') continue;
    if (key === 'output_mode' && value === 'files_with_matches') continue;

    // Determine priority
    const priority = priorityArgs.indexOf(key);
    const actualPriority = priority === -1 ? 999 : priority;

    // Format value
    let formatted: string;
    if (key === 'timeout') {
      const numericTimeout = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(numericTimeout) && numericTimeout >= 0) {
        formatted = formatDuration(numericTimeout);
      } else {
        formatted = String(value);
      }
    } else if (typeof value === 'string') {
      // Preserve full paths/commands/patterns for copy/paste fidelity
      if (key === 'file_path' || key === 'path') {
        formatted = value;
      } else if (key === 'pattern' || key === 'query') {
        formatted = `"${value}"`;
      } else if (key === 'command') {
        formatted = `"${value}"`;
      } else {
        // Regular string truncation for less critical values
        if (value.length > TRUNCATE.DESCRIPTION) {
          formatted = `"${truncateString(value, TRUNCATE.DESCRIPTION - 2)}"`;
        } else {
          formatted = `"${value}"`;
        }
      }
    } else if (typeof value === 'boolean') {
      // Only show boolean if true (false is usually default)
      if (!value) continue;
      formatted = 'true';
    } else if (typeof value === 'number') {
      formatted = String(value);
    } else if (Array.isArray(value)) {
      // Show array length
      formatted = `[${value.length} items]`;
    } else {
      formatted = JSON.stringify(value);
    }

    formattedArgs.push({ key, value: formatted, priority: actualPriority });
  }

  // Sort by priority and limit to most important args
  formattedArgs.sort((a, b) => a.priority - b.priority);
  const displayArgs = formattedArgs.slice(0, DISPLAY_LIMITS.MAX_INLINE_ARGS);

  if (displayArgs.length === 0) {
    return '';
  }

  // Format as inline args
  const argStrings = displayArgs.map(arg => {
    // For primary args (path, pattern, command), show value directly
    if (['file_path', 'path', 'pattern', 'command', 'query', 'url'].includes(arg.key)) {
      return arg.value;
    }
    // For others, show key: value
    return `${arg.key}: ${arg.value}`;
  });

  return `(${argStrings.join(', ')})`;
}

/**
 * Preserve full paths for display (no ellipsis)
 * Ensures copy/paste fidelity for tooling output.
 */
function truncatePathForDisplay(path: string, _maxLength: number): string {
  return path;
}

/**
 * Format expandable content preview
 *
 * Example:
 * import { foo } from 'bar';
 * … +312 lines
 */
export function formatExpandablePreview(
  content: string,
  maxLines: number = DISPLAY_LIMITS.PREVIEW_LINES
): {
  preview: string;
  isExpanded: boolean;
  totalLines: number;
} {
  // Input validation
  if (!content || maxLines < 1) {
    return { preview: '', isExpanded: true, totalLines: 0 };
  }

  const lines = content.split('\n');
  const totalLines = lines.length;

  if (totalLines <= maxLines) {
    return {
      preview: content,
      isExpanded: true,
      totalLines,
    };
  }

  // Show first N lines
  const previewLines = lines.slice(0, maxLines);
  const remainingLines = totalLines - maxLines;

  const expandHint = theme.ui.muted(`${ELLIPSIS} +${remainingLines} lines (${UI_STRINGS.EXPAND_HINT})`);

  previewLines.push(`${expandHint}`);

  return {
    preview: previewLines.join('\n'),
    isExpanded: false,
    totalLines,
  };
}

/**
 * Format diff output (Vigil CLI style)
 *
 * Example:
 * Update(src/core/agent.ts)
 * ⎿  Updated src/core/agent.ts with 2 additions and 1 removal
 *     75    private async processConversation(): Promise<string> {
 *     76      while (true) {
 *     77 -      this.pruneMessagesIfNeeded();
 *     77 +      await this.pruneMessagesIfNeeded();
 *     78
 */
export function formatDiff(diff: DiffLine[]): string {
  const lines: string[] = [];

    for (const line of diff) {
      let formatted: string;

      switch (line.type) {
        case 'add': {
          // Green + with line number
          const addNum = line.lineNumber ? theme.ui.muted(String(line.lineNumber).padStart(6)) : '      ';
          const addSymbol = theme.diff.added('+');
          const addContent = theme.diff.added(line.content);
          formatted = `${addNum} ${addSymbol}  ${addContent}`;
          break;
        }

        case 'remove': {
          // Red - with line number
          const remNum = line.lineNumber ? theme.ui.muted(String(line.lineNumber).padStart(6)) : '      ';
          const remSymbol = theme.diff.removed('-');
          const remContent = theme.diff.removed(line.content);
          formatted = `${remNum} ${remSymbol}  ${remContent}`;
          break;
        }

        case 'context': {
          // Gray line number, regular content
          const ctxNum = line.lineNumber ? theme.ui.muted(String(line.lineNumber).padStart(6)) : '      ';
          formatted = `${ctxNum}    ${line.content}`;
          break;
        }

        case 'info': {
          // Special info line (file headers, etc.)
          formatted = theme.diff.header(line.content);
          break;
        }
      }

      lines.push(formatted);
    }

  return lines.join('\n');
}

/**
 * Format diff summary
 * Example: "Updated src/core/agent.ts with 2 additions and 1 removal"
 */
export function formatDiffSummary(file: string, additions: number, removals: number): string {
  const parts: string[] = ['Updated', file, 'with'];

  if (additions > 0) {
    parts.push(theme.diff.added(`${additions} addition${additions === 1 ? '' : 's'}`));
  }

  if (removals > 0) {
    if (additions > 0) {
      parts.push('and');
    }
    parts.push(theme.diff.removed(`${removals} removal${removals === 1 ? '' : 's'}`));
  }

  return parts.join(' ');
}

/**
 * Box drawing characters for advanced edit display
 */
const BOX = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  leftT: '├',
  rightT: '┤',
  cross: '┼',
};

/**
 * Format edit result with advanced graphics
 * Creates a visually distinct, easy-to-read display for file edits
 *
 * Example output:
 * ╭──────────────────────────────────────────────────────────╮
 * │  ✏️  EDIT  src/core/agent.ts                              │
 * ├──────────────────────────────────────────────────────────┤
 * │  77 │ -      this.pruneMessagesIfNeeded();               │
 * │  77 │ +      await this.pruneMessagesIfNeeded();         │
 * ├──────────────────────────────────────────────────────────┤
 * │  📊 Summary: +1 line, -1 line                            │
 * ╰──────────────────────────────────────────────────────────╯
 */
export function formatAdvancedEdit(
  filePath: string,
  oldString: string,
  newString: string,
  options: { lineNumber?: number; maxWidth?: number; replaceAll?: boolean } = {}
): string {
  const maxWidth = options.maxWidth ?? 70;
  const lineNum = options.lineNumber ?? 0;
  const lines: string[] = [];

  // Truncate file path if needed
  const displayPath = filePath.length > maxWidth - 20
    ? '...' + filePath.slice(-(maxWidth - 23))
    : filePath;

  // Calculate content widths
  const innerWidth = maxWidth - 4; // Account for box borders and padding

  // Helper to pad/truncate lines
  const padLine = (content: string, width: number): string => {
    const stripped = stripAnsi(content);
    if (stripped.length >= width) {
      return content.slice(0, width - 3) + '...';
    }
    return content + ' '.repeat(width - stripped.length);
  };

  // Top border with header
  const topBorder = `${BOX.topLeft}${BOX.horizontal.repeat(maxWidth - 2)}${BOX.topRight}`;
  lines.push(theme.edit.separator(topBorder));

  // Header line with file path
  const headerIcon = '✏️ ';
  const badge = theme.edit.badge(' EDIT ');
  const pathDisplay = theme.edit.filePath(displayPath);
  const replaceAllNote = options.replaceAll ? theme.ui.muted(' (all occurrences)') : '';
  const headerContent = `${headerIcon}${badge} ${pathDisplay}${replaceAllNote}`;
  const headerPadded = padLine(headerContent, innerWidth);
  lines.push(`${theme.edit.separator(BOX.vertical)} ${headerPadded} ${theme.edit.separator(BOX.vertical)}`);

  // Separator
  const separator = `${BOX.leftT}${BOX.horizontal.repeat(maxWidth - 2)}${BOX.rightT}`;
  lines.push(theme.edit.separator(separator));

  // Process removed lines
  const oldLines = oldString.split('\n');
  const newLines = newString.split('\n');

  // Show removed lines (old content)
  for (let i = 0; i < oldLines.length; i++) {
    const lineNo = lineNum > 0 ? String(lineNum + i).padStart(4) : '    ';
    const lineContent = oldLines[i] || '';
    const truncated = lineContent.length > innerWidth - 12
      ? lineContent.slice(0, innerWidth - 15) + '...'
      : lineContent;

    const lineNumDisplay = theme.edit.lineNumber(lineNo);
    const symbol = theme.edit.removedLine('−');
    const content = theme.edit.removedBg(` ${truncated} `);

    const fullLine = `${lineNumDisplay} ${theme.edit.separator('│')} ${symbol} ${content}`;
    const padded = padLine(fullLine, innerWidth);
    lines.push(`${theme.edit.separator(BOX.vertical)} ${padded} ${theme.edit.separator(BOX.vertical)}`);
  }

  // Visual separator between old and new
  if (oldLines.length > 0 && newLines.length > 0) {
    const arrowLine = '     ' + theme.edit.separator('│') + ' ' + theme.ui.muted('↓'.repeat(Math.min(20, innerWidth - 10)));
    const arrowPadded = padLine(arrowLine, innerWidth);
    lines.push(`${theme.edit.separator(BOX.vertical)} ${arrowPadded} ${theme.edit.separator(BOX.vertical)}`);
  }

  // Show added lines (new content)
  for (let i = 0; i < newLines.length; i++) {
    const lineNo = lineNum > 0 ? String(lineNum + i).padStart(4) : '    ';
    const lineContent = newLines[i] || '';
    const truncated = lineContent.length > innerWidth - 12
      ? lineContent.slice(0, innerWidth - 15) + '...'
      : lineContent;

    const lineNumDisplay = theme.edit.lineNumber(lineNo);
    const symbol = theme.edit.addedLine('+');
    const content = theme.edit.addedBg(` ${truncated} `);

    const fullLine = `${lineNumDisplay} ${theme.edit.separator('│')} ${symbol} ${content}`;
    const padded = padLine(fullLine, innerWidth);
    lines.push(`${theme.edit.separator(BOX.vertical)} ${padded} ${theme.edit.separator(BOX.vertical)}`);
  }

  // Summary separator
  lines.push(theme.edit.separator(separator));

  // Summary line
  const addCount = newLines.length;
  const removeCount = oldLines.length;
  const summaryIcon = '📊';
  const addText = addCount > 0 ? theme.diff.added(`+${addCount}`) : '';
  const removeText = removeCount > 0 ? theme.diff.removed(`−${removeCount}`) : '';
  const summaryParts = [addText, removeText].filter(Boolean).join(theme.ui.muted(', '));
  const summaryContent = `${summaryIcon} ${theme.edit.summary('Summary:')} ${summaryParts} ${theme.ui.muted('lines')}`;
  const summaryPadded = padLine(summaryContent, innerWidth);
  lines.push(`${theme.edit.separator(BOX.vertical)} ${summaryPadded} ${theme.edit.separator(BOX.vertical)}`);

  // Bottom border
  const bottomBorder = `${BOX.bottomLeft}${BOX.horizontal.repeat(maxWidth - 2)}${BOX.bottomRight}`;
  lines.push(theme.edit.separator(bottomBorder));

  return lines.join('\n');
}

/**
 * Strip ANSI escape codes from a string
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Format a compact inline edit summary
 * For when the full box display is too verbose
 *
 * Example: "✏️ src/file.ts:42 • +3 −2 lines"
 */
export function formatCompactEdit(
  filePath: string,
  lineNumber: number,
  additions: number,
  removals: number
): string {
  const icon = '✏️';
  const path = theme.edit.filePath(filePath);
  const lineNo = lineNumber > 0 ? theme.edit.lineNumber(`:${lineNumber}`) : '';
  const add = additions > 0 ? theme.diff.added(`+${additions}`) : '';
  const remove = removals > 0 ? theme.diff.removed(`−${removals}`) : '';
  const changes = [add, remove].filter(Boolean).join(' ');

  return `${icon} ${path}${lineNo} ${theme.ui.muted('•')} ${changes} ${theme.ui.muted('lines')}`;
}

/**
 * Format multiline content with indentation (Vigil CLI style)
 *
 * Adds proper indentation and line wrapping
 */
export function formatIndentedContent(content: string, indent: number = 4): string {
  const lines = content.split('\n');
  const indentStr = ' '.repeat(indent);

  return lines.map(line => `${indentStr}${line}`).join('\n');
}

/**
 * Format token usage indicator
 * Example: "• Context 5% used (7.2k tokens)"
 */
export function formatTokenUsage(percentage: number, tokens?: number): string {
  const bullet = theme.info('•');

  let pct: string;
  if (percentage >= 90) {
    pct = theme.error(`${percentage}%`);
  } else if (percentage >= 70) {
    pct = theme.warning(`${percentage}%`);
  } else {
    pct = theme.success(`${percentage}%`);
  }

  const tokensStr = tokens ? ` (${formatTokenCount(tokens)} tokens)` : '';

  return `${bullet} Context ${pct} used${tokensStr}`;
}

/**
 * Format token count with k/M suffixes
 */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

/**
 * Format timing information
 * Example: "(1m 43s)" or "(250ms)"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${seconds}s`;
}

/**
 * Create a "thinking" indicator
 * Example: "∴ Thinking…" or "∴ Thought for 2s"
 */
export function formatThinking(durationMs?: number, _hasContent: boolean = false): string {
  const symbol = theme.info('∴');

  if (durationMs === undefined) {
    return `${symbol} Thinking…`;
  }

  const duration = formatDuration(durationMs);

  return `${symbol} Thought for ${duration}`;
}

/**
 * Format status line at bottom
 * Example: "• Ready for prompts (250ms)"
 */
export function formatStatusLine(message: string, durationMs?: number, tokenUsage?: {
  percentage: number;
  tokens?: number;
}): string {
  const parts: string[] = [];

  // Add token usage first if available
  if (tokenUsage) {
    parts.push(formatTokenUsage(tokenUsage.percentage, tokenUsage.tokens));
  }

  // Add message with duration
  const duration = durationMs ? ` (${formatDuration(durationMs)})` : '';
  parts.push(message + duration);

  return parts.join(' · ');
}

/**
 * Smart truncate for shell commands
 * Preserves important parts like command name and key flags
 */
export function truncateCommand(command: string, _maxLength: number = 2000): string {
  // Show the full command; rely on terminal width to wrap.
  return command;
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Format JSON output with syntax highlighting
 */
export function formatJSON(data: unknown, compact = false): string {
  const json = JSON.stringify(data, null, compact ? 0 : 2);

  // Add basic syntax highlighting
  return json
    .replace(/"([^"]+)":/g, (_, key) => `${theme.info(`"${key}"`)}: `) // Keys in blue
    .replace(/: "([^"]*)"/g, (_, value) => `: ${theme.success(`"${value}"`)}`) // String values in green
    .replace(/: (\d+\.?\d*)/g, (_, num) => `: ${theme.warning(num)}`) // Numbers in amber
    .replace(/: (true|false|null)/g, (_, bool) => `: ${theme.secondary(bool)}`); // Booleans in purple
}

/**
 * Format a list of items (Vigil CLI style)
 * Example:
 *   • Item 1
 *   • Item 2
 *   • Item 3
 */
export function formatList(items: string[], bullet = '•'): string {
  return items.map(item => `  ${theme.info(bullet)} ${item}`).join('\n');
}

/**
 * Format a key-value pair (Vigil CLI style)
 */
export function formatKeyValue(key: string, value: string): string {
  return `${theme.ui.muted(key)}: ${value}`;
}

// ============================================================================
// TOOL RESULT SUMMARY SYSTEM
// Centralized display for all tool results - extend this for new tools
// ============================================================================

export interface ToolResultSummaryInput {
  toolName: string;
  args: Record<string, unknown>;
  output: string;
  success: boolean;
  durationMs?: number;
}

/**
 * Format a tool result summary for display in the terminal.
 * This is the central function for displaying ALL tool results.
 *
 * To add support for a new tool:
 * 1. Add a case in the switch statement below
 * 2. Create a format function for that tool type
 *
 * @returns Formatted string to display, or null if no display needed
 */
export function formatToolResultSummary(input: ToolResultSummaryInput): string | null {
  const { toolName, args, output, success, durationMs } = input;

  // Determine tool category and format accordingly
  switch (toolName) {
    // === FILE OPERATIONS ===
    case 'Edit':
    case 'edit_file':
      // These already return formatted diff output from editTools.ts
      return output;

    // === BASH/COMMAND EXECUTION ===
    case 'Bash':
    case 'bash':
    case 'execute_bash':
    case 'execute_command':
      return formatBashResult(args, output, success, durationMs);

    // === BACKGROUND BASH ===
    case 'BashOutput':
      return formatBashOutputResult(args, output, success);
    case 'KillShell':
      return formatKillShellResult(args, output, success);

    // === FILE READING ===
    case 'Read':
    case 'read_file':
      return formatReadResult(args, output, success);

    // === SEARCH OPERATIONS ===
    case 'Grep':
    case 'grep':
    case 'grep_search':
    case 'search_text':
    case 'search_files':
      return formatGrepResult(args, output, success);

    case 'Glob':
    case 'glob':
      return formatGlobResult(args, output, success);

    case 'list_files':
      return formatListFilesResult(args, output, success);

    case 'find_definition':
      return formatFindDefinitionResult(args, output, success);

    // === WEB OPERATIONS ===
    case 'WebFetch':
    case 'web_fetch':
      return formatWebFetchResult(args, output, success);

    case 'WebSearch':
    case 'web_search':
      return formatWebSearchResult(args, output, success);

    case 'WebExtract':
      return formatWebExtractResult(args, output, success);

    // === TASK/AGENT OPERATIONS ===
    case 'Task':
    case 'task':
      return formatTaskResult(args, output, success);

    // === TODO OPERATIONS ===
    case 'TodoWrite':
    case 'todo_write':
      return formatTodoResult(args, output, success);

    // === NOTEBOOK OPERATIONS ===
    case 'NotebookEdit':
    case 'notebook_edit':
      return formatNotebookResult(args, output, success);

    // === USER INTERACTION ===
    case 'AskUserQuestion':
      return formatAskUserResult(args, output, success);

    // === DEV TOOLS ===
    case 'run_tests':
      return formatTestResult(args, output, success, durationMs);
    case 'run_build':
      return formatBuildResult(args, output, success, durationMs);
    case 'install_dependencies':
      return formatInstallResult(args, output, success, durationMs);
    case 'check_package_info':
      return formatPackageInfoResult(args, output, success);

    // === GIT OPERATIONS ===
    case 'git_release':
    case 'git_sync':
    case 'git_cleanup':
      return formatGitResult(toolName, args, output, success);

    // === DOCKER ===
    case 'docker_build':
    case 'docker_compose':
      return formatDockerResult(toolName, args, output, success, durationMs);

    // === CODE ANALYSIS ===
    case 'analyze_code_structure':
    case 'find_dependencies':
    case 'check_code_complexity':
    case 'advanced_ast_analysis':
    case 'analyze_code_complexity':
    case 'suggest_refactoring':
    case 'generate_code_quality_report':
      return formatCodeAnalysisResult(toolName, args, output, success);

    // === TESTING TOOLS ===
    case 'generate_test_templates':
    case 'run_coverage_analysis':
    case 'summarize_coverage_report':
    case 'analyze_test_coverage':
    case 'generate_comprehensive_tests':
      return formatTestingToolResult(toolName, args, output, success);

    // === LINT/QUALITY ===
    case 'run_lint_checks':
    case 'inspect_code_quality':
    case 'list_lint_rules':
      return formatLintResult(toolName, args, output, success);

    // === CLOUD DEPLOY ===
    case 'cloud_status':
    case 'cloud_deploy':
    case 'cloud_init':
    case 'cloud_login':
    case 'firebase_deploy':
    case 'aliyun_deploy':
      return formatCloudResult(toolName, args, output, success);

    // === BROWSER AUTOMATION ===
    case 'browser_create_session':
    case 'browser_navigate':
    case 'browser_click':
    case 'browser_type':
    case 'browser_screenshot':
    case 'browser_close_session':
      return formatBrowserResult(toolName, args, output, success);

    // === EMAIL ===
    case 'send_email':
    case 'send_batch_emails':
    case 'verify_email_config':
      return formatEmailResult(toolName, args, output, success);

    // === SKILLS ===
    case 'ListSkills':
    case 'Skill':
      return formatSkillResult(toolName, args, output, success);

    // === PLANNING ===
    case 'UpdatePlan':
      return formatPlanUpdateResult(args, output, success);
    case 'ExitPlanMode':
      return formatPlanModeResult(args, output, success);

    // === REPO CHECKS ===
    case 'run_repo_checks':
      return formatRepoChecksResult(args, output, success);

    // === LEARNING & EXPLORATION ===
    case 'learn_codebase':
    case 'learn_file':
    case 'learn_topic':
    case 'learn_summary':
    case 'explore':
    case 'explore_index':
      return formatLearnResult(toolName, args, output, success);

    // === DEFAULT: Unknown tools ===
    default:
      // For unknown tools, show a generic summary if output is non-empty
      return formatGenericToolResult(toolName, output, success, durationMs);
  }
}

/**
 * Format Bash command result
 * Shows: command executed, exit status, and output preview
 */
function formatBashResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean,
  durationMs?: number
): string {
  const command = (args['command'] as string) || '';
  const description = args['description'] as string | undefined;
  const lines: string[] = [];

  // Header with command
  const statusIcon = success ? theme.success('✓') : theme.error('✗');
  const cmdDisplay = truncateCommand(command);
  const durationStr = durationMs ? ` ${theme.ui.muted(`(${formatDuration(durationMs)})`)}` : '';

  if (description) {
    lines.push(`${statusIcon} ${description}${durationStr}`);
    lines.push(`  ${theme.ui.muted('$')} ${theme.dim(cmdDisplay)}`);
  } else {
    lines.push(`${statusIcon} ${theme.ui.muted('$')} ${cmdDisplay}${durationStr}`);
  }

  // Output preview (max 5 lines)
  if (output && output.trim()) {
    const outputLines = output.trim().split('\n');
    const maxPreviewLines = 5;
    const previewLines = outputLines.slice(0, maxPreviewLines);
    const lineFormatter = success ? theme.dim : theme.error;

    for (const line of previewLines) {
      // Truncate long lines
      lines.push(`  ${lineFormatter(line)}`);
    }

    if (outputLines.length > maxPreviewLines) {
      const remaining = outputLines.length - maxPreviewLines;
      lines.push(`  ${theme.ui.muted(`... +${remaining} more line${remaining === 1 ? '' : 's'}`)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format Read file result
 * Shows: file path and line count
 */
function formatReadResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const filePath = (args['file_path'] || args['path']) as string || '';
  const displayPath = truncatePathForDisplay(filePath, 50);

  if (!success) {
    return `${theme.error('✗')} Failed to read ${displayPath}`;
  }

  const lineCount = output.split('\n').length;
  return `${theme.success('✓')} Read ${theme.info(displayPath)} ${theme.ui.muted(`(${lineCount} lines)`)}`;
}

/**
 * Format Grep search result
 * Shows: pattern, matches found, and file list preview
 */
function formatGrepResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const pattern = (args['pattern'] as string) || '';
  const patternDisplay = pattern.length > 30 ? `${pattern.slice(0, 27)}...` : pattern;
  const lines: string[] = [];

  if (!success || !output.trim()) {
    lines.push(`${theme.warning('○')} No matches for "${patternDisplay}"`);
    return lines.join('\n');
  }

  // Count matches/files
  const outputLines = output.trim().split('\n').filter(l => l.trim());
  const matchCount = outputLines.length;

  lines.push(`${theme.success('✓')} Found ${theme.info(String(matchCount))} match${matchCount === 1 ? '' : 'es'} for "${patternDisplay}"`);

  // Show first few matches
  const maxPreview = 3;
  for (let i = 0; i < Math.min(maxPreview, outputLines.length); i++) {
    const line = outputLines[i] || '';
    const truncated = line.length > 70 ? `${line.slice(0, 67)}...` : line;
    lines.push(`  ${theme.dim(truncated)}`);
  }

  if (matchCount > maxPreview) {
    lines.push(`  ${theme.ui.muted(`... +${matchCount - maxPreview} more`)}`);
  }

  return lines.join('\n');
}

/**
 * Format Glob file search result
 * Shows: pattern and files found
 */
function formatGlobResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const pattern = (args['pattern'] as string) || '*';
  const lines: string[] = [];

  if (!success || !output.trim()) {
    lines.push(`${theme.warning('○')} No files matching "${pattern}"`);
    return lines.join('\n');
  }

  const files = output.trim().split('\n').filter(f => f.trim());
  const fileCount = files.length;

  lines.push(`${theme.success('✓')} Found ${theme.info(String(fileCount))} file${fileCount === 1 ? '' : 's'} matching "${pattern}"`);

  // Show first few files
  const maxPreview = 4;
  for (let i = 0; i < Math.min(maxPreview, files.length); i++) {
    const file = files[i] || '';
    lines.push(`  ${theme.dim(truncatePathForDisplay(file, 60))}`);
  }

  if (fileCount > maxPreview) {
    lines.push(`  ${theme.ui.muted(`... +${fileCount - maxPreview} more`)}`);
  }

  return lines.join('\n');
}

/**
 * Format list_files result
 * Shows: directory and item count (no noisy listing)
 */
function formatListFilesResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const path = (args['path'] as string) || '.';
  const displayPath = truncatePathForDisplay(path, 60);

  if (!success) {
    const firstLine = output.trim().split('\n')[0] || 'Failed to list files';
    const truncated = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
    return `${theme.error('✗')} ${truncated}`;
  }

  const items = output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const count = items.length;
  const countLabel = `${count} item${count === 1 ? '' : 's'}`;
  return `${theme.success('✓')} Listed ${theme.info(countLabel)} in ${theme.ui.muted(displayPath)}`;
}

/**
 * Format WebFetch result
 * Shows: URL and content summary
 */
function formatWebFetchResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const url = (args['url'] as string) || '';
  let hostname = url;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Keep original URL if parsing fails
  }

  if (!success) {
    return `${theme.error('✗')} Failed to fetch ${hostname}`;
  }

  const contentLength = output.length;
  const sizeStr = formatFileSize(contentLength);
  return `${theme.success('✓')} Fetched ${theme.info(hostname)} ${theme.ui.muted(`(${sizeStr})`)}`;
}

/**
 * Format WebSearch result
 * Shows: query and result count
 */
function formatWebSearchResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const query = (args['query'] as string) || '';
  const queryDisplay = query.length > 40 ? `${query.slice(0, 37)}...` : query;

  if (!success) {
    return `${theme.error('✗')} Search failed for "${queryDisplay}"`;
  }

  // Try to count results from output
  const resultMatches = output.match(/^\d+\./gm);
  const resultCount = resultMatches ? resultMatches.length : 'multiple';

  return `${theme.success('✓')} Found ${theme.info(String(resultCount))} results for "${queryDisplay}"`;
}

/**
 * Format Task/Agent result
 * Shows: task description and completion status
 */
function formatTaskResult(
  args: Record<string, unknown>,
  _output: string,
  success: boolean
): string {
  const description = (args['description'] as string) || 'Task';
  const truncatedDesc = description.length > 50 ? `${description.slice(0, 47)}...` : description;

  if (!success) {
    return `${theme.error('✗')} Task failed: ${truncatedDesc}`;
  }

  return `${theme.success('✓')} Completed: ${truncatedDesc}`;
}

/**
 * Format TodoWrite result
 * Shows: todo list update summary
 */
function formatTodoResult(
  args: Record<string, unknown>,
  _output: string,
  success: boolean
): string {
  const todos = args['todos'] as Array<{ status: string }> | undefined;

  if (!success) {
    return `${theme.error('✗')} Failed to update todo list`;
  }

  if (!todos || !Array.isArray(todos)) {
    return `${theme.success('✓')} Todo list updated`;
  }

  const completed = todos.filter(t => t.status === 'completed').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;
  const pending = todos.filter(t => t.status === 'pending').length;

  const parts: string[] = [`${theme.success('✓')} Todos:`];
  if (completed > 0) parts.push(theme.success(`${completed} done`));
  if (inProgress > 0) parts.push(theme.warning(`${inProgress} active`));
  if (pending > 0) parts.push(theme.dim(`${pending} pending`));

  return parts.join(' ');
}

/**
 * Format NotebookEdit result
 * Shows: notebook and cell info
 */
function formatNotebookResult(
  args: Record<string, unknown>,
  _output: string,
  success: boolean
): string {
  const notebookPath = (args['notebook_path'] as string) || '';
  const editMode = (args['edit_mode'] as string) || 'replace';
  const displayPath = truncatePathForDisplay(notebookPath, 40);

  if (!success) {
    return `${theme.error('✗')} Failed to edit notebook ${displayPath}`;
  }

  const action = editMode === 'insert' ? 'Inserted cell in' : editMode === 'delete' ? 'Deleted cell from' : 'Updated';
  return `${theme.success('✓')} ${action} ${theme.info(displayPath)}`;
}

/**
 * Format generic/unknown tool result
 * Provides a basic summary for tools not explicitly handled
 */
function formatGenericToolResult(
  toolName: string,
  output: string,
  success: boolean,
  durationMs?: number
): string {
  const statusIcon = success ? theme.success('✓') : theme.error('✗');
  const durationStr = durationMs ? ` ${theme.ui.muted(`(${formatDuration(durationMs)})`)}` : '';

  if (!output || !output.trim()) {
    return `${statusIcon} ${toolName} completed${durationStr}`;
  }

  const lineCount = output.split('\n').length;
  return `${statusIcon} ${toolName} completed ${theme.ui.muted(`(${lineCount} lines)`)}${durationStr}`;
}

// ============================================================================
// ADDITIONAL TOOL FORMATTERS
// ============================================================================

/**
 * Format BashOutput (background shell) result
 */
function formatBashOutputResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const shellId = (args['bash_id'] || args['shell_id']) as string || '';
  const lines: string[] = [];

  if (!success) {
    return `${theme.error('✗')} Failed to get output from shell ${shellId}`;
  }

  const outputLines = output.trim().split('\n').filter(l => l);
  const lineCount = outputLines.length;

  lines.push(`${theme.success('✓')} Shell ${theme.info(shellId)} ${theme.ui.muted(`(${lineCount} lines)`)}`);

  // Show preview
  const maxPreview = 3;
  for (let i = 0; i < Math.min(maxPreview, outputLines.length); i++) {
    const line = outputLines[i] || '';
    const truncated = line.length > 70 ? `${line.slice(0, 67)}...` : line;
    lines.push(`  ${theme.dim(truncated)}`);
  }

  if (lineCount > maxPreview) {
    lines.push(`  ${theme.ui.muted(`... +${lineCount - maxPreview} more`)}`);
  }

  return lines.join('\n');
}

/**
 * Format KillShell result
 */
function formatKillShellResult(
  args: Record<string, unknown>,
  _output: string,
  success: boolean
): string {
  const shellId = (args['shell_id']) as string || '';

  if (!success) {
    return `${theme.error('✗')} Failed to kill shell ${shellId}`;
  }

  return `${theme.success('✓')} Killed shell ${theme.info(shellId)}`;
}

/**
 * Format find_definition result
 */
function formatFindDefinitionResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const symbol = (args['symbol'] || args['name']) as string || '';

  if (!success || !output.trim()) {
    return `${theme.warning('○')} Definition not found: ${symbol}`;
  }

  const locations = output.trim().split('\n').filter(l => l);
  return `${theme.success('✓')} Found ${theme.info(String(locations.length))} definition${locations.length === 1 ? '' : 's'} for "${symbol}"`;
}

/**
 * Format WebExtract result
 */
function formatWebExtractResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const url = (args['url'] as string) || '';
  let hostname = url;
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Keep original
  }

  if (!success) {
    return `${theme.error('✗')} Failed to extract from ${hostname}`;
  }

  const contentLength = output.length;
  return `${theme.success('✓')} Extracted from ${theme.info(hostname)} ${theme.ui.muted(`(${formatFileSize(contentLength)})`)}`;
}

/**
 * Format AskUserQuestion result
 */
function formatAskUserResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const questions = args['questions'] as Array<{ question: string }> | undefined;
  const questionCount = questions?.length || 1;

  if (!success) {
    return `${theme.error('✗')} Failed to ask user`;
  }

  if (output.includes('answer') || output.includes('response')) {
    return `${theme.success('✓')} User responded`;
  }

  return `${theme.info('?')} Asked ${questionCount} question${questionCount === 1 ? '' : 's'}`;
}

/**
 * Format test run result
 */
function formatTestResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean,
  durationMs?: number
): string {
  const testPattern = (args['pattern'] || args['filter']) as string | undefined;
  const lines: string[] = [];
  const durationStr = durationMs ? ` ${theme.ui.muted(`(${formatDuration(durationMs)})`)}` : '';

  // Try to extract test counts from output
  const passMatch = output.match(/(\d+)\s*(?:passing|passed|✓)/i);
  const failMatch = output.match(/(\d+)\s*(?:failing|failed|✗)/i);
  const skipMatch = output.match(/(\d+)\s*(?:skipped|pending)/i);

  const passed = passMatch ? parseInt(passMatch[1] || '0', 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1] || '0', 10) : 0;
  const skipped = skipMatch ? parseInt(skipMatch[1] || '0', 10) : 0;

  const statusIcon = success && failed === 0 ? theme.success('✓') : theme.error('✗');

  let summary = `${statusIcon} Tests`;
  if (testPattern) {
    summary += ` "${testPattern}"`;
  }
  summary += durationStr;
  lines.push(summary);

  // Show counts
  const counts: string[] = [];
  if (passed > 0) counts.push(theme.success(`${passed} passed`));
  if (failed > 0) counts.push(theme.error(`${failed} failed`));
  if (skipped > 0) counts.push(theme.warning(`${skipped} skipped`));

  if (counts.length > 0) {
    lines.push(`  ${counts.join(', ')}`);
  }

  // Show first error if failed
  if (!success && failed > 0) {
    const errorMatch = output.match(/(?:Error|FAIL|✗).*?:(.*?)(?:\n|$)/i);
    if (errorMatch && errorMatch[1]) {
      const errorMsg = errorMatch[1].trim().slice(0, 60);
      lines.push(`  ${theme.error(errorMsg)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format build result
 */
function formatBuildResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean,
  durationMs?: number
): string {
  const target = (args['target'] || args['script']) as string | undefined;
  const durationStr = durationMs ? ` ${theme.ui.muted(`(${formatDuration(durationMs)})`)}` : '';

  if (!success) {
    // Try to extract error count
    const errorMatches = output.match(/error/gi);
    const errorCount = errorMatches ? errorMatches.length : 0;

    if (errorCount > 0) {
      return `${theme.error('✗')} Build failed with ${errorCount} error${errorCount === 1 ? '' : 's'}${durationStr}`;
    }
    return `${theme.error('✗')} Build failed${durationStr}`;
  }

  const label = target ? `Build "${target}"` : 'Build';
  return `${theme.success('✓')} ${label} succeeded${durationStr}`;
}

/**
 * Format install dependencies result
 */
function formatInstallResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean,
  durationMs?: number
): string {
  const packages = args['packages'] as string[] | string | undefined;
  const durationStr = durationMs ? ` ${theme.ui.muted(`(${formatDuration(durationMs)})`)}` : '';

  if (!success) {
    return `${theme.error('✗')} Install failed${durationStr}`;
  }

  // Try to extract package count from output
  const addedMatch = output.match(/added\s+(\d+)\s+packages?/i);
  const packageCount = addedMatch ? addedMatch[1] : null;

  let summary = `${theme.success('✓')} Dependencies installed`;
  if (packageCount) {
    summary += ` ${theme.ui.muted(`(${packageCount} packages)`)}`;
  } else if (packages) {
    const pkgList = Array.isArray(packages) ? packages : [packages];
    summary += ` ${theme.ui.muted(`(${pkgList.length} packages)`)}`;
  }
  summary += durationStr;

  return summary;
}

/**
 * Format package info result
 */
function formatPackageInfoResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const packageName = (args['package'] || args['name']) as string || '';

  if (!success) {
    return `${theme.error('✗')} Package info failed for ${packageName}`;
  }

  // Try to extract version
  const versionMatch = output.match(/version[:\s]+["']?([^"'\s\n]+)/i);
  const version = versionMatch ? versionMatch[1] : null;

  if (version) {
    return `${theme.success('✓')} ${theme.info(packageName)}@${version}`;
  }

  return `${theme.success('✓')} Package info: ${theme.info(packageName)}`;
}

/**
 * Format git operation result
 */
function formatGitResult(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const action = toolName.replace('git_', '');

  if (!success) {
    return `${theme.error('✗')} Git ${action} failed`;
  }

  switch (toolName) {
    case 'git_release': {
      const version = (args['version'] || args['tag']) as string | undefined;
      if (version) {
        return `${theme.success('✓')} Released ${theme.info(version)}`;
      }
      return `${theme.success('✓')} Release created`;
    }
    case 'git_sync': {
      // Try to extract ahead/behind from output
      const aheadMatch = output.match(/(\d+)\s+commit.*ahead/i);
      const behindMatch = output.match(/(\d+)\s+commit.*behind/i);
      const parts: string[] = [];
      if (aheadMatch) parts.push(`${aheadMatch[1]} ahead`);
      if (behindMatch) parts.push(`${behindMatch[1]} behind`);
      if (parts.length > 0) {
        return `${theme.success('✓')} Synced ${theme.ui.muted(`(${parts.join(', ')})`)}`;
      }
      return `${theme.success('✓')} Git synced`;
    }
    case 'git_cleanup': {
      const branchMatch = output.match(/deleted.*?(\d+)/i);
      if (branchMatch) {
        return `${theme.success('✓')} Cleaned up ${branchMatch[1]} branches`;
      }
      return `${theme.success('✓')} Git cleanup completed`;
    }
    default:
      return `${theme.success('✓')} Git ${action} completed`;
  }
}

/**
 * Format docker result
 */
function formatDockerResult(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  success: boolean,
  durationMs?: number
): string {
  const durationStr = durationMs ? ` ${theme.ui.muted(`(${formatDuration(durationMs)})`)}` : '';

  if (!success) {
    return `${theme.error('✗')} Docker ${toolName.replace('docker_', '')} failed${durationStr}`;
  }

  switch (toolName) {
    case 'docker_build': {
      const tag = (args['tag'] || args['image']) as string | undefined;
      // Try to extract image ID from output
      const imageMatch = output.match(/(?:Successfully built|sha256:)\s*([a-f0-9]{12})/i);
      if (tag) {
        return `${theme.success('✓')} Built image ${theme.info(tag)}${durationStr}`;
      }
      if (imageMatch) {
        return `${theme.success('✓')} Built image ${theme.info(imageMatch[1] || '')}${durationStr}`;
      }
      return `${theme.success('✓')} Docker build completed${durationStr}`;
    }
    case 'docker_compose': {
      const action = (args['action'] || args['command']) as string || 'up';
      return `${theme.success('✓')} Docker compose ${action}${durationStr}`;
    }
    default:
      return `${theme.success('✓')} Docker operation completed${durationStr}`;
  }
}

/**
 * Format code analysis result
 */
function formatCodeAnalysisResult(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const filePath = (args['file_path'] || args['path'] || args['file']) as string | undefined;
  const displayPath = filePath ? truncatePathForDisplay(filePath, 40) : '';

  if (!success) {
    return `${theme.error('✗')} Analysis failed${displayPath ? ` for ${displayPath}` : ''}`;
  }

  const toolLabels: Record<string, string> = {
    'analyze_code_structure': 'Structure analyzed',
    'find_dependencies': 'Dependencies found',
    'check_code_complexity': 'Complexity checked',
    'advanced_ast_analysis': 'AST analyzed',
    'analyze_code_complexity': 'Complexity analyzed',
    'suggest_refactoring': 'Refactoring suggestions',
    'generate_code_quality_report': 'Quality report generated',
  };

  const label = toolLabels[toolName] || 'Analysis completed';

  // Try to extract counts from output
  const issueMatch = output.match(/(\d+)\s*(?:issue|warning|suggestion)/i);
  if (issueMatch) {
    return `${theme.success('✓')} ${label}: ${issueMatch[1]} items${displayPath ? ` in ${displayPath}` : ''}`;
  }

  return `${theme.success('✓')} ${label}${displayPath ? ` for ${displayPath}` : ''}`;
}

/**
 * Format testing tool result
 */
function formatTestingToolResult(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const filePath = (args['file_path'] || args['path']) as string | undefined;
  const displayPath = filePath ? truncatePathForDisplay(filePath, 40) : '';

  if (!success) {
    return `${theme.error('✗')} ${toolName.replace(/_/g, ' ')} failed`;
  }

  switch (toolName) {
    case 'generate_test_templates': {
      const countMatch = output.match(/(\d+)\s*(?:test|template)/i);
      if (countMatch) {
        return `${theme.success('✓')} Generated ${countMatch[1]} test templates`;
      }
      return `${theme.success('✓')} Test templates generated`;
    }
    case 'run_coverage_analysis':
    case 'summarize_coverage_report': {
      const coverageMatch = output.match(/(\d+(?:\.\d+)?)\s*%/);
      if (coverageMatch) {
        const pct = clampPercentage(parseFloat(coverageMatch[1] || '0') || 0);
        const color = getCoverageColor(pct, { success: theme.success, warning: theme.warning, error: theme.error });
        return `${theme.success(UI_STRINGS.SUCCESS)} Coverage: ${color(`${pct}%`)}${displayPath ? ` for ${displayPath}` : ''}`;
      }
      return `${theme.success(UI_STRINGS.SUCCESS)} Coverage analyzed${displayPath ? ` for ${displayPath}` : ''}`;
    }
    case 'analyze_test_coverage': {
      const coverageMatch = output.match(/(\d+(?:\.\d+)?)\s*%/);
      if (coverageMatch) {
        const pct = clampPercentage(parseFloat(coverageMatch[1] || '0') || 0);
        return `${theme.success(UI_STRINGS.SUCCESS)} Test coverage: ${pct}%`;
      }
      return `${theme.success(UI_STRINGS.SUCCESS)} Test coverage analyzed`;
    }
    case 'generate_comprehensive_tests': {
      return `${theme.success('✓')} Comprehensive tests generated${displayPath ? ` for ${displayPath}` : ''}`;
    }
    default:
      return `${theme.success('✓')} Testing tool completed`;
  }
}

/**
 * Format lint result
 */
function formatLintResult(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const filePath = (args['file_path'] || args['path']) as string | undefined;
  const displayPath = filePath ? truncatePathForDisplay(filePath, 40) : '';

  // Try to extract error/warning counts
  const errorMatch = output.match(/(\d+)\s*error/i);
  const warnMatch = output.match(/(\d+)\s*warning/i);
  const errors = errorMatch ? parseInt(errorMatch[1] || '0', 10) : 0;
  const warnings = warnMatch ? parseInt(warnMatch[1] || '0', 10) : 0;

  const statusIcon = errors === 0 ? theme.success('✓') : theme.error('✗');

  switch (toolName) {
    case 'run_lint_checks': {
      let summary = `${statusIcon} Lint`;
      if (displayPath) summary += ` ${displayPath}`;

      const counts: string[] = [];
      if (errors > 0) counts.push(theme.error(`${errors} errors`));
      if (warnings > 0) counts.push(theme.warning(`${warnings} warnings`));
      if (counts.length > 0) {
        summary += `: ${counts.join(', ')}`;
      } else if (success) {
        summary += ': clean';
      }
      return summary;
    }
    case 'inspect_code_quality': {
      return `${statusIcon} Code quality inspected${displayPath ? ` for ${displayPath}` : ''}`;
    }
    case 'list_lint_rules': {
      const ruleMatch = output.match(/(\d+)\s*rule/i);
      if (ruleMatch) {
        return `${theme.success('✓')} Found ${ruleMatch[1]} lint rules`;
      }
      return `${theme.success('✓')} Lint rules listed`;
    }
    default:
      return `${statusIcon} Lint completed`;
  }
}

/**
 * Format cloud deployment result
 */
function formatCloudResult(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const provider = (args['provider'] || args['platform']) as string | undefined;

  if (!success) {
    return `${theme.error('✗')} ${toolName.replace(/_/g, ' ')} failed`;
  }

  switch (toolName) {
    case 'cloud_status': {
      return `${theme.success('✓')} Cloud status checked${provider ? ` (${provider})` : ''}`;
    }
    case 'cloud_deploy':
    case 'firebase_deploy':
    case 'aliyun_deploy': {
      // Try to extract URL from output
      const urlMatch = output.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        return `${theme.success('✓')} Deployed to ${theme.info(urlMatch[0])}`;
      }
      return `${theme.success('✓')} Deployment successful${provider ? ` (${provider})` : ''}`;
    }
    case 'cloud_init': {
      return `${theme.success('✓')} Cloud project initialized${provider ? ` (${provider})` : ''}`;
    }
    case 'cloud_login': {
      return `${theme.success('✓')} Logged in${provider ? ` to ${provider}` : ''}`;
    }
    default:
      return `${theme.success('✓')} Cloud operation completed`;
  }
}

/**
 * Format browser automation result
 */
function formatBrowserResult(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  if (!success) {
    return `${theme.error('✗')} Browser ${toolName.replace('browser_', '')} failed`;
  }

  switch (toolName) {
    case 'browser_create_session': {
      const sessionMatch = output.match(/session[:\s]+["']?([^"'\s\n]+)/i);
      if (sessionMatch) {
        return `${theme.success('✓')} Browser session created: ${theme.info(sessionMatch[1] || '')}`;
      }
      return `${theme.success('✓')} Browser session created`;
    }
    case 'browser_navigate': {
      const url = (args['url']) as string | undefined;
      if (url) {
        try {
          const hostname = new URL(url).hostname;
          return `${theme.success('✓')} Navigated to ${theme.info(hostname)}`;
        } catch {
          return `${theme.success('✓')} Navigated to page`;
        }
      }
      return `${theme.success('✓')} Navigated`;
    }
    case 'browser_click': {
      const selector = (args['selector']) as string | undefined;
      return `${theme.success('✓')} Clicked ${selector ? theme.dim(selector) : 'element'}`;
    }
    case 'browser_type': {
      const selector = (args['selector']) as string | undefined;
      return `${theme.success('✓')} Typed text ${selector ? `in ${theme.dim(selector)}` : ''}`;
    }
    case 'browser_screenshot': {
      const path = (args['path'] || args['file_path']) as string | undefined;
      if (path) {
        return `${theme.success('✓')} Screenshot saved: ${truncatePathForDisplay(path, 40)}`;
      }
      return `${theme.success('✓')} Screenshot captured`;
    }
    case 'browser_close_session': {
      return `${theme.success('✓')} Browser session closed`;
    }
    default:
      return `${theme.success('✓')} Browser action completed`;
  }
}

/**
 * Format email result
 */
function formatEmailResult(
  toolName: string,
  args: Record<string, unknown>,
  _output: string,
  success: boolean
): string {
  if (!success) {
    return `${theme.error('✗')} ${toolName.replace(/_/g, ' ')} failed`;
  }

  switch (toolName) {
    case 'send_email': {
      const to = (args['to']) as string | string[] | undefined;
      const recipients = Array.isArray(to) ? to.length : (to ? 1 : 0);
      return `${theme.success('✓')} Email sent${recipients ? ` to ${recipients} recipient${recipients === 1 ? '' : 's'}` : ''}`;
    }
    case 'send_batch_emails': {
      const emails = (args['emails']) as unknown[] | undefined;
      const count = emails?.length || 0;
      return `${theme.success('✓')} Sent ${count} email${count === 1 ? '' : 's'}`;
    }
    case 'verify_email_config': {
      return `${theme.success('✓')} Email config verified`;
    }
    default:
      return `${theme.success('✓')} Email operation completed`;
  }
}

/**
 * Format skill result
 */
function formatSkillResult(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  if (!success) {
    return `${theme.error('✗')} Skill operation failed`;
  }

  switch (toolName) {
    case 'ListSkills': {
      const skillMatch = output.match(/(\d+)\s*skill/i);
      if (skillMatch) {
        return `${theme.success('✓')} Found ${skillMatch[1]} skills`;
      }
      return `${theme.success('✓')} Skills listed`;
    }
    case 'Skill': {
      const skillName = (args['skill'] || args['name']) as string | undefined;
      if (skillName) {
        return `${theme.success('✓')} Skill "${skillName}" executed`;
      }
      return `${theme.success('✓')} Skill executed`;
    }
    default:
      return `${theme.success('✓')} Skill completed`;
  }
}

function formatPlanUpdateResult(
  args: Record<string, unknown>,
  _output: string,
  success: boolean
): string {
  if (!success) {
    return `${theme.error('✗')} Plan update failed`;
  }

  const plan = normalizePlanItems(args['plan']);
  const explanation = typeof args['explanation'] === 'string' ? args['explanation'].trim() : '';
  const width = resolvePlanWidth();
  const body = formatPlan(plan, { width, heading: 'Updated Plan' });

  if (!explanation) {
    return body;
  }

  const wrappedNote = wrapPlanText(explanation, '  ', width);
  return `${body}\n${wrappedNote.join('\n')}`;
}

/**
 * Format plan mode result
 */
function formatPlanModeResult(
  _args: Record<string, unknown>,
  _output: string,
  success: boolean
): string {
  if (!success) {
    return `${theme.error('✗')} Failed to exit plan mode`;
  }
  return `${theme.success('✓')} Exited plan mode`;
}

/**
 * Format repo checks result
 */
function formatRepoChecksResult(
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  const checks = (args['checks']) as string[] | undefined;
  const checkCount = checks?.length || 0;

  // Try to extract pass/fail counts
  const passMatch = output.match(/(\d+)\s*pass/i);
  const failMatch = output.match(/(\d+)\s*fail/i);
  const passed = passMatch ? parseInt(passMatch[1] || '0', 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1] || '0', 10) : 0;

  const statusIcon = success && failed === 0 ? theme.success('✓') : theme.error('✗');

  if (passed > 0 || failed > 0) {
    const counts: string[] = [];
    if (passed > 0) counts.push(theme.success(`${passed} passed`));
    if (failed > 0) counts.push(theme.error(`${failed} failed`));
    return `${statusIcon} Repo checks: ${counts.join(', ')}`;
  }

  return `${statusIcon} Repo checks${checkCount > 0 ? ` (${checkCount} checks)` : ''} ${success ? 'passed' : 'failed'}`;
}

/**
 * Format learn tool result
 */
function formatLearnResult(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  success: boolean
): string {
  if (!success) {
    return `${theme.error('✗')} Learning failed`;
  }

  switch (toolName) {
    case 'learn_codebase': {
      const fileMatch = output.match(/(\d+)\s*file/i);
      if (fileMatch) {
        return `${theme.success('✓')} Learned codebase: ${fileMatch[1]} files analyzed`;
      }
      return `${theme.success('✓')} Codebase learned`;
    }
    case 'learn_file': {
      const filePath = (args['file_path'] || args['path']) as string | undefined;
      if (filePath) {
        return `${theme.success('✓')} Learned: ${truncatePathForDisplay(filePath, 40)}`;
      }
      return `${theme.success('✓')} File learned`;
    }
    case 'learn_topic': {
      const topic = (args['topic']) as string | undefined;
      if (topic) {
        return `${theme.success('✓')} Learned topic: ${topic}`;
      }
      return `${theme.success('✓')} Topic learned`;
    }
    case 'learn_summary': {
      return `${theme.success('✓')} Summary generated`;
    }
    case 'explore': {
      const query = (args['query']) as string | undefined;
      const filesMatch = output.match(/Found\s+(\d+)\s+(?:file|relevant)/i);
      const symbolsMatch = output.match(/Found\s+(\d+)\s+symbol/i);
      const filesCount = filesMatch ? filesMatch[1] : null;
      const symbolsCount = symbolsMatch ? symbolsMatch[1] : null;
      if (filesCount || symbolsCount) {
        const parts = [];
        if (filesCount) parts.push(`${filesCount} files`);
        if (symbolsCount) parts.push(`${symbolsCount} symbols`);
        return `${theme.success('✓')} Explored: ${parts.join(', ')}`;
      }
      if (query) {
        return `${theme.success('✓')} Explored: "${query.slice(0, 30)}${query.length > 30 ? '...' : ''}"`;
      }
      return `${theme.success('✓')} Exploration complete`;
    }
    case 'explore_index': {
      const action = (args['action']) as string | undefined;
      const indexMatch = output.match(/(\d+)\s*files/i);
      if (action === 'rebuild' && indexMatch) {
        return `${theme.success('✓')} Index rebuilt: ${indexMatch[1]} files`;
      }
      if (action === 'status' && indexMatch) {
        return `${theme.info('ℹ')} Index: ${indexMatch[1]} files`;
      }
      return `${theme.success('✓')} Index ${action || 'managed'}`;
    }
    default:
      return `${theme.success('✓')} Learning completed`;
  }
}

// ============================================================================
// ADVANCED PROGRESS INDICATORS
// ============================================================================

/**
 * Format a compact progress bar
 */
export function formatCompactProgressBar(
  current: number,
  total: number,
  options: { width?: number; style?: 'bar' | 'braille' | 'dots' } = {}
): string {
  const { width = PROGRESS.COMPACT_WIDTH, style = 'bar' } = options;
  const percentage = calculatePercentage(current, total);
  const ratio = total > 0 ? current / total : 0;
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);

  let bar: string;
  switch (style) {
    case 'braille': {
      // Smooth braille progress (8 states per character)
      const fullBlocks = Math.floor(ratio * width);
      const remainder = (ratio * width) - fullBlocks;
      const partials = [' ', '⡀', '⡄', '⡆', '⡇', '⣇', '⣧', '⣷', '⣿'];
      const partialIndex = Math.floor(remainder * 8);
      bar = '⣿'.repeat(fullBlocks);
      if (fullBlocks < width) {
        bar += partials[partialIndex] ?? ' ';
        bar += ' '.repeat(Math.max(0, width - fullBlocks - 1));
      }
      bar = theme.progress?.bar?.(bar) ?? theme.info(bar);
      break;
    }
    case 'dots':
      bar = theme.success('●').repeat(filled) + theme.ui.muted('○').repeat(empty);
      break;
    case 'bar':
    default:
      bar = (theme.progress?.bar ?? theme.info)(progressChars.filled.repeat(filled)) +
            (theme.progress?.empty ?? theme.ui.muted)(progressChars.empty.repeat(empty));
  }

  return `[${bar}] ${(theme.progress?.percentage ?? theme.warning)(`${percentage}%`)}`;
}

/**
 * Format a micro progress indicator (fits in status line)
 */
export function formatMicroProgress(current: number, total: number): string {
  const percentage = calculatePercentage(current, total);

  // Use single-char block progress
  const blocks = PROGRESS.CHARS.partial;
  const blockIndex = Math.min(blocks.length - 1, Math.floor(percentage / 25));
  const block = blocks[blockIndex] ?? blocks[0];

  return `${theme.info(block)}${percentage}%`;
}

/**
 * Format a spinner with elapsed time
 */
export function formatSpinnerWithTime(
  frame: string,
  label: string,
  elapsedMs: number
): string {
  const elapsed = formatDurationMs(elapsedMs);
  return `${theme.info(frame)} ${label} ${theme.ui.muted(`(${elapsed})`)}`;
}

/**
 * Format multiple tool operations on a single line
 */
export function formatCompactToolLine(
  operations: Array<{ name: string; status: 'success' | 'error' | 'running'; summary?: string }>,
  options: { separator?: string; maxWidth?: number } = {}
): string {
  const { separator = ' · ', maxWidth = 80 } = options;

  const badges: string[] = [];
  let currentLength = 0;

  for (const op of operations) {
    const icon = op.status === 'success' ? icons.success :
                 op.status === 'error' ? icons.error : icons.running;
    const statusColor = op.status === 'success' ? theme.success :
                        op.status === 'error' ? theme.error : theme.info;
    const toolColor = getToolColor(op.name);

    let badge = `${statusColor(icon)} ${toolColor(op.name)}`;
    if (op.summary) {
      badge += ` ${theme.ui.muted(op.summary)}`;
    }

    // eslint-disable-next-line no-control-regex
    const badgeLength = badge.replace(/\u001B\[[0-9;]*m/g, '').length;
    // eslint-disable-next-line no-control-regex
    const sepLength = badges.length > 0 ? separator.replace(/\u001B\[[0-9;]*m/g, '').length : 0;

    if (currentLength + sepLength + badgeLength > maxWidth - 5) {
      const remaining = operations.length - badges.length;
      if (remaining > 0) {
        badges.push(theme.ui.muted(`+${remaining} more`));
      }
      break;
    }

    badges.push(badge);
    currentLength += sepLength + badgeLength;
  }

  return badges.join(theme.ui.muted(separator));
}

/**
 * Format a file operation summary with additions/removals
 */
export function formatFileOpSummary(
  path: string,
  type: 'read' | 'edit' | 'write',
  stats?: { lines?: number; additions?: number; removals?: number }
): string {
  const shortPath = truncatePathForDisplay(path, 40);
  const icon = type === 'read' ? icons.success :
               type === 'edit' ? icons.success : icons.success;
  const color = theme.success;

  const parts: string[] = [
    `${color(icon)} ${theme.file?.path?.(shortPath) ?? theme.info(shortPath)}`,
  ];

  if (stats) {
    const details: string[] = [];
    if (stats.lines !== undefined) {
      details.push(`${stats.lines} lines`);
    }
    if (stats.additions !== undefined && stats.additions > 0) {
      details.push((theme.file?.additions ?? theme.success)(`+${stats.additions}`));
    }
    if (stats.removals !== undefined && stats.removals > 0) {
      details.push((theme.file?.removals ?? theme.error)(`-${stats.removals}`));
    }
    if (details.length > 0) {
      parts.push(theme.ui.muted(`(${details.join(', ')})`));
    }
  }

  return parts.join(' ');
}

/**
 * Format a search result summary
 */
export function formatSearchOpSummary(
  pattern: string,
  matchCount: number,
  fileCount?: number,
  durationMs?: number
): string {
  const truncPattern = pattern.length > 25 ? `${pattern.slice(0, 22)}...` : pattern;

  if (matchCount === 0) {
    return `${theme.warning(icons.pending)} No matches for "${truncPattern}"`;
  }

  const parts: string[] = [
    `${theme.success(icons.success)} Found`,
    theme.info(`${matchCount}`),
    matchCount === 1 ? 'match' : 'matches',
  ];

  if (fileCount && fileCount > 0) {
    parts.push('in', theme.info(`${fileCount}`), fileCount === 1 ? 'file' : 'files');
  }

  parts.push(theme.ui.muted(`for "${truncPattern}"`));

  if (durationMs) {
    parts.push(theme.ui.muted(`(${formatDuration(durationMs)})`));
  }

  return parts.join(' ');
}

/**
 * Format a context usage badge
 */
export function formatContextBadge(usedPercentage: number): string {
  const remaining = 100 - usedPercentage;
  const color = usedPercentage > 80 ? theme.error :
                usedPercentage > 60 ? theme.warning : theme.success;
  return `${color(icons.context)}${remaining}%`;
}
