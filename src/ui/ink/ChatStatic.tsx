/**
 * ChatStatic — Phase 4 of the Ink migration.
 *
 * Wraps Ink's <Static> component so chat history is committed to
 * scrollback exactly once and never repainted. This is the architectural
 * fix for the resize / rapid-paste / overlay-leak bugs that motivated
 * the Ink switch: messages above the live UI become real terminal lines
 * that no longer participate in any frame diff. <Static> writes a row,
 * then forgets it.
 *
 * Each item is rendered through `renderItem` so the host can format
 * different event kinds (user message, assistant message, tool result)
 * with different styling — the array drives the order, the renderer
 * decides the appearance.
 */

import React from 'react';
import { Static, Box, Text } from 'ink';
import { palette } from '../theme.js';

export interface ChatItem {
  /** Stable identity for React's key prop — usually a monotonic id. */
  id: string;
  /** Tag the host can use to dispatch on style. */
  kind: 'user' | 'assistant' | 'system' | 'tool' | 'tool-result' | 'error' | 'banner';
  /** Pre-formatted content (already wrapped / styled by the caller). */
  text: string;
}

export interface ChatStaticProps {
  items: ChatItem[];
}

const COLORS: Record<ChatItem['kind'], string | undefined> = {
  user: palette.cyan,
  assistant: undefined, // default terminal foreground reads cleanest on any bg
  system: palette.titanium,
  tool: palette.amber,
  'tool-result': palette.titanium,
  error: palette.ruby,
  banner: palette.roseGold,
};

// Single-glyph prefix per turn kind. Mirrors Claude Code / Cursor's
// approach: the glyph + color combo lets the eye find the boundary
// between turns at a glance without the noise of full label prefixes
// like "[user]" / "[assistant]" / "[tool]". Empty for assistant turns
// so model output reads as plain prose. Tool-results indent with `↳ `
// so the call→result pairing is visually clear.
const PREFIX: Record<ChatItem['kind'], string> = {
  user: '> ',
  assistant: '',
  system: '· ',
  tool: '⏺ ',
  'tool-result': '  ↳ ',
  error: '✗ ',
  banner: '',
};

export const ChatStatic: React.FC<ChatStaticProps> = ({ items }) => {
  return (
    <Static items={items}>
      {(item) => (
        <Box key={item.id} flexDirection="column">
          <Text color={COLORS[item.kind]}>
            {PREFIX[item.kind]}
            {item.text}
          </Text>
        </Box>
      )}
    </Static>
  );
};
