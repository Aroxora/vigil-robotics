/**
 * Auto-executor for validation gaps, recommendations, and follow-ups
 *
 * This module parses assistant responses and automatically executes:
 * - Validation gaps (e.g., npm install if tests fail)
 * - Recommendations (e.g., remove unnecessary files)
 * - Follow-up tasks (e.g., git status)
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { unlink, rm } from 'node:fs/promises';

const execAsync = promisify(exec);

export interface ValidationGap {
  type: 'validation_gap';
  description: string;
  command: string;
  autoExecutable: boolean;
}

export interface Recommendation {
  type: 'recommendation';
  description: string;
  action: 'remove_file' | 'remove_dir' | 'run_command';
  target?: string;
  command?: string;
  requiresConfirmation: boolean;
}

export interface FollowUp {
  type: 'follow_up';
  description: string;
  command: string;
  autoExecutable: boolean;
}

export type AutoExecutableAction = ValidationGap | Recommendation | FollowUp;

export interface ParsedActions {
  validationGaps: ValidationGap[];
  recommendations: Recommendation[];
  followUps: FollowUp[];
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Parse assistant response for structured actions
 */
export function parseAssistantResponse(response: string): ParsedActions {
  const validationGaps: ValidationGap[] = [];
  const recommendations: Recommendation[] = [];
  const followUps: FollowUp[] = [];

  // Parse validation gaps
  const validationGapPattern = /Validation Gap:?\s*(.+?)(?:\n|$)/gi;
  let match;
  while ((match = validationGapPattern.exec(response)) !== null) {
    const description = match[1]?.trim();
    if (description) {
      const command = extractCommand(description);
      if (command) {
        validationGaps.push({
          type: 'validation_gap',
          description,
          command,
          autoExecutable: isAutoExecutable(command),
        });
      }
    }
  }

  // Parse common validation gap patterns
  if (response.includes('npm install') && response.includes('dependencies')) {
    validationGaps.push({
      type: 'validation_gap',
      description: 'Install dependencies to run tests',
      command: 'npm install',
      autoExecutable: true,
    });
  }

  // Parse recommendations
  const recommendationPattern = /Recommend(?:ation)?s?:?\s*(.+?)(?:\n|$)/gi;
  while ((match = recommendationPattern.exec(response)) !== null) {
    const description = match[1]?.trim();
    if (description) {
      const action = parseRecommendationAction(description);
      if (action) {
        recommendations.push(action);
      }
    }
  }

  // Parse follow-ups
  const followUpPattern = /Follow[- ]?[Uu]ps?:?\s*(.+?)(?:\n|$)/gi;
  while ((match = followUpPattern.exec(response)) !== null) {
    const description = match[1]?.trim();
    if (description) {
      const command = extractCommand(description);
      if (command) {
        followUps.push({
          type: 'follow_up',
          description,
          command,
          autoExecutable: isAutoExecutable(command),
        });
      }
    }
  }

  // Parse common follow-up patterns
  if (response.match(/run\s+`?git status`?/i)) {
    followUps.push({
      type: 'follow_up',
      description: 'Check git status for untracked files',
      command: 'git status',
      autoExecutable: true,
    });
  }

  return { validationGaps, recommendations, followUps };
}

/**
 * Extract command from description text
 */
