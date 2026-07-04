import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ToolDefinition, ToolSuite } from '../../../core/toolRuntime.js';
import type { CapabilityContribution, CapabilityModule, CapabilityContext } from '../../../runtime/agentHost.js';
import type { ToolPlugin } from '../registry.js';

const execAsync = promisify(exec);

type CommandStatus = 'success' | 'failure' | 'skipped';

interface CommandRunRecord {
  command: string;
  status: CommandStatus;
  durationMs: number;
  stdout: string;
  stderr: string;
  startedAt: number;
}

interface CommandToolArgs {
  command?: string;
  cwd?: string;
  dryRun?: boolean;
}

interface QualityGateArgs extends CommandToolArgs {
  buildCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  testCommand?: string;
  healthCommand?: string;
  steps?: Array<'build' | 'lint' | 'type-check' | 'test' | 'health'>;
}

interface AnalyzeErrorsArgs {
  error?: string;
  log?: string;
}

interface VerifyResultArgs {
  expected?: string;
  actual?: string;
  tolerance?: number;
}

interface HypothesisArgs {
  objective?: string;
  context?: string;
  nextStepHint?: string;
}

class OrchestrationToolkit {
  private recentRuns: CommandRunRecord[] = [];

  constructor(
    private readonly workingDir: string,
    private readonly env: NodeJS.ProcessEnv
  ) {}

  private record(run: CommandRunRecord): void {
    this.recentRuns.push(run);
    // Keep a short history to avoid unbounded growth
    if (this.recentRuns.length > 10) {
      this.recentRuns.splice(0, this.recentRuns.length - 10);
    }
  }

  private formatRun(run: CommandRunRecord, label?: string, dryRun = false, failureReason?: string): string {
    const status = dryRun ? 'SKIPPED (dry-run)' : run.status === 'success' ? 'OK' : 'FAILED';
    const lines = [
      `[${status}] ${label ?? run.command}`,
      `cmd: ${run.command}`,
      `time: ${run.durationMs}ms`,
    ];

    if (run.stdout) {
      lines.push('stdout:', run.stdout);
    } else {
      lines.push('stdout: (empty)');
    }

    if (run.stderr) {
      lines.push('stderr:', run.stderr);
    } else {
      lines.push('stderr: (empty)');
    }

    if (failureReason && !run.stderr) {
      lines.push(`reason: ${failureReason}`);
    }

    return lines.join('\n');
  }

