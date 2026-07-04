/**
 * Vim Mode - Vigil CLI Style
 *
 * Vim-style editing support for the terminal input.
 * Toggle with /vim command or Ctrl+[ to escape.
 *
 * Supported modes:
 * - Normal: Navigation and text manipulation
 * - Insert: Text input mode
 * - Visual: Selection mode (basic)
 *
 * Basic Vim commands:
 * - h/j/k/l: Left/Down/Up/Right
 * - w/b: Word forward/backward
 * - 0/$: Line start/end
 * - i/a: Insert before/after cursor
 * - I/A: Insert at line start/end
 * - o/O: Open line below/above
 * - x: Delete character
 * - dd: Delete line
 * - yy: Yank line
 * - p: Paste
 * - u: Undo
 * - Escape: Exit to normal mode
 */

export type VimMode = 'normal' | 'insert' | 'visual';

export interface VimState {
  mode: VimMode;
  register: string; // Yank register
  count: number; // Repeat count
  pendingCommand: string; // For multi-key commands like 'dd'
  lastCommand: string; // For '.' repeat
  marks: Map<string, number>; // Position marks
}

export interface VimKeyResult {
  handled: boolean;
  newMode?: VimMode;
  cursorDelta?: number;
  textChange?: {
    type: 'insert' | 'delete' | 'replace';
    text?: string;
    start?: number;
    end?: number;
  };
  action?: 'yank' | 'paste' | 'undo';
}

/**
 * Create initial vim state
 */
export function createVimState(): VimState {
  return {
    mode: 'normal',
    register: '',
    count: 0,
    pendingCommand: '',
    lastCommand: '',
    marks: new Map(),
  };
}

/**
 * Check if vim mode is enabled
 */
let vimEnabled = false;

export function isVimEnabled(): boolean {
  return vimEnabled;
}

export function setVimEnabled(enabled: boolean): void {
  vimEnabled = enabled;
}

export function toggleVimMode(): boolean {
  vimEnabled = !vimEnabled;
  return vimEnabled;
}

/**
 * Get mode indicator for display
 */
export function getVimModeIndicator(state: VimState): string {
  if (!vimEnabled) return '';

  switch (state.mode) {
    case 'normal':
      return '-- NORMAL --';
    case 'insert':
      return '-- INSERT --';
    case 'visual':
      return '-- VISUAL --';
    default:
      return '';
  }
}

/**
 * Process a key in vim mode
 */
export function processVimKey(
  key: string,
  state: VimState,
  buffer: string,
  cursor: number
): VimKeyResult {
  if (!vimEnabled) {
    return { handled: false };
  }

  // Handle escape key in any mode
  if (key === '\x1b' || key === '\x1b\x1b') {
    return {
      handled: true,
      newMode: 'normal',
    };
  }

  // Ctrl+[ also escapes (vim standard)
  if (key === '\x1b[') {
    return {
      handled: true,
      newMode: 'normal',
    };
  }

  switch (state.mode) {
    case 'normal':
      return processNormalModeKey(key, state, buffer, cursor);
    case 'insert':
      return processInsertModeKey(key, state, buffer, cursor);
    case 'visual':
      return processVisualModeKey(key, state, buffer, cursor);
    default:
      return { handled: false };
  }
}

/**
 * Process key in normal mode
 */
