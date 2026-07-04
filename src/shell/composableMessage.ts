/**
 * ComposableMessage - Data structure for building messages from multiple parts
 *
 * Handles multi-line pastes by storing them as editable blocks that can be:
 * - Displayed as summaries
 * - Edited individually
 * - Assembled into a final message when sent
 *
 * Architecture:
 * - MessagePart: Union type for text or paste blocks
 * - ComposableMessageBuilder: Manages parts and provides editing/assembly
 * - UI helpers: Format blocks for display with summaries
 */

import { theme } from '../ui/theme.js';

export type MessagePartType = 'text' | 'paste';

export interface TextPart {
  type: 'text';
  id: string;
  content: string;
  timestamp: number;
}

export interface PastePart {
  type: 'paste';
  id: string;
  content: string;
  lineCount: number;
  timestamp: number;
  summary: string; // First line or truncated preview
  edited: boolean;
}

export type MessagePart = TextPart | PastePart;

export interface ComposableMessageState {
  parts: MessagePart[];
  currentDraft: string; // Current input line being typed
}

/**
 * Paste size warning thresholds
 */
export const PASTE_LIMITS = {
  WARN_CHARS: 10000,    // Warn when paste exceeds 10KB
  WARN_LINES: 100,      // Warn when paste exceeds 100 lines
  MAX_CHARS: 500000,    // Hard limit at 500KB
  MAX_LINES: 5000,      // Hard limit at 5000 lines
} as const;

/**
 * Paste size check result
 */
export interface PasteSizeCheck {
  ok: boolean;
  warning?: string;
  error?: string;
  chars: number;
  lines: number;
}

/**
 * Builds messages from composable parts (text + paste blocks)
 * Allows editing blocks before final assembly
 *
 * Features:
 * - Undo/redo support for paste operations
 * - Size warnings for large pastes
 * - Inline editing of paste blocks
 */
export class ComposableMessageBuilder {
  private parts: MessagePart[] = [];
  private currentDraft: string = '';
  private idCounter: number = 0;

  // History for undo/redo
  private history: MessagePart[][] = [];
  private historyIndex: number = -1;
  private maxHistorySize: number = 20;

  constructor() {
    this.saveHistory();
  }

  /**
   * Save current state to history
   */
  private saveHistory(): void {
    // Remove any redo states
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }

    // Save current state
    this.history.push(this.parts.map(p => ({ ...p })));
    this.historyIndex = this.history.length - 1;

