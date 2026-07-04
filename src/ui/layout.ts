import { theme } from './theme.js';
import { isPlainOutputMode } from './outputMode.js';

/**
 * Layout constants for terminal rendering
 * These ensure consistent behavior across all terminal sizes
 */
const MIN_WIDTH = 20; // Minimum usable width (reduced from 42 for narrow terminals)
const MAX_WIDTH = 120; // Maximum content width for readability
const ULTRA_NARROW_WIDTH = 30; // Below this, use compact mode
const DEFAULT_WIDTH = 80; // Standard terminal width fallback

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\u001B\[[0-9;]*m/g;

/**
 * Get terminal columns with robust fallback handling
 * Handles edge cases: undefined stdout, non-TTY, invalid values
 */
export function getTerminalColumns(defaultWidth = DEFAULT_WIDTH): number {
  try {
    // Check if stdout exists and has columns
    if (
      process.stdout &&
      typeof process.stdout.columns === 'number' &&
      Number.isFinite(process.stdout.columns) &&
      process.stdout.columns > 0
    ) {
      return process.stdout.columns;
    }

    // Fallback: try COLUMNS env variable (used in some terminals)
    const envColumns = process.env['COLUMNS'];
    if (envColumns) {
      const parsed = parseInt(envColumns, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  } catch {
    // Silently handle any errors (e.g., in restricted environments)
  }
  return defaultWidth;
}

/**
 * Check if we're in ultra-narrow terminal mode
 */
export function isUltraNarrowMode(): boolean {
  return getTerminalColumns() < ULTRA_NARROW_WIDTH;
}

export type Colorize = (value: string) => string;

export interface PanelOptions {
  title?: string;
  icon?: string;
  accentColor?: Colorize;
  borderColor?: Colorize;
  width?: number;
}

export function getContentWidth(): number {
  const columns = getTerminalColumns();
  const usable = typeof columns === 'number' && Number.isFinite(columns) ? columns - 6 : MAX_WIDTH;
  return clampWidth(usable, columns);
}

export function wrapParagraph(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [''];
  }

  const lines: string[] = [];
  let current = words.shift()!;

  for (const word of words) {
    if (measure(`${current} ${word}`) > width) {
      lines.push(current);
      current = word;
    } else {
      current += ` ${word}`;
    }
  }

  lines.push(current);
  return lines;
}

export function wrapPreformatted(text: string, width: number): string[] {
  if (!text) {
    return [''];
  }

  const result: string[] = [];
  let remaining = text;

  while (measure(remaining) > width) {
    result.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }

  if (remaining) {
    result.push(remaining);
  }

  return result.length ? result : [''];
}

export function normalizePanelWidth(width?: number): number {
  if (typeof width === 'number' && Number.isFinite(width)) {
    return clampWidth(width, getTerminalColumns());
  }
  return clampWidth(getContentWidth(), getTerminalColumns());
}

export function renderPanel(lines: string[], options: PanelOptions = {}): string {
  // Check if plain output mode is enabled for clipboard-friendly text
  if (isPlainOutputMode()) {
    return renderPlainPanel(lines, options);
  }

  const width = normalizePanelWidth(options.width);
  const accent = options.accentColor ?? theme.primary;
  const iconSegment = options.icon ? `${options.icon} ` : '';
  const titleText = options.title ? `${iconSegment}${options.title}` : '';

  const output: string[] = [];

  // Add empty line for spacing
  output.push('');

  if (titleText) {
    const paddedTitle = padLine(accent(truncate(titleText, width)), width);
    output.push(paddedTitle);
    output.push('');
  }

  if (!lines.length) {
    lines = [''];
  }

  for (const line of lines) {
    const padded = padLine(line, width);
    output.push(padded);
  }

  // Add empty line for spacing
  output.push('');

  return output.join('\n');
}

/**
 * Renders a panel in plain text mode without box-drawing characters.
 * Outputs clean text that's clipboard-friendly.
 */
function renderPlainPanel(lines: string[], options: PanelOptions = {}): string {
  const accent = options.accentColor ?? theme.primary;
  const iconSegment = options.icon ? `${options.icon} ` : '';
  const titleText = options.title ? `${iconSegment}${options.title}` : '';

  const output: string[] = [];

  if (titleText) {
    output.push(`[${accent(titleText)}]`);
    output.push('');
  }

  if (!lines.length) {
    lines = [''];
  }

  for (const line of lines) {
    output.push(line.trimEnd());
  }

  return output.join('\n');
}

export function measure(text: string): number {
  return stripAnsi(text).length;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

/**
 * Clamp width to valid bounds with robust error handling
 * Ensures we never return invalid dimensions that could break rendering
 */
function clampWidth(value: number, columns?: number): number {
  // Handle invalid inputs gracefully
  if (!Number.isFinite(value) || value < 0) {
    value = DEFAULT_WIDTH;
  }

  // Calculate max width based on terminal size
  const terminalMax =
    typeof columns === 'number' && Number.isFinite(columns) && columns > 0
      ? Math.max(MIN_WIDTH, Math.floor(columns - 4)) // Leave margin for borders
      : MAX_WIDTH;

  // Ensure min doesn't exceed max
  const effectiveMin = Math.min(MIN_WIDTH, terminalMax);
  const effectiveMax = Math.min(MAX_WIDTH, terminalMax);

  // Clamp to valid range
  const normalized = Math.floor(value);
  return Math.max(effectiveMin, Math.min(normalized, effectiveMax));
}

export function padLine(text: string, width: number): string {
  const visible = measure(text);
  if (visible === width) {
    return text;
  }

  if (visible > width) {
    return truncate(text, width);
  }

  return `${text}${' '.repeat(width - visible)}`;
}

export function truncate(text: string, width: number): string {
  const visible = stripAnsi(text);
  if (visible.length <= width) {
    return text;
  }

  const truncated = visible.slice(0, Math.max(1, width - 1));
  return `${truncated}…`;
}
