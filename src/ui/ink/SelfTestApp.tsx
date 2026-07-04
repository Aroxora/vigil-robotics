/**
 * SelfTestApp — Ink-rendered live view for `vigil --self-test`.
 *
 * Replaces the hand-rolled \x1b[…m escape codes in src/bin/selfTest.ts.
 * Subscribes to a TestEventBus the runner mutates as each test
 * starts/finishes, so the row flips spinner → ✓/✗ live.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { EventEmitter } from 'node:events';

export interface SelfTestRowState {
  name: string;
  phase: string;
  status: 'pending' | 'pass' | 'fail';
  durationMs?: number;
  error?: string;
}

export interface SelfTestSummary {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
}

export class SelfTestEventBus extends EventEmitter {
  emitPhase(phase: string) { this.emit('phase', phase); }
  emitRow(row: SelfTestRowState) { this.emit('row', row); }
  emitSummary(summary: SelfTestSummary) { this.emit('summary', summary); }
}

export function SelfTestApp({ bus }: { bus: SelfTestEventBus }) {
  const [phases, setPhases] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, SelfTestRowState>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [summary, setSummary] = useState<SelfTestSummary | null>(null);

  useEffect(() => {
    const onPhase = (phase: string) => setPhases((p) => [...p, phase]);
    const onRow = (row: SelfTestRowState) => {
      setRows((r) => ({ ...r, [row.name]: row }));
      setOrder((o) => o.includes(row.name) ? o : [...o, row.name]);
    };
    const onSummary = (s: SelfTestSummary) => setSummary(s);
    bus.on('phase', onPhase);
    bus.on('row', onRow);
    bus.on('summary', onSummary);
    return () => {
      bus.off('phase', onPhase);
      bus.off('row', onRow);
      bus.off('summary', onSummary);
    };
  }, [bus]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">▣ Vigil CLI — self-test suite</Text>
      </Box>

      {phases.map((phase, i) => (
        <Box key={`phase-${i}`} marginTop={1}>
          <Text color="cyan" bold>▶ {phase}</Text>
        </Box>
      ))}

      {order.map((name) => {
        const row = rows[name]!;
        const dur = typeof row.durationMs === 'number' ? `(${row.durationMs}ms)` : '';
        return (
          <Box key={name} flexDirection="column">
            <Box>
              <Box width={3}>
                {row.status === 'pending' && <Text color="cyan"><Spinner type="dots" /></Text>}
                {row.status === 'pass' && <Text color="green">✓</Text>}
                {row.status === 'fail' && <Text color="red">✗</Text>}
              </Box>
              <Text>{row.name} </Text>
              <Text color="#8B95A5">{dur}</Text>
            </Box>
            {row.status === 'fail' && row.error && (
              <Box paddingLeft={3}>
                <Text color="red">{row.error}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      {summary && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="white">═ Summary ═</Text>
          <Text>  Total:    {summary.total}</Text>
          <Text color="green">  Passed:   {summary.passed}</Text>
          {summary.failed > 0 && <Text color="red">  Failed:   {summary.failed}</Text>}
          <Text>  Duration: {(summary.durationMs / 1000).toFixed(2)}s</Text>
          <Box marginTop={1}>
            {summary.failed === 0
              ? <Text bold color="green">✓ ALL TESTS PASSED</Text>
              : <Text bold color="red">✗ SOME TESTS FAILED</Text>}
          </Box>
        </Box>
      )}
    </Box>
  );
}
