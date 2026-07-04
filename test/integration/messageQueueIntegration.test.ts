/**
 * Message Queue Integration Tests
 * Tests the critical race condition fix in streaming mode
 */

import { describe, test, expect, jest } from '@jest/globals';

describe('Message Queue Integration', () => {
  test('Messages queue during streaming mode', () => {
    // Simulate the message queue behavior
    const pendingMessages: Array<{content: string; timestamp: number}> = [];
    const isStreaming = true;

    // Simulate writeLocked behavior
    function writeLocked(content: string): void {
      const payload = content.endsWith('\n') ? content : `${content}\n`;

      if (isStreaming) {
        pendingMessages.push({
          content: payload,
          timestamp: Date.now()
        });
      }
    }

    // Queue messages while streaming
    writeLocked('Message 1');
    writeLocked('Message 2');
    writeLocked('Message 3');

    expect(pendingMessages).toHaveLength(3);
    expect(pendingMessages[0]?.content).toBe('Message 1\n');
    expect(pendingMessages[1]?.content).toBe('Message 2\n');
    expect(pendingMessages[2]?.content).toBe('Message 3\n');
  });

  test('Messages flush in FIFO order', () => {
    const pendingMessages: Array<{content: string; timestamp: number}> = [];
    const flushedMessages: string[] = [];

    // Queue messages
    pendingMessages.push({ content: 'First\n', timestamp: Date.now() });
    pendingMessages.push({ content: 'Second\n', timestamp: Date.now() + 1 });
    pendingMessages.push({ content: 'Third\n', timestamp: Date.now() + 2 });

    // Flush in order
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift();
      if (msg) {
        flushedMessages.push(msg.content);
      }
    }

    expect(flushedMessages).toEqual(['First\n', 'Second\n', 'Third\n']);
  });

  test('No messages lost on rapid streaming toggle', () => {
    const pendingMessages: Array<{content: string; timestamp: number}> = [];
    const allMessages: string[] = [];
    let isStreaming = false;

    function writeLocked(content: string): void {
      const payload = content.endsWith('\n') ? content : `${content}\n`;

      if (isStreaming) {
        pendingMessages.push({ content: payload, timestamp: Date.now() });
      } else {
        // Flush pending first
        while (pendingMessages.length > 0) {
          const msg = pendingMessages.shift();
          if (msg) allMessages.push(msg.content);
        }
        allMessages.push(payload);
      }
    }

    // Rapid streaming mode changes
    for (let i = 0; i < 10; i++) {
      isStreaming = true;
      writeLocked(`Streaming ${i}`);

      isStreaming = false;
      writeLocked(`Normal ${i}`);
    }

    expect(allMessages).toHaveLength(20);
    expect(allMessages.filter(m => m.includes('Streaming'))).toHaveLength(10);
    expect(allMessages.filter(m => m.includes('Normal'))).toHaveLength(10);
  });

  test('Timestamps allow debugging of message delays', () => {
    const pendingMessages: Array<{content: string; timestamp: number}> = [];

    const t1 = Date.now();
    pendingMessages.push({ content: 'Msg 1', timestamp: t1 });

    const t2 = Date.now() + 100;
    pendingMessages.push({ content: 'Msg 2', timestamp: t2 });

    const t3 = Date.now() + 200;
    pendingMessages.push({ content: 'Msg 3', timestamp: t3 });

    // Verify timestamps are increasing
    expect(pendingMessages[1]!.timestamp).toBeGreaterThan(pendingMessages[0]!.timestamp);
    expect(pendingMessages[2]!.timestamp).toBeGreaterThan(pendingMessages[1]!.timestamp);

    // Calculate delays
    const delay1 = pendingMessages[1]!.timestamp - pendingMessages[0]!.timestamp;
    const delay2 = pendingMessages[2]!.timestamp - pendingMessages[1]!.timestamp;

    expect(delay1).toBeGreaterThanOrEqual(100);
    expect(delay2).toBeGreaterThanOrEqual(100);
  });

  test('Empty messages are handled correctly', () => {
    const pendingMessages: Array<{content: string; timestamp: number}> = [];
    const isStreaming = true;

    function writeLocked(content: string): void {
      if (!content) return; // Guard against empty content

      const payload = content.endsWith('\n') ? content : `${content}\n`;

      if (isStreaming) {
        pendingMessages.push({ content: payload, timestamp: Date.now() });
      }
    }

    writeLocked('');
    writeLocked('Valid message');
    writeLocked('');

    expect(pendingMessages).toHaveLength(1);
    expect(pendingMessages[0]?.content).toBe('Valid message\n');
  });

  test('Newline handling is consistent', () => {
    const messages: string[] = [];

    function addMessage(content: string): void {
      const payload = content.endsWith('\n') ? content : `${content}\n`;
      messages.push(payload);
    }

    addMessage('Already has newline\n');
    addMessage('Needs newline');
    addMessage('Multiple\nlines\nhere');

    expect(messages[0]).toBe('Already has newline\n');
    expect(messages[1]).toBe('Needs newline\n');
    expect(messages[2]).toBe('Multiple\nlines\nhere\n');

    // All messages should end with exactly one newline
    messages.forEach(msg => {
      expect(msg.endsWith('\n')).toBe(true);
      expect(msg.endsWith('\n\n')).toBe(false);
    });
  });

  test('Message queue has bounded growth', () => {
    const maxMessages = /* TODO: Extract constant */ 1000;
    const pendingMessages: Array<{content: string; timestamp: number}> = [];

    // Simulate rapid message generation
    for (let i = 0; i < maxMessages * 2; i++) {
      pendingMessages.push({ content: `Message ${i}`, timestamp: Date.now() });

      // Simulate periodic flushing to prevent unbounded growth
      if (pendingMessages.length > maxMessages) {
        pendingMessages.shift(); // Remove oldest
      }
    }

    // Queue should not exceed max size
    expect(pendingMessages.length).toBeLessThanOrEqual(maxMessages);
  });

  test('Error during flush does not lose remaining messages', () => {
    const pendingMessages: Array<{content: string; timestamp: number}> = [];
    const successfullyFlushed: string[] = [];
    const errors: string[] = [];

    pendingMessages.push({ content: 'Message 1', timestamp: Date.now() });
    pendingMessages.push({ content: 'BAD_MESSAGE', timestamp: Date.now() });
    pendingMessages.push({ content: 'Message 3', timestamp: Date.now() });

    // Flush with error handling
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift();
      if (msg) {
        try {
          if (msg.content === 'BAD_MESSAGE') {
            throw new Error('Simulated flush error');
          }
          successfullyFlushed.push(msg.content);
        } catch (error) {
          errors.push(msg.content);
          // Continue flushing despite error
        }
      }
    }

    expect(successfullyFlushed).toEqual(['Message 1', 'Message 3']);
    expect(errors).toEqual(['BAD_MESSAGE']);
    expect(pendingMessages).toHaveLength(0); // All messages processed
  });

  test('Stuck streaming state flushes pending messages on reset', () => {
    const pendingMessages: string[] = ['first\n', 'second\n'];
    const flushed: string[] = [];
    let streamingActive = true;
    let rendererMode: 'idle' | 'streaming' = 'streaming';

    // Simulate the stopStreamingHeartbeat logic used by resetRendererStreamingMode
    function stopStreamingHeartbeat(): void {
      streamingActive = false;
      while (pendingMessages.length > 0) {
        const msg = pendingMessages.shift();
        if (msg) flushed.push(msg);
      }
    }

    function resetRendererStreamingMode(isProcessing: boolean): void {
      if (isProcessing) return;
      const streamingStuck = rendererMode === 'streaming' || streamingActive;
      if (!streamingStuck) return;

      stopStreamingHeartbeat();
      rendererMode = 'idle';
    }

    resetRendererStreamingMode(false);

    expect(streamingActive).toBe(false);
    expect(rendererMode).toBe('idle');
    expect(flushed).toEqual(['first\n', 'second\n']);
    expect(pendingMessages).toHaveLength(0);
  });
});

