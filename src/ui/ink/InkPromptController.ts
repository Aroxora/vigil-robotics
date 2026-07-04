/**
 * InkPromptController — the single renderer for the interactive shell.
 * The legacy PromptController and the env-gated migration adapter were
 * removed 2026-05-09; createPromptController() always returns an
 * InkPromptController instance.
 *
 * Goal: satisfy every method that src/headless/interactiveShell.ts calls
 * so the rest of the codebase doesn't notice the swap. Live methods
 * (status, history, secret mode, menu) drive an Ink reconciler commit;
 * decorative methods that don't yet have an Ink implementation are
 * marked as TODOs and behave as no-ops, with the call recorded so
 * future hardening can fill the gaps with real behaviour rather than
 * silent drift.
 *
 * Renderer shim: interactiveShell.ts also calls a handful of methods
 * directly via promptController.getRenderer() — addEvent, addOutputTap,
 * captureInput, clearBuffer, setSecretMode, forceRender. We expose a
 * facade implementing exactly those.
 */

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable, Readable } from 'node:stream';
import type { Instance as InkInstance } from 'ink';
import type { ChatItem } from './ChatStatic.js';
import type { Suggestion } from './App.js';

// Types previously re-exported from the legacy UnifiedUIRenderer +
// PromptController. Inlined here so the Ink path stands alone — the
// legacy renderer files have been removed.
export type EditGuardMode = 'display-edits' | 'require-approval' | 'block-writes' | 'ask-permission' | 'plan';

export interface PromptCallbacks {
  onSubmit: (text: string) => void;
  onQueue: (text: string) => void;
  onInterrupt: () => void;
  onExit?: () => void;
  onCtrlC?: (info: { hadBuffer: boolean }) => void;
  onResume?: () => void;
  onChange?: (event: { text: string; cursor: number }) => void;
  onEditModeChange?: (mode: EditGuardMode) => void;
  onToggleAutoContinue?: () => void;
  onClearContext?: () => void;
  onExpandToolResult?: () => void;
  onToggleHITL?: () => void;
}

export interface CommandSuggestion {
  command: string;
  description: string;
  category?: string;
}

export interface MenuItem {
  id: string;
  label: string;
  description?: string;
  category?: string;
  disabled?: boolean;
  isActive?: boolean;
}

type Mode = 'idle' | 'streaming';

interface ModeToggleState {
  autoMode: 'off' | 'on';
  autoContinueHotkey?: string;
  debugEnabled?: boolean;
  hitlMode: 'off' | 'on';
  hitlHotkey?: string;
}

/** Map RendererEventType (UnifiedUIRenderer) to ChatItem.kind. */
const EVENT_KIND_MAP: Record<string, ChatItem['kind']> = {
  banner: 'banner',
  system: 'system',
  error: 'error',
  response: 'assistant',
  stream: 'assistant',
  thought: 'system',
  tool: 'tool',
  'tool-call': 'tool',
  'tool-result': 'tool-result',
  raw: 'system',
  streaming: 'system',
};

interface RendererTap {
  (type: string, content: string): void;
}

/**
 * The minimal subset of the legacy UnifiedUIRenderer that
 * interactiveShell.ts actually calls. Backed by Ink state under the
 * hood. Method signatures match the legacy renderer exactly — the
 * caller can't tell which implementation it's holding.
 */
