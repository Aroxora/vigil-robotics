/**
 * Error Formatter - Claude Code style
 * Enhanced error message and stack trace formatting with robust handling
 *
 * Features:
 * - Consistent Claude Code styling with proper iconography
 * - Robust handling of malformed error objects
 * - Configurable stack trace depth
 * - Code context display with syntax highlighting
 * - Comparison errors for test assertions
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { theme } from './theme.js';

export interface ErrorInfo {
  type?: string;
  message: string;
  stack?: string;
  code?: string;
  file?: string;
  line?: number;
  column?: number;
  context?: string[];
  cause?: Error | ErrorInfo;
}

export interface ErrorFormatOptions {
  showStack?: boolean;
  showContext?: boolean;
  maxStackLines?: number;
  compact?: boolean;
  showLineNumbers?: boolean;
  showCause?: boolean;
}

/** Maximum message length before truncation */
const MAX_MESSAGE_LENGTH = 500;

/** Maximum context lines to show */
const MAX_CONTEXT_LINES = 10;

/**
 * Format error with enhanced styling
 * Handles malformed error objects gracefully
 */
export function formatError(
  error: Error | ErrorInfo | unknown,
  options: ErrorFormatOptions = {}
): string {
  const showStack = options.showStack ?? true;
  const showContext = options.showContext ?? true;
  const maxStackLines = options.maxStackLines ?? 10;
  const compact = options.compact ?? false;
  const showCause = options.showCause ?? true;

  const lines: string[] = [];

  // Safely extract error info
  const errorInfo = extractErrorInfo(error);
  const errorType = errorInfo.type || 'Error';
  const errorIcon = getErrorIcon(errorType);

  // Truncate very long messages
  const message = errorInfo.message.length > MAX_MESSAGE_LENGTH
    ? errorInfo.message.slice(0, MAX_MESSAGE_LENGTH) + '…'
    : errorInfo.message;

  lines.push(theme.error(`${errorIcon} ${errorType}: ${message}`));

  // Error code if present
  if (errorInfo.code) {
    lines.push(theme.ui.muted(`  Code: ${errorInfo.code}`));
  }

  // Location info
  if (errorInfo.file) {
    const location = formatErrorLocation(
      errorInfo.file,
      errorInfo.line,
      errorInfo.column
    );
    lines.push(theme.ui.muted(`  at ${location}`));
  }

  // Code context
  if (showContext && errorInfo.context && errorInfo.context.length > 0) {
    lines.push('');
    const limitedContext = errorInfo.context.slice(0, MAX_CONTEXT_LINES);
    lines.push(formatCodeContext(limitedContext, errorInfo.line));
  }

  // Stack trace
  if (showStack && errorInfo.stack) {
    const stackLines = parseStackTrace(errorInfo.stack, maxStackLines);
    if (stackLines.length > 0) {
      if (!compact) lines.push('');
      lines.push(theme.ui.muted('Stack trace:'));
      stackLines.forEach(stackLine => {
        lines.push(formatStackLine(stackLine));
      });
    }
  }

  // Cause chain (Error.cause support)
  if (showCause && errorInfo.cause) {
    lines.push('');
    lines.push(theme.ui.muted('Caused by:'));
    lines.push(indent(formatError(errorInfo.cause, { ...options, showCause: true, compact: true }), 2));
  }

  return lines.join('\n');
}

/**
 * Safely extract error info from any value
 */
function extractErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    return {
      type: error.name,
      message: error.message || 'Unknown error',
      stack: error.stack,
      cause: (error as any).cause,
    };
  }

  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    return {
      type: String(obj['type'] || obj['name'] || 'Error'),
      message: String(obj['message'] || 'Unknown error'),
      stack: typeof obj['stack'] === 'string' ? obj['stack'] : undefined,
      code: typeof obj['code'] === 'string' ? obj['code'] : undefined,
      file: typeof obj['file'] === 'string' ? obj['file'] : undefined,
      line: typeof obj['line'] === 'number' ? obj['line'] : undefined,
      column: typeof obj['column'] === 'number' ? obj['column'] : undefined,
      context: Array.isArray(obj['context']) ? obj['context'].map(String) : undefined,
      cause: obj['cause'] as Error | ErrorInfo | undefined,
    };
  }

  return {
    type: 'Error',
    message: String(error ?? 'Unknown error'),
  };
}

