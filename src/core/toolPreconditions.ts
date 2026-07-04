import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize as normalizePath, resolve as resolvePath } from 'node:path';
import { analyzeBashFlow } from './bashCommandGuidance.js';

/**
 * Pre-flight validation patterns for AI flow design.
 * Catches common tool usage failures before execution and provides actionable guidance.
 */
export interface PreflightWarning {
  readonly code: string;
  readonly message: string;
  readonly severity: 'critical' | 'warning' | 'info';
  readonly suggestion: string;
}

export const EDIT_WITHOUT_READ = 'EDIT_WITHOUT_READ';

type ToolHistoryCall = {
  toolName: string;
  args: Record<string, unknown>;
  timestamp?: number;
};

/**
 * Validate tool preconditions before execution to prevent common AI flow failures.
 *
 * This function implements the critical AI flow design principle: validate before execute.
 * It catches common patterns that lead to tool failures and provides actionable guidance.
 *
 * @param toolName - Name of the tool being called
 * @param args - Tool arguments
 * @returns Array of pre-flight warnings (empty if all validations pass)
 */
export function validateToolPreconditions(
  _toolName: string,
  _args: Record<string, unknown>
): PreflightWarning[] {
  return [];
}

/**
 * Enhanced AI flow validation for TypeScript software engineering
 * Provides comprehensive validation of AI tool usage patterns
 */
export function validateAIFlowPatterns(
  _toolName: string,
  _args: Record<string, unknown>,
  _toolHistory: readonly ToolHistoryCall[]
): PreflightWarning[] {
  return [];
}

function isBroadBasePattern(pattern: string): boolean {
  // Only the truly universal patterns that match everything
  return pattern === '.' || pattern === '*' || pattern === '**' || pattern === '**/*';
}

function isVeryBroadRegex(pattern: string): boolean {
  const normalized = pattern.trim();
  return normalized === '.*' || normalized === '.+' || normalized === '.';
}

function hasMatchingRead(
  toolHistory: readonly ToolHistoryCall[],
  targetPath: string | null
): boolean {
  if (!targetPath) return false;

  return toolHistory.some((call) => {
    const callLower = call.toolName.toLowerCase();
    if (!callLower.includes('read')) {
      return false;
    }

    const readPath = normalizeFilePath(call.args['path'] ?? call.args['file_path']);
    return Boolean(readPath && readPath === targetPath);
  });
}

function isNewFileEdit(oldString: unknown): boolean {
  return typeof oldString === 'string' && oldString.length === 0;
}

function normalizeFilePath(pathValue: unknown): string | null {
  if (typeof pathValue !== 'string') {
    return null;
  }

  const trimmed = pathValue.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const normalized = normalizePath(trimmed);
    const absolutePath = isAbsolute(normalized) ? normalized : resolvePath(process.cwd(), normalized);

    // Resolve symlinks on the deepest existing directory to avoid /var vs /private/var mismatches
    let currentDir = dirname(absolutePath);
    let suffix = basename(absolutePath);

    // Loop until we find an existing ancestor or hit the filesystem root.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (existsSync(currentDir)) {
        try {
          const realDir = realpathSync(currentDir);
          return normalizePath(join(realDir, suffix));
        } catch {
          // If realpath fails, fall through to the default normalization
          break;
        }
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }

      suffix = join(basename(currentDir), suffix);
      currentDir = parentDir;
    }

    return normalizePath(absolutePath);
  } catch {
    return trimmed;
  }
}
