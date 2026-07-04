/**
 * RenderGate — single-source-of-truth render scheduler for the terminal
 * UI. Modeled on Claude Code's render-on-commit pattern (custom React
 * reconciler with a dirty flag + double buffering): every state mutation
 * calls markDirty(); a fixed-rate tick commits at most once per frame
 * when state actually changed. The gate guarantees:
 *
 *   1. Animation-driven repaints (spinner, elapsed timer) happen every
 *      frame regardless of whether stdin produced an event. The previous
 *      design had multiple silent-drop paths inside the renderer
 *      (renderThrottle / paste suppression / mode early-return); when ANY
 *      of those flagged on, the screen froze until a keystroke fired.
 *
 *   2. State mutations are batched within a frame. Setting mode +
 *      activity + status in the same JS turn results in ONE commit, not
 *      three.
 *
 *   3. Re-entrant commits are impossible — the gate is locked while a
 *      commit is in flight.
 *
 *   4. A best-effort defer hook (canCommitNow) lets the renderer ask the
 *      gate to wait when an overlay rewrite would be unsafe (e.g.
 *      mid-bracketed-paste). But deferral is hard-bounded: past
 *      maxDeferMs the gate force-commits, so a stuck flag can never
 *      freeze the UI again.
 *
 * This is purely additive: existing inline render calls (renderPrompt)
 * keep working. The gate's tick is the safety net that ensures the
 * screen stays in sync with state even when those inline calls early-
 * return for reasons that wouldn't survive scrutiny.
 */

export interface RenderGateOptions {
  /** Target frame rate. Claude Code's frame budget is ~30fps. */
  fps?: number;
  /** Run a single commit pass; called only when dirty. */
  commit: () => void;
  /**
   * Optional pre-commit gate. Returning false defers this frame's
   * commit. The gate enforces a hard upper bound on consecutive defers
   * (maxDeferMs) so a stuck precondition can never freeze the UI.
   */
  canCommitNow?: () => boolean;
  /** Hard upper bound on consecutive deferrals (default 1500 ms). */
  maxDeferMs?: number;
}

export class RenderGate {
  private dirty = false;
  private rendering = false;
  private readonly targetFrameMs: number;
  private interval: NodeJS.Timeout | null = null;
  private commitCount = 0;
  private skipCount = 0;
  private forceCommitCount = 0;
  private deferStartedAt = 0;
  private readonly commitFn: () => void;
  private readonly canCommitNow: (() => boolean) | null;
  private readonly maxDeferMs: number;
  private disposed = false;

  constructor(opts: RenderGateOptions) {
    this.targetFrameMs = 1000 / (opts.fps ?? 30);
    this.commitFn = opts.commit;
    this.canCommitNow = opts.canCommitNow ?? null;
    this.maxDeferMs = opts.maxDeferMs ?? 1500;
  }

  /** Start the frame-rate tick. Idempotent. */
  start(): void {
    if (this.interval || this.disposed) return;
    this.interval = setInterval(() => this.tick(false), this.targetFrameMs);
    // Allow the process to exit even if the gate is still ticking.
    if (typeof this.interval?.unref === "function") this.interval.unref();
  }

  /** Stop the tick. Safe to call repeatedly. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Mark state dirty. The next tick (or a flush()) will commit once. */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Synchronous force-commit, ignoring deferral and the dirty flag.
   * Use sparingly — for transitions where the next thing to happen
   * (e.g. clearing the screen, reading user input) needs the new state
   * already on the wire.
   */
  flush(): void {
    if (this.rendering || this.disposed) return;
    this.rendering = true;
    this.dirty = false;
    try {
      this.commitFn();
      this.commitCount++;
      this.forceCommitCount++;
    } finally {
      this.rendering = false;
    }
  }

  private tick(force: boolean): void {
    if (this.rendering || this.disposed) return;
    if (!this.dirty && !force) return;

    // Optional defer hook — but never defer past maxDeferMs. This is
    // what kills the stuck-flag freeze: if the precondition (e.g. paste
    // flag) wedges, we still commit eventually so the timer/spinner
    // never appear paused.
    if (this.canCommitNow && !force) {
      const canCommit = this.canCommitNow();
      if (!canCommit) {
        if (this.deferStartedAt === 0) this.deferStartedAt = Date.now();
        if (Date.now() - this.deferStartedAt < this.maxDeferMs) {
          this.skipCount++;
          return;
        }
        // Past the bound — force-commit anyway.
        this.forceCommitCount++;
      }
      this.deferStartedAt = 0;
    }

    this.rendering = true;
    this.dirty = false;
    try {
      this.commitFn();
      this.commitCount++;
    } finally {
      this.rendering = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /** Telemetry — useful for debugging stuck-state issues. */
  stats(): { commitCount: number; skipCount: number; forceCommitCount: number; dirty: boolean } {
    return {
      commitCount: this.commitCount,
      skipCount: this.skipCount,
      forceCommitCount: this.forceCommitCount,
      dirty: this.dirty,
    };
  }
}