/**
 * Indent text by specified number of spaces
 */
function indent(text: string, spaces: number): string {
  const padding = ' '.repeat(spaces);
  return text.split('\n').map(line => padding + line).join('\n');
}

/**
 * Format multiple errors as a list
 */
export function formatErrorList(
  errors: Array<Error | ErrorInfo>,
  options: ErrorFormatOptions = {}
): string {
  if (errors.length === 0) {
    return theme.success('✓ No errors');
  }

  const header = theme.error(`✗ ${errors.length} error${errors.length > 1 ? 's' : ''} found`);
  const formattedErrors = errors.map((error, index) => {
    const errorNum = theme.ui.muted(`[${index + 1}]`);
    const formatted = formatError(error, { ...options, compact: true, showStack: false });
    return `\n${errorNum} ${formatted}`;
  });

  return [header, ...formattedErrors].join('\n');
}

/**
 * Format TypeScript/compiler error
 */
export function formatCompilerError(
  file: string,
  line: number,
  column: number,
  message: string,
  code?: string
): string {
  const location = `${file}:${line}:${column}`;
  const codeStr = code ? theme.ui.muted(` [${code}]`) : '';

  return [
    theme.error(`✗ ${location}${codeStr}`),
    `  ${message}`
  ].join('\n');
}

/**
 * Format validation errors
 */
export function formatValidationErrors(
  errors: Array<{ field: string; message: string; value?: any }>
): string {
  if (errors.length === 0) {
    return theme.success('✓ Validation passed');
  }

  const lines: string[] = [];
  lines.push(theme.error(`✗ ${errors.length} validation error${errors.length > 1 ? 's' : ''}`));

  errors.forEach(error => {
    const field = theme.warning(error.field);
    const value = error.value !== undefined
      ? theme.ui.muted(` (got: ${JSON.stringify(error.value)})`)
      : '';
    lines.push(`  • ${field}: ${error.message}${value}`);
  });

  return lines.join('\n');
}

/**
 * Format error location
 */
function formatErrorLocation(
  file: string,
  line?: number,
  column?: number
): string {
  const parts = [file];
  if (line !== undefined) parts.push(String(line));
  if (column !== undefined) parts.push(String(column));
  return parts.join(':');
}

/**
 * Format code context with error line highlighted
 */
function formatCodeContext(
  contextLines: string[],
  errorLine?: number
): string {
  const startLine = errorLine ? Math.max(1, errorLine - 2) : 1;

  return contextLines.map((line, index) => {
    const lineNum = startLine + index;
    const isError = errorLine !== undefined && lineNum === errorLine;
    const lineNumStr = String(lineNum).padStart(4);

    if (isError) {
      const arrow = theme.error('>');
      const num = theme.error(lineNumStr);
      const code = theme.error(line);
      return `  ${arrow} ${num} │ ${code}`;
    } else {
      const num = theme.ui.muted(lineNumStr);
      const code = theme.ui.muted(line);
      return `    ${num} │ ${code}`;
    }
  }).join('\n');
}

/**
 * Parse stack trace into structured lines
 */
interface StackLine {
  function: string;
  file?: string;
  line?: number;
  column?: number;
}

