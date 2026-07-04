import chalk from 'chalk';
import gradientString from 'gradient-string';

// Type for gradient function returned by gradientString
type GradientFunction = (text: string) => string;

/**
 * Theme system with advanced graphics for the Vigil CLI
 * Enhanced with neon effects, dynamic gradients, and rich visual styling
 */

// Advanced color utilities


// Create a neon glow effect with bright colors
const createNeonStyle = (baseColor: string, glowColor?: string) => {
  const glow = glowColor || baseColor;
  return {
    text: chalk.hex(baseColor).bold,
    bright: chalk.hex(glow).bold,
    dim: chalk.hex(baseColor),
    bg: chalk.bgHex(baseColor).hex('#FFFFFF'),
  };
};

// Naval-cyber palette: abyssal blues, sonar cyan, signal accents.
// Token names retained for compatibility; values shifted to a darker,
// blue-tinted, monochromatic-leaning scheme.
export const palette = {
  // Hull / abyssal surfaces
  obsidian: '#03070E',
  onyx: '#0A1422',
  carbon: '#0E1A2A',
  gunmetal: '#16263A',

  // "Metal" tokens kept as names; values are now slate / sonar-cyan
  gold: '#5DD3FF',
  roseGold: '#7B8CE0',
  silver: '#8AA0B4',
  platinum: '#D8E2EC',
  titanium: '#8A9AA8',
  pearl: '#EAF2FA',

  // Status accents
  emerald: '#3FCF8E',
  sapphire: '#3AA8D4',
  ruby: '#FF5C5C',
  amber: '#FFB454',
  cyan: '#5DD3FF',
  red: '#FF5C5C',
  yellow: '#FFB454',
  orange: '#FFB454',
  green: '#3FCF8E',
  magenta: '#7B8CE0',

  // Aggressive-tool fallbacks; muted into the same family
  neonOrange: '#FFB454',
  neonCyan: '#88E1FF',
};

// Premium neon effect styles with enhanced glow
export const neon = {
  blue: createNeonStyle(palette.sapphire, '#00F7FF'),
  cyan: createNeonStyle(palette.cyan, '#00FFFF'),
  orange: createNeonStyle(palette.neonOrange, '#FF5500'),
  gold: createNeonStyle(palette.gold, '#FFFF00'),
  silver: createNeonStyle(palette.silver, '#FFFFFF'),
  purple: createNeonStyle(palette.sapphire, '#CC00FF'),
  pink: createNeonStyle(palette.roseGold, '#FF00CC'),
  green: createNeonStyle(palette.emerald, '#00FFAA'),
  yellow: createNeonStyle(palette.gold, '#FFEE00'),
  magenta: createNeonStyle(palette.roseGold, '#FF00FF'),
  hologram: createNeonStyle(palette.cyan, palette.roseGold),
  laser: createNeonStyle(palette.emerald, palette.ruby),
  plasma: createNeonStyle(palette.amber, palette.sapphire),
};

