/**
 * Premium UI Components - Enhanced visual design system for Vigil CLI
 * 
 * Features:
 * - Gradient-powered visual hierarchy
 * - Animated progress indicators  
 * - Enhanced typography with proper spacing
 * - Professional diff visualization
 * - Context-aware color schemes
 */

import { theme, icons } from './theme.js';
import { getContentWidth, normalizePanelWidth, wrapParagraph, measure, stripAnsi } from './layout.js';

export type VisualTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent' | 'thinking' | 'planning' | 'analysis';

const toneConfigs: Record<VisualTone, {
  primary: (text: string) => string;
  secondary: (text: string) => string;
  icon: string;
  gradient: (text: string) => string;
}> = {
  neutral: {
    primary: theme.ui.text,
    secondary: theme.ui.muted,
    icon: '○',
    gradient: theme.gradient.cool,
  },
  info: {
    primary: theme.info,
    secondary: theme.ui.muted,
    icon: 'ℹ️',
    gradient: theme.gradient.ocean,
  },
  success: {
    primary: theme.success,
    secondary: theme.ui.muted,
    icon: '✅',
    gradient: theme.gradient.success,
  },
  warning: {
    primary: theme.warning,
    secondary: theme.ui.muted,
    icon: '⚠️',
    gradient: theme.gradient.warm,
  },
  danger: {
    primary: theme.error,
    secondary: theme.ui.muted,
    icon: '❌',
    gradient: theme.gradient.fire,
  },
  accent: {
    primary: theme.secondary,
    secondary: theme.ui.muted,
    icon: '✨',
    gradient: theme.gradient.neon,
  },
  thinking: {
    primary: theme.neon.cyan,
    secondary: theme.ui.muted,
    icon: '💭',
    gradient: theme.gradient.ocean,
  },
  planning: {
    primary: theme.neon.blue,
    secondary: theme.ui.muted,
    icon: '🗺️',
    gradient: theme.gradient.cool,
  },
  analysis: {
    primary: theme.neon.orange,
    secondary: theme.ui.muted,
    icon: '🔍',
    gradient: theme.gradient.warm,
  },
};

export interface ThoughtDisplayOptions {
  tone?: VisualTone;
  icon?: string;
  label?: string;
  compact?: boolean;
  showTimestamp?: boolean;
  gradientLabel?: boolean;
}

export interface ToolResultDisplayOptions {
  toolName: string;
  summary?: string;
  content: string;
  showDiff?: boolean;
  oldContent?: string;
  newContent?: string;
  showExpandHint?: boolean;
}

export interface ProgressIndicatorOptions {
  phase: string;
  current: number;
  total: number;
  showPercentage?: boolean;
  showBar?: boolean;
  showSteps?: boolean;
  width?: number;
}

/**
 * Format a thought/analysis block with premium visual design
 */
export function formatThought(
  content: string,
  options: ThoughtDisplayOptions = {}
): string {
  const config = toneConfigs[options.tone || 'thinking'];
  const icon = options.icon || config.icon;
  const label = options.label || (options.tone === 'thinking' ? 'thinking' : options.tone || 'note');
  
  const timestamp = options.showTimestamp 
    ? theme.ui.muted(` [${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}]`)
    : '';
  
  const coloredLabel = options.gradientLabel
    ? config.gradient(`${icon} ${label}`)
    : config.primary(`${icon} ${label}`);
  
  const bullet = '⏺';
  const labelPrefix = `${bullet} ${coloredLabel}${timestamp}${theme.ui.muted(' · ')}`;
  const indent = ' '.repeat(measure(labelPrefix) + 1);
  
  // Clean and wrap content
  const cleaned = content.replace(/^[⏺•○]\s*/, '').trim();
  const lines = cleaned.split('\n');
  const result: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) {
      result.push('');
      continue;
    }
    
    if (i === 0) {
      // First line with label
      const wrapped = wrapParagraph(line, getContentWidth() - measure(labelPrefix));
      // First wrapped line gets label prefix
      result.push(`${labelPrefix}${config.primary(wrapped[0] || '')}`);
      
      // Subsequent wrapped lines get indentation
      for (let j = 1; j < wrapped.length; j++) {
        result.push(`${indent}${config.primary(wrapped[j] || '')}`);
      }
    } else {
      // Subsequent lines with full indentation
      const wrapped = wrapParagraph(line, getContentWidth() - measure(indent));
      
      for (const wrappedLine of wrapped) {
        result.push(`${indent}${config.primary(wrappedLine)}`);
      }
    }
  }
  
  return result.join('\n') + '\n';
}

/**
 * Format a tool result with enhanced visualization
 */
