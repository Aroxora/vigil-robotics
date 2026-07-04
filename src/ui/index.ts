/**
 * UI Layer — Vigil CLI User Interface System
 *
 * Layers (current stack):
 * - Core primitives: theme.ts, layout.ts, uiConstants.ts, richText.ts
 * - Render helpers: codeHighlighter.ts, textHighlighter.ts, errorFormatter.ts, toolDisplay.ts
 * - Animation: animatedStatus.ts (uses animation/AnimationScheduler)
 * - Renderer + input: src/ui/ink/* — Ink (React-for-terminal). Single
 *   path, no legacy fallback. The previous UnifiedUIRenderer.ts +
 *   PromptController.ts were removed once Ink reached parity.
 * - Integration: outputMode.ts + globalWriteLock.ts for shell safety
 *
 * Usage:
 * - Colors/primitives: import { theme } from './theme.js';
 * - Prompt controller: import { createPromptController } from './ink/InkPromptController.js';
 * - Output selection helpers: import { isPlainOutputMode } from './outputMode.js';
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 1 - Core Primitives
// ═══════════════════════════════════════════════════════════════════════════════

export {
  theme,
  icons,
  spinnerFrames,
  progressChars,
  boxChars,
  formatBanner,
  formatUserPrompt,
  USER_PROMPT_PREFIX,
  formatToolCall,
  formatMessage,
  neon,
  palette,
  getToolColor,
  formatToolName,
} from './theme.js';

// Note: layout.js exports are at the bottom of this file to avoid conflicts
export * from './uiConstants.js';
export * from './designSystem.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 2 - Specialized Renderers
// ═══════════════════════════════════════════════════════════════════════════════

export * from './codeHighlighter.js';
export * from './textHighlighter.js';
export {
  formatError,
  formatErrorList,
  type ErrorInfo,
  type ErrorFormatOptions,
} from './errorFormatter.js';
export * from './toolDisplay.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 3 - Components
// ═══════════════════════════════════════════════════════════════════════════════

export * from './animatedStatus.js';

// Premium UI Components (enhanced visual design system)
export {
  formatThought,
  formatToolResult as formatToolResultPremium,
  formatProgressIndicator,
  formatSectionHeader,
  type ThoughtDisplayOptions,
  type ToolResultDisplayOptions,
  type ProgressIndicatorOptions,
  type VisualTone,
} from './premiumComponents.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 4 - Controllers + Renderer (Ink)
// ═══════════════════════════════════════════════════════════════════════════════

export {
  createPromptController,
  InkPromptController,
  type IPromptController,
  type PromptCallbacks,
  type EditGuardMode,
  type CommandSuggestion,
  type MenuItem,
} from './ink/InkPromptController.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Layer 6 - Integration
// ═══════════════════════════════════════════════════════════════════════════════

export * from './outputMode.js';
export {
  isStreamingMode,
  enterStreamingMode,
  exitStreamingMode,
  ifNotStreaming,
  whenStreamingEnds,
  withStreamLock,
  forceRelease,
  installGlobalWriteLock,
  resetGlobalWriteLock,
} from './globalWriteLock.js';

// Re-export layout utilities explicitly to avoid conflicts
export {
  getTerminalColumns,
  isUltraNarrowMode,
  getContentWidth,
  wrapParagraph,
  wrapPreformatted,
  normalizePanelWidth,
  renderPanel,
  measure,
  stripAnsi,
  padLine,
  truncate,
  type Colorize,
  type PanelOptions,
} from './layout.js';
