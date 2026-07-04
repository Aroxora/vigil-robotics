import { icons, theme } from './theme.js';
import {
  getContentWidth,
  measure,
  normalizePanelWidth,
  renderPanel,
  type PanelOptions,
  wrapParagraph,
  wrapPreformatted,
} from './layout.js';
import { highlightAndWrapCode } from './codeHighlighter.js';
import { isPlainOutputMode } from './outputMode.js';

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'code'; content: string; language?: string }
  | { type: 'diff'; content: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'quote'; lines: string[] }
  | { type: 'divider' };

export function formatRichContent(content: string, width: number): string[] {
  const blocks = parseBlocks(content);
  const lines: string[] = [];

  for (const block of blocks) {
    let blockLines: string[] = [];

    switch (block.type) {
      case 'paragraph': {
        const formatted = formatInlineText(block.text);
        blockLines = wrapParagraph(formatted, width);
        break;
      }
      case 'list':
        blockLines = formatList(block.items, width);
        break;
      case 'code':
        blockLines = formatCodeBlock(block.content, width, block.language);
        break;
      case 'diff':
        blockLines = formatDiffBlock(block.content, width);
        break;
      case 'heading':
        blockLines = formatHeadingBlock(block, width);
        break;
      case 'quote':
        blockLines = formatQuoteBlock(block.lines, width);
        break;
      case 'divider':
        blockLines = [formatDivider(width)];
        break;
      default:
        blockLines = [];
    }

    if (!blockLines.length) {
      continue;
    }

    if (lines.length) {
      const lastLine = lines[lines.length - 1];
      if (lastLine?.trim()) {
        lines.push('');
      }
    }

    lines.push(...blockLines);
  }

  while (lines.length) {
    const lastLine = lines[lines.length - 1];
    if (lastLine?.trim()) {
      break;
    }
    lines.pop();
  }

  return lines;
}

export function renderMessagePanel(
  content: string,
  options: PanelOptions
): string {
  const width = normalizePanelWidth(options.width ?? getContentWidth());
  const lines = formatRichContent(content, width);
  return renderPanel(lines, { ...options, width });
}

export function renderMessageBody(content: string, width?: number): string {
  const normalizedWidth = normalizePanelWidth(width ?? getContentWidth());
  const lines = formatRichContent(content, normalizedWidth);
  return lines.join('\n');
}

/**
 * Format text to make URLs clickable in the terminal.
 * Handles both bare URLs (https://...) and markdown links [text](url).
 * Uses OSC 8 escape sequences for terminal hyperlinks.
 */
export function formatClickableLinks(text: string): string {
  if (!text) {
    return '';
  }

  // Use placeholders to avoid double-processing URLs inside markdown links
  const processedLinks: string[] = [];
  const PLACEHOLDER = '\u0002LINK';

  // First pass: handle markdown links [label](url)
  let result = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    processedLinks.push(formatMarkdownLink(label, url));
    return `${PLACEHOLDER}${processedLinks.length - 1}${PLACEHOLDER}`;
  });

  // Second pass: handle bare URLs (not inside markdown links)
  // Match URLs but stop at trailing punctuation that's likely sentence-ending
  // eslint-disable-next-line no-control-regex
  result = result.replace(/(\bhttps?:\/\/[^\s\u0002<>]+?)([)\]}>,.;:!?"']*(?=\s|$))/g, (_match, url, trailing = '') => {
    // Clean up any trailing colons that might be part of "URL:" patterns
    const cleanUrl = url.replace(/:$/, '');
    const actualTrailing = url.endsWith(':') ? ':' + trailing : trailing;
    processedLinks.push(`${formatBareLink(cleanUrl)}${actualTrailing}`);
    return `${PLACEHOLDER}${processedLinks.length - 1}${PLACEHOLDER}`;
  });

  // Final pass: restore placeholders
  result = result.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'),
    (_match, index) => processedLinks[Number.parseInt(index, 10)] ?? ''
  );

  return result;
}

