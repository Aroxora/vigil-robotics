/**
 * AnimationScheduler - Coordinates animations, spinners, progress bars, and elapsed time
 * Provides frame-based animation updates and smooth transitions
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';

export type AnimationType = 'spinner' | 'progress' | 'elapsed' | 'pulse' | 'transition';

export interface Animation {
  id: string;
  type: AnimationType;
  startTime: number;
  duration?: number; // Optional duration in ms (for finite animations)
  fps: number; // Frames per second
  frameCount: number;
  currentFrame: number;
  data?: unknown;
  easing?: EasingFunction;
  onFrame?: (animation: Animation) => void;
  onComplete?: (animation: Animation) => void;
}

export type EasingFunction = (t: number) => number;

export interface ProgressAnimation extends Animation {
  type: 'progress';
  data: {
    current: number;
    target: number;
    total: number;
    format?: (value: number, total: number) => string;
  };
}

export interface SpinnerAnimation extends Animation {
  type: 'spinner';
  data: {
    frames: string[];
    message?: string;
  };
}

export interface ElapsedAnimation extends Animation {
  type: 'elapsed';
  data: {
    startTime: number;
    format?: (elapsed: number) => string;
  };
}

export interface TransitionAnimation extends Animation {
  type: 'transition';
  data: {
    from: unknown;
    to: unknown;
    property: string;
  };
}

export class AnimationScheduler extends EventEmitter {
  private animations: Map<string, Animation> = new Map();
  private animationLoop: NodeJS.Timeout | null = null;
  private targetFPS: number = 30;
  private lastFrameTime: number = 0;
  private frameInterval: number;
  private isRunning: boolean = false;
  private disposed: boolean = false;

  // Predefined easing functions
  static readonly Easing = {
    linear: (t: number) => t,
    easeInQuad: (t: number) => t * t,
    easeOutQuad: (t: number) => t * (2 - t),
    easeInOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
    easeInCubic: (t: number) => t * t * t,
    easeOutCubic: (t: number) => --t * t * t + 1,
    easeInOutCubic: (t: number) =>
      t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
    easeOutElastic: (t: number) => {
      const p = 0.3;
      return Math.pow(2, -10 * t) * Math.sin((t - p / 4) * (2 * Math.PI) / p) + 1;
    },
  };

  // Predefined spinner frames
  static readonly SpinnerFrames = {
    dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    dots2: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
    dots3: ['⠋', '⠙', '⠚', '⠞', '⠖', '⠦', '⠴', '⠲', '⠳', '⠓'],
    line: ['-', '\\', '|', '/'],
    pipe: ['┤', '┘', '┴', '└', '├', '┌', '┬', '┐'],
    simpleDots: ['.  ', '.. ', '...', '   '],
    simpleDotsScrolling: ['.  ', '.. ', '...', ' ..', '  .', '   '],
    star: ['✶', '✸', '✹', '✺', '✹', '✷'],
    hamburger: ['☱', '☲', '☴'],
    growVertical: ['▁', '▃', '▄', '▅', '▆', '▇', '▆', '▅', '▄', '▃'],
    growHorizontal: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '▊', '▋', '▌', '▍', '▎'],
    balloon: [' ', '.', 'o', 'O', '@', '*', ' '],
    noise: ['▓', '▒', '░'],
    bounce: ['⠁', '⠂', '⠄', '⠂'],
    boxBounce: ['▖', '▘', '▝', '▗'],
    circle: ['◜', '◠', '◝', '◞', '◡', '◟'],
    arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
    arrow: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
    bouncingBar: [
      '[    ]',
      '[=   ]',
      '[==  ]',
      '[=== ]',
      '[ ===]',
      '[  ==]',
      '[   =]',
      '[    ]',
      '[   =]',
      '[  ==]',
      '[ ===]',
      '[====]',
      '[=== ]',
      '[==  ]',
      '[=   ]',
    ],
  };

  constructor(targetFPS: number = 30) {
    super();
    this.targetFPS = targetFPS;
    this.frameInterval = 1000 / targetFPS;
  }

  /**
   * Create and register a spinner animation
   */
  createSpinner(
    id: string,
    message?: string,
    frames: string[] = AnimationScheduler.SpinnerFrames.dots
  ): SpinnerAnimation {
    const animation: SpinnerAnimation = {
      id,
      type: 'spinner',
      startTime: performance.now(),
      fps: 10, // Spinners typically run at 10 FPS
      frameCount: frames.length,
      currentFrame: 0,
      data: {
        frames,
        message,
      },
    };

    this.register(animation);
    return animation;
  }

  /**
   * Create and register a progress animation
   */
  createProgress(
    id: string,
    current: number,
    total: number,
    duration: number = 500
  ): ProgressAnimation {
    const animation: ProgressAnimation = {
      id,
      type: 'progress',
      startTime: performance.now(),
      duration,
      fps: 60, // Smooth progress animations at 60 FPS
      frameCount: Math.ceil((duration / 1000) * 60),
      currentFrame: 0,
      data: {
        current,
        target: current,
        total,
      },
      easing: AnimationScheduler.Easing.easeOutQuad,
    };

    this.register(animation);
    return animation;
  }

  /**
   * Update progress animation target
   */
  updateProgress(id: string, newTarget: number): void {
    const animation = this.animations.get(id) as ProgressAnimation;
    if (!animation || animation.type !== 'progress') return;

    animation.data.current = this.getCurrentProgressValue(animation);
    animation.data.target = newTarget;
    animation.startTime = performance.now();
    animation.currentFrame = 0;
  }

  /**
   * Create and register an elapsed time animation
   */
  createElapsed(id: string, startTime: number = Date.now()): ElapsedAnimation {
    const animation: ElapsedAnimation = {
      id,
      type: 'elapsed',
      startTime: performance.now(),
      fps: 1, // Update once per second
      frameCount: Infinity,
      currentFrame: 0,
      data: {
        startTime,
        format: this.formatElapsedTime,
      },
    };

    this.register(animation);
    return animation;
  }

  /**
   * Create and register a transition animation
   */
  createTransition(
    id: string,
    from: unknown,
    to: unknown,
    property: string,
    duration: number = 300,
    easing?: EasingFunction
  ): TransitionAnimation {
    const animation: TransitionAnimation = {
      id,
      type: 'transition',
      startTime: performance.now(),
      duration,
      fps: 60,
      frameCount: Math.ceil((duration / 1000) * 60),
      currentFrame: 0,
      data: {
        from,
        to,
        property,
      },
      easing: easing || AnimationScheduler.Easing.easeInOutQuad,
    };

    this.register(animation);
    return animation;
  }

  /**
   * Register an animation
   */
  register(animation: Animation): void {
    this.animations.set(animation.id, animation);

    // Start the animation loop if not running
    if (!this.isRunning && this.animations.size > 0) {
      this.start();
    }

    this.emit('animation:registered', animation);
  }

  /**
   * Unregister an animation
   */
  unregister(id: string): void {
    const animation = this.animations.get(id);
    if (animation) {
      this.animations.delete(id);
      this.emit('animation:unregistered', animation);

      // Stop the loop if no animations remain
      if (this.animations.size === 0) {
        this.stop();
      }
    }
  }

  /**
   * Start the animation loop
   */
  private start(): void {
    if (this.isRunning || this.disposed) return;

    this.isRunning = true;
    this.lastFrameTime = performance.now();
    this.animationLoop = setInterval(() => this.tick(), this.frameInterval);
    this.emit('scheduler:start');
  }

  /**
   * Stop the animation loop
   */
  private stop(): void {
    if (!this.isRunning) return;

    if (this.animationLoop) {
      clearInterval(this.animationLoop);
      this.animationLoop = null;
    }

    this.isRunning = false;
    this.emit('scheduler:stop');
  }

  /**
   * Main animation tick
   */
  private tick(): void {
    const now = performance.now();
    const deltaTime = now - this.lastFrameTime;

    // Process each animation
    for (const [, animation] of this.animations) {
      // Check if animation should update based on its FPS
      const animationInterval = 1000 / animation.fps;
      const elapsedTime = now - animation.startTime;
      const expectedFrame = Math.floor(elapsedTime / animationInterval);

      if (expectedFrame > animation.currentFrame) {
        animation.currentFrame = expectedFrame;

        // Check if animation is complete
        if (
          animation.duration &&
          elapsedTime >= animation.duration &&
          animation.frameCount !== Infinity
        ) {
          this.completeAnimation(animation);
          continue;
        }

        // Update animation
        this.updateAnimation(animation, elapsedTime);

        // Call frame callback
        if (animation.onFrame) {
          animation.onFrame(animation);
        }

        this.emit('animation:frame', animation);
      }
    }

    this.lastFrameTime = now;
    this.emit('scheduler:tick', { deltaTime, animationCount: this.animations.size });
  }

  /**
   * Update animation based on type
   */
  private updateAnimation(animation: Animation, elapsedTime: number): void {
    switch (animation.type) {
      case 'spinner':
        this.updateSpinner(animation as SpinnerAnimation);
        break;
      case 'progress':
        this.updateProgressAnimation(animation as ProgressAnimation, elapsedTime);
        break;
      case 'elapsed':
        this.updateElapsed(animation as ElapsedAnimation);
        break;
      case 'transition':
        this.updateTransition(animation as TransitionAnimation, elapsedTime);
        break;
    }
  }

  /**
   * Update spinner animation
   */
  private updateSpinner(animation: SpinnerAnimation): void {
    const frameIndex = animation.currentFrame % animation.data.frames.length;
    this.emit('spinner:frame', {
      id: animation.id,
      frame: animation.data.frames[frameIndex],
      message: animation.data.message,
    });
  }

  /**
   * Update progress animation
   */
  private updateProgressAnimation(
    animation: ProgressAnimation,
    elapsedTime: number
  ): void {
    if (!animation.duration) return;

    const progress = Math.min(elapsedTime / animation.duration, 1);
    const easedProgress = animation.easing ? animation.easing(progress) : progress;
    const { current, target, total } = animation.data;

    const newValue = current + (target - current) * easedProgress;
    const percentage = Math.round((newValue / total) * 100);

    this.emit('progress:update', {
      id: animation.id,
      value: newValue,
      percentage,
      total,
      formatted: animation.data.format
        ? animation.data.format(newValue, total)
        : `${percentage}%`,
    });
  }

  /**
   * Update elapsed time animation
   */
  private updateElapsed(animation: ElapsedAnimation): void {
    const elapsed = Date.now() - animation.data.startTime;
    const formatted = animation.data.format
      ? animation.data.format(elapsed)
      : this.formatElapsedTime(elapsed);

    this.emit('elapsed:update', {
      id: animation.id,
      elapsed,
      formatted,
    });
  }

  /**
   * Update transition animation
   */
  private updateTransition(
    animation: TransitionAnimation,
    elapsedTime: number
  ): void {
    if (!animation.duration) return;

    const progress = Math.min(elapsedTime / animation.duration, 1);
    const easedProgress = animation.easing ? animation.easing(progress) : progress;
    const { from, to } = animation.data;

    let value;
    if (typeof from === 'number' && typeof to === 'number') {
      value = from + (to - from) * easedProgress;
    } else {
      // For non-numeric values, switch at 50% progress
      value = easedProgress < 0.5 ? from : to;
    }

    this.emit('transition:update', {
      id: animation.id,
      property: animation.data.property,
      value,
      progress: easedProgress,
    });
  }

  /**
   * Complete an animation
   */
  private completeAnimation(animation: Animation): void {
    if (animation.onComplete) {
      animation.onComplete(animation);
    }

    this.emit('animation:complete', animation);
    this.unregister(animation.id);
  }

  /**
   * Get current progress value with easing
   */
  private getCurrentProgressValue(animation: ProgressAnimation): number {
    const elapsedTime = performance.now() - animation.startTime;
    if (!animation.duration) return animation.data.target;

    const progress = Math.min(elapsedTime / animation.duration, 1);
    const easedProgress = animation.easing ? animation.easing(progress) : progress;
    const { current, target } = animation.data;

    return current + (target - current) * easedProgress;
  }

  /**
   * Format elapsed time
   */
  private formatElapsedTime(elapsedMs: number): string {
    const seconds = Math.floor(elapsedMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Get animation by ID
   */
  getAnimation(id: string): Animation | undefined {
    return this.animations.get(id);
  }

  /**
   * Get all active animations
   */
  getActiveAnimations(): Animation[] {
    return Array.from(this.animations.values());
  }

  /**
   * Check if scheduler is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get target FPS
   */
  getTargetFPS(): number {
    return this.targetFPS;
  }

  /**
   * Set target FPS
   */
  setTargetFPS(fps: number): void {
    this.targetFPS = fps;
    this.frameInterval = 1000 / fps;

    // Restart the loop with new interval if running
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  /**
   * Clear all animations
   */
  clearAll(): void {
    for (const animation of this.animations.values()) {
      if (animation.onComplete) {
        animation.onComplete(animation);
      }
    }

    this.animations.clear();
    this.stop();
    this.emit('scheduler:cleared');
  }

  /**
   * Dispose of the scheduler
   */
  dispose(): void {
    this.disposed = true;
    this.clearAll();
    this.removeAllListeners();
  }

  /**
   * Check if the scheduler has been disposed
   */
  isDisposed(): boolean {
    return this.disposed;
  }
}