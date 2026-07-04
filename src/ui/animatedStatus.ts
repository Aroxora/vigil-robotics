/**
 * AnimatedStatus - Provides smooth, dynamic status indicators with animations
 * Integrates with the AnimationScheduler for real-time UI updates
 */

import { theme, spinnerFrames, progressChars } from './theme.js';
import { AnimationScheduler } from './animation/AnimationScheduler.js';
import { clampPercentage, getContextColor } from './uiConstants.js';

// Singleton scheduler for global animation coordination
let globalScheduler: AnimationScheduler | null = null;
let schedulerDisposed = false; // Prevent recreation after disposal
let schedulerRefCount = 0; // Reference counting for proper cleanup

/**
 * Get or create the global animation scheduler
 * Uses lazy initialization and reference counting
 */
function getScheduler(): AnimationScheduler {
  if (schedulerDisposed) {
    // Return a no-op scheduler if disposed to prevent recreation
    // This handles edge cases where animations try to register after cleanup
    if (!globalScheduler) {
      globalScheduler = createNoOpScheduler();
    }
    return globalScheduler;
  }
  if (!globalScheduler) {
    globalScheduler = new AnimationScheduler(30); // 30 FPS for smooth animations
  }
  schedulerRefCount++;
  return globalScheduler;
}

/**
 * Create a no-op scheduler for disposed state
 */
function createNoOpScheduler(): AnimationScheduler {
  const scheduler = new AnimationScheduler(30);
  scheduler.dispose(); // Immediately dispose - it's a stub
  return scheduler;
}

/**
 * Release a reference to the scheduler
 */
function releaseScheduler(): void {
  if (schedulerRefCount > 0) {
    schedulerRefCount--;
  }
}

/**
 * Animated spinner that cycles through frames
 */
export class AnimatedSpinner {
  private frameIndex = 0;
  private readonly frames: string[];
  private intervalId: NodeJS.Timeout | null = null;
  private message: string;
  private readonly color: (text: string) => string;
  private currentFrame = '';
  private onUpdate?: (frame: string) => void;

  constructor(
    message: string = '',
    style: 'dots' | 'arc' | 'circle' | 'bounce' | 'braille' = 'dots',
    color: (text: string) => string = theme.info
  ) {
    this.frames = spinnerFrames[style];
    this.message = message;
    this.color = color;
    this.currentFrame = this.frames[0] ?? '⠋';
  }

  start(onUpdate?: (frame: string) => void): void {
    this.onUpdate = onUpdate;
    this.frameIndex = 0;
    this.intervalId = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      this.currentFrame = this.frames[this.frameIndex] ?? '⠋';
      if (this.onUpdate) {
        this.onUpdate(this.render());
      }
    }, 80); // ~12 FPS for smooth spinner animations
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.onUpdate = undefined;
  }

  setMessage(message: string): void {
    this.message = message;
  }

  render(): string {
    const spinnerChar = this.color(this.currentFrame);
    return this.message ? `${spinnerChar} ${this.message}` : spinnerChar;
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }

  /**
   * Dispose of the spinner and clean up resources
   */
  dispose(): void {
    this.stop();
  }
}

/**
 * Animated progress bar with smooth transitions
 */
export class AnimatedProgressBar {
  private current = 0;
  private target = 0;
  private readonly total: number;
  private readonly width: number;
  private animationId: string | null = null;
  // Store the bound listener so we can remove it to prevent memory leaks
  private transitionHandler: ((data: { id: string; value: number }) => void) | null = null;

  constructor(total: number, width: number = 20) {
    this.total = total;
    this.width = width;
  }

  update(value: number): void {
    this.target = Math.min(value, this.total);

    // Smooth transition to target
    const scheduler = getScheduler();

    // Remove old listener before creating new animation to prevent accumulation
    if (this.transitionHandler) {
      scheduler.removeListener('transition:update', this.transitionHandler);
      this.transitionHandler = null;
    }

    if (this.animationId) {
      scheduler.unregister(this.animationId);
    }

    this.animationId = `progress-${Date.now()}`;
    scheduler.createTransition(
      this.animationId,
      this.current,
      this.target,
      'progress',
      300,
      AnimationScheduler.Easing.easeOutQuad
    );

    // Create and store the listener for proper cleanup
    this.transitionHandler = (data: { id: string; value: number }) => {
      if (data.id === this.animationId && typeof data.value === 'number') {
        this.current = data.value;
      }
    };
    scheduler.on('transition:update', this.transitionHandler);
  }

