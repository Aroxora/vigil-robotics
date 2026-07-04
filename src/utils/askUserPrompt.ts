import { getTerminalColumns } from '../ui/layout.js';
import { theme } from '../ui/theme.js';

export interface AskUserOption {
  label: string;
  description: string;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  options: AskUserOption[];
  multiSelect: boolean;
}

export const MAX_ASK_USER_OPTIONS = 9; // Previously 4; allow 5 more to show fuller lists

const MIN_PANEL_WIDTH = 32;
const MAX_PANEL_WIDTH = 96;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const OPTION_COLORS = [
  theme.primary,
  theme.info,
  theme.accent,
  theme.success,
  theme.warning,
  theme.secondary,
];

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');
const visibleLength = (value: string): number => stripAnsi(value).length;
const colorForIndex = (index: number): ((value: string) => string) =>
  OPTION_COLORS[index % OPTION_COLORS.length] ?? ((value: string) => value);

const computePanelWidth = (preferred?: number): number => {
  const columns = getTerminalColumns();
  const usable = Number.isFinite(columns) && columns > 0 ? Math.max(columns - 4, MIN_PANEL_WIDTH) : MIN_PANEL_WIDTH;
  const target = preferred ?? 68;
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, Math.min(target, usable)));
};

const wrapText = (text: string, width: number): string[] => {
  const limit = Math.max(1, width);
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [''];
  }

  const lines: string[] = [];
  let current = words.shift()!;

  for (const word of words) {
    const candidate = `${current} ${word}`;
    if (visibleLength(candidate) > limit) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  lines.push(current);
  return lines;
};

export function formatAskUserPrompt(
  question: AskUserQuestion,
  options: { maxOptions?: number; width?: number } = {}
): {
  lines: string[];
  displayOptions: AskUserOption[];
  instruction: string;
  truncated: boolean;
} {
  const panelWidth = computePanelWidth(options.width);
  const maxOptions = Math.max(question.options.length, options.maxOptions ?? question.options.length);
  const displayOptions = question.options.slice(0, maxOptions);
  const truncated = question.options.length > displayOptions.length;

  const divider = theme.ui.muted('─'.repeat(panelWidth));
  const headerLabel = theme.bold(`[${question.header}]`);
  const questionLines = wrapText(question.question, panelWidth - 4);
  const lines: string[] = [];

  lines.push(divider);
  lines.push(`${headerLabel} ${questionLines[0] ?? ''}`.trimEnd());
  for (const line of questionLines.slice(1)) {
    lines.push(`  ${line}`);
  }
  lines.push(divider);

  for (const [index, option] of displayOptions.entries()) {
    const colorize = colorForIndex(index);
    const optionHeader = `${index + 1}. ${option.label}`;
    const optionLines = wrapText(optionHeader, panelWidth - 4).map(line => colorize(line));
    lines.push(` ${optionLines[0] ?? ''}`.trimEnd());
    for (const line of optionLines.slice(1)) {
      lines.push(`   ${line}`);
    }

    const descriptionLines = wrapText(option.description, panelWidth - 6);
    for (const line of descriptionLines) {
      lines.push(`   ${theme.ui.muted(line)}`);
    }
  }

  const otherLabel = `${displayOptions.length + 1}. Other (custom input)`;
  lines.push(` ${theme.accent(otherLabel)}`);
  if (truncated) {
    const hiddenCount = question.options.length - displayOptions.length;
    lines.push(theme.warning(`   +${hiddenCount} more option${hiddenCount === 1 ? '' : 's'} not shown (use "Other" to specify)`));
  }

  const instruction = question.multiSelect
    ? `Select one or more options (comma-separated numbers, e.g., "${theme.primary('1,3')}").`
    : `Select an option (${theme.primary(`1-${displayOptions.length + 1}`)}).`;
  lines.push(theme.ui.muted(instruction));
  lines.push(divider);

  return { lines, displayOptions, instruction, truncated };
}
