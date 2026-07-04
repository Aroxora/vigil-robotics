/**
 * HitlDecisionMenu — Ink-rendered HUMAN DECISION REQUIRED prompt.
 *
 * Replaces the manual `\x1b[2J\x1b[H` + chalk-bordered ASCII box +
 * stdin raw-mode keypress loop in src/core/hitl.ts. Owns its own
 * Ink mount via showHitlDecision(); the caller awaits the resolve.
 *
 * Three states:
 *   1. menu      — arrow-key list, last item is "Enter your own"
 *   2. custom    — single-line text input for the operator's freeform answer
 *   3. cancelled — Ctrl+C handled by parent (signal handler) → unmounts
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface HitlOption {
  id: string;
  label: string;
  description?: string;
}

export interface HitlDecisionRequest {
  title: string;
  description?: string;
  context?: string;
  options: HitlOption[];
  /** ID returned when the operator picks the "Enter your own" item. */
  customId?: string;
}

export interface HitlDecisionResult {
  selectedOptionId: string;
  userInput?: string;
}

interface MenuItem {
  id: string;
  label: string;
  description: string;
  isCustom?: boolean;
}

function buildMenuItems(req: HitlDecisionRequest): MenuItem[] {
  return [
    ...req.options.map((opt) => ({
      id: opt.id,
      label: opt.label,
      description: opt.description ?? '',
    })),
    {
      id: req.customId ?? '__custom__',
      label: 'Enter your own',
      description: 'Type a custom plan, instruction, or alternative approach',
      isCustom: true,
    },
  ];
}

export function HitlDecision({
  request,
  onResolve,
}: {
  request: HitlDecisionRequest;
  onResolve: (result: HitlDecisionResult) => void;
}) {
  const items = React.useMemo(() => buildMenuItems(request), [request]);
  const [selected, setSelected] = useState(items.length - 1);
  const [phase, setPhase] = useState<'menu' | 'custom'>('menu');
  const [customInput, setCustomInput] = useState('');

  useInput((input, key) => {
    if (phase === 'menu') {
      if (key.upArrow || input === 'k') {
        setSelected((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setSelected((i) => Math.min(items.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const item = items[selected]!;
        if (item.isCustom) {
          setPhase('custom');
          setCustomInput('');
        } else {
          onResolve({ selectedOptionId: item.id });
        }
        return;
      }
      // Allow number shortcuts (1-9) for quick selection
      if (input >= '1' && input <= '9') {
        const idx = parseInt(input, 10) - 1;
        if (idx < items.length) {
          const item = items[idx]!;
          if (item.isCustom) {
            setPhase('custom');
            setCustomInput('');
          } else {
            onResolve({ selectedOptionId: item.id });
          }
        }
        return;
      }
      return;
    }

    // phase === 'custom'
    if (key.return) {
      const trimmed = customInput.trim();
      const customId = items[items.length - 1]!.id;
      if (trimmed) {
        onResolve({ selectedOptionId: customId, userInput: trimmed });
      } else {
        const fallback = items[0]?.id ?? customId;
        onResolve({ selectedOptionId: fallback });
      }
      return;
    }
    if (key.escape) {
      setPhase('menu');
      setCustomInput('');
      return;
    }
    if (key.backspace || key.delete) {
      setCustomInput((s) => s.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setCustomInput((s) => s + input);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} flexDirection="column">
        <Text bold color="cyan">▣ HUMAN DECISION REQUIRED</Text>
        <Box marginTop={1}>
          <Text bold>{request.title}</Text>
        </Box>
        {request.description ? (
          <Box>
            <Text color="#8B95A5">{request.description}</Text>
          </Box>
        ) : null}
        {request.context ? (
          <Box marginTop={1} flexDirection="column">
            <Text color="blue">▾ Context</Text>
            <Text color="#8B95A5">{request.context}</Text>
          </Box>
        ) : null}
      </Box>

      {phase === 'menu' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">↑↓ to select · 1-9 shortcut · Enter to confirm</Text>
          <Box flexDirection="column" marginTop={1}>
            {items.map((item, i) => {
              const active = i === selected;
              // Show numeric shortcut hint
              const num = i + 1;
              return (
                <Box key={item.id} flexDirection="column" marginBottom={1}>
                  <Box>
                    <Text color={active ? 'cyan' : undefined} bold={active}>
                      {active ? '▸ ' : '  '}[{num}] {item.label}
                    </Text>
                  </Box>
                  {item.description ? (
                    <Box paddingLeft={4}>
                      <Text color={active ? 'cyan' : 'gray'} dimColor={!active}>
                        {item.description}
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">↳ Type your custom plan below · Esc to go back · Enter to submit</Text>
          <Box marginTop={1} borderStyle="single" borderColor="magenta" paddingX={1}>
            <Text>{customInput}</Text>
            <Text color="cyan">█</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

/**
 * Mount the Ink decision menu, await the operator's selection, unmount.
 * The caller (hitl.ts) handles bookkeeping (event emit, history, etc.).
 */
export async function showHitlDecision(
  request: HitlDecisionRequest,
): Promise<HitlDecisionResult> {
  const { render } = await import('ink');
  return new Promise<HitlDecisionResult>((resolve) => {
    let result: HitlDecisionResult | null = null;
    const inst = render(
      React.createElement(HitlDecision, {
        request,
        onResolve: (r) => { result = r; },
      }),
    );
    inst.waitUntilExit().finally(() => {
      try { inst.unmount(); } catch (_) { /* already torn down */ }
      resolve(result ?? { selectedOptionId: request.options[0]?.id ?? '__cancelled__' });
    });
  });
}