    // Limit history size
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
      this.historyIndex--;
    }
  }

  /**
   * Undo last operation
   */
  undo(): boolean {
    if (this.historyIndex <= 0) {
      return false;
    }

    this.historyIndex--;
    this.parts = this.history[this.historyIndex]!.map(p => ({ ...p }));
    return true;
  }

  /**
   * Redo last undone operation
   */
  redo(): boolean {
    if (this.historyIndex >= this.history.length - 1) {
      return false;
    }

    this.historyIndex++;
    this.parts = this.history[this.historyIndex]!.map(p => ({ ...p }));
    return true;
  }

  /**
   * Check if undo is available
   */
  canUndo(): boolean {
    return this.historyIndex > 0;
  }

  /**
   * Check if redo is available
   */
  canRedo(): boolean {
    return this.historyIndex < this.history.length - 1;
  }

  /**
   * Check paste size and return warnings/errors
   */
  static checkPasteSize(content: string): PasteSizeCheck {
    const chars = content.length;
    const lines = content.split('\n').length;

    // Hard limits
    if (chars > PASTE_LIMITS.MAX_CHARS) {
      return {
        ok: false,
        error: `Paste too large: ${(chars / 1000).toFixed(1)}KB exceeds ${(PASTE_LIMITS.MAX_CHARS / 1000)}KB limit`,
        chars,
        lines,
      };
    }

    if (lines > PASTE_LIMITS.MAX_LINES) {
      return {
        ok: false,
        error: `Paste too long: ${lines} lines exceeds ${PASTE_LIMITS.MAX_LINES} line limit`,
        chars,
        lines,
      };
    }

    // Warnings
    const warnings: string[] = [];
    if (chars > PASTE_LIMITS.WARN_CHARS) {
      warnings.push(`Large paste: ${(chars / 1000).toFixed(1)}KB`);
    }
    if (lines > PASTE_LIMITS.WARN_LINES) {
      warnings.push(`${lines} lines`);
    }

    return {
      ok: true,
      warning: warnings.length > 0 ? warnings.join(', ') : undefined,
      chars,
      lines,
    };
  }

  /**
   * Get current state
   */
  getState(): ComposableMessageState {
    return {
      parts: [...this.parts],
      currentDraft: this.currentDraft,
    };
  }

  /**
   * Check if message is empty
   */
  isEmpty(): boolean {
    return this.parts.length === 0 && !this.currentDraft.trim();
  }

  /**
   * Check if message has content
   */
  hasContent(): boolean {
    return !this.isEmpty();
  }

  /**
   * Get number of parts
   */
  getPartCount(): number {
    return this.parts.length;
  }

  /**
   * Set current draft text
   */
  setDraft(text: string): void {
    this.currentDraft = text;
  }

  /**
   * Get current draft
   */
  getDraft(): string {
    return this.currentDraft;
  }

  /**
   * Add a text part from current draft
   */
  commitDraft(): void {
    const trimmed = this.currentDraft.trim();
    if (!trimmed) {
      return;
    }

    this.parts.push({
      type: 'text',
      id: this.generateId(),
      content: trimmed,
      timestamp: Date.now(),
    });

    this.currentDraft = '';
  }

  /**
   * Add a paste block
   * @returns Paste ID, or null if paste was rejected due to size limits
   */
  addPaste(content: string): string | null {
    // Check paste size
    const sizeCheck = ComposableMessageBuilder.checkPasteSize(content);
    if (!sizeCheck.ok) {
      // Paste rejected - return null, caller should show error
      return null;
    }

    const lines = content.split('\n');
    const lineCount = lines.length;
    const summary = this.generateSummary(content, lineCount);
    const id = this.generateId();

    this.parts.push({
      type: 'paste',
      id,
      content,
      lineCount,
      summary,
      timestamp: Date.now(),
      edited: false,
    });

    // Save to history for undo
    this.saveHistory();

    return id;
  }

  /**
   * Add a paste block without size check (for internal use)
   */
  addPasteUnchecked(content: string): string {
    const lines = content.split('\n');
    const lineCount = lines.length;
    const summary = this.generateSummary(content, lineCount);
    const id = this.generateId();

    this.parts.push({
      type: 'paste',
      id,
      content,
      lineCount,
      summary,
      timestamp: Date.now(),
      edited: false,
    });

    this.saveHistory();
    return id;
  }

  /**
   * Edit a paste block by ID
   */
  editPaste(id: string, newContent: string): boolean {
    const part = this.parts.find((p) => p.id === id && p.type === 'paste') as PastePart | undefined;
    if (!part) {
      return false;
    }

    const lines = newContent.split('\n');
    part.content = newContent;
    part.lineCount = lines.length;
    part.summary = this.generateSummary(newContent, lines.length);
    part.edited = true;

    // Save to history for undo
    this.saveHistory();

    return true;
  }

  /**
   * Remove a part by ID
   */
  removePart(id: string): boolean {
    const index = this.parts.findIndex((p) => p.id === id);
    if (index === -1) {
      return false;
    }

    this.parts.splice(index, 1);

    // Save to history for undo
    this.saveHistory();

    return true;
  }

  /**
   * Get a part by ID
   */
  getPart(id: string): MessagePart | null {
    return this.parts.find((p) => p.id === id) ?? null;
  }

  /**
   * Assemble final message from all parts
   */
  assemble(): string {
    const parts: string[] = [];

    // Add all committed parts
    for (const part of this.parts) {
      parts.push(part.content);
    }

    // Add current draft if non-empty
    const draftTrimmed = this.currentDraft.trim();
    if (draftTrimmed) {
      parts.push(draftTrimmed);
    }

    return parts.join('\n\n').trim();
  }

  /**
   * Clear all parts and draft
   */
  clear(): void {
    if (this.parts.length > 0) {
      // Save to history for undo before clearing
      this.saveHistory();
    }
    this.parts = [];
    this.currentDraft = '';
  }

  /**
   * Format for display in chat
   */
  formatForDisplay(): string {
    if (this.parts.length === 0) {
      return this.currentDraft;
    }

    const lines: string[] = [];

    for (const part of this.parts) {
      if (part.type === 'text') {
        lines.push(part.content);
      } else if (part.type === 'paste') {
        const header = theme.ui.muted(
          `[Block ${this.parts.indexOf(part) + 1}: ${part.lineCount} lines${part.edited ? ', edited' : ''}]`
        );
        const preview = theme.secondary(
          part.summary.length > 60 ? `${part.summary.slice(0, 57)  }...` : part.summary
        );
        lines.push(`${header}\n${preview}`);
      }
    }

    if (this.currentDraft.trim()) {
      lines.push(this.currentDraft);
    }

    return lines.join('\n\n');
  }

  /**
   * Format summary for status display
   */
  formatSummary(): string {
    const partCount = this.parts.length;
    const hasDraft = Boolean(this.currentDraft.trim());

    if (partCount === 0 && hasDraft) {
      return 'Current input';
    }

    if (partCount === 1 && !hasDraft) {
      const part = this.parts[0]!;
      return part.type === 'paste' ? `1 pasted block (${part.lineCount} lines)` : 'Text input';
    }

    const parts: string[] = [];
    if (partCount > 0) {
      const pasteCount = this.parts.filter((p) => p.type === 'paste').length;
      if (pasteCount > 0) {
        parts.push(`${pasteCount} block${pasteCount > 1 ? 's' : ''}`);
      }
    }
    if (hasDraft) {
      parts.push('text');
    }

    return parts.join(' + ');
  }

  /**
   * Format paste blocks for prompt display.
   * Returns empty string - paste blocks are now displayed as actual content.
   */
  formatPasteChips(): string {
    return '';
  }

  /**
   * Get count of paste blocks only
   */
  getPasteBlockCount(): number {
    return this.parts.filter((p) => p.type === 'paste').length;
  }

  /**
   * Generate a summary for a paste block
   */
  private generateSummary(content: string, lineCount: number): string {
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);

    if (lines.length === 0) {
      return `[${lineCount} empty lines]`;
    }

    // Use first non-empty line as summary
    const firstLine = lines[0] || '';
    const maxLength = 80;

    if (firstLine.length <= maxLength) {
      return firstLine;
    }

    return `${firstLine.slice(0, maxLength - 3)  }...`;
  }

  /**
   * Generate unique ID for parts
   */
  private generateId(): string {
    this.idCounter += 1;
    return `part-${this.idCounter}-${Date.now()}`;
  }
}
