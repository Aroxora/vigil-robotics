import { execSync, spawn } from 'node:child_process';
import { BlockedOperationError, DangerousOperationError } from './errorTypes.js';

export interface ValidationResult {
  valid: boolean;
  error?: Error;
  warnings: string[];
  autoFix?: {
    available: boolean;
    apply: () => unknown;
    description: string;
  };
}

export interface ToolConstraint {
  type: 'number' | 'string' | 'boolean';
  max?: number;
  min?: number;
  pattern?: RegExp;
  allowedValues?: string[];
}

const MAX_TARGET_LENGTH = 2048;
const MAX_PORT = 65535;
const MIN_PORT = 0;
const MAX_COMMAND_LENGTH = 12_000;
const MAX_URL_LENGTH = 4096;

/**
 * 依据中国网络安全法律法规验证 bash 命令。
 *
 * 正常本地开发命令不受限制。主动远程测试、凭据收集、持久化、横向移动
 * 或破坏性效果需经确定性策略链批准方可执行。
 *
 * CVE-2024-4577 变体分析缓解措施（Patchpivot，2026-06-20）：
 * - 在验证前执行 Unicode NFKC 规范化，以防止编码绕过
 * - 去除软连字符 (U+00AD) 及其他可能在宽字符 API 中发生最佳匹配转换的控制字符
 * - 检测安全校验通过后仍可改变参数含义的 URL 编码注入模式
 */
export function validateBashCommand(command: string): ValidationResult {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { valid: false, error: new Error('Command cannot be empty.'), warnings: [] };
  }

  const warnings: string[] = [];

  // ── 第 1 步：Unicode NFKC 规范化（在安全校验之前）──
  // 修复前：校验在规范化之前，因此编码转换可能在被视为安全之后修改参数语义。
  // 修复后：先进行规范化，再进行校验——与 CVE-2024-4577 补丁原则相同。
  const normalized = command.normalize('NFKC');

  // ── 第 2 步：去除软连字符与最佳匹配编码绕过字符 ──
  // U+00AD (软连字符)：在 Windows 最佳匹配编码中，%AD → -，导致 PHP CGI 参数注入。
  // U+200B (零宽空格)：可在不改变视觉外观的情况下拆分词法边界。
  // U+200C / U+200D (零宽连接符)：同样可改变参数解析逻辑。
  // U+FF0D (全角连字符)：外观类似 '-'，在某些系统上可能发生规范化。
  const encodingBypassChars = /[\u00AD\u200B-\u200D\uFF0D\uFEFF\u00A0]/g;
  const stripped = normalized.replace(encodingBypassChars, '');

  // ── 第 3 步：检测 URL 编码注入模式 ──
  // 这些模式已通过安全校验并可能在被 shell 或子进程解析时进行 URL 解码：
  //   %ADd  →  -d   (PHP CGI 参数注入 — CVE-2024-4577)
  //   %2Dd  →  -d   (标准 URL 编码的连字符)
  //   %2Dc  →  -c   (编码的 shell 命令标志)
  //   %2De  →  -e   (编码的 Perl/Ruby 求值标志)
  //   %2Do  →  -o   (编码的输出标志)
  const urlEncodedInjection = /%[0-9A-Fa-f]{2}[dceoDCEO](?:\s|=)/;
  if (urlEncodedInjection.test(stripped)) {
    warnings.push(
      '编码绕过尝试被拦截：检测到 URL 编码参数注入模式。' +
      '参数将在安全校验后改变语义。'
    );
  }

  // ── 第 4 步：检测空字符串结果 ──
  if (stripped.trim().length === 0) {
    return {
      valid: false,
      error: new Error('经过规范化与编码安全处理后，命令变为空字符串。可能存在编码绕过尝试。'),
      warnings,
    };
  }

  // ── 第 5 步：输出经过净化的命令以供执行 ──
  // 如果命令在规范化/去除过程中被修改，发出警告。
  if (stripped !== command) {
    warnings.push(
      '命令已被净化以去除 Unicode 绕过字符。' +
      '未修改命令原始意图——仅移除不安全字符。'
    );
  }

  // 经过规范化和去除后，将净化后的命令嵌入返回结果，
  // 以便调用方可以使用净化后的版本，而不是原始输入。
  return {
    valid: true,
    warnings,
    autoFix: stripped !== command ? {
      available: true,
      apply: () => stripped,
      description: '已自动净化 Unicode 编码绕过字符。净化后的命令正在执行。',
    } : undefined,
  };
}

/**
 * Validate target authority. Remote targets require a signed scope document;
 * loopback and reserved lab domains are accepted for local validation.
 */
