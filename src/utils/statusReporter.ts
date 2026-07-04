import { stdout } from 'node:process';

type StatusSink = (message: string) => void;

let statusSink: StatusSink | null = null;

const normalizeStatusMessage = (message: string): string =>
  message.replace(/\s+/g, ' ').trim();

export function setStatusSink(sink: StatusSink | null): void {
  statusSink = sink;
}

export function reportStatus(message: string): void {
  const normalized = normalizeStatusMessage(message);
  if (!normalized) {
    return;
  }
  if (statusSink) {
    statusSink(normalized);
    return;
  }
  // Plain stdout fallback — used early in boot (before Ink is ready)
  // and as the fallback for non-fatal status pings.
  stdout.write(`${normalized}\n`);
}

/**
 * Render a fatal error as an Ink card and exit. Used by every catch
 * block in src/bin/vigil.ts so the user sees a consistent red panel
 * instead of a one-line console.error. Falls back to stderr if Ink
 * fails to mount (degraded TTY, ENOTTY, etc.) so the user always sees
 * the message somewhere.
 */
export async function reportFatal(error: unknown, prefix: string = 'Error'): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const safePrefix = prefix.trim() || 'Error';
  try {
    const { showCard } = await import('../ui/ink/oneShot.js');
    await showCard({ tone: 'error', title: safePrefix, body: message });
  } catch {
    // Ink failed (no TTY, etc.). Still surface the message.
    process.stderr.write(`${safePrefix}: ${message}\n`);
  }
}

/**
 * Legacy non-Ink error reporter. Prefer reportFatal() for new call
 * sites; this stays for low-level paths that can't await an import
 * (e.g. signal handlers).
 */
export function reportStatusError(error: unknown, prefix: string = 'Error'): void {
  const message = error instanceof Error ? error.message : String(error);
  const safePrefix = prefix.trim();
  const text = safePrefix
    ? `${safePrefix}${safePrefix.endsWith(':') ? '' : ':'} ${message}`
    : message;
  reportStatus(text);
}
