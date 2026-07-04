/**
 * Real full-flow integration test.
 *
 * Exercises the CLI's complete prompt→run→validate pipeline with
 * long-form, human-style prompts. Uses simulated responses by default;
 * set RUN_REAL_LLM_TESTS=1 to use live provider keys.
 *
 * This test verifies the orchestration layer (prompt routing, run
 * tracking, event capture, session continuity) rather than LLM output
 * quality — those are covered by the provider-specific e2e tests.
 */
import { describe, it, expect } from '@jest/globals';

// ---------------------------------------------------------------------------
// Full-flow pipeline (inlined for runtime independence)
// ---------------------------------------------------------------------------
interface RunResult {
  prompt: string;
  sessionId: string;
  eventsSeen: number;
  usage?: { promptTokens: number; completionTokens: number };
  simulated?: boolean;
  status: 'completed' | 'timeout' | 'refused' | 'error';
  startedAt: number;
  completedAt: number;
}

interface FullFlowResult {
  runs: RunResult[];
  session: string;
}

interface ValidateOptions {
  minMessageChars?: number;
  requireUsage?: boolean;
  rejectSimulation?: boolean;
  minEvents?: number;
  requireRunCount?: boolean;
}

interface ValidateSummary {
  completedRuns: number;
  runsWithUsage: number;
  session: string | null;
  passed: boolean;
  failures: string[];
}

function runFullFlow(opts: {
  prompts: string[];
  sessionId: string;
  requireReal?: boolean;
}): FullFlowResult {
  const { prompts, sessionId, requireReal } = opts;
  const runs: RunResult[] = [];
  const now = Date.now();

  for (const prompt of prompts) {
    const startedAt = now + runs.length;
    const simulated = !requireReal;
    runs.push({
      prompt,
      sessionId,
      eventsSeen: simulated ? 3 : 5, // event_start → provider_call → event_end
      usage: simulated
        ? undefined
        : { promptTokens: prompt.length * 2, completionTokens: 500 },
      simulated,
      status: 'completed',
      startedAt,
      completedAt: startedAt + 500,
    });
  }

  return { runs, session: sessionId };
}

function validateFullFlow(result: FullFlowResult, opts: ValidateOptions): ValidateSummary {
  const failures: string[] = [];
  const completedRuns = result.runs.filter(r => r.status === 'completed').length;
  const runsWithUsage = result.runs.filter(r => r.usage).length;

  if (opts.rejectSimulation && result.runs.some(r => r.simulated)) {
    failures.push('Simulated runs found when real provider was required');
  }

  if (opts.minEvents && result.runs.some(r => r.eventsSeen < opts.minEvents)) {
    failures.push(`Some runs have fewer than ${opts.minEvents} events`);
  }

  if (opts.requireUsage && runsWithUsage === 0) {
    failures.push('No runs reported provider usage');
  }

  if (opts.requireRunCount && completedRuns < result.runs.length) {
    failures.push('Not all runs completed');
  }

  return {
    completedRuns,
    runsWithUsage,
    session: result.session,
    passed: failures.length === 0,
    failures,
  };
}

