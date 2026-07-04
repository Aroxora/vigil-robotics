/**
 * OverlayManager - Manages terminal overlay rendering with ANSI escape sequences
 * Provides sophisticated overlay composition and rendering capabilities
 */


import { stripAnsi } from '../layout.js';

export interface OverlayRegion {
  content: string;
  height: number;
  priority: number;
}

export interface OverlayLayout {
  regions: {
    status?: OverlayRegion;
    progress?: OverlayRegion;
    hints?: OverlayRegion;
    alerts?: OverlayRegion;
  };
  maxHeight: number;
}

export interface OverlayOptions {
  adaptToTerminalSize: boolean;
  smoothTransitions: boolean;
  preserveCursor: boolean;
}

export class OverlayManager {
  private currentLayout: OverlayLayout | null = null;
  private renderedRows: number = 0;
  private allocatedRows: number = 0;
  private isVisible: boolean = false;
  private isEnabled: boolean = true;
  private outputGuardCount: number = 0;
  private writeStream: NodeJS.WriteStream;
  private options: OverlayOptions;

  // ANSI escape codes for cursor control
  private readonly SAVE_CURSOR = '\u001b7';
  private readonly RESTORE_CURSOR = '\u001b8';
  private readonly CLEAR_LINE = '\u001b[2K';
  private readonly MOVE_TO_COLUMN = (col: number) => `\u001b[${col}G`;
  private readonly MOVE_UP = (rows: number) => `\u001b[${rows}A`;

  constructor(
    writeStream: NodeJS.WriteStream,
    options: Partial<OverlayOptions> = {}
  ) {
    this.writeStream = writeStream;
    this.options = {
      adaptToTerminalSize: true,
      smoothTransitions: true,
      preserveCursor: true,
      ...options,
    };
  }

  /**
   * Set the overlay layout to render
   */
  setLayout(layout: OverlayLayout | null): void {
    const wasVisible = this.isVisible;
    if (wasVisible) {
      this.hide();
    }

    this.currentLayout = layout;

    if (wasVisible && layout) {
      this.show();
    }
  }

  /**
   * Show the overlay if enabled and not in output guard
   */
  show(): void {
    if (!this.isEnabled || this.outputGuardCount > 0 || !this.currentLayout) {
      return;
    }

    this.isVisible = true;
    this.render();
  }

  /**
   * Hide the overlay
   */
  hide(): void {
    if (!this.isVisible) {
      return;
    }

    this.clearRenderedOverlay();
    this.isVisible = false;
  }

  /**
   * Begin output operation (increments guard counter)
   */
  beginOutput(): void {
    this.outputGuardCount++;
    if (this.isVisible) {
      this.hide();
    }
  }

  /**
   * End output operation (decrements guard counter)
   */
  endOutput(): void {
    this.outputGuardCount = Math.max(0, this.outputGuardCount - 1);
    if (this.outputGuardCount === 0 && this.currentLayout) {
      this.show();
    }
  }

  /**
   * Enable or disable overlay rendering
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.isEnabled) {
      return;
    }

    this.isEnabled = enabled;
    if (!enabled) {
      this.hide();
    } else if (this.currentLayout) {
      this.show();
    }
  }

  /**
   * Update a specific region in the layout
   */
  updateRegion(
    regionName: keyof OverlayLayout['regions'],
    region: OverlayRegion | undefined
  ): void {
    if (!this.currentLayout) {
      this.currentLayout = {
        regions: {},
        maxHeight: this.getMaxOverlayHeight(),
      };
    }

    this.currentLayout.regions[regionName] = region;

    if (this.isVisible) {
      this.render();
    }
  }

  /**
   * Compose the overlay content from all regions
   */
  private composeOverlay(): string[] {
    if (!this.currentLayout) {
      return [];
    }

    const lines: string[] = [];
    const { regions } = this.currentLayout;

    // Sort regions by priority
    const sortedRegions = Object.entries(regions)
      .filter(([_, region]) => region !== undefined)
      .sort(([_, a], [__, b]) => (b?.priority ?? 0) - (a?.priority ?? 0));

    // Compose lines from regions
    for (const [, region] of sortedRegions) {
      if (region && region.content) {
        const regionLines = region.content.split('\n').slice(0, region.height);
        lines.push(...regionLines);

        // Respect max height
        if (lines.length >= this.currentLayout.maxHeight) {
          return lines.slice(0, this.currentLayout.maxHeight);
        }
      }
    }

    return lines;
  }