class InkRendererShim extends EventEmitter {
  private taps: Set<RendererTap> = new Set();
  private resolveCapture: ((value: string) => void) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly owner: InkPromptController) {
    super();
  }

  addEvent(type: string, content: string): void {
    // Always feed the taps first — they observe the raw event stream
    // even if the type is filtered out of the visible history.
    for (const tap of this.taps) {
      try { tap(type, content); } catch { /* tap errors must not break rendering */ }
    }

    // Thoughts are the model's pre-response reasoning. Showing them as
    // plain chat lines (which my previous map did) leaks "The user
    // just said 'hi' — this is a greeting…" into the visible
    // transcript right above the actual answer. Drop them from the
    // chat surface; debug mode can re-enable later.
    if (type === 'thought' || type === 'streaming') return;

    if (type === 'stream') {
      // Coalesce streaming deltas into a single growing assistant
      // message. Pre-fix this rendered "Hi How can I help you today"
      // as one word per line because each delta became its own
      // ChatItem. Now the in-progress message lives in
      // owner._streamingText and renders in a non-Static slot above
      // the prompt; on the next non-stream event (typically the
      // 'response' completion) we commit it as a Static entry.
      this.owner._appendStreamingDelta(content);
      return;
    }

    if (type === 'response') {
      // Streaming is finishing. Replace the in-progress text with the
      // canonical final content (the streamed chunks may have lost
      // formatting under markdown wrapping) and commit to history.
      this.owner._commitStreaming(content);
      return;
    }

    // Non-streaming events: a brand-new committed history entry. Also
    // finalises any in-progress streaming message in case the model
    // emitted a tool/system event between deltas.
    this.owner._finalizeStreamingIfAny();
    const kind = EVENT_KIND_MAP[type] ?? 'system';
    this.owner._appendHistoryEntry({ id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind, text: content });
  }

  addOutputTap(fn: RendererTap): () => void {
    this.taps.add(fn);
    return () => { this.taps.delete(fn); };
  }

  /**
   * Resolve the next user submission with the typed text. Used by the
   * sudo-password capture flow in interactiveShell.ts.
   *
   * Implementation: stash a resolver, swap the prompt callbacks for one
   * that resolves it, restore on submit. The owner runs setSecretMode
   * around the call site.
   */
  captureInput(_opts: { allowEmpty?: boolean; trim?: boolean; resetBuffer?: boolean } = {}): Promise<string> {
    // If HITL has suspended input, resolve immediately with empty string
    if (this._inputCaptureSuspended) return Promise.resolve('');
    return new Promise<string>((resolve) => {
      this.resolveCapture = resolve;
      this.owner._installCaptureHandler((text) => {
        const trim = _opts.trim !== false;
        const value = trim ? text.trim() : text;
        if (this.resolveCapture) {
          const r = this.resolveCapture;
          this.resolveCapture = null;
          this.owner._restoreSubmitHandler();
          if (_opts.resetBuffer !== false) this.owner._setBuffer('');
          r(value);
        }
      });
    });
  }

  clearBuffer(): void {
    this.owner._setBuffer('');
  }

  setSecretMode(enabled: boolean): void {
    this.owner._setSecretMode(enabled);
  }

  /** No-op. Ink owns its render loop; manual force is unnecessary. */
  forceRender(): void { /* no-op — Ink reconciler handles redraws */ }

  /** Shape parity with the legacy renderer; returns a fixed false. */
  supportsInlinePanel(): boolean { return true; }

  /**
   * Used by interactiveShell.ts when re-rendering a tool result after
   * the user expands it. Live update: append a new history entry with
   * the expanded content.
   */
  expandLastToolResult(): boolean { return false; }

  /**
   * HITL suspend: stop the main prompt from capturing keyboard input so
   * the HITL decision menu owns the terminal exclusively. Also signals
   * the prompt controller to flush any pending render.
   */
  private _inputCaptureSuspended = false;

  suspendPromptRendering(): void {
    this.owner._suspendForHITL(true);
  }

  suspendInputCapture(): void {
    this._inputCaptureSuspended = true;
    // Cancel any in-progress capture to free up input for HITL menu
    if (this.resolveCapture) {
      const r = this.resolveCapture;
      this.resolveCapture = null;
      this.owner._restoreSubmitHandler();
      r('');
    }
  }

  resumeInputCapture(): void {
    this._inputCaptureSuspended = false;
  }

  resumePromptRendering(force: boolean): void {
    this.owner._suspendForHITL(false);
    if (force) {
      this.owner._forceRerender();
    }
  }

  isInputCaptureSuspended(): boolean {
    return this._inputCaptureSuspended;
  }
  getCollapsedResultCount(): number { return 0; }
}

