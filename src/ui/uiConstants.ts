/**
 * Centralized UI Constants
 *
 * Single source of truth for all magic numbers, thresholds, and display limits
 * used throughout the UI layer. Prevents inconsistencies and makes tuning easier.
 */

// ============================================================================
// TRUNCATION LIMITS
// ============================================================================

/**
 * Standard truncation lengths for different content types.
 * All values account for ellipsis character (…) which is 1 char.
 */
export const TRUNCATE = {
  /** Short paths in compact displays */
  SHORT_PATH: 40,
  /** Full paths in expanded displays */
  LONG_PATH: 80,
  /** Task/tool descriptions */
  DESCRIPTION: 50,
  /** Search queries and patterns */
  QUERY: 40,
  /** Pattern display in search results */
  PATTERN: 30,
  /** Preview lines in collapsed content */
  PREVIEW_LINE: 70,
  /** Error messages */
  ERROR_MESSAGE: 80,
  /** Command display */
  COMMAND: 100,
  /** Generic content truncation */
  DEFAULT: 40,
} as const;

/**
 * The ellipsis character to use for truncation.
 * Unicode ellipsis (…) is preferred over three dots (...) for consistency.
 */
export const ELLIPSIS = '…';

/**
 * Format for showing additional hidden items.
 */
export const moreIndicator = (count: number): string => `+${count} more`;

// ============================================================================
// PROGRESS BAR CONFIGURATION
// ============================================================================

export const PROGRESS = {
  /** Default width for progress bars */
  BAR_WIDTH: 20,
  /** Compact progress bar width */
  COMPACT_WIDTH: 15,
  /** Micro progress indicator width */
  MICRO_WIDTH: 10,
  /** Progress bar characters */
  CHARS: {
    filled: '█',
    empty: '░',
    partial: ['░', '▒', '▓', '█'],
  },
} as const;

// ============================================================================
// STATUS/HEALTH THRESHOLDS
// ============================================================================

/**
 * Color thresholds for context/memory usage indicators.
 * Values are percentages (0-100).
 */
export const CONTEXT_THRESHOLDS = {
  /** Critical - show error color */
  CRITICAL: 90,
  /** Warning - show warning color */
  WARNING: 70,
  /** Info - show info color */
  INFO: 50,
  // Below INFO threshold shows success color
} as const;

/**
 * Color thresholds for test coverage displays.
 */
export const COVERAGE_THRESHOLDS = {
  /** Good coverage - show success color */
  SUCCESS: 80,
  /** Acceptable coverage - show warning color */
  WARNING: 60,
  // Below WARNING threshold shows error color
} as const;

/**
 * Color thresholds for token usage displays.
 */
export const TOKEN_THRESHOLDS = {
  /** High usage - show error color */
  HIGH: 90,
  /** Medium usage - show warning color */
  MEDIUM: 70,
  // Below MEDIUM shows success color
} as const;

// ============================================================================
// DISPLAY LIMITS
// ============================================================================

export const DISPLAY_LIMITS = {
  /** Maximum lines to show in inline panels before collapsing */
  INLINE_PANEL_MAX_LINES: 64,
  /** Minimum usable width for content */
  MIN_WIDTH: 20,
  /** Default max width for thinking/reasoning blocks */
  MAX_THOUGHT_WIDTH: 72,
  /** Maximum tool arguments to display inline */
  MAX_INLINE_ARGS: 5,
  /** Maximum collapsed tool results to keep in memory */
  MAX_COLLAPSED_RESULTS: 50,
  /** Preview lines for expandable content */
  PREVIEW_LINES: 5,
  /** Preview lines for tool results */
  TOOL_RESULT_PREVIEW_LINES: 3,
  /** Maximum files to show in search results preview */
  SEARCH_PREVIEW_FILES: 4,
} as const;

// ============================================================================
// TIMING CONSTANTS
// ============================================================================

