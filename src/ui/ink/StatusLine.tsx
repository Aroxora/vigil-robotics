/**
 * StatusLine — Ink-rendered status bar with sparkle animation.
 *
 * Enhanced with custom sparkle spinner (6-frame star cycle at 120ms),
 * rotating thinking gerunds (20 whimsical verbs, 3.2s rotation),
 * elapsed time counter, and token usage display. Self-ticks via
 * useState + setInterval — survives host re-renders.
 *
 * Design contract: NO emoji in chrome. Unicode glyphs only (from glyphs.ts).
 * Colors from centralized color system (colors.ts).
 */
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { colors } from '../colors.js';
import { GLYPHS } from '../glyphs.js';

export interface StatusLineProps {
  message?: string | null;
  modeMessage?: string | null;
  spinning?: boolean;
  startTime?: number | null;
  tokensUsed?: number | null;
  thinkingGerund?: boolean;
}

const GERUNDS = [
  'Thinking', 'Synthesizing', 'Forging', 'Puzzling', 'Conjuring',
  'Noodling', 'Pondering', 'Brewing', 'Cooking', 'Churning',
  'Crafting', 'Computing', 'Cerebrating', 'Simmering', 'Percolating',
  'Ruminating', 'Wrangling', 'Tinkering', 'Marinating', 'Spelunking',
];

const SPARKLE_INTERVAL = 120; // ms per frame
const GERUND_INTERVAL = 3200; // ms per gerund

function formatTokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  return `${(n / 1000).toFixed(1)}k tok`;
}

function formatElapsed(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

export const StatusLine: React.FC<StatusLineProps> = ({
  message, modeMessage, spinning, startTime, tokensUsed, thinkingGerund,
}) => {
  const [sparkleIdx, setSparkleIdx] = useState(0);
  const [gerundIdx, setGerundIdx] = useState(0);
  const [elapsed, setElapsed] = useState('');
  const sparkleRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const gerundRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (spinning) {
      sparkleRef.current = setInterval(() => setSparkleIdx(i => (i + 1) % GLYPHS.sparkleFrames.length), SPARKLE_INTERVAL);
      gerundRef.current = setInterval(() => setGerundIdx(i => (i + 1) % GERUNDS.length), GERUND_INTERVAL);
      elapsedRef.current = setInterval(() => {
        if (startTime) setElapsed(formatElapsed(startTime));
      }, 1000);
      return () => {
        if (sparkleRef.current) clearInterval(sparkleRef.current);
        if (gerundRef.current) clearInterval(gerundRef.current);
        if (elapsedRef.current) clearInterval(elapsedRef.current);
      };
    } else {
      if (sparkleRef.current) clearInterval(sparkleRef.current);
      if (gerundRef.current) clearInterval(gerundRef.current);
      if (elapsedRef.current) clearInterval(elapsedRef.current);
      setElapsed('');
      setSparkleIdx(0);
    }
  }, [spinning, startTime]);

  const hasMessage = Boolean(message && message.length);
  const hasMode = Boolean(modeMessage && modeMessage.length);
  const displayMsg = thinkingGerund ? GERUNDS[gerundIdx]! : message;
  if (!hasMessage && !hasMode && !spinning) return null;

  const metaParts: string[] = [];
  if (elapsed) metaParts.push(`⏱ ${elapsed}`);
  if (tokensUsed != null && tokensUsed > 0) metaParts.push(`↑ ${formatTokens(tokensUsed)}`);
  if (spinning) metaParts.push('esc to interrupt');

  return (
    <Box flexDirection="column">
      {hasMessage || spinning ? (
        <Box>
          {spinning ? (
            <Text color={colors.accent}>
              {GLYPHS.sparkleFrames[sparkleIdx]}{' '}
            </Text>
          ) : null}
          <Text dimColor={!spinning} color={spinning ? colors.text : undefined}>
            {displayMsg || (spinning ? GERUNDS[gerundIdx] : '')}
          </Text>
          {metaParts.length > 0 ? (
            <Text dimColor> ({metaParts.join(' · ')})</Text>
          ) : null}
        </Box>
      ) : null}
      {hasMode ? (
        <Box>
          <Text dimColor>{modeMessage}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