  private truncate(text: string, max = 4000): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
  }

  async runCommand(command: string, options: CommandToolArgs = {}, label?: string): Promise<string> {
    const cwd = options.cwd ?? this.workingDir;
    const dryRun = Boolean(options.dryRun);
    const startedAt = Date.now();

    if (dryRun) {
      const run: CommandRunRecord = {
        command,
        status: 'skipped',
        durationMs: 0,
        stdout: '',
        stderr: 'dry-run',
        startedAt,
      };
      this.record(run);
      return this.formatRun(run, label, true);
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        env: this.env,
        maxBuffer: 8 * 1024 * 1024,
      });
      const run: CommandRunRecord = {
        command,
        status: 'success',
        durationMs: Date.now() - startedAt,
        stdout: this.truncate(stdout?.toString().trim() ?? ''),
        stderr: this.truncate(stderr?.toString().trim() ?? ''),
        startedAt,
      };
      this.record(run);
      return this.formatRun(run, label);
    } catch (error: any) {
      const run: CommandRunRecord = {
        command,
        status: 'failure',
        durationMs: Date.now() - startedAt,
        stdout: this.truncate(error?.stdout?.toString().trim?.() ?? ''),
        stderr: this.truncate(error?.stderr?.toString().trim?.() ?? error?.message ?? ''),
        startedAt,
      };
      this.record(run);
      return this.formatRun(run, label, false, error?.message);
    }
  }

  async runQualityGate(args: QualityGateArgs = {}): Promise<string> {
    const steps = args.steps?.length ? args.steps : ['build', 'lint', 'type-check', 'test', 'health'];
    const outputs: string[] = [];

    for (const step of steps) {
      switch (step) {
        case 'build':
          outputs.push(await this.runCommand(args.buildCommand ?? 'npm run build', args, 'build'));
          break;
        case 'lint':
          outputs.push(await this.runCommand(args.lintCommand ?? 'npm run lint', args, 'lint'));
          break;
        case 'type-check':
          outputs.push(await this.runCommand(args.typecheckCommand ?? 'npm run type-check', args, 'type-check'));
          break;
        case 'test':
          outputs.push(await this.runCommand(args.testCommand ?? 'npm test -- --runInBand', args, 'test'));
          break;
        case 'health': {
          const command = args.healthCommand
            ?? (existsSync(join(this.workingDir, 'scripts', 'health-check.mjs')) ? 'node scripts/health-check.mjs' : null);
          outputs.push(
            command
              ? await this.runCommand(command, args, 'health-check')
              : '[SKIPPED] health-check\nreason: scripts/health-check.mjs not found'
          );
          break;
        }
        default:
          outputs.push(`[SKIPPED] ${step}\nreason: unknown step`);
      }
    }

    return outputs.join('\n\n');
  }

  analyzeErrors({ error, log }: AnalyzeErrorsArgs = {}): string {
    const recentFailure = [...this.recentRuns].reverse().find((run) => run.status === 'failure');
    const hints: string[] = [];
    const source = [error ?? '', log ?? '', recentFailure?.stderr ?? '', recentFailure?.stdout ?? ''].join(' ').toLowerCase();

    if (source.includes('tsc') || source.includes('type')) {
      hints.push('Re-run type checks locally: npm run type-check');
    }
    if (source.includes('eslint') || source.includes('lint')) {
      hints.push('Fix lint failures or run npm run lint -- --fix');
    }
    if (source.includes('test')) {
      hints.push('Inspect failing test output and rerun with npm test -- --runInBand');
    }
    if (!hints.length) {
      hints.push('Review recent command output; retry with --verbose or enable debug logging.');
    }

    const failureContext = recentFailure
      ? `Last failure: ${recentFailure.command} (${recentFailure.durationMs}ms)`
      : 'No previous failures recorded.';

    return [
      'Orchestration Error Analysis',
      failureContext,
      `Error: ${error ?? 'n/a'}`,
      `Hints: ${hints.join(' | ')}`,
    ].join('\n');
  }

  verifyResult({ expected, actual, tolerance = 0 }: VerifyResultArgs = {}): string {
    if (expected == null && actual == null) {
      return 'verification: no inputs provided';
    }

    const expectedNum = typeof expected === 'number' ? expected : Number.isFinite(Number(expected)) ? Number(expected) : null;
    const actualNum = typeof actual === 'number' ? actual : Number.isFinite(Number(actual)) ? Number(actual) : null;

    if (expectedNum !== null && actualNum !== null) {
      const delta = Math.abs(expectedNum - actualNum);
      const pass = delta <= tolerance;
      return `verification: ${pass ? 'pass' : 'fail'} (${actualNum} vs ${expectedNum}, tolerance ${tolerance})`;
    }

    if (expected && actual) {
      const pass = String(actual).toLowerCase().includes(String(expected).toLowerCase());
      return `verification: ${pass ? 'pass' : 'fail'} (expected to find "${expected}" in "${actual}")`;
    }

    return `verification: incomplete (expected=${expected ?? 'n/a'}, actual=${actual ?? 'n/a'})`;
  }

  generateHypothesis({ objective, context, nextStepHint }: HypothesisArgs = {}): string {
    const lines = [
      'Hypothesis',
      `Objective: ${objective ?? 'unspecified'}`,
      context ? `Context: ${context}` : 'Context: n/a',
      `Next step: ${nextStepHint ?? 'Run quality gate then iterate on failures.'}`,
    ];
    return lines.join('\n');
  }

  summarizeRecentRuns(): string {
    if (!this.recentRuns.length) {
      return 'No orchestration runs recorded yet. Execute run_build/run_tests/quality_gate to capture telemetry.';
    }
    const lines = this.recentRuns.slice(-5).map((run) => {
      const status = run.status === 'success' ? 'ok' : run.status === 'failure' ? 'fail' : 'skip';
      return `[${status}] ${run.command} (${run.durationMs}ms)`;
    });
    return ['Recent orchestration runs:', ...lines].join('\n');
  }
}

class OrchestrationCapabilityModule implements CapabilityModule {
  id = 'orchestration.tools.unified';
  description = 'Unified orchestration toolkit';