  render(): string {
    const percentage = this.total > 0 ? this.current / this.total : 0;
    const filled = Math.floor(percentage * this.width);
    const partial = (percentage * this.width) % 1;
    const empty = this.width - filled - (partial > 0 ? 1 : 0);

    let bar = theme.progress.bar(progressChars.filled.repeat(filled));

    if (partial > 0 && filled < this.width) {
      const partialIndex = Math.floor(partial * progressChars.partial.length);
      const partialChar = progressChars.partial[partialIndex] ?? progressChars.partial[0];
      bar += theme.progress.bar(partialChar);
    }

    bar += theme.progress.empty(progressChars.empty.repeat(Math.max(0, empty)));

    const percentText = theme.progress.percentage(`${Math.round(percentage * 100)}%`);
    return `${bar} ${percentText}`;
  }

  dispose(): void {
    // Remove the transition listener to prevent memory leaks
    if (this.transitionHandler) {
      try {
        getScheduler().removeListener('transition:update', this.transitionHandler);
      } catch {
        // Ignore errors during cleanup
      }
      this.transitionHandler = null;
    }
    if (this.animationId) {
      try {
        getScheduler().unregister(this.animationId);
      } catch {
        // Ignore errors during cleanup
      }
      this.animationId = null;
    }
    releaseScheduler();
  }
}

/**
 * Animated elapsed time display
 */
export class AnimatedElapsedTime {
  private startTime: number;
  private intervalId: NodeJS.Timeout | null = null;
  private currentDisplay = '0s';
  private onUpdate?: (display: string) => void;

  constructor() {
    this.startTime = Date.now();
  }

  start(onUpdate?: (display: string) => void): void {
    this.startTime = Date.now();
    this.onUpdate = onUpdate;
    this.intervalId = setInterval(() => {
      this.currentDisplay = this.format();
      if (this.onUpdate) {
        this.onUpdate(this.currentDisplay);
      }
    }, 1000); // Update every second
  }

  stop(): string {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.onUpdate = undefined;
    return this.format();
  }

  format(): string {
    const elapsed = Date.now() - this.startTime;
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
    } else {
      return `${seconds}s`;
    }
  }

  render(): string {
    return theme.ui.muted(this.currentDisplay);
  }

  dispose(): void {
    this.stop();
  }
}

/**
 * Pulsing text effect for emphasis
 */
export class PulsingText {
  private text: string;
  private intensity = 0;
  private increasing = true;
  private intervalId: NodeJS.Timeout | null = null;
  private onUpdate?: (rendered: string) => void;

  constructor(text: string) {
    this.text = text;
  }

  start(onUpdate?: (rendered: string) => void): void {
    this.onUpdate = onUpdate;
    this.intervalId = setInterval(() => {
      if (this.increasing) {
        this.intensity += 0.1;
        if (this.intensity >= 1) {
          this.intensity = 1;
          this.increasing = false;
        }
      } else {
        this.intensity -= 0.1;
        if (this.intensity <= 0.3) {
          this.intensity = 0.3;
          this.increasing = true;
        }
      }
      if (this.onUpdate) {
        this.onUpdate(this.render());
      }
    }, 50); // 20 FPS for pulse
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.onUpdate = undefined;
  }

  setText(text: string): void {
    this.text = text;
  }

  render(): string {
    // Use intensity to vary between dim and bright
    if (this.intensity > 0.7) {
      return theme.ui.highlight(this.text);
    } else if (this.intensity > 0.4) {
      return theme.info(this.text);
    } else {
      return theme.ui.muted(this.text);
    }
  }

  dispose(): void {
    this.stop();
  }
}

/**
 * Thinking indicator with animated dots
 */
export class ThinkingIndicator {
  private dotCount = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private label: string;
  private onUpdate?: (rendered: string) => void;

  constructor(label: string = 'Thinking') {
    this.label = label;
  }

  start(onUpdate?: (rendered: string) => void): void {
    this.onUpdate = onUpdate;
    this.dotCount = 0;
    this.intervalId = setInterval(() => {
      this.dotCount = (this.dotCount + 1) % 4;
      if (this.onUpdate) {
        this.onUpdate(this.render());
      }
    }, 400); // Slower animation for thinking
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.onUpdate = undefined;
  }

  setLabel(label: string): void {
    this.label = label;
  }

