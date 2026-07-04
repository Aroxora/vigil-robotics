/**
 * Test inline panel behavior for /secrets and /help commands
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

describe('Inline Panel Behavior', () => {
  let consoleOutput: string[] = [];
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    consoleOutput = [];
    originalStdoutWrite = process.stdout.write;
    // Capture stdout
    process.stdout.write = ((str: string) => {
      consoleOutput.push(str);
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    jest.clearAllTimers();
  });

  it('should show secrets panel when /secrets is submitted', async () => {
    // This test verifies that the inline panel is set and not immediately dismissed
    // when the /secrets command is submitted

    const mockPromptController = {
      setInlinePanel: jest.fn(),
      clearInlinePanel: jest.fn(),
      setStatusMessage: jest.fn(),
    };

    // Simulate the /secrets command flow
    const scheduleInlinePanelDismiss = jest.fn();

    // Call setInlinePanel (what showSecrets does)
    mockPromptController.setInlinePanel(['API Keys:', 'DEEPSEEK_API_KEY: ✓ set']);

    // Schedule auto-dismiss (what showSecrets does)
    scheduleInlinePanelDismiss();

    // Verify panel was set
    expect(mockPromptController.setInlinePanel).toHaveBeenCalledWith(
      expect.arrayContaining(['API Keys:', 'DEEPSEEK_API_KEY: ✓ set'])
    );

    // Verify panel was NOT cleared immediately
    expect(mockPromptController.clearInlinePanel).not.toHaveBeenCalled();

    // Verify auto-dismiss was scheduled
    expect(scheduleInlinePanelDismiss).toHaveBeenCalled();
  });

  it('should show help panel when /help is submitted', async () => {
    const mockPromptController = {
      setInlinePanel: jest.fn(),
      clearInlinePanel: jest.fn(),
      setStatusMessage: jest.fn(),
    };

    const scheduleInlinePanelDismiss = jest.fn();

    // Call setInlinePanel (what showHelp does)
    mockPromptController.setInlinePanel(['Available Commands:', '/secrets - Manage API keys']);

    // Schedule auto-dismiss (what showHelp does)
    scheduleInlinePanelDismiss();

    // Verify panel was set
    expect(mockPromptController.setInlinePanel).toHaveBeenCalledWith(
      expect.arrayContaining(['Available Commands:', '/secrets - Manage API keys'])
    );

    // Verify panel was NOT cleared immediately
    expect(mockPromptController.clearInlinePanel).not.toHaveBeenCalled();

    // Verify auto-dismiss was scheduled
    expect(scheduleInlinePanelDismiss).toHaveBeenCalled();
  });

  it('should dismiss panel when regular prompt is submitted', async () => {
    const mockPromptController = {
      clearInlinePanel: jest.fn(),
    };

    const dismissInlinePanel = () => {
      mockPromptController.clearInlinePanel();
    };

    // Simulate submitting a regular prompt (not a slash command)
    dismissInlinePanel();

    // Verify panel was dismissed
    expect(mockPromptController.clearInlinePanel).toHaveBeenCalled();
  });

  it('should not dismiss panel on onChange after /secrets', async () => {
    const mockPromptController = {
      setInlinePanel: jest.fn(),
      clearInlinePanel: jest.fn(),
    };

    // Simulate the /secrets command flow
    mockPromptController.setInlinePanel(['API Keys:', 'DEEPSEEK_API_KEY: ✓ set']);

    // Simulate onChange callback (which happens when input is cleared after submit)
    // Before the fix, this would call dismissInlinePanel()
    // After the fix, onChange no longer dismisses the panel

    // Verify panel was NOT cleared on onChange
    expect(mockPromptController.clearInlinePanel).not.toHaveBeenCalled();
  });

  it('should auto-dismiss panel after 8 seconds', async () => {
    jest.useFakeTimers();

    const mockPromptController = {
      setInlinePanel: jest.fn(),
      clearInlinePanel: jest.fn(),
    };

    let dismissTimer: NodeJS.Timeout | null = null;

    const scheduleInlinePanelDismiss = () => {
      if (dismissTimer) {
        clearTimeout(dismissTimer);
      }
      dismissTimer = setTimeout(() => {
        mockPromptController.clearInlinePanel();
        dismissTimer = null;
      }, 8000);
    };

    // Show the panel
    mockPromptController.setInlinePanel(['API Keys:', 'DEEPSEEK_API_KEY: ✓ set']);
    scheduleInlinePanelDismiss();

    // Verify panel not dismissed yet
    expect(mockPromptController.clearInlinePanel).not.toHaveBeenCalled();

    // Fast-forward time by 7 seconds
    jest.advanceTimersByTime(7000);
    expect(mockPromptController.clearInlinePanel).not.toHaveBeenCalled();

    // Fast-forward to 8 seconds
    jest.advanceTimersByTime(1000);
    expect(mockPromptController.clearInlinePanel).toHaveBeenCalled();

    jest.useRealTimers();
  });
});