export const theme = {
  // Premium primary colors
  primary: chalk.hex(palette.gold).bold, // Gold
  secondary: chalk.hex(palette.platinum).bold, // Platinum
  accent: chalk.hex(palette.silver).bold, // Silver
  success: chalk.hex(palette.emerald).bold, // Green
  warning: chalk.hex(palette.amber).bold, // Amber
  error: chalk.hex(palette.ruby).bold, // Red
  info: chalk.hex(palette.cyan).bold, // Cyan

  // Enhanced text styles
  dim: chalk.hex('#9DA5B2'),
  bold: chalk.bold,
  italic: chalk.italic,
  underline: chalk.underline,
  inverse: chalk.inverse,
  strikethrough: chalk.strikethrough,

  // Premium UI components
  user: chalk.hex(palette.gold).bold,
  assistant: chalk.hex(palette.pearl).bold,
  system: chalk.hex(palette.titanium).bold,
  highlight: chalk.bgHex(palette.obsidian).hex(palette.gold).bold,

  // Premium gradients with enhanced vibrancy and smooth transitions
  gradient: {
    primary: gradientString([palette.gold, palette.platinum, palette.silver]) as GradientFunction,
    pro: gradientString([palette.gold, palette.roseGold, palette.platinum]) as GradientFunction,
    system: gradientString([palette.titanium, palette.silver, palette.platinum, palette.pearl]) as GradientFunction,
    cool: gradientString([palette.titanium, palette.silver, palette.platinum, palette.cyan]) as GradientFunction,
    warm: gradientString([palette.roseGold, palette.gold, palette.amber]) as GradientFunction,
    success: gradientString([palette.emerald, palette.silver, palette.platinum]) as GradientFunction,
    // Premium neon gradients
    neon: gradientString([palette.neonCyan, palette.platinum, palette.silver]) as GradientFunction,
    fire: gradientString([palette.ruby, palette.roseGold, palette.amber, palette.gold]) as GradientFunction,
    ocean: gradientString([palette.gunmetal, palette.titanium, palette.silver, palette.cyan]) as GradientFunction,
    sunset: gradientString([palette.ruby, palette.roseGold, palette.gold, palette.amber]) as GradientFunction,

    // Sonar / haze gradients (palette-only to avoid drift)
    gold: gradientString([palette.gold, palette.neonCyan, palette.platinum]) as GradientFunction,
    silver: gradientString([palette.silver, palette.platinum, palette.pearl]) as GradientFunction,
    platinum: gradientString([palette.platinum, palette.pearl, palette.platinum]) as GradientFunction,
  } as Record<string, GradientFunction>,

  // Neon text styles for special effects
  neon: {
    blue: chalk.hex(palette.sapphire).bold,
    purple: chalk.hex(palette.ruby).bold,
    pink: chalk.hex(palette.roseGold).bold,
    green: chalk.hex(palette.emerald).bold,
    cyan: chalk.hex(palette.cyan).bold,
    yellow: chalk.hex(palette.gold).bold,
    orange: chalk.hex(palette.neonOrange).bold,
  },

  ui: {
    border: chalk.hex(palette.gunmetal),
    background: chalk.bgHex(palette.obsidian),
    userPromptBackground: chalk.bgHex(palette.onyx),
    muted: chalk.hex(palette.titanium),
    text: chalk.hex(palette.platinum),
    highlight: chalk.hex(palette.gold).bold, // Important text
    emphasis: chalk.hex(palette.pearl).bold, // Emphasized text
    code: chalk.hex(palette.silver), // Inline code
    number: chalk.hex(palette.roseGold), // Numbers
    string: chalk.hex(palette.cyan), // Strings
    keyword: chalk.hex(palette.gold), // Keywords
    operator: chalk.hex(palette.titanium), // Operators
  },

  metrics: {
    elapsedLabel: chalk.hex(palette.gold).bold,
    elapsedValue: chalk.hex(palette.silver),
  },

  fields: {
    label: chalk.hex(palette.gold).bold,
    agent: chalk.hex(palette.silver),
    profile: chalk.hex(palette.titanium),
    model: chalk.hex(palette.platinum),
    workspace: chalk.hex(palette.cyan),
  },

  link: {
    label: chalk.hex(palette.gold).underline,
    url: chalk.hex(palette.cyan),
  },

  diff: {
    header: chalk.hex(palette.gold),
    hunk: chalk.hex(palette.silver),
    added: chalk.hex(palette.emerald),
    removed: chalk.hex(palette.ruby),
    meta: chalk.hex(palette.titanium),
  },

  // Thinking/reasoning block styling - distinct from regular output
  thinking: {
    icon: chalk.hex(palette.titanium),        // Titanium icon
    text: chalk.hex(palette.silver),          // Silver thinking content
    border: chalk.hex(palette.gunmetal),      // Gunmetal borders
    label: chalk.hex(palette.platinum).bold,  // Platinum "Thinking" label
  },

  // Badge styles for compact status indicators
  badge: {
    success: chalk.bgHex(palette.emerald).hex(palette.obsidian),     // Green bg, dark text
    error: chalk.bgHex(palette.ruby).hex(palette.pearl),             // Red bg, white text
    warning: chalk.bgHex(palette.amber).hex(palette.obsidian),       // Amber bg, dark text
    info: chalk.bgHex(palette.cyan).hex(palette.obsidian),           // Cyan bg, dark text
    muted: chalk.bgHex(palette.gunmetal).hex(palette.platinum),      // Gray bg, light text
    primary: chalk.bgHex(palette.gold).hex(palette.obsidian),        // Gold bg, dark text
    accent: chalk.bgHex(palette.silver).hex(palette.obsidian),       // Silver bg, dark text
    cached: chalk.bgHex(palette.roseGold).hex(palette.obsidian),     // Rose Gold bg, dark text
  },

  // Inline badge styles (lighter, no background)
  inlineBadge: {
    success: chalk.hex(palette.emerald),    // Light green
    error: chalk.hex(palette.ruby),         // Light red
    warning: chalk.hex(palette.amber),      // Light amber
    info: chalk.hex(palette.cyan),          // Light cyan
    muted: chalk.hex(palette.titanium),     // Gray
    primary: chalk.hex(palette.gold),       // Gold
    accent: chalk.hex(palette.silver),      // Silver
  },

  // Progress indicators
  progress: {
    bar: chalk.hex(palette.gold),           // Progress bar fill
    empty: chalk.hex(palette.gunmetal),     // Progress bar empty
    text: chalk.hex(palette.platinum),      // Progress text
    percentage: chalk.hex(palette.amber),   // Percentage number
  },

  // Status line styles
  status: {
    active: chalk.hex(palette.emerald),     // Active/running status
    pending: chalk.hex(palette.titanium),   // Pending/waiting status
    completed: chalk.hex(palette.silver),   // Completed status
    separator: chalk.hex(palette.gunmetal), // Status separator
  },

  // File operation styles
  file: {
    path: chalk.hex(palette.cyan),          // File paths
    additions: chalk.hex(palette.emerald),  // +X additions
    removals: chalk.hex(palette.ruby),      // -X removals
    unchanged: chalk.hex(palette.titanium), // Unchanged indicator
  },

  // Enhanced edit display styles
  edit: {
    header: chalk.hex(palette.gold).bold,           // Edit header
    filePath: chalk.hex(palette.cyan).bold,         // File being edited
    lineNumber: chalk.hex(palette.titanium),        // Line numbers
    addedLine: chalk.hex(palette.emerald),          // Added lines (green)
    addedBg: chalk.bgHex(palette.gunmetal).hex(palette.emerald),  // Added line background
    removedLine: chalk.hex(palette.ruby),           // Removed lines (red)
    removedBg: chalk.bgHex(palette.carbon).hex(palette.ruby), // Removed line background
    contextLine: chalk.hex(palette.silver),         // Context lines
    separator: chalk.hex(palette.gunmetal),         // Separators
    summary: chalk.hex(palette.platinum),           // Summary text
    badge: chalk.bgHex(palette.gold).hex(palette.obsidian).bold, // Edit badge
  },

  // Search result styles
  search: {
    match: chalk.hex(palette.gold).bold,       // Matching text highlight
    context: chalk.hex(palette.silver),        // Context lines
    lineNum: chalk.hex(palette.titanium),      // Line numbers
    filename: chalk.hex(palette.cyan),         // File names in results
  },

  // Agent/task styles
  agent: {
    name: chalk.hex(palette.gold),             // Agent name
    task: chalk.hex(palette.platinum),         // Task description
    result: chalk.hex(palette.emerald),        // Task result
    duration: chalk.hex(palette.amber),        // Task duration
  },

  // Tool-specific colors for different categories
  toolColors: {
    // Bash/Execute - Gold
    bash: chalk.hex(palette.gold),
    execute: chalk.hex(palette.gold),

    // Read/File operations - Cyan
    read: chalk.hex(palette.cyan),
    file: chalk.hex(palette.cyan),

    // Write/Edit - Silver
    write: chalk.hex(palette.silver),
    edit: chalk.hex(palette.silver),

    // Search/Grep - Titanium
    search: chalk.hex(palette.titanium),
    grep: chalk.hex(palette.titanium),
    glob: chalk.hex(palette.titanium),

    // Web operations - Platinum
    web: chalk.hex(palette.platinum),
    fetch: chalk.hex(palette.platinum),

    // Task/Agent - Rose Gold
    task: chalk.hex(palette.roseGold),
    agent: chalk.hex(palette.roseGold),

    // Todo - Pearl
    todo: chalk.hex(palette.pearl),

    // Notebook - Cyan
    notebook: chalk.hex(palette.cyan),

    // User interaction - Gold
    ask: chalk.hex(palette.gold),

    // Default - Platinum
    default: chalk.hex(palette.platinum),
  },
};

