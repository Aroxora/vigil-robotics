/**
 * EnterWorktree / ExitWorktree — Claude-Code-parity isolation tools.
 *
 * Creates a temporary git worktree the agent can work in without
 * disturbing the user's checkout, then cleans it up. Used by the
 * sub-agent flow when `isolation: "worktree"` is requested, and
 * directly by the agent for risky multi-file changes that should
 * land as a single PR.
 *
 * Worktrees are created under <repoRoot>/.vigil/worktrees/<id>/.
 * The branch follows `vigil/worktree/<id>` so a stale tree is
 * easy to spot in `git branch`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';

const WORKTREE_REGISTRY = new Map<string, { path: string; branch: string }>();

function repoRoot(workingDir: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workingDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() || workingDir;
  } catch {
    return workingDir;
  }
}

function safeId(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return `wt-${Date.now().toString(36)}`;
  // Lock down to alnum/hyphen/underscore. Caller owns the ergonomic name.
  return s.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
}

export function getWorktreeRegistry(): ReadonlyMap<string, { path: string; branch: string }> {
  return WORKTREE_REGISTRY;
}

export function clearWorktreeRegistry(): void {
  WORKTREE_REGISTRY.clear();
}

export function createWorktreeTools(workingDir: string): ToolDefinition[] {
  return [
    {
      name: 'EnterWorktree',
      description:
        'Create a temporary git worktree for isolated changes. ' +
        'Returns the worktree path; the agent should `cd` into it ' +
        'or pass the path to subsequent file ops. Use for risky or ' +
        'speculative changes that should not touch the live checkout.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description:
              'Short ergonomic id for the worktree (alnum/-/_, ≤64 chars). ' +
              'Used in path and branch name. Auto-generated if omitted.',
          },
          base: {
            type: 'string',
            description: 'Branch or commit to base the worktree on. Defaults to HEAD.',
          },
        },
      },
      handler: async (args) => {
        const id = safeId(args['id']);
        if (WORKTREE_REGISTRY.has(id)) {
          const existing = WORKTREE_REGISTRY.get(id)!;
          return `Worktree "${id}" already exists at ${existing.path} (branch ${existing.branch}).`;
        }
        const root = repoRoot(workingDir);
        const wtRoot = join(root, '.vigil', 'worktrees');
        if (!existsSync(wtRoot)) {
          mkdirSync(wtRoot, { recursive: true });
        }
        const wtPath = join(wtRoot, id);
        const branch = `vigil/worktree/${id}`;
        const base = typeof args['base'] === 'string' && args['base'].trim() ? args['base'].trim() : 'HEAD';

        try {
          execFileSync('git', ['worktree', 'add', '-b', branch, wtPath, base], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `EnterWorktree failed: ${msg}`;
        }

        WORKTREE_REGISTRY.set(id, { path: wtPath, branch });
        return `Worktree "${id}" created at ${wtPath} on branch ${branch}.`;
      },
    },
    {
      name: 'ExitWorktree',
      description:
        'Remove a worktree previously created by EnterWorktree. ' +
        'Pass `keepBranch: true` to preserve the branch (the worktree ' +
        'directory is always removed). Use this once the changes have ' +
        'been merged back or are no longer needed.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Worktree id from EnterWorktree.' },
          keepBranch: {
            type: 'boolean',
            description: 'Preserve the underlying branch after removing the worktree.',
          },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const id = safeId(args['id']);
        const entry = WORKTREE_REGISTRY.get(id);
        if (!entry) {
          return `No registered worktree with id "${id}". Use EnterWorktree first.`;
        }
        const root = repoRoot(workingDir);
        try {
          execFileSync('git', ['worktree', 'remove', '--force', entry.path], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch {
          if (existsSync(entry.path)) {
            rmSync(entry.path, { recursive: true, force: true });
          }
        }
        if (!args['keepBranch']) {
          try {
            execFileSync('git', ['branch', '-D', entry.branch], {
              cwd: root,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } catch {
            // Branch may already be gone or detached; non-fatal.
          }
        }
        WORKTREE_REGISTRY.delete(id);
        return `Worktree "${id}" removed${args['keepBranch'] ? ' (branch retained)' : ''}.`;
      },
    },
    {
      name: 'ListWorktrees',
      description: 'List active worktrees registered by EnterWorktree.',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        if (WORKTREE_REGISTRY.size === 0) {
          return 'No active worktrees.';
        }
        const lines = Array.from(WORKTREE_REGISTRY.entries()).map(
          ([id, e]) => `${id} → ${resolve(e.path)} (branch ${e.branch})`,
        );
        return lines.join('\n');
      },
    },
  ];
}