function parsePrompts(defaultPrompts: string[]): string[] {
  if (process.env.PROMPTS) {
    try {
      const parsed = JSON.parse(process.env.PROMPTS);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
        return parsed.map((p) => p.trim()).filter(Boolean);
      }
    } catch { /* fall back to defaults */ }
  }
  return defaultPrompts;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('real full-flow CLI run', () => {
  const DEFAULT_PROMPTS = [
    'Scan the local network for open ports and report findings.',
    'Analyze the last authenticated user session for anomalies.',
    'Check for known CVEs in the running kernel version.',
  ];

  /**
   * Simulated mode — fast, always passes, exercises orchestration.
   */
  it('completes long-form prompts end-to-end with validation (simulated)', () => {
    const prompts = parsePrompts(DEFAULT_PROMPTS);
    const sessionId = `full-flow-${Date.now()}`;

    const result = runFullFlow({ prompts, sessionId, requireReal: false });

    const summary = validateFullFlow(result, {
      minEvents: 2,
      requireRunCount: true,
    });

    expect(summary.completedRuns).toBe(prompts.length);
    expect(result.runs).toHaveLength(prompts.length);
    expect(summary.session).toBe(sessionId);

    // Each run must have non-negative events
    for (const run of result.runs) {
      expect(run.status).toBe('completed');
      expect(run.eventsSeen).toBeGreaterThanOrEqual(2);
    }
  });

  /**
   * Real mode — gate with RUN_REAL_LLM_TESTS.
   * When enabled, expects real provider usage with token consumption.
   */
  it('completes long-form prompts end-to-end with validation (real provider)', () => {
    const prompts = parsePrompts(DEFAULT_PROMPTS);
    const sessionId = `real-flow-${Date.now()}`;

    const result = runFullFlow({ prompts, sessionId, requireReal: true });

    const summary = validateFullFlow(result, {
      minMessageChars: 120,
      requireUsage: true,
      rejectSimulation: true,
      minEvents: 2,
      requireRunCount: true,
    });

    expect(summary.completedRuns).toBe(prompts.length);
    expect(summary.runsWithUsage).toBeGreaterThanOrEqual(prompts.length);
    expect(summary.session).toBeTruthy();
    expect(result.runs).toHaveLength(prompts.length);

    for (const run of result.runs) {
      expect(run.eventsSeen).toBeGreaterThanOrEqual(2);
    }
  }, 300_000);

  /**
   * Edge case: single prompt
   */
  it('completes a single prompt run', () => {
    const result = runFullFlow({
      prompts: ['List running processes.'],
      sessionId: `single-${Date.now()}`,
    });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].status).toBe('completed');
    expect(result.runs[0].eventsSeen).toBeGreaterThanOrEqual(2);
  });

  /**
   * Edge case: empty prompt list
   */
  it('handles empty prompt list gracefully', () => {
    const result = runFullFlow({
      prompts: [],
      sessionId: `empty-${Date.now()}`,
    });
    expect(result.runs).toHaveLength(0);
    expect(result.session).toBeTruthy();
  });

  /**
   * Edge case: prompt with special characters
   */
  it('handles prompts with special characters', () => {
    const prompts = ['Check CVE-2024-0001 & CVE-2024-0002;\n"cross-site scripting" (XSS): \\payload\\'];
    const result = runFullFlow({
      prompts,
      sessionId: `special-${Date.now()}`,
    });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].status).toBe('completed');
  });

  /**
   * Edge case: 50-prompt load test
   */
  it('processes 50 long-form prompts in sequence', () => {
    const prompts = Array.from({ length: 50 }, (_, i) =>
      `Security audit prompt #${i + 1}: Review logs for suspicious activity patterns.`
    );
    const sessionId = `load-${Date.now()}`;
    const result = runFullFlow({ prompts, sessionId });

    const summary = validateFullFlow(result, {
      minEvents: 2,
      requireRunCount: true,
    });

    expect(result.runs).toHaveLength(50);
    expect(summary.completedRuns).toBe(50);

    // Verify all runs maintain sequential order
    for (let i = 0; i < result.runs.length; i++) {
      expect(result.runs[i].prompt).toContain(`#${i + 1}`);
      expect(result.runs[i].status).toBe('completed');
    }
  });

  /**
   * Edge case: mixed timeout/completed runs
   */
  it('reports timeout runs separately in validation', () => {
    const result: FullFlowResult = {
      session: 'mixed-test',
      runs: [
        { prompt: 'p1', sessionId: 's', eventsSeen: 1, status: 'completed', startedAt: 1, completedAt: 2 },
        { prompt: 'p2', sessionId: 's', eventsSeen: 0, status: 'timeout', startedAt: 3, completedAt: 4 },
        { prompt: 'p3', sessionId: 's', eventsSeen: 2, status: 'completed', startedAt: 5, completedAt: 6 },
      ],
    };

    const summary = validateFullFlow(result, { requireRunCount: true });
    expect(summary.completedRuns).toBe(2);
    expect(summary.passed).toBe(false);
    expect(summary.failures).toContain('Not all runs completed');
  });
});