/**
 * Vigil CLI style icons
 * Following the official Vigil CLI UI conventions:
 * - ⏺ (action): Used for tool calls, actions, and thinking/reasoning
 * - ⎿ (subaction): Used for results, details, and nested information
 * - ─ (separator): Horizontal lines for dividing sections (not in this object)
 * - > (user prompt): User input prefix (used in formatUserPrompt)
 */
export const icons = {
  // Status indicators
  success: '✓',
  error: '✗',
  warning: '⚠',
  info: 'ℹ',
  pending: '○',
  running: '◐',
  cached: '⚡',

  // Navigation & flow
  arrow: '→',
  arrowRight: '▸',
  arrowDown: '▾',
  bullet: '•',
  dot: '·',

  // Tool indicators
  thinking: '◐',
  tool: '⚙',
  action: '⏺',      // Vigil CLI: tool actions and thoughts
  subaction: '⎿',   // Vigil CLI: results and details

  // User/assistant
  user: '❯',
  assistant: '◆',
  sparkle: '✨',     // AGI branding

  // Progress & loading
  loading: '⣾',
  spinner: ['◐', '◓', '◑', '◒'],
  progress: ['░', '▒', '▓', '█'],

  // File operations
  file: '📄',
  folder: '📁',
  edit: '✏️',
  read: '📖',
  write: '💾',
  delete: '🗑️',

  // Search & find
  search: '🔍',
  match: '◉',
  noMatch: '○',

  // Grouping & hierarchy
  branch: '│',
  corner: '└',
  tee: '├',
  horizontal: '─',

  // Context & metrics
  context: '⊛',
  time: '⏱',
  memory: '◈',
};