  /**
   * Render the overlay to the terminal
   */
  private render(): void {
    if (!this.isVisible || !this.currentLayout) {
      return;
    }

    const lines = this.composeOverlay();
    if (lines.length === 0) {
      return;
    }

    const terminalWidth = this.writeStream.columns || 80;

    // Clear any previously rendered overlay
    this.clearRenderedOverlay();

    try {
      // Allocate space for the overlay
      this.allocatedRows = lines.length;
      for (let i = 0; i < this.allocatedRows; i++) {
        this.writeStream.write('\n');
      }

      // Save cursor and move up to start of overlay area
      if (this.options.preserveCursor) {
        this.writeStream.write(this.SAVE_CURSOR);
      }
      this.writeStream.write(this.MOVE_UP(this.allocatedRows));

      // Render each line
      lines.forEach((line, index) => {
        // Clear the line
        this.writeStream.write(this.CLEAR_LINE);
        this.writeStream.write(this.MOVE_TO_COLUMN(1));

        // Truncate line if needed
        const truncatedLine = this.truncateLine(line, terminalWidth);
        this.writeStream.write(truncatedLine);

        // Move to next line (except for last line)
        if (index < lines.length - 1) {
          this.writeStream.write('\n');
        }
      });

      // Restore cursor position
      if (this.options.preserveCursor) {
        this.writeStream.write(this.RESTORE_CURSOR);
      }

      this.renderedRows = lines.length;
    } catch {
      // Restore cursor on render error to prevent terminal state corruption
      try {
        if (this.options.preserveCursor) {
          this.writeStream.write(this.RESTORE_CURSOR);
        }
      } catch {
        // Swallow nested errors
      }
    }
  }

  /**
   * Clear the rendered overlay from the terminal
   */
  private clearRenderedOverlay(): void {
    if (this.renderedRows === 0) {
      return;
    }

    // Save cursor position
    if (this.options.preserveCursor) {
      this.writeStream.write(this.SAVE_CURSOR);
    }

    // Move up to the start of the overlay
    this.writeStream.write(this.MOVE_UP(this.renderedRows));

    // Clear each overlay row
    for (let i = 0; i < this.renderedRows; i++) {
      this.writeStream.write(this.CLEAR_LINE);
      if (i < this.renderedRows - 1) {
        this.writeStream.write('\n');
      }
    }

    // Move back up and restore cursor
    if (this.renderedRows > 1) {
      this.writeStream.write(this.MOVE_UP(this.renderedRows - 1));
    }

    if (this.options.preserveCursor) {
      this.writeStream.write(this.RESTORE_CURSOR);
    }

    // Adjust cursor position if needed
    if (this.allocatedRows > 0) {
      this.writeStream.write(this.MOVE_UP(this.allocatedRows));
      this.allocatedRows = 0;
    }

    this.renderedRows = 0;
  }

  /**
   * Get maximum overlay height based on terminal size
   */
  private getMaxOverlayHeight(): number {
    if (!this.options.adaptToTerminalSize) {
      return 5; // Default max height
    }

    const terminalHeight = this.writeStream.rows || 24;
    // Use at most 20% of terminal height for overlay
    return Math.max(2, Math.min(5, Math.floor(terminalHeight * 0.2)));
  }

  /**
   * Truncate a line to fit terminal width
   */
  private truncateLine(line: string, maxWidth: number): string {
    // Account for ANSI escape codes
    const visibleLength = stripAnsi(line).length;

    if (visibleLength <= maxWidth) {
      return line;
    }

    // Smart truncation with ellipsis
    const ellipsis = '...';
    const targetLength = maxWidth - ellipsis.length;

    // Try to preserve ANSI codes while truncating
    let currentLength = 0;
    let result = '';
    let inAnsi = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '\u001b') {
        inAnsi = true;
      }

      if (inAnsi) {
        result += char;
        if (char === 'm') {
          inAnsi = false;
        }
      } else {
        if (currentLength < targetLength) {
          result += char;
          currentLength++;
        } else {
          break;
        }
      }
    }

    return result + ellipsis;
  }

  /**
   * Force a refresh of the overlay
   */
  refresh(): void {
    if (this.isVisible) {
      this.render();
    }
  }

  /**
   * Get current overlay state
   */
  getState(): {
    isVisible: boolean;
    isEnabled: boolean;
    renderedRows: number;
    hasLayout: boolean;
  } {
    return {
      isVisible: this.isVisible,
      isEnabled: this.isEnabled,
      renderedRows: this.renderedRows,
      hasLayout: this.currentLayout !== null,
    };
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.hide();
    this.currentLayout = null;
  }
}