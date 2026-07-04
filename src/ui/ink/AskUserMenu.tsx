/**
 * AskUserMenu — Ink-rendered AskUserQuestion prompt for the agent's
 * in-tool TTY HITL flow. Replaces the readline + raw stdout fallback
 * in src/tools/interactionTools.ts.
 *
 * Single-select: arrow keys + Enter. Multi-select: arrow keys + Space
 * to toggle + Enter to submit. Esc cancels.
 */
import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';

export interface AskUserMenuOption { label: string; description?: string }

export interface AskUserMenuRequest {
  question: string;
  header?: string;
  options: AskUserMenuOption[];
  multiSelect: boolean;
}

export interface AskUserMenuResult {
  selected: string[];
  cancelled: boolean;
}

function AskUserMenuBody({
  request,
  onResolve,
}: {
  request: AskUserMenuRequest;
  onResolve: (r: AskUserMenuResult) => void;
}) {
  const [cursor, setCursor] = useState(0);
  const [marks, setMarks] = useState<Set<number>>(() => new Set());
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(request.options.length - 1, c + 1));
      return;
    }
    if (key.escape || (key.ctrl && input === 'c')) {
      onResolve({ selected: [], cancelled: true });
      exit();
      return;
    }
    if (request.multiSelect && input === ' ') {
      setMarks((s) => {
        const n = new Set(s);
        if (n.has(cursor)) n.delete(cursor); else n.add(cursor);
        return n;
      });
      return;
    }
    if (key.return) {
      if (request.multiSelect) {
        const labels = [...marks]
          .sort((a, b) => a - b)
          .map((i) => request.options[i]!.label);
        if (labels.length === 0) {
          onResolve({ selected: [], cancelled: true });
        } else {
          onResolve({ selected: labels, cancelled: false });
        }
      } else {
        onResolve({ selected: [request.options[cursor]!.label], cancelled: false });
      }
      exit();
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        {request.header && (
          <Text color="cyan" bold>▣ {request.header}</Text>
        )}
        <Text bold>{request.question}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text color="green">
          ↑↓ to move · {request.multiSelect ? 'Space to toggle · Enter to submit' : 'Enter to confirm'} · Esc to cancel
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {request.options.map((opt, i) => {
            const active = i === cursor;
            const marked = marks.has(i);
            const glyph = request.multiSelect
              ? (marked ? '◉' : '○')
              : (active ? '▸' : ' ');
            return (
              <Box key={i} flexDirection="column">
                <Box>
                  <Text color={active ? 'cyan' : marked ? 'green' : undefined} bold={active}>
                    {glyph} {opt.label}
                  </Text>
                </Box>
                {opt.description && (
                  <Box paddingLeft={2}>
                    <Text color={active ? 'cyan' : 'gray'} dimColor={!active}>
                      {opt.description}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

export async function showAskUserMenu(req: AskUserMenuRequest): Promise<AskUserMenuResult> {
  const { render } = await import('ink');
  return new Promise<AskUserMenuResult>((resolve) => {
    let result: AskUserMenuResult | null = null;
    const inst = render(
      React.createElement(AskUserMenuBody, {
        request: req,
        onResolve: (r) => { result = r; },
      }),
    );
    inst.waitUntilExit().finally(() => {
      try { inst.unmount(); } catch (_) { /* already torn down */ }
      resolve(result ?? { selected: [], cancelled: true });
    });
  });
}
