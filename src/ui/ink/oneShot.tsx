/**
 * oneShot — minimal helpers for "render a small Ink panel and exit"
 * surfaces (--help, --version, --key save, error cards, etc.).
 *
 * The interactive shell owns its own Ink tree via InkPromptController;
 * these one-shot mounts are for surfaces that print and exit before
 * the shell ever starts. Each helper resolves once Ink has flushed at
 * least one frame so the panel paints before the process exits.
 */
import React, { useEffect } from 'react';
import { Box, Text } from 'ink';

export type CardTone = 'info' | 'success' | 'warn' | 'error';

const TONE: Record<CardTone, { glyph: string; color: string }> = {
  info:    { glyph: '▣', color: 'cyan' },
  success: { glyph: '✓', color: 'green' },
  warn:    { glyph: '!', color: 'yellow' },
  error:   { glyph: '✗', color: 'red' },
};

/**
 * Renders a single Ink card and unmounts after the next paint. Resolves
 * once the panel has been flushed to the terminal so callers can safely
 * `process.exit()` immediately after awaiting.
 */
export async function showCard(opts: {
  tone?: CardTone;
  title: string;
  body?: string | string[];
  hint?: string | null;
}): Promise<void> {
  const { render } = await import('ink');
  const tone = opts.tone ?? 'info';
  const palette = TONE[tone];
  const lines = Array.isArray(opts.body) ? opts.body : (opts.body ? [opts.body] : []);

  const Card = () => (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box>
        <Text color={palette.color}>{palette.glyph} </Text>
        <Text color={palette.color} bold>{opts.title}</Text>
      </Box>
      {lines.length > 0 && (
        <Box flexDirection="column" marginTop={lines.length > 1 ? 1 : 0}>
          {lines.map((line, i) => (
            <Text key={i} color={tone === 'error' ? 'red' : 'gray'}>{line}</Text>
          ))}
        </Box>
      )}
      {opts.hint && (
        <Box marginTop={1}>
          <Text color="#8B95A5" dimColor>{opts.hint}</Text>
        </Box>
      )}
    </Box>
  );

  const inst = render(React.createElement(Card));
  // Two ticks: first paints the card, second lets Ink commit the static
  // output before unmount tears the alternate-screen buffer.
  await new Promise((r) => setTimeout(r, 30));
  try { inst.unmount(); } catch (_) { /* already torn down */ }
}

/**
 * Renders a key/value table panel — used for --version banners,
 * approval-denied summaries, install summaries, etc.
 */
export async function showKv(opts: {
  tone?: CardTone;
  title: string;
  rows: Array<[string, string]>;
  hint?: string | null;
}): Promise<void> {
  const { render } = await import('ink');
  const tone = opts.tone ?? 'info';
  const palette = TONE[tone];

  const Panel = () => (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={palette.color}>{palette.glyph} </Text>
        <Text color={palette.color} bold>{opts.title}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {opts.rows.map(([k, v], i) => (
          <Box key={i}>
            <Box width={14}><Text color="#8B95A5">{k}</Text></Box>
            <Text color={tone === 'error' ? 'red' : 'white'}>{v}</Text>
          </Box>
        ))}
      </Box>
      {opts.hint && (
        <Box marginTop={1}>
          <Text color="#8B95A5" dimColor>{opts.hint}</Text>
        </Box>
      )}
    </Box>
  );

  const inst = render(React.createElement(Panel));
  await new Promise((r) => setTimeout(r, 30));
  try { inst.unmount(); } catch (_) { /* already torn down */ }
}

/**
 * Renders preformatted help text inside an Ink frame. The text body
 * keeps its own formatting (newlines, indentation); Ink owns the
 * decorative chrome around it.
 */
export async function showHelp(opts: { title: string; body: string; foot?: string | null }): Promise<void> {
  const { render } = await import('ink');
  const View = () => (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>{opts.title}</Text>
      </Box>
      <Box>
        <Text>{opts.body}</Text>
      </Box>
      {opts.foot && (
        <Box marginTop={1}>
          <Text color="#8B95A5" dimColor>{opts.foot}</Text>
        </Box>
      )}
    </Box>
  );
  const inst = render(React.createElement(View));
  await new Promise((r) => setTimeout(r, 30));
  try { inst.unmount(); } catch (_) { /* already torn down */ }
}