  constructor(
    private readonly workingDir: string,
    private readonly env: NodeJS.ProcessEnv
  ) {}

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    const toolkit = new OrchestrationToolkit(
      context.workingDir ?? this.workingDir,
      { ...this.env, ...context.env },
    );

    const orchestrationTools: ToolDefinition[] = [
      {
        name: 'run_build',
        description: 'Run project build (default: npm run build).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Override build command' },
            cwd: { type: 'string', description: 'Working directory to use' },
            dryRun: { type: 'boolean', description: 'Skip execution and report intent only' },
          },
        },
        handler: async (args: CommandToolArgs = {}) =>
          toolkit.runCommand(args.command ?? 'npm run build', args, 'build'),
      },
      {
        name: 'run_lint',
        description: 'Run linting (default: npm run lint).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Override lint command' },
            cwd: { type: 'string' },
            dryRun: { type: 'boolean' },
          },
        },
        handler: async (args: CommandToolArgs = {}) =>
          toolkit.runCommand(args.command ?? 'npm run lint', args, 'lint'),
      },
      {
        name: 'run_type_check',
        description: 'Run type checks (default: npm run type-check).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Override type-check command' },
            cwd: { type: 'string' },
            dryRun: { type: 'boolean' },
          },
        },
        handler: async (args: CommandToolArgs = {}) =>
          toolkit.runCommand(args.command ?? 'npm run type-check', args, 'type-check'),
      },
      {
        name: 'run_tests',
        description: 'Run tests (default: npm test -- --runInBand).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Override test command' },
            cwd: { type: 'string' },
            dryRun: { type: 'boolean' },
          },
        },
        handler: async (args: CommandToolArgs = {}) =>
          toolkit.runCommand(args.command ?? 'npm test -- --runInBand', args, 'tests'),
      },
      {
        name: 'quality_gate',
        description: 'Run build + lint + type-check + tests (+ optional health check).',
        parameters: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              description: 'Ordered steps to run',
              items: { type: 'string' },
            },
            buildCommand: { type: 'string' },
            lintCommand: { type: 'string' },
            typecheckCommand: { type: 'string' },
            testCommand: { type: 'string' },
            healthCommand: { type: 'string' },
            cwd: { type: 'string' },
            dryRun: { type: 'boolean' },
          },
        },
        handler: async (args: QualityGateArgs = {}) => toolkit.runQualityGate(args),
      },
      {
        name: 'analyze_errors',
        description: 'Analyze execution errors and suggest remediations.',
        parameters: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            log: { type: 'string' },
          },
        },
        handler: async (args: AnalyzeErrorsArgs = {}) => toolkit.analyzeErrors(args),
      },
      {
        name: 'verify_result',
        description: 'Verify a result for correctness or tolerance.',
        parameters: {
          type: 'object',
          properties: {
            expected: { type: 'string', description: 'Expected value (text or number as text)' },
            actual: { type: 'string', description: 'Actual value (text or number as text)' },
            tolerance: { type: 'number', description: 'Numeric delta tolerance' },
          },
        },
        handler: async (args: VerifyResultArgs = {}) => toolkit.verifyResult(args),
      },
      {
        name: 'hypothesis',
        description: 'Generate and test a hypothesis.',
        parameters: {
          type: 'object',
          properties: {
            objective: { type: 'string' },
            context: { type: 'string' },
            nextStepHint: { type: 'string' },
          },
        },
        handler: async (args: HypothesisArgs = {}) => toolkit.generateHypothesis(args),
      },
      {
        name: 'summarize_orchestration',
        description: 'Summarize the most recent orchestration runs.',
        handler: async () => toolkit.summarizeRecentRuns(),
      },
    ];

    const toolSuite: ToolSuite = {
      id: 'orchestration.tools.unified',
      description: 'Core orchestration helpers for build/test/quality flows.',
      tools: orchestrationTools,
    };

    return {
      id: this.id,
      description: this.description,
      toolSuite,
    };
  }
}

export function createOrchestrationToolPlugin(): ToolPlugin {
  return {
    id: 'tool.orchestration.unified',
    description: 'Unified orchestration toolkit (build, test, quality, telemetry).',
    targets: ['universal'],
    create: (context) =>
      new OrchestrationCapabilityModule(
        context.workingDir,
        { ...process.env, ...context.env },
      ),
  };
}