export function formatDiffBlock(diff: string, width: number): string[] {
  const lines = diff.replace(/\t/g, '  ').split('\n');
  const result: string[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      result.push('');
      continue;
    }

    const color = pickDiffColor(line);
    const chunks = wrapPreformatted(line, width);
    chunks.forEach((chunk) => result.push(color(chunk)));
  }

  return result;
}

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const lines = content.split('\n');
  let fence: { language: string; buffer: string[] } | null = null;
  let paragraph: string[] = [];
  let blockquote: string[] | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }
    const merged = paragraph.join('\n');
    const trimmedLines = merged
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (!trimmedLines.length) {
      paragraph = [];
      return;
    }

    const isList = trimmedLines.every((line) =>
      /^(\*|-|•|\d+\.)\s+/.test(line)
    );

    if (isList) {
      blocks.push({
        type: 'list',
        items: trimmedLines.map((line) => line.replace(/^(\*|-|•|\d+\.)\s+/, '')),
      });
    } else {
      blocks.push({ type: 'paragraph', text: trimmedLines.join(' ') });
    }
    paragraph = [];
  };

  const flushBlockquote = () => {
    if (!blockquote?.length) {
      blockquote = null;
      return;
    }
    blocks.push({ type: 'quote', lines: blockquote });
    blockquote = null;
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      const raw = line.trim();
      if (fence) {
        blocks.push(
          fence.language.includes('diff')
            ? { type: 'diff', content: fence.buffer.join('\n') }
            : { type: 'code', content: fence.buffer.join('\n'), language: fence.language }
        );
        fence = null;
        continue;
      }

      flushParagraph();
      flushBlockquote();
      const language = raw.slice(3).trim().toLowerCase();
      fence = { language, buffer: [] };
      continue;
    }

    if (fence) {
      fence.buffer.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushBlockquote();
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      blockquote = blockquote ?? [];
      blockquote.push(quoteMatch[1] ?? '');
      continue;
    }

    flushBlockquote();

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      const hashes = headingMatch[1] ?? '';
      const text = headingMatch[2] ?? '';
      blocks.push({ type: 'heading', level: hashes.length, text: text.trim() });
      continue;
    }

    if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ type: 'divider' });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  flushBlockquote();
  return blocks;
}

function formatList(items: string[], width: number): string[] {
  const lines: string[] = [];
  const bulletWidth = 4; // "  • " or "  ✓ "
  const contentWidth = Math.max(10, width - bulletWidth);

  for (const item of items) {
    const formatted = formatInlineText(item);

    // Detect status indicators in list items
    let bulletChar = icons.bullet;
    let bulletColor = theme.secondary;
    let textColor = (s: string) => s; // identity function

    // Check for status patterns like "✅", "🔄", "✓", etc.
    if (/^[✅✓]/u.test(item) || item.toLowerCase().startsWith('done') || item.toLowerCase().startsWith('completed')) {
      bulletChar = '✓';
      bulletColor = theme.success;
    } else if (/^[🔄⏳]/u.test(item) || item.toLowerCase().startsWith('in progress') || item.toLowerCase().startsWith('pending')) {
      bulletChar = '◐';
      bulletColor = theme.warning;
    } else if (/^[❌✗]/u.test(item) || item.toLowerCase().startsWith('failed') || item.toLowerCase().startsWith('error')) {
      bulletChar = '✗';
      bulletColor = theme.error;
    } else if (
      // eslint-disable-next-line no-misleading-character-class
      /^[ℹ️💡]/u.test(item) ||
      item.toLowerCase().startsWith('note:') ||
      item.toLowerCase().startsWith('tip:')
    ) {
      bulletChar = '◇';
      bulletColor = theme.info;
      textColor = theme.dim;
    }

    const bullet = bulletColor(`  ${bulletChar} `);
    const wrapped = wrapParagraph(formatted, contentWidth);
    wrapped.forEach((segment, index) => {
      if (index === 0) {
        lines.push(`${bullet}${textColor(segment)}`);
      } else {
        lines.push(`${' '.repeat(bulletWidth)}${textColor(segment)}`);
      }
    });
  }

  return lines;
}