/**
 * Spinner animation frames (braille dots style)
 */
export const spinnerFrames = {
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
  circle: ['◐', '◓', '◑', '◒'],
  bounce: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'],
  braille: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
};

/**
 * Progress bar characters
 */
export const progressChars = {
  filled: '█',
  empty: '░',
  partial: ['▏', '▎', '▍', '▌', '▋', '▊', '▉'],
};

/**
 * Box drawing characters for panels
 */
export const boxChars = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  teeRight: '├',
  teeLeft: '┤',
  cross: '┼',
};

/**
 * Get the appropriate color function for a tool name
 * Returns different colors based on tool category
 */
export function getToolColor(toolName: string): (text: string) => string {
  const name = toolName.toLowerCase();

  // Bash/Execute commands - Orange
  if (name.includes('bash') || name.includes('execute') || name === 'killshell' || name === 'bashoutput') {
    return theme.toolColors.bash;
  }

  // Read/File operations - Cyan
  if (name.includes('read') || name === 'glob' || name === 'list_files') {
    return theme.toolColors.read;
  }

  // Write operations - Green
  if (name.includes('write')) {
    return theme.toolColors.write;
  }

  // Edit operations - Light green
  if (name.includes('edit')) {
    return theme.toolColors.edit;
  }

  // Search/Grep - Yellow
  if (name.includes('grep') || name.includes('search')) {
    return theme.toolColors.grep;
  }

  // Glob pattern search - Amber
  if (name === 'glob') {
    return theme.toolColors.glob;
  }

  // Web operations - Indigo
  if (name.includes('web') || name.includes('fetch')) {
    return theme.toolColors.web;
  }

  // Task/Agent - Purple
  if (name === 'task' || name.includes('agent')) {
    return theme.toolColors.task;
  }

  // Todo - Pink
  if (name.includes('todo')) {
    return theme.toolColors.todo;
  }

  // Notebook - Teal
  if (name.includes('notebook')) {
    return theme.toolColors.notebook;
  }

  // User interaction - Rose
  if (name.includes('ask') || name.includes('question')) {
    return theme.toolColors.ask;
  }

  // Default - Green
  return theme.toolColors.default;
}

/**
 * Format a tool name with category-specific coloring
 */
export function formatToolName(toolName: string): string {
  const colorFn = getToolColor(toolName);
  return colorFn(`[${toolName}]`);
}

export function formatBanner(profileLabel: string, model: string): string {
  const name = profileLabel || 'Agent';
  const title = theme.gradient.primary(name);
  const subtitle = theme.ui.muted(`${model} • Interactive Shell`);

  return `\n${title}\n${subtitle}\n`;
}

export function formatUserPrompt(_profile?: string): string {
  // Always use '>' as the user input prefix for consistent look
  const glyph = theme.user('>');
  return `${glyph} `;
}

/**
 * Get the raw '>' prompt character for display consistency
 */
export const USER_PROMPT_PREFIX = '> ';

export function formatToolCall(name: string, status: 'running' | 'success' | 'error'): string {
  const statusIcon = status === 'running' ? icons.thinking :
                     status === 'success' ? icons.success : icons.error;
  const statusColor = status === 'running' ? theme.info :
                      status === 'success' ? theme.success : theme.error;

  // Use category-specific coloring for tool names
  const toolColor = getToolColor(name);
  return `${statusColor(statusIcon)} ${toolColor(`[${name}]`)}`;
}

export function formatMessage(role: 'user' | 'assistant' | 'system', content: string): string {
  switch (role) {
    case 'user':
      return `${theme.user('You:')} ${content}`;
    case 'assistant':
      return `${theme.assistant('Assistant:')} ${content}`;
    case 'system':
      return theme.system(`[System] ${content}`);
  }
}