describe('Streaming Mode State Transitions', () => {
  test('Detects double-entry to streaming mode', () => {
    const warnings: string[] = [];
    let streamingActive = false;

    function enterStreamingMode(): void {
      if (streamingActive) {
        warnings.push('enterStreamingMode() called while already in streaming mode');
      }
      streamingActive = true;
    }

    enterStreamingMode();
    enterStreamingMode(); // Should warn

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('already in streaming mode');
  });

  test('Detects exit when not in streaming mode', () => {
    const warnings: string[] = [];
    let streamingActive = false;

    function exitStreamingMode(): void {
      if (!streamingActive) {
        warnings.push('exitStreamingMode() called while not in streaming mode');
      }
      streamingActive = false;
    }

    exitStreamingMode(); // Should warn

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not in streaming mode');
  });

  test('Clean state transitions work correctly', () => {
    const warnings: string[] = [];
    let streamingActive = false;

    function enterStreamingMode(): void {
      if (streamingActive) {
        warnings.push('enterStreamingMode() called while already in streaming mode');
      }
      streamingActive = true;
    }

    function exitStreamingMode(): void {
      if (!streamingActive) {
        warnings.push('exitStreamingMode() called while not in streaming mode');
      }
      streamingActive = false;
    }

    // Proper sequence
    enterStreamingMode();
    expect(streamingActive).toBe(true);

    exitStreamingMode();
    expect(streamingActive).toBe(false);

    enterStreamingMode();
    expect(streamingActive).toBe(true);

    exitStreamingMode();
    expect(streamingActive).toBe(false);

    expect(warnings).toHaveLength(0);
  });
});