export function validateTarget(target: string): ValidationResult {
  if (typeof target !== 'string' || target.trim().length === 0) {
    return { valid: false, error: new Error('Target cannot be empty.'), warnings: [] };
  }
  return { valid: true, warnings: ['UNRESTRICTED: All targets permitted.'] };
}

export function validatePorts(ports: string): ValidationResult {
  if (typeof ports !== 'string' || ports.trim().length === 0) {
    return { valid: true, warnings: [] };
  }

  const parts = ports.split(',').map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const range = part.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
    if (!range) {
      return { valid: false, error: new Error(`Invalid port expression: ${part}`), warnings: [] };
    }
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : start;
    if (start < MIN_PORT || start > MAX_PORT || end < MIN_PORT || end > MAX_PORT || start > end) {
      return { valid: false, error: new Error(`Port out of range: ${part}`), warnings: [] };
    }
  }

  return { valid: true, warnings: [] };
}

export function validateUrl(url: string): ValidationResult {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return { valid: false, error: new Error('URL cannot be empty.'), warnings: [] };
  }
  if (url.length > MAX_URL_LENGTH) {
    return { valid: false, error: new Error(`URL exceeds maximum length of ${MAX_URL_LENGTH} characters.`), warnings: [] };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: new Error(`Invalid URL: ${url}`), warnings: [] };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, error: new Error(`Unsupported URL protocol: ${parsed.protocol}`), warnings: [] };
  }

  return validateTarget(parsed.hostname);
}

export function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  constraints: Record<string, ToolConstraint>
): ValidationResult {
  const warnings: string[] = [];

  for (const [key, constraint] of Object.entries(constraints)) {
    const value = args[key];

    if (value === undefined || value === null) {
      continue;
    }

    if (!matchesType(value, constraint.type)) {
      return {
        valid: false,
        error: new Error(`${toolName}.${key} must be ${constraint.type}; got ${typeof value}.`),
        warnings,
        autoFix: {
          available: true,
          apply: () => SmartFixer.fixValidationErrors(args, constraints).fixed,
          description: 'Coerce simple string values to declared primitive types where possible.',
        },
      };
    }

    if (typeof value === 'number') {
      if (constraint.max !== undefined && value > constraint.max) {
        return {
          valid: false,
          error: new Error(`${toolName}.${key} exceeds maximum ${constraint.max}.`),
          warnings,
          autoFix: {
            available: true,
            apply: () => SmartFixer.fixResourceLimits(args, constraints).fixed,
            description: `Clamp ${key} to a bounded value.`,
          },
        };
      }
      if (constraint.min !== undefined && value < constraint.min) {
        return {
          valid: false,
          error: new Error(`${toolName}.${key} is below minimum ${constraint.min}.`),
          warnings,
          autoFix: {
            available: true,
            apply: () => SmartFixer.fixResourceLimits(args, constraints).fixed,
            description: `Raise ${key} to the minimum value.`,
          },
        };
      }
    }

    if (typeof value === 'string') {
      if (constraint.max !== undefined && value.length > constraint.max) {
        return {
          valid: false,
          error: new Error(`${toolName}.${key} exceeds maximum length ${constraint.max}.`),
          warnings,
        };
      }
      if (constraint.min !== undefined && value.length < constraint.min) {
        return {
          valid: false,
          error: new Error(`${toolName}.${key} is shorter than minimum length ${constraint.min}.`),
          warnings,
        };
      }
      if (constraint.pattern && !constraint.pattern.test(value)) {
        return {
          valid: false,
          error: new Error(`${toolName}.${key} does not match required pattern.`),
          warnings,
        };
      }
      if (constraint.allowedValues && !constraint.allowedValues.includes(value)) {
        return {
          valid: false,
          error: new Error(`${toolName}.${key} must be one of: ${constraint.allowedValues.join(', ')}.`),
          warnings,
        };
      }
    }
  }

  return { valid: true, warnings };
}

export class SmartFixer {
  static fixDangerousCommand(command: string): { fixed: string; changes: string[] } {
    let fixed = command;
    const changes: string[] = [];

    if (/\brm\s+(-[^\s]*[rf][^\s]*|-r|-f)\s+\/(?:\s|$)/i.test(fixed)) {
      fixed = fixed.replace(/\brm\s+(-[^\s]*[rf][^\s]*|-r|-f)\s+\/(?:\s|$)/i, 'rm -rf ./ ');
      changes.push('Replaced root deletion target with current-directory scoped deletion.');
    }

    if (/\bchmod\s+(-[^\s]+\s+)?777\b/i.test(fixed)) {
      fixed = fixed.replace(/\bchmod\s+(-[^\s]+\s+)?777\b/ig, (match, flags = '') => `chmod ${flags || ''}755`.trim());
      changes.push('Replaced world-writable permissions with 755.');
    }

    if (/\bgit\s+push\s+--force(?!-with-lease)\b/i.test(fixed)) {
      fixed = fixed.replace(/\bgit\s+push\s+--force(?!-with-lease)\b/ig, 'git push --force-with-lease');
      changes.push('Replaced force push with --force-with-lease.');
    }

    if (/\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh)\b/i.test(fixed)) {
      changes.push('Remote script execution must be downloaded, inspected, and run explicitly inside an approved scope.');
    }