export const TIMING = {
  /** Minimum duration (ms) to show elapsed time */
  MIN_SHOW_DURATION: 1000,
  /** Debounce delay for status updates (ms) */
  STATUS_DEBOUNCE: 100,
  /** Animation frame interval (ms) */
  ANIMATION_INTERVAL: 80,
  /** Spinner animation interval (ms) */
  SPINNER_INTERVAL: 100,
} as const;

// ============================================================================
// UI STRINGS
// ============================================================================

export const UI_STRINGS = {
  /** Interrupt hint shown during long operations */
  INTERRUPT_HINT: 'esc to interrupt',
  /** Expand hint for collapsed content. Empty string while no real
   *  Ctrl+O keybinding exists — restore once the handler is wired up. */
  EXPAND_HINT: '',
  /** No matches found */
  NO_MATCHES: 'No matches found',
  /** No output */
  NO_OUTPUT: 'No output',
  /** Loading indicator */
  LOADING: 'Loading…',
  /** Success indicator */
  SUCCESS: '✓',
  /** Failure indicator */
  FAILURE: '✗',
  /** Warning indicator */
  WARNING: '⚠',
  /** Info indicator */
  INFO: 'ℹ',
  /** Pending indicator */
  PENDING: '○',
} as const;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Safely truncate a string with ellipsis.
 * Handles edge cases and ensures consistent truncation.
 */
export function truncateString(
  text: string,
  maxLength: number,
  ellipsis: string = ELLIPSIS
): string {
  if (!text || maxLength < 1) return '';
  if (text.length <= maxLength) return text;

  const truncateAt = Math.max(1, maxLength - ellipsis.length);
  return text.slice(0, truncateAt) + ellipsis;
}

/**
 * Truncate a file path, preserving the end (most relevant part).
 * Shows "…/path/to/file.ts" instead of "/very/long/pat…"
 */
export function truncatePath(
  path: string,
  maxLength: number,
  ellipsis: string = ELLIPSIS
): string {
  if (!path || maxLength < 1) return '';
  if (path.length <= maxLength) return path;

  // Keep the end of the path (most relevant)
  const keepLength = Math.max(1, maxLength - ellipsis.length);
  return ellipsis + path.slice(-keepLength);
}

/**
 * Calculate percentage with bounds checking.
 * Always returns a value between 0 and 100.
 */
export function calculatePercentage(current: number, total: number): number {
  if (total <= 0 || !Number.isFinite(current) || !Number.isFinite(total)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((current / total) * 100)));
}

/**
 * Clamp a percentage value to valid range.
 */
export function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Get color function based on context usage percentage.
 */
export function getContextColor<T>(
  percentage: number,
  colors: { error: T; warning: T; info: T; success: T }
): T {
  const pct = clampPercentage(percentage);
  if (pct > CONTEXT_THRESHOLDS.CRITICAL) return colors.error;
  if (pct > CONTEXT_THRESHOLDS.WARNING) return colors.warning;
  if (pct > CONTEXT_THRESHOLDS.INFO) return colors.info;
  return colors.success;
}

/**
 * Get color function based on coverage percentage.
 */
export function getCoverageColor<T>(
  percentage: number,
  colors: { success: T; warning: T; error: T }
): T {
  const pct = clampPercentage(percentage);
  if (pct >= COVERAGE_THRESHOLDS.SUCCESS) return colors.success;
  if (pct >= COVERAGE_THRESHOLDS.WARNING) return colors.warning;
  return colors.error;
}

/**
 * Get color function based on token usage percentage.
 */
export function getTokenColor<T>(
  percentage: number,
  colors: { error: T; warning: T; success: T }
): T {
  const pct = clampPercentage(percentage);
  if (pct >= TOKEN_THRESHOLDS.HIGH) return colors.error;
  if (pct >= TOKEN_THRESHOLDS.MEDIUM) return colors.warning;
  return colors.success;
}

