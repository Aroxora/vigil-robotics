/**
 * Prompt — Ink-rendered input box.
 *
 * Phase 2 of the Ink migration. Real text input via React reducer + Ink's
 * useInput. The reducer is the single source of truth for buffer + cursor;
 * keystrokes dispatch actions; Ink's reconciler renders. Frame coalescing,
 * visual-column handling, and resize bookkeeping are owned by Ink.
 *
 * Render contract: this component is the only writer for the prompt row.
 * No `process.stdout.write` side-effects — submission and cancellation
 * surface through the `onSubmit` / `onCancel` props so the host can pipe
 * to the existing event bus.
 *
 * Paste sanitization mirrors UnifiedUIRenderer.sanitizePasteContent: ANSI
 * escapes, raw C0 control bytes, and bracketed-paste markers are stripped
 * at intake (issues #3 + #8). The sanitizer runs on every batch of text
 * Ink hands us, so a malicious paste can't survive into the buffer.
 */

import React, { useReducer, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';

export interface PromptProps {
  initial?: string;
  prefix?: string;
  /** Hide the buffer (password mode). */
  secret?: boolean;
  /** Called with the final buffer when the user presses Enter. */
  onSubmit: (text: string) => void;
  /** Called when the user presses Ctrl+C with an empty buffer. */
  onCancel: () => void;
  /**
   * Optional callback for Shift+Tab. The host typically wires this to a
   * mode toggle (auto-continue / hitl). No-op when unset.
   */
  onToggleMode?: () => void;
  /**
   * Optional callback for Option+V. Toggles HITL (human-in-the-loop) mode.
   * Separate from onToggleMode so both can be triggered independently.
   */
  onToggleHITL?: () => void;
}

interface State {
  text: string;
  cursor: number;
}

type Action =
  | { type: 'insert'; text: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'set'; text: string; cursor?: number };

/**
 * Sanitize for paste: strip ANSI control sequences but preserve
 * newlines and tabs as literal text. Used inside bracketed-paste
 * mode where \r/\n must NOT trigger submit.
 */
function sanitizePaste(text: string): string {
  if (!text) return '';
  // Strip ANSI escape sequences. The bracketed-paste markers are
  // already stripped by the caller (handled outside this function).
  let s = text.replace(/\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07|\x1b[PX^_][^\x1b]*\x1b\\|\x1b./g, '');
  // Normalize \r\n and bare \r to \n so the buffer holds canonical newlines.
  s = s.replace(/\r\n?/g, '\n');
  // Strip C0 controls except \t (tab) and \n (newline).
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return s;
}

function sanitize(text: string): string {
  if (!text) return '';
  // Full ANSI sequences (with the \x1b prefix intact).
  let s = text.replace(/\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07|\x1b[PX^_][^\x1b]*\x1b\\|\x1b./g, '');
  // Ink's parseKeypress sometimes splits a chunk such that the \x1b is
  // consumed but the body lands in the next input string (e.g. "[2J" or
  // "[201~"). Strip those leaked CSI bodies too. The pattern matches the
  // standard CSI body shape; legitimate user text rarely matches.
  // Arrow/tab bodies ([D][C][A][B][Z]) are handled explicitly in the
  // for-loop below so they are stripped here too — the for-loop reads
  // the raw `input` and detects them before sanitize runs.
  s = s.replace(/\[[0-9;?]*[A-Za-z~]/g, '');
  s = s.replace(/\r\n/g, '\n');
  // Strip C0 controls EXCEPT the ones the walk-loop in useInput acts on:
  //   \x01 (Ctrl+A) → home, \x03 (Ctrl+C) → cancel, \x05 (Ctrl+E) → end,
  //   \x08 / \x7f → backspace, \x09 (tab, accepted as text),
  //   \x0a (\n) → submit, \x0d (\r) → submit.
  // Everything else is hostile (NUL, BEL, VT, FF, etc.).
  s = s.replace(/[\x00\x02\x04\x06\x07\x0b\x0c\x0e-\x1f]/g, '');
  return s;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'insert': {
      const clean = sanitize(action.text);
      if (!clean) return state;
      const before = state.text.slice(0, state.cursor);
      const after = state.text.slice(state.cursor);
      return { text: before + clean + after, cursor: state.cursor + clean.length };
    }
    case 'backspace': {
      if (state.cursor === 0) return state;
      const before = state.text.slice(0, state.cursor - 1);
      const after = state.text.slice(state.cursor);
      return { text: before + after, cursor: state.cursor - 1 };
    }
    case 'delete': {
      if (state.cursor >= state.text.length) return state;
      const before = state.text.slice(0, state.cursor);
      const after = state.text.slice(state.cursor + 1);
      return { text: before + after, cursor: state.cursor };
    }
    case 'left':
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case 'right':
      return { ...state, cursor: Math.min(state.text.length, state.cursor + 1) };
    case 'home':
      return { ...state, cursor: 0 };
    case 'end':
      return { ...state, cursor: state.text.length };
    case 'set':
      return { text: action.text, cursor: action.cursor ?? action.text.length };
    default:
      return state;
  }
}

export const Prompt: React.FC<PromptProps> = ({ initial = '', prefix = '> ', secret = false, onSubmit, onCancel, onToggleMode, onToggleHITL }) => {
  // Source of truth lives in a ref, not React state. useReducer's state
  // commit is deferred to the next render; Ink can fire useInput multiple
  // times in the same JS turn (parseKeypress splits a chunk into N
  // events), and every closure would read the same stale state. Apply
  // the reducer synchronously to the ref, then force a re-render so the
  // UI catches up. The bumper is the only useState-style hook needed.
  const stateRef = useRef<State>({ text: initial, cursor: initial.length });
  const [, bumpRender] = useReducer((n: number) => n + 1, 0);

  // Sync the ref to externally-driven `initial` changes. The ref is
  // only initialised once on mount, so when the host clears the buffer
  // after a submit (sets `initial=''` via prop) the ref still holds
  // the old text and the prompt keeps showing it. Watching `initial`
  // here resets the ref whenever it transitions to a new value the
  // user didn't type — the typical case is buffer clearing after
  // submit. We don't reset when `initial` matches what's already in
  // the ref so user keystrokes between renders aren't clobbered.
  useEffect(() => {
    if (initial !== stateRef.current.text) {
      stateRef.current = { text: initial, cursor: initial.length };
      bumpRender();
    }
  }, [initial]);

  const apply = (action: Action): void => {
    stateRef.current = reducer(stateRef.current, action);
    bumpRender();
  };

  // Bracketed-paste-mode tracking. The terminal wraps a paste in
  // \x1b[200~ ... \x1b[201~. Inside that wrapper, \r/\n is literal
  // text — NOT Enter. Without this state, pasting a multi-line code
  // block submits at the first newline, which is the most-reported
  // input bug. Persist across input events because a paste can span
  // chunk boundaries when the terminal flushes mid-stream.
  const inPasteRef = useRef(false);

  useInput((input, key) => {
    if (process.env['VIGIL_INK_DEBUG'] === '1') {
      process.stderr.write(`KEY: input=${JSON.stringify(input)} ret=${key.return} bs=${key.backspace} ctrl=${key.ctrl} shift=${(key as { shift?: boolean }).shift} meta=${(key as { meta?: boolean }).meta}\n`);
    }

    // Shift+Tab → cycle mode. Most terminals send Shift+Tab as the
    // CSI "back tab" sequence \x1b[Z; Ink also exposes it as
    // tab + shift. Handle both.
    const shiftKey = (key as { shift?: boolean }).shift === true;
    if ((key.tab && shiftKey) || input === '\x1b[Z') {
      onToggleMode?.();
      return;
    }

    // Option+V / Alt+V → toggle HITL mode
    const metaKey = (key as { meta?: boolean }).meta === true;
    if (metaKey && (input === 'v' || input === 'V')) {
      onToggleHITL?.();
      return;
    }

    // Alt+Enter / Meta+Enter → insert a literal newline without submitting.
    if (key.return && metaKey) {
      apply({ type: 'insert', text: '\n' });
      return;
    }

    if (key.return) {
      // Clear stateRef synchronously BEFORE notifying the host. The
      // host's `initial` prop is fed from `this.buffer` which only
      // tracks programmatic setBuffer() calls — typed keystrokes never
      // touch it. So after submit, `initial` stays the same value it
      // was before, the [initial]-keyed useEffect doesn't fire, and
      // stateRef keeps the typed text — leaving the prompt box still
      // showing the just-submitted message. Resetting locally first
      // is the only way to clear without coupling the controller to
      // every keystroke.
      const submitted = stateRef.current.text;
      apply({ type: 'set', text: '', cursor: 0 });
      onSubmit(submitted);
      return;
    }
    if (key.ctrl && (input === 'c' || input === 'C')) {
      if (stateRef.current.text.length === 0) {
        onCancel();
      } else {
        apply({ type: 'set', text: '', cursor: 0 });
      }
      return;
    }
    if (key.leftArrow || input === '\x1b[D' || input === '[D') return apply({ type: 'left' });
    if (key.rightArrow || input === '\x1b[C' || input === '[C') return apply({ type: 'right' });
    // Up/down arrows are intentionally consumed as no-ops at this
    // layer. They're meaningful in HITL menus (selection movement),
    // but Ink and HITL share stdin so the same keystrokes also reach
    // here. Letting them fall through to the chunk-walk would
    // dispatch the raw `\x1b[A` / `\x1b[B` bytes through `sanitize()`
    // (which strips them anyway), but explicit `return` is cheaper
    // and makes the intent obvious to a reader. Wire to history
    // navigation later if we add a previous-prompts ring.
    if (key.upArrow || key.downArrow || input === '\x1b[A' || input === '\x1b[B' || input === '[A' || input === '[B') return;
    if (key.backspace || input === '\b' || input === '\x7f') return apply({ type: 'backspace' });
    // Forward-delete (real Delete key sends \x1b[3~). When \x7f (DEL)
    // arrives after an ESC sequence via pipe-mode Ink, it may set
    // key.delete instead of key.backspace. Only apply forward-delete
    // when the input carries an explicit CSI delete body; otherwise
    // interpret as backspace (the common terminal mapping for \x7f).
    if (key.delete) {
      if (input === '\x1b[3~' || input === '[3~') return apply({ type: 'delete' });
      return apply({ type: 'backspace' });
    }
    if (input === '\x1b[3~' || input === '[3~') return apply({ type: 'delete' });
    if (key.ctrl && (input === 'a' || input === 'A')) return apply({ type: 'home' });
    if (key.ctrl && (input === 'e' || input === 'E')) return apply({ type: 'end' });
    // When Esc arrives via a pipe, Ink may split the CSI arrow
    // sequence: \x1b first (keys.escape=true, input=''), then the
    // CSI body "[D"/"[C" in a second callback. The arrow checks
    // above catch "[D" already. But some terminal configs send
    // \x7f (DEL) as meta+backspace after an Esc prefix, causing
    // keys.meta=true + keys.backspace=true or keys.meta=true +
    // input=''. Handle that here before the escape guard swallows it.
    if (key.meta && (key.backspace || input === '\x7f' || input === '\b')) return apply({ type: 'backspace' });
    if (key.escape) return; // ignored — main shell handles overlays

    // Ink hands us paste / pre-buffered chunks as a single `input` string.
    // parseKeypress only flags key.return / key.ctrl when the chunk is a
    // pure single key. When a control byte is embedded mid-chunk (e.g.
    // 'world\x01' or '[2J' after Ink ate the \x1b prefix) the flags stay
    // false and the raw bytes sit inside `input`. Sanitise the WHOLE
    // chunk first so multi-byte ANSI sequences like '[2J' are stripped
    // as one, then walk for embedded \r / Ctrl+letter and insert the
    // rest. Splitting into per-char dispatches without sanitising the
    // chunk first would let CSI bodies through.
    if (input) {
      // Process CSI arrow bodies that arrived without their Esc prefix
      // (Ink splits Esc from the CSI body in pipe mode). The top-level
      // arrow checks at lines above catch '[D' when it arrives alone,
      // but when batched with other bytes (e.g. '[D\x7f'), sanitize()
      // would strip the CSI body silently and lose the arrow action.
      // Apply arrow actions BEFORE sanitize by scanning the raw input.
      let work = input;
      for (const csi of work.matchAll(/\[[ABCDZ]/g)) {
        const body = csi[0];
        if (body === '[D') apply({ type: 'left' });
        else if (body === '[C') apply({ type: 'right' });
        // [A]/[B]/[Z] are consumed silently (up/down arrows, shift-tab)
      }
      // Remove processed CSI bodies so they don't end up as text in
      // the buffer after sanitize.
      work = work.replace(/\[[ABCDZ]/g, '');
      const cleaned = sanitize(work);
      // Paste vs type-then-Enter discrimination. Ink batches
      // keystrokes that arrive close together — `'end\r'` (user typed
      // 'end' then Enter as one quick burst) and `'line one\nline two'`
      // (a real paste) both look like "multi-char chunk with newline"
      // at this layer. Distinguish by where the newline sits:
      //   - trailing newline only  → type-then-Enter: insert the
      //     prefix, then submit (preserves the Enter behavior).
      //   - newline followed by more content → genuine paste: insert
      //     the whole chunk as literal text, newlines kept as `\n`.
      // Without this, pasting code blocks into the prompt either
      // submitted halfway through or never submitted at all.
      // Pastes don't contain C0 command bytes — Ctrl+A / Ctrl+C / Ctrl+E
      // are *keystrokes*, and seeing one mid-chunk means Ink batched
      // several user keystrokes (e.g. typing fast across an Ctrl+A
      // home-jump). Real pasted text is just printable + newlines.
      // Without this guard, a batched chunk like 'world\x01hello \x05\r'
      // gets short-circuited as paste and the C0 commands land in the
      // buffer as literal bytes instead of being executed.
      const hasC0Commands = /[\x01\x03\x05\x08\x7f]/.test(cleaned);
      if (cleaned.length > 1 && /[\r\n]/.test(cleaned) && !hasC0Commands) {
        const lastNewlineIdx = Math.max(cleaned.lastIndexOf('\n'), cleaned.lastIndexOf('\r'));
        const tail = cleaned.slice(lastNewlineIdx + 1);
        if (tail.length === 0) {
          // Trailing newline only — submit the prefix.
          const prefix = cleaned.slice(0, lastNewlineIdx).replace(/\r\n?/g, '\n');
          if (prefix) apply({ type: 'insert', text: prefix });
          const submitted = stateRef.current.text;
          apply({ type: 'set', text: '', cursor: 0 });
          onSubmit(submitted);
          return;
        }
        // Real paste — newlines mid-chunk with content after.
        const normalized = cleaned.replace(/\r\n?/g, '\n');
        apply({ type: 'insert', text: normalized });
        return;
      }
      for (const ch of cleaned) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          const submitted = stateRef.current.text;
          apply({ type: 'set', text: '', cursor: 0 });
          onSubmit(submitted);
          return;
        }
        if (code === 0x03) {
          if (stateRef.current.text.length === 0) { onCancel(); return; }
          apply({ type: 'set', text: '', cursor: 0 });
          continue;
        }
        if (code === 0x01) { apply({ type: 'home' }); continue; }
        if (code === 0x05) { apply({ type: 'end' });  continue; }
        if (code === 0x08 || code === 0x7f) { apply({ type: 'backspace' }); continue; }
        // sanitize() above already stripped C0 bytes other than the
        // shortlist we just handled, so this insert is always safe.
        apply({ type: 'insert', text: ch });
      }
    }
  });

  // Snapshot the ref into a local for the JSX below. Outside the input
  // handler the latest committed render value is the right thing to draw.
  const state = stateRef.current;

  // Render the buffer with a visible cursor block. In secret mode we
  // collapse the buffer to • characters but keep the cursor markers so
  // the user can still see where they are editing.
  // Children must be non-empty strings — empty <Text> siblings collide
  // on React's auto-generated keys and the parent fails to mount, which
  // also prevents useInput's effect from running. Render a single space
  // when a slice would be empty.
  const display = secret ? '•'.repeat(state.text.length) : state.text;
  const before = display.slice(0, state.cursor) || ' ';
  const at = display.slice(state.cursor, state.cursor + 1) || ' ';
  const after = display.slice(state.cursor + 1) || ' ';

  // Surface state via a hidden marker line for subprocess testing.
  // VIGIL_INK_DEBUG=1 enables a `STATE: <buffer>|<cursor>` annotation
  // that the test harness greps for. Off by default.
  useEffect(() => {
    if (process.env['VIGIL_INK_DEBUG'] === '1') {
      process.stderr.write(`STATE: ${state.text}|${state.cursor}\n`);
    }
  }, [state.text, state.cursor]);

  return (
    <Box>
      <Text key="prefix" dimColor>{prefix}</Text>
      <Text key="before">{before}</Text>
      <Text key="cursor" inverse>{at}</Text>
      <Text key="after">{after}</Text>
    </Box>
  );
};