function extractCommand(text: string): string | null {
  // Look for commands in backticks or quotes
  const backtickMatch = text.match(/`([^`]+)`/);
  if (backtickMatch && backtickMatch[1]) {
    return backtickMatch[1];
  }

  // Look for npm commands
  const npmMatch = text.match(/npm\s+(?:run\s+)?[\w:-]+/);
  if (npmMatch) {
    return npmMatch[0];
  }

  // Look for git commands
  const gitMatch = text.match(/git\s+[\w-]+(?:\s+[^\s]+)*/);
  if (gitMatch) {
    return gitMatch[0];
  }

  return null;
}

/**
 * Parse recommendation action from description
 */
function parseRecommendationAction(description: string): Recommendation | null {
  // Check for file/directory removal
  if (description.match(/remove|delete/i)) {
    const pathMatch = description.match(/[./][\w/.-]+/);
    if (pathMatch) {
      const target = pathMatch[0];
      return {
        type: 'recommendation',
        description,
        action: target.includes('.') ? 'remove_file' : 'remove_dir',
        target,
        requiresConfirmation: true,
      };
    }
  }

  // Check for command execution
  const command = extractCommand(description);
  if (command) {
    return {
      type: 'recommendation',
      description,
      action: 'run_command',
      command,
      requiresConfirmation: !isAutoExecutable(command),
    };
  }

  return null;
}

/**
 * Check if command is safe to auto-execute.
 * Safe commands are: read-only, idempotent, or standard dev workflow commands
 * that don't modify system state outside the project.
 */
function isAutoExecutable(command: string): boolean {
  const safeCommands = [
    // Package management (install only, not publish/uninstall)
    /^npm\s+install$/,
    /^npm\s+i$/,
    /^npm\s+ci$/,
    /^pnpm\s+install$/,
    /^yarn(\s+install)?$/,

    // Standard dev workflow scripts
    /^npm\s+test(\s|$)/,
    /^npm\s+run\s+(?:test|build|lint|type-check|typecheck|check|verify|compile|format|prettier|eslint)(?::\w+)?$/,
    /^pnpm\s+(?:test|build|lint|type-check|typecheck)$/,
    /^yarn\s+(?:test|build|lint|type-check|typecheck)$/,

    // Direct tool invocations (read-only / idempotent)
    /^npx\s+(?:tsc|eslint|prettier|jest|vitest|mocha)(?:\s|$)/,
    /^tsc(?:\s+--noEmit)?$/,
    /^eslint\s/,
    /^prettier\s+--check\s/,

    // Git read-only commands
    /^git\s+status$/,
    /^git\s+diff(?:\s|$)/,
    /^git\s+log(?:\s|$)/,
    /^git\s+show(?:\s|$)/,
    /^git\s+branch(?:\s+-[avr])?$/,
    /^git\s+remote\s+-v$/,

    // Read-only filesystem commands
    /^ls(?:\s|$)/,
    /^cat\s/,
    /^head\s/,
    /^tail\s/,
    /^wc\s/,
    /^find\s.*-type\s+[fd](?:\s|$)/,
    /^du\s/,
    /^df\s/,
  ];

  return safeCommands.some((pattern) => pattern.test(command));
}

/**
 * Execute a validation gap
 */
export async function executeValidationGap(
  gap: ValidationGap,
  workingDir: string
): Promise<ExecutionResult> {
  try {
    const { stdout, stderr } = await execAsync(gap.command, {
      cwd: workingDir,
      timeout: 10 * 60 * 1000, // 10 minutes
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    return {
      success: true,
      output: stdout || stderr,
    };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      output: err?.stdout || '',
      error: err?.stderr || err?.message,
    };
  }
}

/**
 * Execute a recommendation
 */
export async function executeRecommendation(
  recommendation: Recommendation,
  workingDir: string
): Promise<ExecutionResult> {
  try {
    switch (recommendation.action) {
      case 'remove_file':
        if (recommendation.target) {
          const fullPath = `${workingDir}/${recommendation.target}`;
          await unlink(fullPath);
          return {
            success: true,
            output: `Removed file: ${recommendation.target}`,
          };
        }
        break;

      case 'remove_dir':
        if (recommendation.target) {
          const fullPath = `${workingDir}/${recommendation.target}`;
          await rm(fullPath, { recursive: true });
          return {
            success: true,
            output: `Removed directory: ${recommendation.target}`,
          };
        }
        break;

      case 'run_command':
        if (recommendation.command) {
          const { stdout, stderr } = await execAsync(recommendation.command, {
            cwd: workingDir,
            timeout: 5 * 60 * 1000,
            maxBuffer: 10 * 1024 * 1024,
          });
          return {
            success: true,
            output: stdout || stderr,
          };
        }
        break;
    }

    return {
      success: false,
      output: '',
      error: 'Invalid recommendation action',
    };
  } catch (error: unknown) {
    const err = error as { message?: string };
    return {
      success: false,
      output: '',
      error: err?.message || 'Recommendation execution failed',
    };
  }
}

/**
 * Execute a follow-up task
 */
export async function executeFollowUp(
  followUp: FollowUp,
  workingDir: string
): Promise<ExecutionResult> {
  try {
    const { stdout, stderr } = await execAsync(followUp.command, {
      cwd: workingDir,
      timeout: 5 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      success: true,
      output: stdout || stderr,
    };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      output: err?.stdout || '',
      error: err?.stderr || err?.message,
    };
  }
}

/**
 * Execute all auto-executable actions
 */
export async function executeAutoActions(
  actions: ParsedActions,
  workingDir: string,
  options: { skipConfirmation?: boolean } = {}
): Promise<{
  executed: number;
  failed: number;
  results: Array<{ type: string; description: string; result: ExecutionResult }>;
}> {
  const results: Array<{ type: string; description: string; result: ExecutionResult }> = [];
  let executed = 0;
  let failed = 0;

  // Execute validation gaps
  for (const gap of actions.validationGaps) {
    if (gap.autoExecutable) {
      const result = await executeValidationGap(gap, workingDir);
      results.push({ type: 'validation_gap', description: gap.description, result });
      executed++;
      if (!result.success) failed++;
    }
  }

  // Execute recommendations (only if skipConfirmation or requiresConfirmation is false)
  for (const rec of actions.recommendations) {
    if (!rec.requiresConfirmation || options.skipConfirmation) {
      const result = await executeRecommendation(rec, workingDir);
      results.push({ type: 'recommendation', description: rec.description, result });
      executed++;
      if (!result.success) failed++;
    }
  }

  // Execute follow-ups
  for (const followUp of actions.followUps) {
    if (followUp.autoExecutable) {
      const result = await executeFollowUp(followUp, workingDir);
      results.push({ type: 'follow_up', description: followUp.description, result });
      executed++;
      if (!result.success) failed++;
    }
  }

  return { executed, failed, results };
}