export interface IPromptController extends EventEmitter {
  start(): void;
  stop(): void;
  setStreaming(s: boolean): void;
  getMode(): Mode;
  setContextUsage(p: number | null): void;
  setModeToggles(opts: Partial<ModeToggleState>): void;
  setDebugMode(enabled: boolean): void;
  toggleAutoContinue(): void;
  getAutoMode(): 'off' | 'on';
  setAutoMode(m: 'off' | 'on'): void;
  toggleHITL(): void;
  getHITLMode(): 'off' | 'on';
  getModeToggleState(): Readonly<ModeToggleState>;
  setStatusMessage(message: string | null): void;
  setOverrideStatus(message: string | null): void;
  setStreamingLabel(label: string | null): void;
  setStatusLine(s: { main?: string | null; override?: string | null; streaming?: string | null }): void;
  setMetaStatus(meta: { elapsedSeconds?: number | null; tokensUsed?: number | null; tokenLimit?: number | null; thinkingMs?: number | null; thinkingHasContent?: boolean }): void;
  clearAllStatus(): void;
  setModelContext(opts: { model?: string | null; provider?: string | null }): void;
  setChromeMeta(meta: { workspace?: string; directory?: string; writes?: string; sessionLabel?: string; thinkingLabel?: string; autosave?: boolean; version?: string }): void;
  setAvailableCommands(commands: CommandSuggestion[]): void;
  setInlinePanel(lines: string[]): void;
  clearInlinePanel(): void;
  supportsInlinePanel(): boolean;
  setPinnedPrompt(text: string | null): void;
  getPinnedPrompt(): string | null;
  clearPinnedPrompt(): void;
  setMenu(items: MenuItem[], options: { title?: string; initialIndex?: number }, callback: (item: MenuItem | null) => void): void;
  closeMenu(): void;
  isMenuActive(): boolean;
  setActivityMessage(message: string | null): void;
  /** Commit any pending streaming text to history. No-op if empty. */
  flushStreaming(): void;
  setEditMode(mode: EditGuardMode): void;
  applyEditMode(mode: EditGuardMode): void;
  getEditMode(): EditGuardMode;
  getBuffer(): string;
  getCursor(): number;
  setBuffer(text: string, cursorPos?: number): void;
  setSecretMode(enabled: boolean): void;
  clear(): void;
  render(): void;
  forceRender(): void;
  handleResize(): void;
  dispose(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRenderer(): any;
}

export class InkPromptController extends EventEmitter implements IPromptController {
  private readonly callbacks: PromptCallbacks;
  // ink module + App component imported lazily on start() so non-Ink
  // codepaths don't pay the React parse cost.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private inkRender: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private React: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private AppComponent: any = null;
  private inst: InkInstance | null = null;
  private readonly shim = new InkRendererShim(this);
  private readonly stdin: Readable;
  private readonly stdout: Writable;

  // In-progress assistant message — accumulates 'stream' deltas. While
  // non-null it renders below <Static> in a regular Ink Box so the text
  // grows in place. Committed to history on 'response' (or finalised
  // when any non-stream event arrives mid-flight).
  private streamingText = '';

  // ── live state ────────────────────────────────────────────────
  private statusMain: string | null = null;
  private statusOverride: string | null = null;
  private statusStreaming: string | null = null;
  private activityMessage: string | null = null;
  private mode: Mode = 'idle';
  private metaInfo: { contextPercent?: number; sessionTime?: string; model?: string; provider?: string; workspace?: string; directory?: string } = {};
  private vigilContext: { targets?: number; findings?: number; critHigh?: number } = {};
  private history: ChatItem[] = [];
  private suggestions: Suggestion[] = [];
  private allCommands: Suggestion[] = []; // full command registry for incremental filtering
  private inlinePanel: string[] | null = null;
  private secretMode = false;
  private editMode: EditGuardMode = 'display-edits';
  private pinnedPrompt: string | null = null;
  private modeToggleState: ModeToggleState = {
    autoMode: 'on',
    autoContinueHotkey: '⌥G',
    hitlMode: 'off',
    hitlHotkey: '⌥V',
  };
  private buffer = '';
  // Set by InkRendererShim.captureInput — temporarily replaces onSubmit.
  private captureSubmit: ((text: string) => void) | null = null;
  private menuCallback: ((item: MenuItem | null) => void) | null = null;
  private menuItems: MenuItem[] = [];
  private menuOpen = false;
  // True while a `core/hitl.ts` raw-mode menu is on screen. The HITL
  // path takes over the terminal with `\x1b[2J\x1b[H` + console.log;
  // if Ink keeps rendering through that, every rerender stomps on the
  // HITL menu and every up/down arrow leaves stale ghost frames around
  // the selection. Set true on `hitlEvents:prompt-open`, cleared on
  // `prompt-close`. While true, buildTree returns a minimal tree so
  // Ink's live region is empty and HITL owns the screen unilaterally.
  private hitlOpen = false;
  // Pending HITL request rendered inline in the main Ink tree (via
  // the presenter registered with the HITL system). When set, the
  // buildTree() renders the HitlDecision component instead of the
  // normal prompt UI. Cleared on prompt-close.
  private _pendingHitlRequest: {
    title: string; description?: string; context?: string;
    options: Array<{ id: string; label: string; description?: string }>;
    customId: string;
  } | null = null;
  private _pendingHitlResolve: ((r: { selectedOptionId: string; userInput?: string }) => void) | null = null;
  private _HitlDecisionComponent: React.ComponentType<any> | null = null;
  private hitlListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  private started = false;
  private disposed = false;

