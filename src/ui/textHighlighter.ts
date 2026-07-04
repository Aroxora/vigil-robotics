/**
 * Text Highlighter - Vigil CLI style
 * Applies sophisticated coloring to different text types
 */

import { theme } from './theme.js';

/**
 * Highlight file paths (Vigil CLI style)
 * Example: src/ui/UnifiedUIRenderer.ts
 */
export function highlightFilePath(path: string): string {
  const parts = path.split('/');
  const file = parts.pop() || '';
  const dir = parts.join('/');

  if (dir) {
    return `${theme.ui.muted(`${dir  }/`)}${theme.info(file)}`;
  }
  return theme.info(file);
}

/**
 * Highlight numbers in text
 * Example: "Read 150 lines" -> "Read [150] lines"
 */
export function highlightNumbers(text: string): string {
  return text.replace(/\b(\d+)\b/g, (match) => theme.ui.number(match));
}

/**
 * Highlight code blocks (inline)
 * Example: `const foo = 'bar'`
 */
export function highlightInlineCode(text: string): string {
  return text.replace(/`([^`]+)`/g, (_, code) => theme.ui.code(code));
}

/**
 * Highlight quoted strings
 * Example: "hello world"
 */
export function highlightQuotedStrings(text: string): string {
  return text.replace(/"([^"]*)"/g, (_, str) => theme.ui.string(`"${str}"`));
}

/**
 * Highlight keywords (Vigil CLI style)
 * Example: function, class, const, let, etc.
 */
export function highlightKeywords(text: string): string {
  const keywords = [
    'function', 'class', 'const', 'let', 'var',
    'import', 'export', 'from', 'default',
    'async', 'await', 'return', 'if', 'else',
    'for', 'while', 'do', 'switch', 'case',
    'try', 'catch', 'finally', 'throw',
    'new', 'this', 'super', 'extends', 'implements',
  ];

  let result = text;
  for (const keyword of keywords) {
    const regex = new RegExp(`\\b(${keyword})\\b`, 'g');
    result = result.replace(regex, (match) => theme.ui.keyword(match));
  }

  return result;
}

/**
 * Highlight URLs
 */
export function highlightUrls(text: string): string {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, (url) => theme.link.url(url));
}

/**
 * Highlight error messages (Vigil CLI style)
 * Makes errors stand out with proper coloring and clickable file references
 */
export function highlightError(text: string): string {
  // Highlight error type (TypeScript, JavaScript, Node errors)
  text = text.replace(
    /^(Error|TypeError|SyntaxError|ReferenceError|RangeError|URIError|EvalError):/im,
    (match) => theme.error.bold(match)
  );

  // Highlight TypeScript errors (TS2xxx)
  text = text.replace(
    /error (TS\d+):/g,
    (_, code) => `error ${theme.error.bold(code)}:`
  );

  // Highlight file:line:col references (Vigil CLI style - make them look clickable)
  // Pattern: path/to/file.ts(10,5) or path/to/file.ts:10:5
  text = text.replace(
    /([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)\((\d+),(\d+)\)/g,
    (_, file, line, col) =>
      `${theme.info(file)}:${theme.warning(line)}:${theme.warning(col)}`
  );

  text = text.replace(
    /([a-zA-Z0-9_\-./]+\.[a-zA-Z]+):(\d+):(\d+)/g,
    (_, file, line, col) =>
      `${theme.info(file)}:${theme.warning(line)}:${theme.warning(col)}`
  );

  // Highlight stack trace lines (at function in file:line:col)
  text = text.replace(
    /^\s+at\s+([^\s]+)\s+\(([^:]+):(\d+):(\d+)\)/gm,
    (_, fn, file, line, col) =>
      `  at ${theme.ui.muted(fn)} (${theme.info(file)}:${theme.warning(line)}:${theme.warning(col)})`
  );

  // Highlight anonymous stack trace (at file:line:col without function)
  text = text.replace(
    /^\s+at\s+([^(]+):(\d+):(\d+)$/gm,
    (_, file, line, col) =>
      `  at ${theme.info(file.trim())}:${theme.warning(line)}:${theme.warning(col)}`
  );

  // Highlight error keywords in the message
  const errorKeywords = ['failed', 'cannot', 'unable', 'invalid', 'missing', 'undefined', 'null', 'expected'];
  for (const keyword of errorKeywords) {
    const regex = new RegExp(`\\b(${keyword})\\b`, 'gi');
    text = text.replace(regex, (match) => theme.error(match));
  }

  return text;
}

/**
 * Format file:line reference for terminal output (Vigil CLI style)
 * Returns a formatted string that looks like a clickable reference
 */
export function formatFileLineRef(filePath: string, line?: number, col?: number): string {
  if (line !== undefined && col !== undefined) {
    return `${theme.info(filePath)}:${theme.warning(String(line))}:${theme.warning(String(col))}`;
  }
  if (line !== undefined) {
    return `${theme.info(filePath)}:${theme.warning(String(line))}`;
  }
  return theme.info(filePath);
}

/**
 * Highlight success messages
 */
export function highlightSuccess(text: string): string {
  const successWords = ['success', 'completed', 'passed', 'done', 'ok'];
  let result = text;

  for (const word of successWords) {
    const regex = new RegExp(`\\b(${word})\\b`, 'gi');
    result = result.replace(regex, (match) => theme.success.bold(match));
  }

  return result;
}

/**
 * Highlight warning messages
 */
export function highlightWarning(text: string): string {
  const warningWords = ['warning', 'deprecated', 'caution', 'attention'];
  let result = text;

  for (const word of warningWords) {
    const regex = new RegExp(`\\b(${word})\\b`, 'gi');
    result = result.replace(regex, (match) => theme.warning.bold(match));
  }

  return result;
}

/**
 * Highlight tool names (Vigil CLI style)
 */
export function highlightToolName(name: string): string {
  return theme.info.bold(name);
}

/**
 * Highlight command output (Vigil CLI style)
 * Applies context-aware highlighting
 */
export function highlightCommandOutput(output: string, command?: string): string {
  let result = output;

  // Git commands
  if (command?.includes('git')) {
    result = highlightGitOutput(result);
  }

  // npm commands
  else if (command?.includes('npm')) {
    result = highlightNpmOutput(result);
  }

  // General highlighting
  else {
    result = highlightNumbers(result);
    result = highlightUrls(result);
    result = highlightFilePaths(result);
  }

  return result;
}

/**
 * Highlight file paths in text
 */
function highlightFilePaths(text: string): string {
  // Match common file path patterns
  const pathRegex = /([a-zA-Z0-9_\-./]+\.(ts|js|tsx|jsx|json|md|txt|yml|yaml|css|scss|html))/g;
  return text.replace(pathRegex, (match) => highlightFilePath(match));
}

/**
 * Highlight git output
 */
function highlightGitOutput(text: string): string {
  let result = text;

  // Branch names
  result = result.replace(/On branch (\w+)/g, (_, branch) =>
    `On branch ${theme.info.bold(branch)}`
  );

  // File statuses
  result = result.replace(/^\s*modified:/gm, (match) => theme.warning(match));
  result = result.replace(/^\s*deleted:/gm, (match) => theme.error(match));
  result = result.replace(/^\s*new file:/gm, (match) => theme.success(match));

  // Ahead/behind
  result = result.replace(/ahead (\d+)/g, (_, num) =>
    `ahead ${theme.success.bold(num)}`
  );
  result = result.replace(/behind (\d+)/g, (_, num) =>
    `behind ${theme.warning.bold(num)}`
  );

  return result;
}

/**
 * Highlight npm output
 */
function highlightNpmOutput(text: string): string {
  let result = text;

  // Package names
  result = result.replace(/(@[\w-]+\/[\w-]+|[\w-]+@[\d.]+)/g, (match) =>
    theme.info(match)
  );

  // Warnings
  result = result.replace(/WARN/g, theme.warning.bold('WARN'));

  // Errors
  result = result.replace(/ERR!/g, theme.error.bold('ERR!'));

  return result;
}

/**
 * Apply all highlighting (auto-detect)
 */
export function highlightText(text: string, context?: 'code' | 'command' | 'error' | 'log'): string {
  let result = text;

  switch (context) {
    case 'error':
      result = highlightError(result);
      break;
    case 'code':
      result = highlightKeywords(result);
      result = highlightQuotedStrings(result);
      result = highlightNumbers(result);
      break;
    case 'command':
      result = highlightCommandOutput(result);
      break;
    case 'log':
      result = highlightSuccess(result);
      result = highlightWarning(result);
      result = highlightNumbers(result);
      break;
    default:
      // Auto-detect and apply all
      result = highlightNumbers(result);
      result = highlightUrls(result);
      result = highlightInlineCode(result);
      result = highlightSuccess(result);
      result = highlightWarning(result);
  }

  return result;
}

/**
 * Highlight important text (bold + colored)
 */
export function highlightImportant(text: string): string {
  return theme.ui.highlight(text);
}

/**
 * Emphasize text (less prominent than important)
 */
export function emphasizeText(text: string): string {
  return theme.ui.emphasis(text);
}

/**
 * Highlight thinking blocks (Vigil CLI style)
 * Wraps <thinking>...</thinking> content in a styled box
 */
export function highlightThinkingBlock(text: string): string {
  // Match <thinking>...</thinking> blocks
  const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/gi;

  return text.replace(thinkingRegex, (_, content: string) => {
    const trimmedContent = content.trim();
    const lines = trimmedContent.split('\n');

    // Build the styled thinking box
    const header = theme.ui.muted('┌─ ') + theme.secondary('💭 Thinking') + theme.ui.muted(' ─');
    const footer = theme.ui.muted(`└${  '─'.repeat(20)}`);

    const styledLines = lines.map(line => {
      const trimmedLine = line.trim();
      if (!trimmedLine) return theme.ui.muted('│');
      return theme.ui.muted('│ ') + theme.ui.muted(trimmedLine);
    });

    return [header, ...styledLines, footer].join('\n');
  });
}

/**
 * Format streaming thinking content (for incremental display)
 * Shows thinking in a muted italic style without the box
 */
export function formatThinkingContent(content: string): string {
  return theme.ui.muted(content);
}