function formatCodeBlock(code: string, width: number, language?: string): string[] {
  const gutterRaw = isPlainOutputMode() ? '' : '│ ';
  const gutter = theme.ui.muted(gutterRaw);
  const available = Math.max(16, width - measure(gutterRaw));
  const { lines, languageLabel } = highlightAndWrapCode(code, language, available);
  const headerLabel = (languageLabel ?? 'CODE').toUpperCase();
  const result: string[] = [];

  if (isPlainOutputMode()) {
    result.push(theme.ui.muted(`[${headerLabel}]`));
    for (const line of lines) {
      result.push(line);
    }
  } else {
    result.push(`${gutter}${theme.ui.muted(buildCodeDivider(headerLabel, available))}`);
    for (const line of lines) {
      result.push(`${gutter}${line}`);
    }
  }

  return result;
}

function formatHeadingBlock(block: { level: number; text: string }, width: number): string[] {
  const wrapped = wrapParagraph(formatInlineText(block.text), width);
  if (!wrapped.length) {
    return [];
  }
  const accent = pickHeadingAccent(block.level);
  const content: string[] = [];

  if (isPlainOutputMode()) {
    content.push(...wrapped.map((line) => accent(theme.bold(line))));
    return content;
  }

  // Enhanced heading styling based on level
  switch (block.level) {
    case 1: {
      // H1: Bold with decorative box
      const headingIcon = '◆';
      const headerText = wrapped.join(' ');
      const decorWidth = Math.max(0, width - headerText.length - 4);
      const leftDecor = '═'.repeat(Math.floor(decorWidth / 2));
      const rightDecor = '═'.repeat(decorWidth - leftDecor.length);
      content.push(accent(`${leftDecor} ${headingIcon} ${theme.bold(headerText)} ${headingIcon} ${rightDecor}`));
      break;
    }
    case 2: {
      // H2: Bold with underline
      const headerText = wrapped.join(' ');
      content.push(accent(`▸ ${theme.bold(headerText)}`));
      content.push(accent('─'.repeat(Math.min(width, headerText.length + 2))));
      break;
    }
    case 3: {
      // H3: Bold with bullet prefix
      content.push(...wrapped.map((line) => accent(`  ${theme.bold(line)}`)));
      break;
    }
    default: {
      // H4+: Regular bold
      content.push(...wrapped.map((line) => accent(theme.bold(line))));
    }
  }

  return content;
}

function formatQuoteBlock(lines: string[], width: number): string[] {
  if (!lines.length) {
    return [];
  }
  const gutterText = isPlainOutputMode() ? '> ' : '│ ';
  const gutter = theme.ui.muted(gutterText);
  const available = Math.max(12, width - measure(gutterText));
  const result: string[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      result.push(gutter);
      continue;
    }
    const wrapped = wrapParagraph(formatInlineText(line), available);
    wrapped.forEach((segment) => {
      result.push(`${gutter}${segment}`);
    });
  }

  return result;
}

function formatDivider(width: number): string {
  if (isPlainOutputMode()) {
    return theme.ui.muted('---');
  }
  return theme.ui.muted('─'.repeat(width));
}

function buildCodeDivider(label: string, width: number): string {
  const normalized = label.trim() || 'CODE';
  const targetWidth = Math.max(8, width);
  const title = ` ${normalized} `;
  if (title.length >= targetWidth) {
    return title.slice(0, targetWidth);
  }
  const remaining = targetWidth - title.length;
  const left = '─'.repeat(Math.floor(remaining / 2));
  const right = '─'.repeat(remaining - left.length);
  return `${left}${title}${right}`;
}

function pickDiffColor(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return theme.diff.header;
  }
  if (line.startsWith('@@')) {
    return theme.diff.hunk;
  }
  if (line.startsWith('+')) {
    return theme.diff.added;
  }
  if (line.startsWith('-')) {
    return theme.diff.removed;
  }
  if (line.startsWith('diff')) {
    return theme.diff.meta;
  }
  return theme.ui.text;
}