function processNormalModeKey(
  key: string,
  state: VimState,
  buffer: string,
  cursor: number
): VimKeyResult {
  // Handle number prefix for count
  if (/^[1-9]$/.test(key) || (state.count > 0 && /^[0-9]$/.test(key))) {
    state.count = state.count * 10 + parseInt(key, 10);
    return { handled: true };
  }

  const count = Math.max(1, state.count);
  state.count = 0;

  // Handle pending commands (like 'dd', 'yy')
  if (state.pendingCommand) {
    return processPendingCommand(state.pendingCommand + key, state, buffer, cursor);
  }

  switch (key) {
    // Navigation
    case 'h':
      return { handled: true, cursorDelta: -count };

    case 'l':
      return { handled: true, cursorDelta: count };

    case 'j': {
      // Move down a line
      const lines = buffer.split('\n');
      let pos = 0;
      let lineIdx = 0;
      for (let i = 0; i < lines.length; i++) {
        if (cursor <= pos + lines[i]!.length) {
          lineIdx = i;
          break;
        }
        pos += lines[i]!.length + 1;
      }
      const nextLine = Math.min(lineIdx + count, lines.length - 1);
      let newPos = 0;
      for (let i = 0; i < nextLine; i++) {
        newPos += lines[i]!.length + 1;
      }
      return { handled: true, cursorDelta: newPos - cursor };
    }

    case 'k': {
      // Move up a line
      const lines = buffer.split('\n');
      let pos = 0;
      let lineIdx = 0;
      for (let i = 0; i < lines.length; i++) {
        if (cursor <= pos + lines[i]!.length) {
          lineIdx = i;
          break;
        }
        pos += lines[i]!.length + 1;
      }
      const prevLine = Math.max(lineIdx - count, 0);
      let newPos = 0;
      for (let i = 0; i < prevLine; i++) {
        newPos += lines[i]!.length + 1;
      }
      return { handled: true, cursorDelta: newPos - cursor };
    }

    case 'w': {
      // Word forward
      let pos = cursor;
      for (let i = 0; i < count; i++) {
        // Skip current word
        while (pos < buffer.length && !/\s/.test(buffer[pos]!)) pos++;
        // Skip whitespace
        while (pos < buffer.length && /\s/.test(buffer[pos]!)) pos++;
      }
      return { handled: true, cursorDelta: pos - cursor };
    }

    case 'b': {
      // Word backward
      let pos = cursor;
      for (let i = 0; i < count; i++) {
        // Skip whitespace
        while (pos > 0 && /\s/.test(buffer[pos - 1]!)) pos--;
        // Skip word
        while (pos > 0 && !/\s/.test(buffer[pos - 1]!)) pos--;
      }
      return { handled: true, cursorDelta: pos - cursor };
    }

    case '0':
      // Line start
      return { handled: true, cursorDelta: -getColumnInLine(buffer, cursor) };

    case '$': {
      // Line end
      const lineEnd = buffer.indexOf('\n', cursor);
      const target = lineEnd === -1 ? buffer.length : lineEnd;
      return { handled: true, cursorDelta: target - cursor };
    }

    case '^': {
      // First non-whitespace
      const lineStart = getLineStart(buffer, cursor);
      let pos = lineStart;
      while (pos < buffer.length && buffer[pos] === ' ') pos++;
      return { handled: true, cursorDelta: pos - cursor };
    }

    case 'G':
      // Go to end
      return { handled: true, cursorDelta: buffer.length - cursor };

    case 'g':
      state.pendingCommand = 'g';
      return { handled: true };

    // Mode switching
    case 'i':
      return { handled: true, newMode: 'insert' };

    case 'a':
      return {
        handled: true,
        newMode: 'insert',
        cursorDelta: cursor < buffer.length ? 1 : 0,
      };

    case 'I': {
      const lineStart = getLineStart(buffer, cursor);
      let pos = lineStart;
      while (pos < buffer.length && buffer[pos] === ' ') pos++;
      return { handled: true, newMode: 'insert', cursorDelta: pos - cursor };
    }

    case 'A': {
      const lineEnd = buffer.indexOf('\n', cursor);
      const target = lineEnd === -1 ? buffer.length : lineEnd;
      return { handled: true, newMode: 'insert', cursorDelta: target - cursor };
    }

    case 'o':
      return {
        handled: true,
        newMode: 'insert',
        textChange: {
          type: 'insert',
          text: '\n',
          start: getLineEnd(buffer, cursor),
        },
      };

    case 'O': {
      const lineStart = getLineStart(buffer, cursor);
      return {
        handled: true,
        newMode: 'insert',
        textChange: {
          type: 'insert',
          text: '\n',
          start: lineStart,
        },
        cursorDelta: -cursor + lineStart,
      };
    }

    // Editing
    case 'x':
      return {
        handled: true,
        textChange: {
          type: 'delete',
          start: cursor,
          end: Math.min(cursor + count, buffer.length),
        },
      };

    case 'd':
      state.pendingCommand = 'd';
      return { handled: true };

    case 'y':
      state.pendingCommand = 'y';
      return { handled: true };

    case 'p':
      return {
        handled: true,
        action: 'paste',
      };

    case 'u':
      return {
        handled: true,
        action: 'undo',
      };

    case 'v':
      return { handled: true, newMode: 'visual' };

    default:
      return { handled: false };
  }
}