  constructor(stdin: Readable, stdout: Writable, callbacks: PromptCallbacks) {
    super();
    this.stdin = stdin;
    this.stdout = stdout;
    this.callbacks = callbacks;
  }

  // ── lifecycle ─────────────────────────────────────────────────

  /**
   * Async start so the Ink + React modules can be loaded via dynamic
   * import (the dist build emits ESM under `module: NodeNext`, where
   * `require()` mixed with top-level await is a hard error in Node 22+).
   * Call sites that go through createPromptController() should await
   * .start(); the legacy controller's start() is sync, so the IPrompt
   * interface defines start() as `void` and we coerce here.
   */
  start(): void { void this.startAsync(); }

  private async startAsync(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    const [ink, react, appMod, hitl] = await Promise.all([
      import('ink'),
      import('react'),
      import('./App.js'),
      import('../../core/hitl.js'),
    ]);
    this.React = react;
    this.AppComponent = appMod.App;
    this.inkRender = ink.render;
    this.inst = this.inkRender(this.buildTree(), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdin: this.stdin as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stdout: this.stdout as any,
      // exitOnCtrlC=false so the host's onCtrlC callback fires first.
      exitOnCtrlC: false,
    });

    // Suspend Ink rendering while the raw-mode HITL menu owns the
    // screen. Without this, every up/down keystroke in HITL races
    // with an Ink rerender — Ink's live region paints over the
    // selection marker, HITL's `\x1b[2J\x1b[H` clears Ink's frame,
    // and the user sees a flickering hybrid of the two.
    const onOpen = () => { this.hitlOpen = true; this.rerender(); };
    const onClose = () => { this.hitlOpen = false; this._pendingHitlRequest = null; this._pendingHitlResolve = null; this.rerender(); };
    hitl.hitlEvents.on('prompt-open', onOpen);
    hitl.hitlEvents.on('prompt-close', onClose);
    this.hitlListeners.push(
      { event: 'prompt-open', fn: onOpen as (...args: unknown[]) => void },
      { event: 'prompt-close', fn: onClose as (...args: unknown[]) => void },
    );

    // Load and register the inline HITL presenter so the decision menu
    // renders in the main Ink tree (no separate mount, no stdin fight).
    const hitlMenu = await import('./HitlDecisionMenu.js');
    this._HitlDecisionComponent = hitlMenu.HitlDecision;
    hitl.setHitlPresenter(async (req) => {
      return new Promise((resolve) => {
        this._pendingHitlRequest = req;
        this._pendingHitlResolve = resolve;
        this.hitlOpen = true;
        this.rerender();
      });
    });
  }

  stop(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    // Detach hitlEvents listeners so a later HITL prompt-open after
    // shutdown doesn't try to rerender a torn-down Ink instance.
    if (this.hitlListeners.length) {
      void import('../../core/hitl.js').then((hitl) => {
        for (const l of this.hitlListeners) {
          try { hitl.hitlEvents.removeListener(l.event, l.fn); } catch { /* ignore */ }
        }
        this.hitlListeners = [];
      }).catch(() => { /* ignore */ });
    }
    try { this.inst?.unmount(); } catch { /* ignore */ }
    this.inst = null;
  }

  dispose(): void { this.stop(); }

  /** Manual repaint hook — Ink owns its tick, so render/forceRender are coalesced into a rerender(). */
  render(): void { this.rerender(); }
  forceRender(): void { this.rerender(); }
  handleResize(): void { /* Ink subscribes to SIGWINCH itself */ }

  // ── status / activity / streaming ─────────────────────────────

