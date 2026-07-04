/**
 * Global Write Lock - Robust streaming-safe output coordination
 *
 * This module provides a thread-safe mechanism to ensure streaming content
 * is not interrupted by other UI components during streaming.
 *
 * Design Principles:
 * - During streaming, ONLY streaming content writes to stdout
 * - All other UI components (status, input area, etc.) wait until streaming ends
 * - Supports nested/re-entrant locking with reference counting
 * - Provides timeout-based automatic unlock for safety
 *
 * This prevents the garbled output and cutoffs that occur when multiple
 * components try to write simultaneously with cursor positioning.
 */

/** Current lock depth for re-entrant locking */
let lockDepth = 0;

/** Streaming mode flag (true when actively streaming content) */
let streamingActive = false;

/** Queue of callbacks waiting for stream to finish */
const pendingCallbacks: Array<() => void> = [];

/** Maximum pending callbacks to prevent memory leaks */
const MAX_PENDING_CALLBACKS = 100;

/** Safety timeout to auto-release stuck locks (30 seconds) */
const LOCK_TIMEOUT_MS = 30000;

/** Timer for auto-unlock safety mechanism */
let safetyTimer: NodeJS.Timeout | null = null;

/**
 * Check if streaming mode is currently active
 */
export function isStreamingMode(): boolean {
  return streamingActive || lockDepth > 0;
}

/**
 * Get current lock depth (for debugging)
 */
export function getLockDepth(): number {
  return lockDepth;
}

/**
 * Enter streaming mode - blocks all non-streaming output
 * Supports nested calls with reference counting
 */
export function enterStreamingMode(): void {
  lockDepth++;
  streamingActive = true;

  // Set safety timer on first lock
  if (lockDepth === 1 && !safetyTimer) {
    safetyTimer = setTimeout(() => {
      if (streamingActive) {
        // Force release if lock is held too long (safety mechanism)
        console.warn('[GlobalWriteLock] Safety timeout triggered - forcing release');
        forceRelease();
      }
    }, LOCK_TIMEOUT_MS);
  }
}

/**
 * Exit streaming mode - allows normal UI output to resume
 * Only fully exits when all nested locks are released
 */
export function exitStreamingMode(): void {
  if (lockDepth > 0) {
    lockDepth--;
  }

  // Only clear streaming mode when all locks are released
  if (lockDepth === 0) {
    streamingActive = false;
    clearSafetyTimer();
    flushPendingCallbacks();
  }
}

/**
 * Force release all locks (emergency/cleanup use)
 */
export function forceRelease(): void {
  lockDepth = 0;
  streamingActive = false;
  clearSafetyTimer();
  flushPendingCallbacks();
}

/**
 * Clear the safety timer
 */
function clearSafetyTimer(): void {
  if (safetyTimer) {
    clearTimeout(safetyTimer);
    safetyTimer = null;
  }
}

/**
 * Flush all pending callbacks
 */
function flushPendingCallbacks(): void {
  // Process callbacks in order
  while (pendingCallbacks.length > 0) {
    const callback = pendingCallbacks.shift();
    try {
      callback?.();
    } catch {
      // Silently ignore callback errors to prevent cascading failures
    }
  }
}

/**
 * Execute a callback only if not in streaming mode.
 * Returns true if the callback was executed, false if skipped.
 */
export function ifNotStreaming(callback: () => void): boolean {
  if (isStreamingMode()) {
    return false;
  }
  try {
    callback();
    return true;
  } catch {
    // Silently handle callback errors
    return false;
  }
}

/**
 * Execute a callback when streaming ends (immediately if not streaming)
 * Queues the callback if currently streaming
 */
export function whenStreamingEnds(callback: () => void): void {
  if (!isStreamingMode()) {
    try {
      callback();
    } catch {
      // Silently handle callback errors
    }
    return;
  }

  // Queue callback for later, with overflow protection
  if (pendingCallbacks.length < MAX_PENDING_CALLBACKS) {
    pendingCallbacks.push(callback);
  }
}

/**
 * Execute callback with exclusive stream lock
 * Automatically acquires and releases the lock
 */
export async function withStreamLock<T>(callback: () => T | Promise<T>): Promise<T> {
  enterStreamingMode();
  try {
    return await callback();
  } finally {
    exitStreamingMode();
  }
}

/**
 * Legacy: installGlobalWriteLock is now a no-op
 * The old approach of wrapping stdout.write caused nested lock issues.
 * We now use a simpler streaming mode flag instead.
 */
export function installGlobalWriteLock(): void {
  // No-op - we no longer wrap stdout.write
  // The streaming mode flag handles coordination instead
}

/**
 * Reset all state (for testing)
 */
export function resetGlobalWriteLock(): void {
  lockDepth = 0;
  streamingActive = false;
  clearSafetyTimer();
  pendingCallbacks.length = 0;
}
