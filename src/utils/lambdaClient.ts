/**
 * Minimal CLI-side client for the Vigil AWS Lambda callable surface.
 *
 * Mirrors the `httpsCallable` envelope used by the portal:
 *   POST <API_BASE>/callable/<name>
 *   Authorization: Bearer <Firebase ID token>
 *   { data: ... }
 *
 * Used by the cron / webhook / HITL tools so they can talk to the same
 * Lambda + Firestore the portal does. Auth is best-effort: if the user
 * has not signed in, callable requests fail with a clear message rather
 * than throwing — the calling tool decides whether the missing auth is
 * fatal or fallback-able.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LAMBDA_API_BASE = 'https://cfqeqx4lt9.execute-api.us-east-1.amazonaws.com';

export interface LambdaCallResult<T> {
  ok: boolean;
  status?: number;
  result?: T;
  error?: string;
}

interface CachedAuth {
  uid?: string;
  token?: string;
  tokenExpiresAt?: number;
  refreshToken?: string;
}

const AUTH_FILE = join(homedir(), '.vigil', 'auth.json');

export function readCliAuth(): CachedAuth | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_FILE, 'utf-8')) as CachedAuth;
  } catch {
    return null;
  }
}

function tokenLooksFresh(state: CachedAuth | null): boolean {
  if (!state?.token) return false;
  if (typeof state.tokenExpiresAt !== 'number') return true;
  // 60s safety margin so we don't burn a request on an about-to-expire token.
  return Date.now() + 60_000 < state.tokenExpiresAt;
}

export async function callLambda<T = unknown>(
  name: string,
  data: Record<string, unknown> | undefined,
  options: { signal?: AbortSignal; baseUrl?: string; timeoutMs?: number } = {},
): Promise<LambdaCallResult<T>> {
  const auth = readCliAuth();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (tokenLooksFresh(auth)) {
    headers.authorization = `Bearer ${auth!.token}`;
  } else {
    // Short-circuit: no fresh bearer means the Lambda's requireSignedIn
    // gate will reject. Skip the network round-trip entirely so the
    // caller's "best-effort mirror" path resolves immediately instead
    // of holding a connection until timeoutMs. This makes offline /
    // jest-suite runs (no auth.json) finish in microseconds rather
    // than timing out at 3–15s. v1.5 hardening 2026-05-10.
    return { ok: false, status: 401, error: 'unauthenticated (no fresh CLI token)' };
  }

  const controller = new AbortController();
  const timeout = options.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const baseUrl = options.baseUrl ?? LAMBDA_API_BASE;
    const res = await fetch(`${baseUrl}/callable/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: data ?? {} }),
      signal: controller.signal,
    });
    let body: { result?: T; error?: { status?: string; message?: string } } | null = null;
    try { body = await res.json() as typeof body; } catch { body = null; }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: body?.error?.message || `HTTP ${res.status}`,
      };
    }
    return { ok: true, status: res.status, result: body?.result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
