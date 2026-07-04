/**
 * Centralized guidance for bash command flows.
 * Keeps publish/git heuristics in one place so bash tooling stays concise.
 */

export type BashFlowSeverity = 'info' | 'warning' | 'critical';

export interface BashFlowWarning {
  readonly code: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly severity?: BashFlowSeverity;
}

/**
 * Analyze a bash command for common workflow gaps (publish, git efficiency).
 */
export function analyzeBashFlow(command: string): BashFlowWarning[] {
  const warnings: BashFlowWarning[] = [];
  const normalized = command.toLowerCase();

  if (!normalized.trim()) {
    return warnings;
  }

  // Git efficiency: avoid repeated status calls in a single command chain.
  const gitStatusMatches = normalized.match(/git status/g);
  if (gitStatusMatches && gitStatusMatches.length > 1) {
    warnings.push({
      code: 'GIT_REDUNDANT_STATUS',
      message: 'Multiple git status calls detected in one command',
      suggestion: 'Combine git operations: git add -A && git commit -m "msg" && git push',
      severity: 'info',
    });
  }

  // Publish flow completeness for npm-style commands.
  if (normalized.includes('npm publish')) {
    const hasVersionStep = /\b(?:npm|pnpm|yarn)\s+version\b/.test(normalized);
    const hasBuildOrTests = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(build|test|lint|prepare)\b/.test(normalized);
    const hasGitPush = /\bgit\s+push\b/.test(normalized);

    if (!(hasVersionStep && hasBuildOrTests && hasGitPush)) {
      warnings.push({
        code: 'NPM_INCOMPLETE_WORKFLOW',
        message: 'npm publish detected without a complete release flow',
        suggestion: 'Include version bump, build/tests, and git push or use npm_publish to automate the full release',
        severity: 'warning',
      });
    }
  }

  return warnings;
}
