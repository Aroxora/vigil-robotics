/**
 * Session-scoped quota state for external providers (Tavily, DeepSeek,
 * future model brains). When an upstream API responds with a quota /
 * insufficient-balance signal — i.e. one that retrying within this
 * session won't fix — we mark the provider DISABLED and short-circuit
 * future calls with a user-friendly message instead of hammering the
 * provider further or surfacing a raw HTTP error.
 *
 * Rate-limit errors (429 Retry-After style) do NOT disable here; the
 * resilientProvider retry+backoff handles those. This module is for
 * "monthly limit hit, won't recover this billing cycle" cases.
 *
 * State is in-memory and resets when the CLI restarts; no disk
 * persistence so a top-up + relaunch immediately works.
 */

export type ProviderQuotaName = 'tavily' | 'deepseek' | (string & {});

export interface ProviderQuotaInfo {
  reason: string;
  detectedAt: number;
  detail?: string;
  /**
   * Optional HTTP status that triggered the disable. Lets callers
   * decide whether to expose it to the user.
   */
  httpStatus?: number;
}

const disabled = new Map<ProviderQuotaName, ProviderQuotaInfo>();

const TOP_UP_URLS: Record<string, string> = {
  tavily: 'https://app.tavily.com/home (billing tab)',
  deepseek: 'https://platform.deepseek.com/usage',
};

const PROVIDER_FRIENDLY_NAME: Record<string, string> = {
  tavily: 'Tavily (WebSearch / WebExtract)',
  deepseek: 'DeepSeek (model brain)',
};

export function markProviderQuotaExhausted(
  provider: ProviderQuotaName,
  reason: string,
  extras: { detail?: string; httpStatus?: number } = {},
): void {
  const existing = disabled.get(provider);
  if (existing) return; // first signal wins; don't churn
  disabled.set(provider, {
    reason,
    detectedAt: Date.now(),
    ...(extras.detail !== undefined ? { detail: extras.detail } : {}),
    ...(extras.httpStatus !== undefined ? { httpStatus: extras.httpStatus } : {}),
  });
}

export function isProviderQuotaExhausted(provider: ProviderQuotaName): boolean {
  return disabled.has(provider);
}

export function getProviderQuotaInfo(provider: ProviderQuotaName): ProviderQuotaInfo | null {
  return disabled.get(provider) ?? null;
}

export function clearProviderQuota(provider: ProviderQuotaName): void {
  disabled.delete(provider);
}

export function buildQuotaExhaustedMessage(provider: ProviderQuotaName): string {
  const info = disabled.get(provider);
  const friendly = PROVIDER_FRIENDLY_NAME[provider] ?? provider;
  const topUp = TOP_UP_URLS[provider];
  const detail = info?.detail ? ` (${info.detail.slice(0, 200)})` : '';
  const lines = [
    `${friendly} is disabled for the rest of this session — monthly quota or account balance exhausted${detail}.`,
    `Wait for the monthly reset or top up this month${topUp ? ` at ${topUp}` : ''}, then restart Vigil to re-enable.`,
    '',
    '\x1b[33m💡 Use your own API keys to bypass server quota:',
    `  vigil --key sk-...        (DeepSeek: https://platform.deepseek.com/api_keys)`,
    `  vigil --tavily-key tvly-...  (Tavily: https://app.tavily.com/home)`,
    '  Then restart Vigil — custom keys override built-in keys.\x1b[0m',
  ];
  return lines.join('\n');
}

/**
 * Heuristic: given an HTTP status + response body fragment, decide
 * whether the failure is "out of quota / out of balance" (persistent)
 * vs. transient rate-limit. Returns null for "neither / inconclusive".
 *
 * This is shared by the Tavily handlers and the model provider wrapper
 * so we stay consistent about which signals burn the quota flag.
 */
export function classifyUpstreamError(
  status: number | undefined,
  body: string | undefined,
): 'quota-exhausted' | 'rate-limit' | null {
  const text = (body ?? '').toLowerCase();
  // Strong quota signals — payment-required or explicit balance errors.
  if (status === 402) return 'quota-exhausted';
  if (text.includes('insufficient_balance') || text.includes('insufficient balance')) return 'quota-exhausted';
  if (text.includes('insufficient_quota')) return 'quota-exhausted';
  if (text.includes('usage limit exceeded')) return 'quota-exhausted';
  if (text.includes('quota exceeded')) return 'quota-exhausted';
  if (text.includes('exceeded your current quota')) return 'quota-exhausted';
  if (text.includes('monthly limit')) return 'quota-exhausted';
  if (text.includes('plan_limit')) return 'quota-exhausted';
  if (text.includes('account suspended') || text.includes('account disabled')) return 'quota-exhausted';
  // Rate-limit only — transient, don't disable.
  if (status === 429) return 'rate-limit';
  if (text.includes('rate limit') || text.includes('rate_limit') || text.includes('ratelimit')) return 'rate-limit';
  if (text.includes('too many requests')) return 'rate-limit';
  return null;
}