function parseStackTrace(stack: string, maxLines: number): StackLine[] {
  const lines = stack.split('\n').slice(1); // Skip first line (error message)
  const parsed: StackLine[] = [];

  for (const line of lines) {
    if (parsed.length >= maxLines) break;

    // Match common stack trace formats
    // at functionName (file:line:column)
    const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
    if (match && match[1] && match[2] && match[3] && match[4]) {
      parsed.push({
        function: match[1],
        file: match[2],
        line: parseInt(match[3]),
        column: parseInt(match[4])
      });
      continue;
    }

    // at file:line:column
    const simpleMatch = line.match(/at\s+(.+?):(\d+):(\d+)/);
    if (simpleMatch && simpleMatch[1] && simpleMatch[2] && simpleMatch[3]) {
      parsed.push({
        function: '<anonymous>',
        file: simpleMatch[1],
        line: parseInt(simpleMatch[2]),
        column: parseInt(simpleMatch[3])
      });
      continue;
    }
  }

  return parsed;
}

/**
 * Format single stack trace line
 */
function formatStackLine(stackLine: StackLine): string {
  const func = theme.info(stackLine.function);
  const location = stackLine.file
    ? theme.ui.muted(` (${stackLine.file}:${stackLine.line}:${stackLine.column})`)
    : '';

  return `  ${theme.ui.muted('at')} ${func}${location}`;
}

/**
 * Get icon for error type
 */
function getErrorIcon(errorType: string): string {
  const iconMap: Record<string, string> = {
    'TypeError': '🔤',
    'ReferenceError': '❓',
    'SyntaxError': '⚠️',
    'RangeError': '📏',
    'NetworkError': '🌐',
    'ValidationError': '✗',
    'AuthError': '🔒',
    'PermissionError': '🚫',
    'NotFoundError': '🔍',
    'TimeoutError': '⏱️'
  };

  return iconMap[errorType] || '✗';
}

/**
 * Format error summary (count and types)
 */
export function formatErrorSummary(
  errors: Array<Error | ErrorInfo>
): string {
  if (errors.length === 0) {
    return theme.success('✓ No errors');
  }

  const typeCount = new Map<string, number>();
  errors.forEach(error => {
    const type = error instanceof Error ? error.name : (error.type || 'Error');
    typeCount.set(type, (typeCount.get(type) || 0) + 1);
  });

  const total = theme.error(`✗ ${errors.length} error${errors.length > 1 ? 's' : ''}`);
  const breakdown = Array.from(typeCount.entries())
    .map(([type, count]) => `${theme.warning(count.toString())} ${theme.ui.muted(type)}`)
    .join(theme.ui.muted(', '));

  return `${total} ${theme.ui.muted('·')} ${breakdown}`;
}

/**
 * Format diff-style error (expected vs actual)
 */
export function formatComparisonError(
  expected: any,
  actual: any,
  path?: string
): string {
  const lines: string[] = [];
  const pathStr = path ? ` at ${theme.ui.muted(path)}` : '';

  lines.push(theme.error(`✗ Comparison failed${pathStr}`));
  lines.push('');
  lines.push(theme.error('  - Expected:'));
  lines.push(`    ${formatValue(expected)}`);
  lines.push(theme.success('  + Actual:'));
  lines.push(`    ${formatValue(actual)}`);

  return lines.join('\n');
}

/**
 * Format value for comparison display
 */
function formatValue(value: any): string {
  if (typeof value === 'string') {
    return theme.success(`"${value}"`);
  } else if (typeof value === 'number') {
    return theme.warning(String(value));
  } else if (typeof value === 'boolean') {
    return theme.info(String(value));
  } else if (value === null) {
    return theme.ui.muted('null');
  } else if (value === undefined) {
    return theme.ui.muted('undefined');
  } else {
    return JSON.stringify(value, null, 2);
  }
}

/**
 * Format caught exception with context
 */
export function formatCaughtError(
  error: unknown,
  context?: string
): string {
  const contextStr = context ? theme.ui.muted(` (${context})`) : '';
  const header = theme.error(`✗ Caught exception${contextStr}`);

  if (error instanceof Error) {
    return `${header}\n${formatError(error, { compact: true })}`;
  } else {
    return `${header}\n  ${String(error)}`;
  }
}
