/**
 * Vigil Ink Glyphs — Unicode Box-Drawing & Semantic Symbols
 *
 * Design contract: NO emoji in chrome. All decorative elements use
 * Unicode symbols/glyphs for consistent rendering across terminals.
 * Ported from erosolar-coder's glyph system, adapted for Vigil.
 */

export const GLYPHS = {
  // ── Box drawing ─────────────────────────────────────────
  /** Rounded box corners (Ink borderStyle="round") */
  box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },

  // ── Action markers ──────────────────────────────────────
  /** Filled bullet for agent actions (U+23FA BLACK TRAPEZOID) */
  action: '⏺',
  /** Tool result turn marker (U+23BF DENTISTRY SYMBOL) */
  toolResult: '⎿',
  /** Done/success marker */
  done: '✓',
  /** Error marker */
  error: '✗',

  // ── Cursors ─────────────────────────────────────────────
  /** Menu cursor (U+25B8 BLACK RIGHT-POINTING SMALL TRIANGLE) */
  menuCursor: '▸',
  /** Active step cursor */
  activeStep: '▸',

  // ── Status indicators ───────────────────────────────────
  /** Play/run (U+23F5 BLACK MEDIUM RIGHT-POINTING TRIANGLE) */
  play: '⏵',
  /** Pause/plan (U+23F8 DOUBLE VERTICAL BAR) */
  pause: '⏸',

  // ── Todo checklist ──────────────────────────────────────
  /** Done (U+2612 BALLOT BOX WITH X) */
  todoDone: '☒',
  /** Pending (U+2610 BALLOT BOX) */
  todoPending: '☐',
  /** Active (U+25B8) */
  todoActive: '▸',

  // ── Sparkle animation frames ────────────────────────────
  sparkleFrames: ['·', '✢', '✳', '✶', '✻', '✽'] as const,

  // ── Plan tree ───────────────────────────────────────────
  /** Tree branch (U+2514 BOX DRAWINGS LIGHT UP AND RIGHT) */
  treeBranch: '└',
  /** Plan pending (U+25A1 WHITE SQUARE) */
  planPending: '□',
  /** Plan in progress (U+25D0 CIRCLE WITH LEFT HALF BLACK) */
  planProgress: '◐',
  /** Plan completed (U+2714 HEAVY CHECK MARK) */
  planDone: '✔',

  // ── Diff markers ────────────────────────────────────────
  diffAdd: '+',
  diffRemove: '-',
  diffContext: ' ',

  // ── Misc ────────────────────────────────────────────────
  /** Separator dot */
  separator: '·',
  /** Ellipsis */
  ellipsis: '…',
  /** Arrow right */
  arrowRight: '→',
} as const;