/**
 * Process pending multi-key commands
 */
function processPendingCommand(
  command: string,
  state: VimState,
  buffer: string,
  cursor: number
): VimKeyResult {
  state.pendingCommand = '';

  switch (command) {
    case 'dd': {
      // Delete line
      const lineStart = getLineStart(buffer, cursor);
      const lineEnd = getLineEnd(buffer, cursor);
      const deleteEnd = lineEnd < buffer.length ? lineEnd + 1 : lineEnd;
      state.register = buffer.slice(lineStart, deleteEnd);
      return {
        handled: true,
        textChange: {
          type: 'delete',
          start: lineStart,
          end: deleteEnd,
        },
      };
    }

    case 'yy': {
      // Yank line
      const lineStart = getLineStart(buffer, cursor);
      const lineEnd = getLineEnd(buffer, cursor);
      state.register = buffer.slice(lineStart, lineEnd + 1);
      return { handled: true, action: 'yank' };
    }

    case 'gg':
      // Go to start
      return { handled: true, cursorDelta: -cursor };

    case 'dw': {
      // Delete word
      let end = cursor;
      while (end < buffer.length && !/\s/.test(buffer[end]!)) end++;
      while (end < buffer.length && /\s/.test(buffer[end]!)) end++;
      return {
        handled: true,
        textChange: {
          type: 'delete',
          start: cursor,
          end,
        },
      };
    }

    default:
      return { handled: false };
  }
}

/**
 * Process key in insert mode
 */
function processInsertModeKey(
  _key: string,
  _state: VimState,
  _buffer: string,
  _cursor: number
): VimKeyResult {
  // In insert mode, most keys pass through to normal input
  // Only escape switches back to normal mode
  return { handled: false };
}

/**
 * Process key in visual mode
 */
function processVisualModeKey(
  key: string,
  state: VimState,
  buffer: string,
  cursor: number
): VimKeyResult {
  // Basic visual mode - for now, just support escape
  switch (key) {
    case 'y':
      // Yank selection (simplified - just current line for now)
      state.register = getCurrentLine(buffer, cursor);
      return { handled: true, newMode: 'normal', action: 'yank' };

    case 'd':
    case 'x': {
      // Delete selection
      const lineStart = getLineStart(buffer, cursor);
      const lineEnd = getLineEnd(buffer, cursor);
      return {
        handled: true,
        newMode: 'normal',
        textChange: {
          type: 'delete',
          start: lineStart,
          end: lineEnd + 1,
        },
      };
    }

    default: {
      // Fall through to normal mode navigation
      const result = processNormalModeKey(key, state, buffer, cursor);
      if (!result.newMode) result.newMode = 'visual';
      return result;
    }
  }
}

// Helper functions

function getLineStart(buffer: string, cursor: number): number {
  let pos = cursor;
  while (pos > 0 && buffer[pos - 1] !== '\n') pos--;
  return pos;
}

function getLineEnd(buffer: string, cursor: number): number {
  let pos = cursor;
  while (pos < buffer.length && buffer[pos] !== '\n') pos++;
  return pos;
}

function getColumnInLine(buffer: string, cursor: number): number {
  return cursor - getLineStart(buffer, cursor);
}

function getCurrentLine(buffer: string, cursor: number): string {
  const start = getLineStart(buffer, cursor);
  const end = getLineEnd(buffer, cursor);
  return buffer.slice(start, end);
}

/**
 * Format vim help for display
 */
export function formatVimHelp(): string {
  return `
Vim Mode Commands:

Navigation:
  h/l       Move left/right
  j/k       Move down/up
  w/b       Word forward/backward
  0/$       Line start/end
  ^         First non-whitespace
  gg/G      Go to start/end

Mode Switching:
  i         Insert before cursor
  a         Insert after cursor
  I/A       Insert at line start/end
  o/O       Open line below/above
  v         Visual mode
  Escape    Normal mode

Editing:
  x         Delete character
  dd        Delete line
  dw        Delete word
  yy        Yank (copy) line
  p         Paste
  u         Undo

Commands can be prefixed with count: 3dd deletes 3 lines
Toggle vim mode with /vim command
`.trim();
}