/**
 * Format duration in milliseconds to human-readable string.
 * Handles ms, seconds, minutes, and hours.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${seconds}s`;
}

/**
 * Format elapsed time from seconds.
 */
export function formatElapsedSeconds(seconds: number): string {
  return formatDurationMs(seconds * 1000);
}

/**
 * Calculate usable width accounting for margins.
 */
export function calculateUsableWidth(
  terminalWidth: number,
  margins: number = 4
): number {
  return Math.max(DISPLAY_LIMITS.MIN_WIDTH, terminalWidth - margins);
}

/**
 * Validate and normalize a line count.
 */
export function normalizeLineCount(lines: number, defaultValue: number = 0): number {
  if (!Number.isFinite(lines) || lines < 0) return defaultValue;
  return Math.floor(lines);
}

// ============================================================================
// ADDITIONAL ROBUST UTILITY FUNCTIONS
// ============================================================================

/**
 * Safely format a number with locale-aware separators
 */
export function formatNumber(value: number, locale = 'en-US'): string {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString(locale);
}

/**
 * Format bytes to human-readable size
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * Safely split text into lines with consistent line endings
 */
export function splitLines(text: string): string[] {
  if (!text) return [];
  return text.split(/\r?\n/);
}

/**
 * Count visible characters (excluding ANSI codes)
 */
export function visibleLength(text: string): number {
  if (!text) return 0;
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, '').length;
}

/**
 * Pad text to width accounting for ANSI codes
 */
export function padToWidth(text: string, width: number, padChar = ' '): string {
  const visible = visibleLength(text);
  if (visible >= width) return text;
  return text + padChar.repeat(width - visible);
}

/**
 * Create a horizontal line/separator
 */
export function createSeparator(
  width: number,
  char = '─',
  style?: (text: string) => string
): string {
  const line = char.repeat(Math.max(0, width));
  return style ? style(line) : line;
}

/**
 * Wrap text to fit within width, preserving words
 */
export function wrapText(text: string, width: number): string[] {
  if (!text || width < 1) return [''];

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if (visibleLength(currentLine) + 1 + visibleLength(word) <= width) {
      currentLine += ' ' + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.length ? lines : [''];
}

/**
 * Indent text by specified amount
 */
export function indent(text: string, spaces: number = 2): string {
  if (!text) return '';
  const padding = ' '.repeat(Math.max(0, spaces));
  return text.split('\n').map(line => padding + line).join('\n');
}

/**
 * Strip ANSI escape codes from text
 * @deprecated Use stripAnsi from layout.ts instead
 */
export function stripAnsiCodes(text: string): string {
  if (!text) return '';
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, '');
}

/**
 * Check if text contains ANSI codes
 */
export function hasAnsiCodes(text: string): boolean {
  if (!text) return false;
  // eslint-disable-next-line no-control-regex
  return /\u001B\[[0-9;]*m/.test(text);
}

/**
 * Truncate from middle, keeping start and end
 */
export function truncateMiddle(
  text: string,
  maxLength: number,
  separator = '…'
): string {
  if (!text || maxLength < 3) return text?.slice(0, maxLength) ?? '';
  if (text.length <= maxLength) return text;

  const keep = Math.floor((maxLength - separator.length) / 2);
  return text.slice(0, keep) + separator + text.slice(-keep);
}

/**
 * Safely get a property from an object with type checking
 */
export function safeGet<T>(obj: unknown, key: string, defaultValue: T): T {
  if (obj && typeof obj === 'object' && key in obj) {
    return (obj as Record<string, unknown>)[key] as T ?? defaultValue;
  }
  return defaultValue;
}

/**
 * Debounce a function call
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): T {
  let timeoutId: NodeJS.Timeout | null = null;
  return ((...args: unknown[]) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  }) as T;
}

/**
 * Throttle a function call
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  limit: number
): T {
  let lastCall = 0;
  return ((...args: unknown[]) => {
    const now = Date.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      fn(...args);
    }
  }) as T;
}