  setStatusMessage(message: string | null): void { this.statusMain = (message?.trim() || null); this.rerender(); }
  setOverrideStatus(message: string | null): void { this.statusOverride = (message?.trim() || null); this.rerender(); }
  setStreamingLabel(label: string | null): void { this.statusStreaming = (label?.trim() || null); this.rerender(); }
  setStatusLine(status: { main?: string | null; override?: string | null; streaming?: string | null }): void {
    if ('main' in status) this.statusMain = status.main?.trim() || null;
    if ('override' in status) this.statusOverride = status.override?.trim() || null;
    if ('streaming' in status) this.statusStreaming = status.streaming?.trim() || null;
    this.rerender();
  }
  clearAllStatus(): void {
    this.statusMain = null; this.statusOverride = null; this.statusStreaming = null;
    this.activityMessage = null;
    this.rerender();
  }
  setActivityMessage(message: string | null): void { this.activityMessage = message; this.rerender(); }

  flushStreaming(): void {
    if (this.streamingText) {
      this._commitStreaming('');
    }
  }

  setStreaming(streaming: boolean): void { this.mode = streaming ? 'streaming' : 'idle'; this.rerender(); }
  getMode(): Mode { return this.mode; }

  setContextUsage(percentage: number | null): void {
    if (percentage !== null) { this.metaInfo.contextPercent = percentage; this.rerender(); }
  }

  setMetaStatus(meta: { elapsedSeconds?: number | null; tokensUsed?: number | null; tokenLimit?: number | null }): void {
    if (typeof meta.elapsedSeconds === 'number' && Number.isFinite(meta.elapsedSeconds) && meta.elapsedSeconds >= 0) {
      const m = Math.floor(meta.elapsedSeconds / 60);
      const s = meta.elapsedSeconds % 60;
      this.metaInfo.sessionTime = `${m}:${s < 10 ? '0' : ''}${s}`;
    }
    if (meta.tokensUsed != null && meta.tokenLimit != null) {
      this.metaInfo.contextPercent = meta.tokenLimit > 0 ? Math.round((meta.tokensUsed / meta.tokenLimit) * 100) : 0;
    }
    this.rerender();
  }

  setModelContext(options: { model?: string | null; provider?: string | null }): void {
    if (options.model !== undefined) this.metaInfo.model = options.model || undefined;
    if (options.provider !== undefined) this.metaInfo.provider = options.provider || undefined;
    this.rerender();
  }

  setChromeMeta(meta: { workspace?: string; directory?: string }): void {
    if (meta.workspace !== undefined) this.metaInfo.workspace = meta.workspace;
    if (meta.directory !== undefined) this.metaInfo.directory = meta.directory;
    this.rerender();
  }

  // ── toggles ───────────────────────────────────────────────────

  setModeToggles(options: Partial<ModeToggleState>): void {
    this.modeToggleState = { ...this.modeToggleState, ...options };
    this.rerender();
  }
  setDebugMode(enabled: boolean): void { this.modeToggleState.debugEnabled = enabled; this.rerender(); }
  toggleAutoContinue(): void {
    this.modeToggleState.autoMode = this.modeToggleState.autoMode === 'off' ? 'on' : 'off';
    this.rerender();
    this.callbacks.onToggleAutoContinue?.();
  }
  getAutoMode(): 'off' | 'on' { return this.modeToggleState.autoMode; }
  setAutoMode(mode: 'off' | 'on'): void { this.modeToggleState.autoMode = mode; this.rerender(); }
  toggleHITL(): void {
    this.modeToggleState.hitlMode = this.modeToggleState.hitlMode === 'off' ? 'on' : 'off';
    this.rerender();
    this.callbacks.onToggleHITL?.();
  }
  getHITLMode(): 'off' | 'on' { return this.modeToggleState.hitlMode; }
  getModeToggleState(): Readonly<ModeToggleState> { return this.modeToggleState; }

  // ── inline panel / pinned prompt / menu / suggestions ──────

  setAvailableCommands(commands: CommandSuggestion[]): void {
    this.allCommands = commands.map((c) => ({ label: c.command, hint: c.description }));
    // Don't show all commands upfront — _setBuffer filters them as user types '/'
    this.suggestions = [];
    this.rerender();
  }

  setInlinePanel(lines: string[]): void { this.inlinePanel = [...lines]; this.rerender(); }
  clearInlinePanel(): void { this.inlinePanel = null; this.rerender(); }
  supportsInlinePanel(): boolean { return true; }

  setPinnedPrompt(text: string | null): void { this.pinnedPrompt = text; this.rerender(); }
  getPinnedPrompt(): string | null { return this.pinnedPrompt; }
  clearPinnedPrompt(): void { this.pinnedPrompt = null; this.rerender(); }

