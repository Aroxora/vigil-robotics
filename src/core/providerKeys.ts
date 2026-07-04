/**
 * Provider key resolution utilities.
 * Supports user-supplied overrides (USER_<KEY>) with environment fallbacks.
 * If neither is set, reports as missing so the runtime can prompt the user.
 */

export type KeySource = 'user' | 'env' | 'missing';

export interface ResolvedKey {
  name: string;
  value?: string;
  source: KeySource;
}

function pickKey(name: string): ResolvedKey {
  const user = process.env[`USER_${name}`];
  if (user && user !== 'CHANGE_ME') {
    return { name, value: user, source: 'user' };
  }
  const env = process.env[name];
  if (env && env !== 'CHANGE_ME') {
    return { name, value: env, source: 'env' };
  }
  return { name, source: 'missing' };
}

/**
 * Resolves a list of keys, preferring user-supplied overrides.
 */
export function resolveKeys(names: string[]): ResolvedKey[] {
  return names.map((n) => pickKey(n));
}

/**
 * Builds a user-facing message listing missing keys and how to provide them.
 */
export function buildMissingKeyMessage(names: string[]): string | null {
  const resolved = resolveKeys(names);
  const missing = resolved.filter((r) => r.source === 'missing').map((r) => r.name);
  if (missing.length === 0) return null;
  const lines = [
    'The following API keys or connections are missing:',
    ...missing.map((m) => `- ${m} (set USER_${m} for user-scoped, or ${m} for env-scoped)`),
    '',
    'You can provide user-scoped keys by setting USER_<KEY> (preferred for per-user billing),',
    'or set the env var globally if you intend to bill via platform keys.',
  ];
  return lines.join('\n');
}
