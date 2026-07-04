/**
 * App — Phase 3 root that mounts the Phase 1 StatusLine + Phase 2 Prompt
 * together and exposes a minimal command surface.
 *
 * This is the integration that proves the Ink tree can replace the
 * sticky-bottom panel of the existing renderer wholesale: status row on
 * top, suggestions list, prompt at the bottom. The host (eventually
 * interactiveShell.ts) drives state via the props on this component.
 *
 * Phase 4 will add a `<Static>` chat-history block above this component;
 * the API stays the same — only the host's rendering of past events
 * changes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { StatusLine, type StatusLineProps } from './StatusLine.js';
import { Prompt, type PromptProps } from './Prompt.js';
import { ChatStatic, type ChatItem } from './ChatStatic.js';
import { palette } from '../theme.js';

export interface Suggestion {
  label: string;
  hint?: string;
}

export interface AppProps {
  /** Past chat events. Rendered via <Static> so scrollback is permanent. */
  history?: ChatItem[];
  /**
   * In-progress assistant message. Streaming deltas accumulate here so
   * the text grows in place; once the model emits its `response` event
   * the controller moves the final text into `history` and clears
   * this. Without this slot, every delta would create its own
   * <Static> entry — which is what produced the "one word per line"
   * symptom users saw in 1.1.0/1.1.1.
   */
  streamingMessage?: string | null;
  status?: StatusLineProps;
  prompt: PromptProps;
  suggestions?: Suggestion[];
}

export const App: React.FC<AppProps> = ({ history, streamingMessage, status, prompt, suggestions }) => {
  // Split the status surface: the transient line (Thinking… / Editing…)
  // and the spinner sit ABOVE the prompt; the persistent meta footer
  // (model · ctx % · mode chips) sits BELOW. Mirrors Claude Code's
  // layout — focus stays in the input box, status accents above and
  // below without competing for attention.
  const transient = status && (status.message || status.spinning)
    ? { message: status.message ?? null, spinning: status.spinning, modeMessage: null }
    : null;
  const footer = status?.modeMessage?.trim() || null;

  return (
    <Box flexDirection="column">
      {history && history.length > 0 ? <ChatStatic items={history} /> : null}
      {/* Live-streaming text is intentionally NOT rendered between
          <Static> and the prompt anymore: Ink's log-update can't
          reliably clear it when Static appends below, leading to
          duplicated text in scrollback. Streaming progress is
          surfaced via the StatusLine spinner instead, and the final
          assistant message commits as one Static entry on the
          'response' event. The streamingMessage prop is retained for
          callers that want to show a single-line "receiving…"
          indicator if needed.  */}
      {transient ? <StatusLine {...transient} /> : null}
      {suggestions && suggestions.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {suggestions.map((s, i) => (
            <Box key={`s-${i}-${s.label}`}>
              <Text color={palette.cyan}>{i === 0 ? '▸ ' : '  '}{s.label}</Text>
              {s.hint ? <Text dimColor>  {s.hint}</Text> : null}
            </Box>
          ))}
        </Box>
      ) : null}
      {/* Rounded border matches the visual idiom of Claude Code / Cursor /
          Aider — softer cue that the box is interactive without the heavy
          single-line frame. The input still disappears into the surrounding
          text without any border, which is why we keep one. */}
      <Box borderStyle="round" borderColor={palette.titanium} marginTop={1} paddingX={1}>
        <Prompt {...prompt} />
      </Box>
      {footer ? (
        <Box>
          <Text dimColor>{footer}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
