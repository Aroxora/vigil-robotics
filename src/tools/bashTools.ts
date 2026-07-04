import { spawn, ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';
import { reportToolProgress } from '../core/toolRuntime.js';
import { validateBashCommand, SmartFixer } from '../core/errors/safetyValidator.js';
import { toStructuredError } from '../core/errors/errorTypes.js';
import { analyzeBashFlow } from '../core/bashCommandGuidance.js';
import { buildError } from '../core/errors.js';
import {
  verifiedSuccess,
  verifiedFailure,
  analyzeOutput,
  OutputPatterns,
  createCommandCheck,
} from '../core/resultVerification.js';
import { createErrorFixer, type AIErrorFixer } from '../core/aiErrorFixer.js';
import { logDebug } from '../utils/debugLogger.js';
import { createTestMonitor, isTestCommand, type TestFailureMonitor } from '../core/testFailureMonitor.js';

// stub: sudoPasswordManager removed in robotics refactor
const getSudoPassword = async (): Promise<string | null> => null;
const invalidateSudoPassword = (): void => {};

// ANSI color codes for enhanced output
const ANSI_RESET = '\x1b[0m';
const ANSI_RED = '\x1b[31m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_BLUE = '\x1b[34m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_DIM = '\x1b[2m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RED_BOLD = '\x1b[1;31m';
const ANSI_GREEN_BOLD = '\x1b[1;32m';
const ANSI_YELLOW_BOLD = '\x1b[1;33m';

// ============================================================================
// Background Shell Manager (consolidated from backgroundBashTools.ts)
// ============================================================================

class BackgroundShell {
  private process?: ChildProcess;
  private outputBuffer: string[] = [];
  private errorBuffer: string[] = [];
  private lastReadPosition = 0;
  private isRunning = false;
  private exitCode?: number;

  constructor(
    public readonly id: string,
    private command: string,
    private workingDir: string
  ) {}

  start(): void {
    this.process = spawn('bash', ['-c', this.command], {
      cwd: this.workingDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.isRunning = true;

    this.process.stdout?.on('data', (data) => {
      this.outputBuffer.push(data.toString());
    });

    this.process.stderr?.on('data', (data) => {
      this.errorBuffer.push(data.toString());
    });

    this.process.on('exit', (code) => {
      this.exitCode = code ?? 0;
      this.isRunning = false;
    });
  }

  getNewOutput(filter?: RegExp): { stdout: string; stderr: string; status: string } {
    const allOutput = this.outputBuffer.join('');
    const newOutput = allOutput.substring(this.lastReadPosition);
    this.lastReadPosition = allOutput.length;

    const allError = this.errorBuffer.join('');

    let stdout = newOutput;
    if (filter) {
      const lines = newOutput.split('\n');
      stdout = lines.filter(line => filter.test(line)).join('\n');
    }

    return {
      stdout,
      stderr: allError,
      status: this.isRunning ? 'running' : `exited with code ${this.exitCode}`,
    };
  }

  kill(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }
  }
}

class BackgroundShellManager {
  private shells = new Map<string, BackgroundShell>();
  private nextId = 1;

  createShell(command: string, workingDir: string): string {
    const shellId = `shell_${this.nextId++}`;
    const shell = new BackgroundShell(shellId, command, workingDir);
    this.shells.set(shellId, shell);
    shell.start();
    return shellId;
  }

  getShell(shellId: string): BackgroundShell | undefined {
    return this.shells.get(shellId);
  }

  killShell(shellId: string): boolean {
    const shell = this.shells.get(shellId);
    if (shell) {
      shell.kill();
      this.shells.delete(shellId);
      return true;
    }
    return false;
  }

  listShells(): string[] {
    return Array.from(this.shells.keys());
  }
}

// Global shell manager instance
const shellManager = new BackgroundShellManager();

/**
 * Number of currently running background shells. Used by the chat-box footer.
 */
export function getBackgroundShellCount(): number {
  return shellManager.listShells().length;
}

// ============================================================================
// Streaming Execution
// ============================================================================

interface StreamingExecOptions {
  cwd: string;
  timeout: number;
  env: NodeJS.ProcessEnv;
  testMonitor?: TestFailureMonitor | null;
}

interface StreamingExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  earlyAbort?: boolean;
  abortReason?: string;
  abortMessage?: string;
}

async function execWithStreaming(
  command: string,
  options: StreamingExecOptions
): Promise<StreamingExecResult> {
  const MAX_BUFFER_BYTES = 1_000_000; // ~1MB per stream to prevent OOM on chatty commands
  return new Promise((resolve, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let lineCount = 0;
    let killed = false;
    let earlyAbort = false;
    let abortReason: string | undefined;

    const child = spawn('bash', ['-c', command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeoutId = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000);
    }, options.timeout);

    // Early abort function for test failures
    const triggerEarlyAbort = (reason: string) => {
      if (earlyAbort) return; // Already aborting
      earlyAbort = true;
      abortReason = reason;
      logDebug(`[Bash] Early abort triggered: ${reason}`);
      reportToolProgress({
        current: lineCount,
        message: `⚡ Early abort: ${reason}`,
      });
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 2000);
    };

    const processLine = (line: string, isStderr: boolean) => {
      lineCount++;
      const trimmedLine = line.slice(0, 80);
      reportToolProgress({
        current: lineCount,
        message: isStderr ? `stderr: ${trimmedLine}` : trimmedLine,
      });

      // Feed line to test monitor for real-time failure detection
      if (options.testMonitor && !earlyAbort) {
        const shouldAbort = options.testMonitor.processLine(line);
        if (shouldAbort) {
          const state = options.testMonitor.getState();
          triggerEarlyAbort(state.abortReason || 'Test failures detected');
        }
      }
    };

    const appendChunk = (chunks: string[], data: Buffer, isStdout: boolean): void => {
      const byteLength = data.length;
      const used = isStdout ? stdoutBytes : stderrBytes;
      const available = MAX_BUFFER_BYTES - used;
      if (available <= 0) {
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }

      const slice = byteLength > available ? data.subarray(0, available) : data;
      chunks.push(slice.toString());
      const consumed = slice.length; // Buffer length in bytes
      if (isStdout) {
        stdoutBytes += consumed;
        if (byteLength > available) stdoutTruncated = true;
      } else {
        stderrBytes += consumed;
        if (byteLength > available) stderrTruncated = true;
      }
    };

    let stdoutBuffer = '';
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      appendChunk(stdout, data, true);
      stdoutBuffer += text;
      if (stdoutBuffer.length > 4096) {
        stdoutBuffer = stdoutBuffer.slice(-2048);
      }
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) processLine(line, false);
      }
    });

    let stderrBuffer = '';
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      appendChunk(stderr, data, false);
      stderrBuffer += text;
      if (stderrBuffer.length > 4096) {
        stderrBuffer = stderrBuffer.slice(-2048);
      }
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) processLine(line, true);
      }
    });

    const buildOutput = (chunks: string[], truncated: boolean): string => {
      const output = chunks.join('');
      if (!truncated) return output;
      const limitKb = Math.round(MAX_BUFFER_BYTES / 1024);
      const notice = `\n[output truncated after ${limitKb}KB to protect memory; rerun with narrower command to see full output]`;
      return output ? `${output}${notice}` : notice.trim();
    };

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      if (stdoutBuffer.trim()) processLine(stdoutBuffer, false);
      if (stderrBuffer.trim()) processLine(stderrBuffer, true);

      const stdoutText = buildOutput(stdout, stdoutTruncated);
      const stderrText = buildOutput(stderr, stderrTruncated);

      if (killed && !earlyAbort) {
        reject({ killed: true, stdout: stdoutText, stderr: stderrText, code });
      } else {
        const result: StreamingExecResult = {
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: earlyAbort ? 1 : (code ?? 0),
        };

        if (earlyAbort && options.testMonitor) {
          result.earlyAbort = true;
          result.abortReason = abortReason;
          result.abortMessage = options.testMonitor.formatAbortMessage();
        }

        resolve(result);
      }
    });

    child.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