  render(): string {
    const dots = '.'.repeat(this.dotCount);
    const padding = ' '.repeat(3 - this.dotCount);
    return `${theme.thinking.icon('◐')} ${theme.thinking.label(this.label)}${theme.thinking.text(dots)}${padding}`;
  }

  dispose(): void {
    this.stop();
  }
}

/**
 * Streaming status with spinner and message
 */
export class StreamingStatus {
  private spinner: AnimatedSpinner;
  private elapsed: AnimatedElapsedTime;
  private isActive = false;

  constructor() {
    this.spinner = new AnimatedSpinner('', 'braille', theme.info);
    this.elapsed = new AnimatedElapsedTime();
  }

  start(message: string, onUpdate?: (status: string) => void): void {
    this.isActive = true;
    this.spinner.setMessage(message);

    const update = () => {
      if (this.isActive && onUpdate) {
        const spinnerPart = this.spinner.render();
        const elapsedPart = this.elapsed.render();
        onUpdate(`${spinnerPart} ${theme.ui.muted('·')} ${elapsedPart}`);
      }
    };

    this.spinner.start(update);
    this.elapsed.start(update);
  }

  updateMessage(message: string): void {
    this.spinner.setMessage(message);
  }

  stop(): string {
    this.isActive = false;
    this.spinner.stop();
    const finalTime = this.elapsed.stop();
    return `${theme.success('✓')} ${theme.ui.muted('Completed')} ${theme.ui.muted('·')} ${theme.ui.muted(finalTime)}`;
  }
}

/**
 * Context usage meter with color transitions
 */
export class ContextMeter {
  private percentage = 0;
  private targetPercentage = 0;
  private animationFrame: NodeJS.Timeout | null = null;

  update(percentage: number): void {
    this.targetPercentage = Math.min(100, Math.max(0, percentage));
    this.animate();
  }

  private animate(): void {
    if (this.animationFrame) {
      clearTimeout(this.animationFrame);
    }

    const step = () => {
      const diff = this.targetPercentage - this.percentage;
      if (Math.abs(diff) < 0.5) {
        this.percentage = this.targetPercentage;
        return;
      }

      // Smooth easing
      this.percentage += diff * 0.15;
      this.animationFrame = setTimeout(step, 16); // ~60 FPS
    };

    step();
  }

  render(): string {
    const pct = Math.round(clampPercentage(this.percentage));
    const color = getContextColor(pct, {
      error: theme.error,
      warning: theme.warning,
      info: theme.info,
      success: theme.success,
    });

    return `${theme.ui.muted('ctx')} ${color(`${pct}%`)}`;
  }

  dispose(): void {
    if (this.animationFrame) {
      clearTimeout(this.animationFrame);
    }
  }
}

/**
 * Animated typing indicator (for showing AI is responding)
 */
export class TypingIndicator {
  private frames = ['▌', '▐', '▌', ' '];
  private frameIndex = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private onUpdate?: (frame: string) => void;

  start(onUpdate?: (frame: string) => void): void {
    this.onUpdate = onUpdate;
    this.intervalId = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      if (this.onUpdate) {
        this.onUpdate(this.render());
      }
    }, 530); // Blink at cursor rate
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.onUpdate = undefined;
  }

  render(): string {
    return theme.info(this.frames[this.frameIndex] ?? '▌');
  }

  dispose(): void {
    this.stop();
  }
}

/**
 * Wave animation for processing states
 */
export class WaveIndicator {
  private frames = ['∙∙∙∙∙', '●∙∙∙∙', '∙●∙∙∙', '∙∙●∙∙', '∙∙∙●∙', '∙∙∙∙●', '∙∙∙∙∙'];
  private frameIndex = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private onUpdate?: (frame: string) => void;

  start(onUpdate?: (frame: string) => void): void {
    this.onUpdate = onUpdate;
    this.intervalId = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      if (this.onUpdate) {
        this.onUpdate(this.render());
      }
    }, 120);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.onUpdate = undefined;
  }

  render(): string {
    return theme.info(this.frames[this.frameIndex] ?? '∙∙∙∙∙');
  }

  dispose(): void {
    this.stop();
  }
}

// Export singleton cleanup
export function disposeAnimations(): void {
  schedulerDisposed = true; // Prevent recreation
  if (globalScheduler) {
    globalScheduler.dispose();
    globalScheduler = null;
  }
}

// Reset function for testing or re-initialization scenarios
export function resetAnimationScheduler(): void {
  if (globalScheduler) {
    globalScheduler.dispose();
    globalScheduler = null;
  }
  schedulerDisposed = false;
}
