/**
 * Menu — Ink interactive selection list.
 *
 * Arrow keys to move, Enter to select, Esc to cancel. Supports
 * optional boxed mode (rounded border in accent color for HITL popups),
 * description subtext, and initialIndex for default cursor position.
 * Colors from centralized system (colors.ts), glyphs from glyphs.ts.
 */
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors } from '../colors.js';
import { GLYPHS } from '../glyphs.js';

export interface MenuItem {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface MenuProps {
  items: MenuItem[];
  onSelect: (item: MenuItem | null) => void;
  onCancel?: () => void;
  initialIndex?: number;
  boxed?: boolean;
  title?: string;
}

export const Menu: React.FC<MenuProps> = ({
  items, onSelect, onCancel, initialIndex = 0, boxed = false, title,
}) => {
  const [cursor, setCursor] = useState(Math.max(0, Math.min(initialIndex, items.length - 1)));

  useEffect(() => {
    setCursor(Math.max(0, Math.min(initialIndex, items.length - 1)));
  }, [items, initialIndex]);

  useInput((_input, key) => {
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(items.length - 1, c + 1));
    if (key.return) {
      const item = items[cursor];
      if (item && !item.disabled) onSelect(item);
    }
    if (key.escape) onCancel?.();
  });

  const content = (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
      {title ? (
        <Box marginBottom={1}>
          <Text bold color={colors.accent}>{title}</Text>
        </Box>
      ) : null}
      {items.map((item, i) => {
        const isActive = i === cursor;
        const isDisabled = item.disabled;
        return (
          <Box key={item.id || i} paddingY={0}>
            <Text color={isActive && !isDisabled ? colors.accent : isDisabled ? colors.textDim : colors.text}>
              {isActive && !isDisabled ? GLYPHS.menuCursor : ' '}{' '}
              {item.label}
            </Text>
            {item.description ? (
              <Text dimColor> — {item.description}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );

  if (boxed) {
    return (
      <Box borderStyle="round" borderColor={colors.accent} paddingX={1} marginTop={1}>
        {content}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {content}
    </Box>
  );
};