/**
 * Execute a sudo command with password authentication
 * Uses -S flag to read password from stdin
 */
async function execSudoWithPassword(
  command: string,
  password: string,
  options: StreamingExecOptions
): Promise<StreamingExecResult> {
  const MAX_BUFFER_BYTES = 1_000_000;
  return new Promise((resolve, reject) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let lineCount = 0;
    let killed = false;
    let passwordSent = false;

    // Use sudo -S to read password from stdin, -k to ignore cached credentials
    // This ensures we always use our provided password
    const sudoCommand = command.replace(/^\s*sudo\s+/, 'sudo -S ');

    const child = spawn('bash', ['-c', sudoCommand], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'], // Connect stdin for password
    });

    const timeoutId = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000);
    }, options.timeout);

    const processLine = (line: string, isStderr: boolean) => {
      // Filter out password prompt from output
      if (line.includes('[sudo] password') || line.includes('Password:')) {
        return;
      }
      lineCount++;
      const trimmedLine = line.slice(0, 80);
      reportToolProgress({
        current: lineCount,
        message: isStderr ? `stderr: ${trimmedLine}` : trimmedLine,
      });
    };

    const appendChunk = (chunks: string[], data: Buffer, isStdout: boolean): void => {
      const byteLength = data.length;
      const used = isStdout ? stdoutBytes : stderrBytes;
      const available = MAX_BUFFER_BYTES - used;
      if (available <= 0) {
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }

      const slice = byteLength > available ? data.subarray(0, available) : data;
      chunks.push(slice.toString());
      const consumed = slice.length;
      if (isStdout) {
        stdoutBytes += consumed;
        if (byteLength > available) stdoutTruncated = true;
      } else {
        stderrBytes += consumed;
        if (byteLength > available) stderrTruncated = true;
      }
    };

    let stdoutBuffer = '';
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      appendChunk(stdout, data, true);
      stdoutBuffer += text;
      if (stdoutBuffer.length > 4096) {
        stdoutBuffer = stdoutBuffer.slice(-2048);
      }
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) processLine(line, false);
      }
    });

    let stderrBuffer = '';
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();

      // Send password when sudo prompts for it
      if (!passwordSent && (text.includes('[sudo] password') || text.includes('Password:'))) {
        child.stdin?.write(password + '\n');
        child.stdin?.end();
        passwordSent = true;
        reportToolProgress({ current: 0, message: '🔐 Authenticating with sudo...' });
        return; // Don't add password prompt to output
      }

      // Filter password prompt lines from output
      const filteredText = text.split('\n')
        .filter(line => !line.includes('[sudo] password') && !line.includes('Password:'))
        .join('\n');

      if (filteredText) {
        appendChunk(stderr, Buffer.from(filteredText), false);
        stderrBuffer += filteredText;
        if (stderrBuffer.length > 4096) {
          stderrBuffer = stderrBuffer.slice(-2048);
        }
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) processLine(line, true);
        }
      }
    });

    // Send password immediately after spawn for cases where prompt comes fast
    setTimeout(() => {
      if (!passwordSent && child.stdin?.writable) {
        child.stdin?.write(password + '\n');
        child.stdin?.end();
        passwordSent = true;
      }
    }, 100);

    const buildOutput = (chunks: string[], truncated: boolean): string => {
      const output = chunks.join('');
      // Filter out any remaining password-related lines
      const filtered = output.split('\n')
        .filter(line => !line.includes('[sudo] password') && !line.includes('Password:') && !line.includes('Sorry, try again'))
        .join('\n');
      if (!truncated) return filtered;
      const limitKb = Math.round(MAX_BUFFER_BYTES / 1024);
      const notice = `\n[output truncated after ${limitKb}KB to protect memory]`;
      return filtered ? `${filtered}${notice}` : notice.trim();
    };

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      if (stdoutBuffer.trim()) processLine(stdoutBuffer, false);
      if (stderrBuffer.trim()) processLine(stderrBuffer, true);

      const stdoutText = buildOutput(stdout, stdoutTruncated);
      const stderrText = buildOutput(stderr, stderrTruncated);

      // Check for authentication failure
      const combinedOutput = stdoutText + stderrText;
      if (combinedOutput.includes('Sorry, try again') ||
          combinedOutput.includes('incorrect password') ||
          combinedOutput.includes('Authentication failure') ||
          (code !== 0 && combinedOutput.includes('sudo:'))) {
        // Invalid password - invalidate cache
        invalidateSudoPassword();
      }

      if (killed) {
        reject({ killed: true, stdout: stdoutText, stderr: stderrText, code });
      } else {
        resolve({
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: code ?? 0,
        });
      }
    });

    child.on('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

// Keep the shell responsive while long commands run
function findGuiLauncher(_command: string): string | null {
  return null;
}

const errorFixerCache = new Map<string, AIErrorFixer>();
function getErrorFixer(workingDir: string): AIErrorFixer {
  let fixer = errorFixerCache.get(workingDir);
  if (!fixer) {
    fixer = createErrorFixer({ workingDir });
    errorFixerCache.set(workingDir, fixer);
  }
  return fixer;
}

/**
 * Smart timeout detection based on command type
 */
function getSmartTimeout(command: string): number {
  const cmd = command.toLowerCase().trim();

  // Long-running commands that legitimately take time
  if (cmd.includes('npm install') || cmd.includes('yarn install') || cmd.includes('pnpm install')) {
    return 10 * 60 * 1000; // 10 minutes for package installs
  }
  if (cmd.includes('npm run build') || cmd.includes('yarn build') || cmd.includes('make')) {
    return 10 * 60 * 1000; // 10 minutes for builds
  }
  if (cmd.includes('docker build') || cmd.includes('docker-compose')) {
    return 15 * 60 * 1000; // 15 minutes for docker builds
  }
  if (cmd.includes('npm test') || cmd.includes('yarn test') || cmd.includes('pytest') || cmd.includes('jest')) {
    return 10 * 60 * 1000; // 10 minutes for tests
  }
  if (cmd.includes('git clone') || cmd.includes('git fetch') || cmd.includes('git pull')) {
    return 5 * 60 * 1000; // 5 minutes for git network ops
  }

  // Default timeout for most commands - prevents hung commands from blocking
  return 2 * 60 * 1000; // 2 minutes default
}

// ============================================================================
// Sandbox Environment
// ============================================================================

interface SandboxPaths {
  root: string;
  home: string;
  cache: string;
  config: string;
  data: string;
  tmp: string;
}

const sandboxCache = new Map<string, Promise<SandboxPaths>>();

async function ensureSandboxPaths(workingDir: string): Promise<SandboxPaths> {
  let pending = sandboxCache.get(workingDir);
  if (!pending) {
    pending = createSandboxPaths(workingDir);
    sandboxCache.set(workingDir, pending);
  }
  return pending;
}

async function createSandboxPaths(workingDir: string): Promise<SandboxPaths> {
  const root = join(workingDir, '.vigil', 'shell-sandbox');
  const home = join(root, 'home');
  const cache = join(root, 'cache');
  const config = join(root, 'config');
  const data = join(root, 'data');
  const tmp = join(root, 'tmp');
  await Promise.all([home, cache, config, data, tmp].map((dir) => mkdir(dir, { recursive: true })));
  return { root, home, cache, config, data, tmp };
}

/**
 * Detect if a command needs access to the real home directory for cloud CLI credentials.
 * Commands like firebase, gcloud, aws, az, kubectl require access to stored credentials.
 */
function needsRealHome(command: string): boolean {
  const cloudCliPatterns = [
    /\bfirebase\b/i,           // Firebase CLI
    /\bgcloud\b/i,             // Google Cloud CLI
    /\bgsutil\b/i,             // Google Cloud Storage
    /\baws\b/i,                // AWS CLI
    /\baz\b/i,                 // Azure CLI
    /\bkubectl\b/i,            // Kubernetes
    /\bhelm\b/i,               // Helm
    /\bdocker\b/i,             // Docker (for registry auth)
    /\bnpm\s+publish\b/i,      // npm publish (needs npm auth)
    /\byarn\s+publish\b/i,     // yarn publish
    /\bpnpm\s+publish\b/i,     // pnpm publish
    /\bgit\b/i,                // Git (needs user/global config, hooks, signing, credential helpers)
    /\bgh\b/i,                 // GitHub CLI
    /\bvercel\b/i,             // Vercel CLI
    /\bnetlify\b/i,            // Netlify CLI
    /\bheroku\b/i,             // Heroku CLI
    /\bfly\b/i,                // Fly.io CLI
    /\bsupabase\b/i,           // Supabase CLI
    /\bwrangler\b/i,           // Cloudflare Workers
  ];

  return cloudCliPatterns.some(pattern => pattern.test(command));
}

function needsRealTemp(command: string): boolean {
  const realTempPatterns = [
    /\bgit\b/i,        // macOS git may invoke Xcode tooling that expects the real per-user temp/cache dirs.
    /\bxcodebuild\b/i,
  ];
  return realTempPatterns.some(pattern => pattern.test(command));
}

export async function buildSandboxEnv(
  workingDir: string,
  options?: { preserveHome?: boolean; command?: string }
): Promise<NodeJS.ProcessEnv> {
  const envPreference = process.env['VIGIL_PRESERVE_HOME'];
  // Preserve home if: env var set, option passed, or command needs cloud CLI credentials
  const commandNeedsHome = options?.command ? needsRealHome(options.command) : false;
  const commandNeedsTemp = options?.command ? needsRealTemp(options.command) : false;
  const preserveHome = envPreference === '1' ? true :
                       envPreference === '0' ? false :
                       Boolean(options?.preserveHome) || commandNeedsHome;

  const paths = await ensureSandboxPaths(workingDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VIGIL_SANDBOX_ROOT: paths.root,
    VIGIL_SANDBOX_HOME: paths.home,
    VIGIL_SANDBOX_TMP: paths.tmp,
  };

  if (!preserveHome) {
    env['HOME'] = paths.home;
    env['XDG_CACHE_HOME'] = paths.cache;
    env['XDG_CONFIG_HOME'] = paths.config;
    env['XDG_DATA_HOME'] = paths.data;
  }
  if (!commandNeedsTemp) {
    env['TMPDIR'] = paths.tmp;
    env['TMP'] = paths.tmp;
    env['TEMP'] = paths.tmp;
  }

  return env;
}

// ============================================================================
// Main Tool Factory
// ============================================================================

export function createBashTools(workingDir: string): ToolDefinition[] {
  return [
    // Main bash execution tool
    {
      name: 'execute_bash',
      description: 'Execute a bash command. Commands auto-timeout based on type. Use run_in_background: true for servers/watchers.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (smart defaults apply)' },
          run_in_background: { type: 'boolean', description: 'Run in background for long-running processes' },
        },
        required: ['command'],
      },
      handler: async (args) => {
        let command = args['command'] as string;
        const runInBackground = args['run_in_background'] === true;
        const userTimeout = args['timeout'] as number | undefined;
        const timeout = userTimeout ?? getSmartTimeout(command);

        // Check if this is a sudo command
        const isSudoCommand = /^\s*sudo\s+/i.test(command);

        // Block commands that typically require passwords or interactive input (except sudo which we handle)
        const interactiveCommands = /\b(passwd|su\s|login|ssh\s(?!-o)|sftp|ftp|mysql\s+-p|psql\s+-W)\b/i;
        if (interactiveCommands.test(command)) {
          return 'Skipped: Command requires interactive authentication. Use non-interactive alternatives.';
        }

        // Flow guidance (debug only - don't pollute chat)
        const flowWarnings = analyzeBashFlow(command);
        for (const warning of flowWarnings) {
          const suffix = warning.suggestion ? ` — ${warning.suggestion}` : '';
          logDebug(`[Bash Flow] ${warning.message}${suffix}`);
        }

        // Safety validation (fail closed)
        const validation = validateBashCommand(command);
        if (!validation.valid) {
          logDebug(`[Bash Safety] Command validation failed: ${validation.error?.message || 'Unknown error'}`);
          const suggestions = ['使用只读的、有边界的操作，或提供签署的授权范围文件。'];
          if (validation.autoFix?.available) {
            suggestions.unshift(`Auto-fix available: ${validation.autoFix.description}`);
          }
          return verifiedFailure(
            '命令被安全策略阻止',
            `Command: ${command}\n\nReason: ${validation.error?.message || 'Denied by policy.'}`,
            suggestions,
            [
              { check: '安全策略', passed: false, details: validation.error?.message || 'Denied' },
            ],
            0
          );
        }

        // Safety warnings (debug only - don't pollute chat)
        if (validation.warnings.length > 0) {
          for (const warning of validation.warnings) {
            logDebug(`[Bash Safety] WARNING: ${warning}`);
          }
        }

        // CVE-2024-4577 变体缓解措施：如果 autoFix 可用，使用净化后的命令。
        // 这是执行 Unicode NFKC 规范化、去除软连字符及其他编码绕过字符的地方。
        if (validation.autoFix?.available) {
          const sanitized = validation.autoFix.apply() as string;
          logDebug(`[Bash Safety] Auto-fixed command: ${validation.autoFix.description}`);
          command = sanitized;
        }

        // GUI blocking check
        const guiBlocked = findGuiLauncher(command);
        if (guiBlocked) {
          logDebug(`[Bash Safety] GUI launcher detected: ${guiBlocked}`);
        }

        // Background execution
        if (runInBackground) {
          const shellId = shellManager.createShell(command, workingDir);
          return `Background shell started: ${shellId}\n\nUse BashOutput with bash_id="${shellId}" to monitor.\nUse KillShell with shell_id="${shellId}" to terminate.`;
        }

        // Foreground execution
        const startTime = Date.now();
        const usesRealHome = needsRealHome(command);

        // Create test monitor for test commands to enable early abort on failures
        const testMonitor = createTestMonitor(command);
        if (testMonitor) {
          logDebug(`[Bash] Test command detected, enabling failure monitoring with early abort`);
        }

        try {
          const env = await buildSandboxEnv(workingDir, { command });

          // Report sandbox status for visibility
          const sandboxStatus = usesRealHome
            ? `${ANSI_CYAN}🔓 Using real credentials (cloud CLI detected)${ANSI_RESET}`
            : `${ANSI_DIM}🔒 Sandboxed environment${ANSI_RESET}`;
          reportToolProgress({ current: 0, message: sandboxStatus });

          let result: StreamingExecResult;

          // Handle sudo commands with password authentication
          if (isSudoCommand) {
            logDebug('[Bash] Sudo command detected, requesting password');
            reportToolProgress({ current: 0, message: '🔐 Sudo command detected, requesting password...' });

            const password = await getSudoPassword();
            if (!password) {
              return `${ANSI_YELLOW}Sudo command cancelled: No password provided.${ANSI_RESET}\n\nTo run this command, you need to provide your sudo password when prompted.`;
            }

            result = await execSudoWithPassword(command, password, { cwd: workingDir, timeout, env, testMonitor });
          } else {
            result = await execWithStreaming(command, { cwd: workingDir, timeout, env, testMonitor });
          }
          const { stdout, stderr, exitCode, earlyAbort, abortMessage } = result;
          const durationMs = Date.now() - startTime;
          const combinedOutput = [stdout, stderr].filter(Boolean).join('\n');

          // Handle early abort from test monitor - encourage replanning
          if (earlyAbort && testMonitor) {
            const state = testMonitor.getState();
            const suggestions = [
              'REPLAN: Fix the identified issues before running tests again',
              ...state.suggestions,
            ];

            return verifiedFailure(
              `${ANSI_YELLOW_BOLD}Test run aborted early - replan recommended${ANSI_RESET}`,
              `Command: ${command}\n\n${ANSI_YELLOW}The test run was stopped early to save time.${ANSI_RESET}\n\n` +
              `${abortMessage || ''}\n\n` +
              `${ANSI_DIM}Partial output:${ANSI_RESET}\n${combinedOutput || '(none)'}`,
              suggestions,
              [
                { check: 'Early abort', passed: false, details: state.abortReason || 'Multiple test failures' },
                { check: 'Failed tests', passed: false, details: `${state.failedTests.length} test file(s) failed` },
              ],
              durationMs
            );
          }

          const commandLower = command.toLowerCase().trim();
          let patterns = OutputPatterns.command;
          if (commandLower.startsWith('git ') || commandLower === 'git') patterns = OutputPatterns.git;
          else if (commandLower.startsWith('npm ') || commandLower.startsWith('npx ')) patterns = OutputPatterns.npm;

          const analysis = analyzeOutput(combinedOutput, patterns, exitCode);
          const commandCheck = createCommandCheck('Command execution', exitCode, combinedOutput);

          if (exitCode !== 0) {
            const errorFixer = getErrorFixer(workingDir);
            const aiErrors = errorFixer.analyzeOutput(combinedOutput, command);
            const aiGuidance = aiErrors.length > 0 ? errorFixer.formatForAI(aiErrors) : '';
            const suggestions = ['Review the error message', 'Fix the issue and retry'];
            const firstError = aiErrors[0];
            if (firstError?.suggestedFixes[0]) {
              suggestions.unshift(`AI Suggestion: ${firstError.suggestedFixes[0].description}`);
            }

            // Add replan suggestion for test failures
            if (testMonitor && testMonitor.getState().failedTests.length > 0) {
              suggestions.unshift('REPLAN: Multiple test failures detected - consider fixing incrementally');
            }

            return verifiedFailure(
              `Command failed with exit code ${exitCode}`,
              `Command: ${command}\n\nOutput:\n${combinedOutput || '(none)'}${aiGuidance}`,
              suggestions,
              [commandCheck],
              durationMs
            );
          }

          if (analysis.isFailure) {
            return verifiedFailure(
              `Command completed with exit code 0 but output indicates failure`,
              `Command: ${command}\n\n${ANSI_RED_BOLD}Output:${ANSI_RESET}\n${combinedOutput || '(no output)'}`,
              ['Review the error message in the output', 'Fix the underlying issue and retry'],
              [commandCheck, { check: 'Output analysis', passed: false, details: `Failure pattern: ${analysis.matchedPattern}` }],
              durationMs
            );
          }

          const envLabel = usesRealHome ? `${ANSI_CYAN}[real credentials]${ANSI_RESET}` : `${ANSI_DIM}[sandboxed]${ANSI_RESET}`;
          return verifiedSuccess(
            combinedOutput.trim() ? `Command executed successfully ${envLabel}` : `Command executed successfully (no output) ${envLabel}`,
            `Command: ${command}${combinedOutput.trim() ? `\n\n${ANSI_GREEN_BOLD}Output:${ANSI_RESET}\n${combinedOutput}` : ''}`,
            [commandCheck, ...(analysis.isSuccess ? [{ check: 'Output analysis', passed: true, details: `Success pattern matched` }] : [])],
            durationMs
          );
        } catch (error: unknown) {
          const execError = error as { code?: number; stdout?: string; stderr?: string; message?: string; killed?: boolean };
          const durationMs = Date.now() - startTime;
          const exitCode = execError.code ?? 1;
          const combinedError = [execError.stdout, execError.stderr, execError.message].filter(Boolean).join('\n');

          if (execError.killed) {
            return verifiedFailure(
              `Command timed out after ${timeout}ms`,
              `Command: ${command}\n\nPartial output:\n${combinedError || '(none)'}`,
              ['Increase timeout if command legitimately needs more time', 'Check if command is hanging'],
              [{ check: 'Timeout', passed: false, details: `Exceeded ${timeout}ms` }],
              durationMs
            );
          }

          const errorFixer = getErrorFixer(workingDir);
          const aiErrors = errorFixer.analyzeOutput(combinedError, command);
          const aiGuidance = aiErrors.length > 0 ? errorFixer.formatForAI(aiErrors) : '';
          const suggestions = ['Review the error message', 'Fix the issue and retry'];
          const firstError = aiErrors[0];
          if (firstError?.suggestedFixes[0]) {
            suggestions.unshift(`AI Suggestion: ${firstError.suggestedFixes[0].description}`);
          }

          return verifiedFailure(
            `Command failed with exit code ${exitCode}`,
            `Command: ${command}\n\nError output:\n${combinedError || '(none)'}${aiGuidance}`,
            suggestions,
            [createCommandCheck('Command execution', exitCode, combinedError)],
            durationMs
          );
        }
      },
    },

    // Background shell output retrieval
    {
      name: 'BashOutput',
      description: 'Retrieve output from a running or completed background bash shell.',
      parameters: {
        type: 'object',
        properties: {
          bash_id: { type: 'string', description: 'The ID of the background shell' },
          filter: { type: 'string', description: 'Optional regex to filter output lines' },
        },
        required: ['bash_id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const bashId = args['bash_id'];
        const filterStr = args['filter'];

        if (typeof bashId !== 'string' || !bashId.trim()) {
          return 'Error: bash_id must be a non-empty string.';
        }

        try {
          const shell = shellManager.getShell(bashId);
          if (!shell) {
            const available = shellManager.listShells();
            return `Error: Shell "${bashId}" not found.\n\nAvailable: ${available.length > 0 ? available.join(', ') : 'none'}`;
          }

          const filter = filterStr && typeof filterStr === 'string' ? new RegExp(filterStr) : undefined;
          const { stdout, stderr, status } = shell.getNewOutput(filter);

          const parts: string[] = [`Shell: ${bashId}`, `Status: ${status}`];
          if (stdout) { parts.push('\n=== New Output ==='); parts.push(stdout); }
          if (stderr) { parts.push('\n=== Errors ==='); parts.push(stderr); }
          if (!stdout && !stderr) parts.push('\n(No new output)');

          return parts.join('\n');
        } catch (error: unknown) {
          return buildError('retrieving shell output', error, { bash_id: bashId });
        }
      },
    },

    // Kill background shell
    {
      name: 'KillShell',
      description: 'Kill a running background bash shell by its ID.',
      parameters: {
        type: 'object',
        properties: {
          shell_id: { type: 'string', description: 'The ID of the background shell to kill' },
        },
        required: ['shell_id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const shellId = args['shell_id'];

        if (typeof shellId !== 'string' || !shellId.trim()) {
          return 'Error: shell_id must be a non-empty string.';
        }

        try {
          const success = shellManager.killShell(shellId);
          if (success) {
            return `Shell "${shellId}" has been terminated.`;
          } else {
            const available = shellManager.listShells();
            return `Error: Shell "${shellId}" not found.\n\nAvailable: ${available.length > 0 ? available.join(', ') : 'none'}`;
          }
        } catch (error: unknown) {
          return buildError('killing shell', error, { shell_id: shellId });
        }
      },
    },
  ];
}