export function formatInlineText(text: string): string {
  if (!text) {
    return '';
  }

  const codeSpans: string[] = [];
  const linkSpans: string[] = [];
  const LINK_PLACEHOLDER = '\u0001';

  let result = text.replace(/`([^`]+)`/g, (_, inner) => {
    codeSpans.push(inner);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  const formatBold = (_match: string, value: string) => theme.bold(value);
  result = result.replace(/\*\*(.+?)\*\*/g, formatBold);
  result = result.replace(/__(.+?)__/g, formatBold);

  const formatItalics = (_match: string, value: string) => theme.italic(value);
  result = result.replace(/(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)/g, formatItalics);
  // Only apply underscore italics when surrounded by whitespace/punctuation (not in SCREAMING_SNAKE_CASE identifiers)
  result = result.replace(/(?<=\s|^|[([{])_([^_\s][^_]*?)_(?=\s|$|[.,!?;:)\]}])/g, formatItalics);

  result = result.replace(/~~(.+?)~~/g, (_match, value) => theme.dim(value));

  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    linkSpans.push(formatMarkdownLink(label, url));
    return `${LINK_PLACEHOLDER}${linkSpans.length - 1}${LINK_PLACEHOLDER}`;
  });

  result = result.replace(/(\bhttps?:\/\/[^\s)]+)([)\]}>,.;:!?"]*)/g, (_match, url, trailing = '') => {
    linkSpans.push(`${formatBareLink(url)}${trailing}`);
    return `${LINK_PLACEHOLDER}${linkSpans.length - 1}${LINK_PLACEHOLDER}`;
  });

  result = result.replace(
    new RegExp(`${LINK_PLACEHOLDER}(\\d+)${LINK_PLACEHOLDER}`, 'g'),
    (_match, index) => linkSpans[Number.parseInt(index, 10)] ?? ''
  );

  // eslint-disable-next-line no-control-regex
  result = result.replace(/\u0000(\d+)\u0000/g, (_match, index) =>
    formatInlineCode(codeSpans[Number.parseInt(index, 10)] ?? '')
  );

  return result;
}

function formatInlineCode(value: string): string {
  const normalized = value.length ? value.trim() : value;
  const display = normalized.length ? normalized : value;
  const snippet = display.replace(/\s+/g, ' ');
  return theme.ui.background(theme.ui.text(` ${snippet} `));
}

/**
 * Wrap text in an OSC 8 hyperlink escape sequence for terminal clickable links.
 * Format: \x1b]8;;URL\x1b\\TEXT\x1b]8;;\x1b\\
 * Supported by: iTerm2, Kitty, Hyper, Windows Terminal, GNOME Terminal 3.26+, etc.
 */
function makeClickableLink(url: string, displayText: string): string {
  // OSC 8 hyperlink: ESC ] 8 ; ; URL ST text ESC ] 8 ; ; ST
  // ST (String Terminator) can be ESC \ or BEL (\x07)
  const OSC = '\x1b]';
  const ST = '\x1b\\';
  return `${OSC}8;;${url}${ST}${displayText}${OSC}8;;${ST}`;
}

function formatMarkdownLink(label: string, url: string): string {
  const cleanUrl = url.trim();
  const cleanLabel = label.trim() || cleanUrl;
  const labelColor = theme.link?.label ?? theme.secondary;
  const urlColor = theme.link?.url ?? theme.info;
  // Make the label clickable, then show URL in parentheses (also clickable)
  const styledLabel = labelColor(cleanLabel);
  const styledUrl = urlColor(`(${cleanUrl})`);
  const clickableLabel = makeClickableLink(cleanUrl, styledLabel);
  const clickableUrl = makeClickableLink(cleanUrl, styledUrl);
  return `${clickableLabel} ${clickableUrl}`;
}

function formatBareLink(url: string): string {
  const colorize = theme.link?.url ?? theme.info;
  const styledUrl = colorize(url.trim());
  return makeClickableLink(url.trim(), styledUrl);
}

function pickHeadingAccent(level: number) {
  if (level <= 1) {
    return theme.primary;
  }
  if (level === 2) {
    return theme.secondary;
  }
  return theme.assistant;
}