  setMenu(items: MenuItem[], _options: { title?: string; initialIndex?: number }, callback: (item: MenuItem | null) => void): void {
    this.menuItems = items;
    this.menuCallback = callback;
    this.menuOpen = true;
    this.suggestions = items.map((it, i) => ({
      label: typeof it.label === 'string' ? it.label : `item ${i + 1}`,
    }));
    this.rerender();
  }
  closeMenu(): void {
    this.menuOpen = false;
    this.suggestions = [];
    if (this.menuCallback) { try { this.menuCallback(null); } catch { /* ignore */ } }
    this.menuCallback = null;
    this.rerender();
  }
  isMenuActive(): boolean { return this.menuOpen; }

  // ── input buffer ──────────────────────────────────────────────

  /** Test/observability hook — true while the raw-mode HITL menu is on screen. */
  isHitlSuspended(): boolean { return this.hitlOpen; }

  setSecretMode(enabled: boolean): void { this.secretMode = enabled; this.rerender(); }
  setEditMode(mode: EditGuardMode): void { this.editMode = mode; this.callbacks.onEditModeChange?.(mode); }
  applyEditMode(mode: EditGuardMode): void { this.setEditMode(mode); }
  getEditMode(): EditGuardMode { return this.editMode; }

  /**
   * The input buffer in the Ink path is owned by the Prompt component,
   * not by this controller. We keep `this.buffer` as a snapshot for
   * legacy callers asking for getBuffer/getCursor; updates flow when the
   * Prompt's onSubmit / clear actions fire. setBuffer drives a new
   * `initial` prop on the next mount.
   */
  getBuffer(): string { return this.buffer; }
  getCursor(): number { return this.buffer.length; }
  setBuffer(text: string, _cursorPos?: number): void { this.buffer = text; this.rerender(); }
  clear(): void { this.buffer = ''; this.rerender(); }

  // ── renderer facade ───────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getRenderer(): any { return this.shim; }

  // ── internal ──────────────────────────────────────────────────

  /** Append history (used by the renderer shim's addEvent). */
  _appendHistoryEntry(item: ChatItem): void {
    this.history = [...this.history, item];
    this.rerender();
  }

  /**
   * Streaming-message accumulators. We buffer deltas in memory and
   * commit ONLY the canonical 'response' text into history. Earlier
   * versions rendered the in-progress text as a live region between
   * <Static> and the prompt; Ink's log-update couldn't reliably
   * clear that region when more Static items appended below it, so
   * the still-streaming partial text would pile up in scrollback
   * AND the finalised version would render — duplicate text bug.
   *
   * UX impact of buffer-only: the user sees a "Streaming…" status
   * indicator while waiting, then the full assistant message
   * appears as one bubble. No flicker, no duplication, no live
   * token-by-token render. For the fast models the CLI uses
   * (DeepSeek-V4-Pro / -Flash) the wait is sub-second.
   */
  _appendStreamingDelta(delta: string): void {
    this.streamingText = (this.streamingText || '') + (delta || '');
    // Drive a status update so the user sees "receiving response…"
    // instead of dead air, but do NOT render the partial text itself.
    this.rerender();
  }

  _commitStreaming(finalText: string): void {
    const text = (finalText || this.streamingText || '').trim();
    this.streamingText = '';
    if (text) {
      this.history = [...this.history, { id: `r-${Date.now()}`, kind: 'assistant', text }];
    }
    this.rerender();
  }

  _finalizeStreamingIfAny(): void {
    if (!this.streamingText) return;
    const text = this.streamingText.trim();
    this.streamingText = '';
    if (text) {
      this.history = [...this.history, { id: `r-${Date.now()}`, kind: 'assistant', text }];
    }
    // No rerender — the caller is about to push another history entry
    // and rerender once. Avoid the double commit.
  }