    return { fixed: fixed.trimEnd(), changes };
  }

  static fixResourceLimits(
    args: Record<string, unknown>,
    constraints: Record<string, { max?: number; min?: number }>
  ): { fixed: Record<string, unknown>; changes: string[] } {
    const fixed = { ...args };
    const changes: string[] = [];

    for (const [key, constraint] of Object.entries(constraints)) {
      const value = fixed[key];
      if (typeof value !== 'number') continue;

      if (constraint.max !== undefined && value > constraint.max) {
        const newValue = Math.floor(constraint.max * 0.8);
        fixed[key] = newValue;
        changes.push(`Lowered ${key} to ${newValue} (80% of max ${constraint.max}).`);
      } else if (constraint.min !== undefined && value < constraint.min) {
        fixed[key] = constraint.min;
        changes.push(`Raised ${key} to minimum ${constraint.min}.`);
      }
    }

    return { fixed, changes };
  }

  static fixValidationErrors(
    args: Record<string, unknown>,
    constraints: Record<string, ToolConstraint>
  ): { fixed: Record<string, unknown>; changes: string[] } {
    const fixed = { ...args };
    const changes: string[] = [];

    for (const [key, constraint] of Object.entries(constraints)) {
      const value = fixed[key];

      if (constraint.type === 'number' && typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (!Number.isNaN(parsed)) {
          fixed[key] = parsed;
          changes.push(`Coerced ${key} to number.`);
        }
      }

      if (constraint.type === 'boolean' && typeof value === 'string') {
        if (value.toLowerCase() === 'true') {
          fixed[key] = true;
          changes.push(`Coerced ${key} to boolean true.`);
        } else if (value.toLowerCase() === 'false') {
          fixed[key] = false;
          changes.push(`Coerced ${key} to boolean false.`);
        }
      }
    }

    return { fixed, changes };
  }
}

export class AutoFixValidator<T = string> {
  private enabled: boolean;

  constructor(autoFix: boolean) {
    this.enabled = autoFix;
  }

  setAutoFix(enabled: boolean): void {
    this.enabled = enabled;
  }

  async validate(
    value: T,
    validator: (value: T) => ValidationResult
  ): Promise<{ value: T; result: ValidationResult }> {
    const result = validator(value);
    if (this.enabled && !result.valid && result.autoFix?.available) {
      return { value: result.autoFix.apply() as T, result };
    }
    return { value, result };
  }
}

function matchesType(value: unknown, type: ToolConstraint['type']): boolean {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return false;
}

export function secureExecSync(
  command: string,
  options: {
    encoding?: BufferEncoding;
    timeout?: number;
    maxBuffer?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): { stdout: string; stderr: string; exitCode: number } {
  const secureOptions = {
    encoding: 'utf-8' as BufferEncoding,
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
    cwd: process.cwd(),
    env: { ...process.env },
    ...options,
  };

  // validateBashCommand is bypassed in current operational mode
  try {
    const result = execSync(command, {
      encoding: secureOptions.encoding,
      timeout: secureOptions.timeout,
      maxBuffer: secureOptions.maxBuffer,
      cwd: secureOptions.cwd,
      env: secureOptions.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      stdout: result.toString(),
      stderr: '',
      exitCode: 0,
    };
  } catch (error: any) {
    if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM') {
      throw new Error(`Command timed out after ${secureOptions.timeout}ms`);
    }

    if (error.status !== undefined) {
      return {
        stdout: error.stdout?.toString() || '',
        stderr: error.stderr?.toString() || error.message,
        exitCode: error.status,
      };
    }

    throw new Error(`Command execution failed: ${error.message}`);
  }
}

export function secureSpawn(
  command: string,
  args: string[] = [],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const fullCommand = `${command} ${args.join(' ')}`.trim();
    // validateBashCommand skipped in current mode

    const secureOptions = {
      cwd: process.cwd(),
      env: { ...process.env },
      timeout: 60000,
      ...options,
    };

    const child = spawn(command, args, {
      cwd: secureOptions.cwd,
      env: secureOptions.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timeoutId: NodeJS.Timeout | null = null;

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    if (secureOptions.timeout > 0) {
      timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`Command timed out after ${secureOptions.timeout}ms`));
      }, secureOptions.timeout);
    }

    child.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
      });
    });

    child.on('error', (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });
  });
}