export function formatToolResult(
  content: string,
  options: ToolResultDisplayOptions
): string {
  const toolColor = theme.toolColors[options.toolName as keyof typeof theme.toolColors] || theme.toolColors.default;
  const resultIndent = '  ';
  const diffIndent = '    ';
  
  const lines: string[] = [];
  const bullet = '⎿';
  
  // Main summary line
  const coloredToolName = toolColor(`[${options.toolName}]`);
  const summary = options.summary || extractSummary(content);
  
  lines.push(`${resultIndent}${theme.ui.muted(bullet)}  ${coloredToolName} ${theme.ui.text(summary)}`);
  
  // Show diff visualization if available
  if (options.showDiff && (options.oldContent || options.newContent)) {
    lines.push(`${resultIndent}${theme.ui.muted('├─┐')}`);
    
    if (options.oldContent) {
      const oldPreview = truncateWithEllipsis(options.oldContent, 60);
      lines.push(`${resultIndent}${theme.ui.muted('│')} ${theme.error('─ ' + oldPreview)}`);
    }
    
    if (options.newContent) {
      const newPreview = truncateWithEllipsis(options.newContent, 60);
      lines.push(`${resultIndent}${theme.ui.muted('│')} ${theme.success('+ ' + newPreview)}`);
    }
    
    lines.push(`${resultIndent}${theme.ui.muted('└─')}`);
  }
  
  // Expand-hint suppressed: the CLI never wired up a Ctrl+O keybinding,
  // so suggesting one would lie to the user. If we ever ship a real
  // expander, restore the hint here and add the keydown handler at the
  // same time.

  return lines.join('\n') + '\n';
}

/**
 * Format a progress indicator with visual polish
 */
export function formatProgressIndicator(
  options: ProgressIndicatorOptions
): string {
  const width = options.width || getContentWidth() - 20;
  const percentage = Math.round((options.current / options.total) * 100);
  
  const elements: string[] = [];
  
  // Icon - use first frame of spinner
  elements.push(icons.spinner[0] || '◐');
  
  // Phase name
  elements.push(theme.info(options.phase));
  
  // Progress bar
  if (options.showBar !== false) {
    const barWidth = Math.min(20, width - 30);
    const filled = Math.round((percentage / 100) * barWidth);
    const empty = barWidth - filled;
    
    const bar = `${theme.success('█'.repeat(filled))}${theme.ui.muted('░'.repeat(empty))}`;
    elements.push(`[${bar}]`);
  }
  
  // Percentage
  if (options.showPercentage !== false) {
    elements.push(theme.success(`${percentage}%`));
  }
  
  // Step count
  if (options.showSteps !== false) {
    elements.push(theme.ui.muted(`(${options.current}/${options.total})`));
  }
  
  return elements.join(' ');
}

/**
 * Format a beautiful section header with gradient
 */
export function formatSectionHeader(
  title: string,
  subtitle?: string,
  tone: VisualTone = 'accent'
): string {
  const config = toneConfigs[tone];
  const width = getContentWidth();
  
  const headerLine = config.gradient('━'.repeat(width));
  const titleLine = config.gradient(padCenter(title.toUpperCase(), width));
  
  const lines = [headerLine, titleLine];
  
  if (subtitle) {
    const subtitleLine = theme.ui.muted(padCenter(subtitle, width));
    lines.push(subtitleLine);
  }
  
  return lines.join('\n') + '\n';
}

/**
 * Helper: Extract meaningful summary from content
 */
function extractSummary(content: string): string {
  const firstLine = content.split('\n')[0] || content;
  
  // Common patterns
  if (firstLine.match(/(\d+)\s*lines?/i)) {
    const match = firstLine.match(/(\d+)\s*lines?/i);
    return `Found ${match![1]} line${match![1] === '1' ? '' : 's'}`;
  }
  
  if (firstLine.match(/(\d+)\s*(?:files?|matches?)/i)) {
    const match = firstLine.match(/(\d+)\s*(?:files?|matches?)/i);
    return `Found ${match![1]} file${match![1] === '1' ? '' : 's'}`;
  }
  
  if (firstLine.match(/read.*?(\d+)\s*lines?/i)) {
    const match = firstLine.match(/read.*?(\d+)\s*lines?/i);
    return `Read ${match![1]} lines`;
  }
  
  // Default: first 80 chars or until sentence end
  const maxLength = 80;
  if (firstLine.length <= maxLength) {
    return firstLine;
  }
  
  const sentenceEnd = firstLine.slice(0, maxLength).search(/[.!?;]\s|[.!?;]$/);
  if (sentenceEnd > 30) {
    return firstLine.slice(0, sentenceEnd + 1);
  }
  
  const truncated = firstLine.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 40 ? truncated.slice(0, lastSpace) + '…' : truncated + '…';
}

/**
 * Helper: Truncate text with ellipsis
 */
function truncateWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}

/**
 * Helper: Pad text to center within width
 */
function padCenter(text: string, width: number): string {
  const visible = measure(text);
  if (visible >= width) return text;
  
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  
  return ' '.repeat(left) + text + ' '.repeat(right);
}