  _setBuffer(text: string): void {
    this.buffer = text;
    // Filter slash-command suggestions to match what the user is typing.
    // Only show suggestions while the input starts with '/' and has no space
    // (i.e. they're mid-command, not mid-argument).
    if (this.allCommands.length > 0) {
      const trimmed = text.trimStart();
      if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
        const prefix = trimmed.toLowerCase();
        this.suggestions = this.allCommands
          .filter((c) => c.label.toLowerCase().startsWith(prefix))
          .slice(0, 8);
      } else {
        this.suggestions = [];
      }
    }
    this.rerender();
  }
  _setSecretMode(enabled: boolean): void { this.secretMode = enabled; this.rerender(); }

  _installCaptureHandler(handler: (text: string) => void): void { this.captureSubmit = handler; this.rerender(); }
  _restoreSubmitHandler(): void { this.captureSubmit = null; this.rerender(); }

  /** Called from the shim to suspend/resume rendering for HITL. */
  _suspendForHITL(suspend: boolean): void {
    this.hitlOpen = suspend;
    this.rerender();
  }

  /** Force a re-render after HITL resumes. */
  _forceRerender(): void { this.rerender(); }

  private rerender(): void {
    if (!this.inst) return;
    try { this.inst.rerender(this.buildTree()); } catch { /* swallow rerender races */ }
  }

  private buildTree() {
    // HITL guard. While the raw-mode HITL menu is on screen, Ink must
    // render an empty tree — anything else races with HITL's
    // `\x1b[2J\x1b[H` + console.log path. Returning a single empty
    // <Box> keeps Ink's reconciler happy (something to commit) while
    // ceding the live region to HITL. After prompt-close we rerender
    // with the real tree and the prompt reappears underneath HITL's
    // "✅ Selected" line that landed in scrollback.
    if (this.hitlOpen && this.React) {
      // Render the HITL decision menu inline when a presenter-registered
      // request is pending. Falls back to an empty Box if the component
      // hasn't loaded yet or no request is pending.
      if (this._pendingHitlRequest && this._HitlDecisionComponent) {
        return this.React.createElement(this._HitlDecisionComponent, {
          request: this._pendingHitlRequest,
          onResolve: (result: { selectedOptionId: string; userInput?: string }) => {
            const r = this._pendingHitlResolve;
            this._pendingHitlRequest = null;
            this._pendingHitlResolve = null;
            if (r) r(result);
          },
        });
      }
      return this.React.createElement('Box', null);
    }

    // While we're accumulating streaming deltas the status row should
    // tell the user something's happening — show a preview of what's
    // being generated so the user sees progress not just a spinner.
    const streamingHint = this.streamingText
      ? `Generating... ${this.streamingText.length}c · ${this.streamingText.slice(-60).replace(/\n/g, ' ').trim()}`
      : null;
    const composedStatus = this.statusOverride
      || (this.mode === 'streaming' ? this.statusStreaming : null)
      || streamingHint
      || this.activityMessage
      || this.statusMain;
    const modeChips = this.formatModeChips();
    return this.React!.createElement(this.AppComponent!, {
      history: this.history,
      streamingMessage: this.streamingText || null,
      status: { message: composedStatus, modeMessage: modeChips, spinning: this.mode === 'streaming' || Boolean(this.activityMessage) },
      suggestions: this.suggestions.length ? this.suggestions : undefined,
      prompt: {
        initial: this.buffer,
        secret: this.secretMode,
        onSubmit: (text: string) => {
          if (this.captureSubmit) {
            this.captureSubmit(text);
            return;
          }
          // Commit the user's submitted text into history before
          // dispatching to the host. The legacy renderer auto-emitted
          // an 'addEvent("prompt", text)' on its own submit path; the
          // Ink path didn't, so submitted prompts vanished from the
          // chat surface. Symptom: user typed "hi", saw the agent
          // respond, but their own "hi" was never in the transcript.
          // Skip secret submissions (passwords) and slash commands —
          // both are interpreted by the host, not user-visible
          // history. Keeps history aligned with what the agent saw.
          const trimmed = text.trim();
          if (!this.secretMode && trimmed && !trimmed.startsWith('/')) {
            this.history = [
              ...this.history,
              { id: `u-${Date.now()}`, kind: 'user', text: trimmed },
            ];
          }
          this.buffer = '';
          this.rerender();
          this.callbacks.onSubmit(text);
        },
        onCancel: () => {
          this.callbacks.onCtrlC?.({ hadBuffer: this.buffer.length > 0 });
          this.callbacks.onInterrupt();
        },
        // Shift+Tab cycles auto-continue. Bound here (not in the App
        // component) so the toggle can mutate the controller's
        // mode-chip state and rerender — App is a pure render of the
        // tree we hand it, no side-channel writes.
        onToggleMode: () => { this.toggleAutoContinue(); },
        // Option+V toggles HITL (human-in-the-loop) mode
        onToggleHITL: () => { this.toggleHITL(); },
      },
    });
  }

  /** Update the target/findings badge shown in the footer status line. */
  setVigilContext(ctx: { targets?: number; findings?: number; critHigh?: number }): void {
    this.vigilContext = { ...this.vigilContext, ...ctx };
    this.rerender();
  }

  private formatModeChips(): string | null {
    const parts: string[] = [];

    // Keyboard shortcuts — always visible below chatbox
    const kb = this.formatKeyboardShortcuts();
    if (kb) parts.push(kb);

    const meta = this.metaInfo;
    if (meta.directory) parts.push(`📁 ${meta.directory}`);
    if (meta.model) parts.push(`🧠 ${meta.model}${meta.provider ? ` · ${meta.provider}` : ''}`);
    if (meta.contextPercent != null) parts.push(`ctx ${meta.contextPercent}%`);
    if (meta.sessionTime) parts.push(`⏱ ${meta.sessionTime}`);

    const vc = this.vigilContext;
    if (vc.targets != null && vc.targets > 0) parts.push(`🎯 ${vc.targets} target${vc.targets !== 1 ? 's' : ''}`);
    if (vc.findings != null && vc.findings > 0) {
      const badge = vc.critHigh ? `⚠ ${vc.critHigh} crit/high` : `${vc.findings} findings`;
      parts.push(badge);
    }
    if (this.modeToggleState.autoMode === 'on') parts.push('auto');
    if (this.modeToggleState.hitlMode === 'on') parts.push('HITL');
    if (this.modeToggleState.debugEnabled) parts.push('debug');
    if (this.pinnedPrompt) parts.push(`📌 ${this.pinnedPrompt.slice(0, 40)}`);
    if (this.inlinePanel && this.inlinePanel.length > 0) parts.push(this.inlinePanel.slice(0, 1).join(' '));
    return parts.length ? parts.join('  ·  ') : null;
  }

  /** Build keyboard shortcut + auth tier + context status string for the footer. */
  private formatKeyboardShortcuts(): string {
    const dsKey = process.env['DEEPSEEK_API_KEY'] || '';
    const tvKey = process.env['TAVILY_API_KEY'] || '';
    const dsOk = dsKey.length > 10 ? '✓' : '✗';
    const tvOk = tvKey.length > 5 ? '✓' : '✗';

    // Context usage with 1M limit (DeepSeek V4 Pro/Flash — api-docs.deepseek.com)
    const ctxPct = this.metaInfo.contextPercent;
    const ctxLimit = 1_000_000;
    const ctxUsed = ctxPct != null ? Math.round(ctxPct * ctxLimit / 100) : 0;
    const ctxStr = ctxPct != null
      ? ` ctx:${ctxPct}%(${ctxUsed >= 1000 ? Math.round(ctxUsed/1000) + 'K' : ctxUsed}/${Math.round(ctxLimit/1000)}K)`
      : ` ctx:0%(0/1M)`;

    // Read login + auth tier status
    let loginStatus = 'guest';
    let cneOk = false;
    let cnaOk = false;
    try {
      const authPath = homedir() + '/.vigil/auth.json';
      if (existsSync(authPath)) {
        const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
        if (auth.tokenExpiresAt > Date.now() + 60000) {
          loginStatus = auth.email || 'logged-in';
          const isAdmin = auth.cna === true;
          cneOk = auth.cne === true;
          cnaOk = isAdmin || auth.cna === true;
        }
      }
    } catch {}

    const cne = cneOk ? '✓' : '✗';
    const cna = cnaOk ? '✓' : '✗';

    // Read version from package.json
    let version = '';
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const pkgPath = join(__dirname, '../../package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      version = pkg.version || '';
    } catch {}

    return `⌨ /help  /model  /workspace  DS:${dsOk} TV:${tvOk}${ctxStr}  ⇧⇥:auto  ⌥V:HITL${version ? '  v' + version : ''}`;
  }
}

/**
 * Factory — returns the Ink-backed controller. Ink is now the only
 * renderer; the legacy UnifiedUIRenderer + PromptController have been
 * removed. interactiveShell.ts exits early on non-TTY so Ink's
 * raw-mode requirement is always satisfied here. Plain mode
 * (NO_COLOR / TERM=dumb) still flows through Ink — Ink itself
 * down-styles when colours are disabled.
 */
export async function createPromptController(
  stdin: Readable,
  stdout: Writable,
  callbacks: PromptCallbacks,
): Promise<IPromptController> {
  return new InkPromptController(stdin, stdout, callbacks);
}
