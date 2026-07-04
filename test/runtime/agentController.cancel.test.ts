import { describe, expect, test, afterEach, jest } from '@jest/globals';

// Mock modules that rely on import.meta or heavy runtime wiring
jest.mock('../../src/runtime/node.js', () => ({
  createNodeRuntime: jest.fn(() => {
    throw new Error('createNodeRuntime should not be called in unit tests');
  }),
}));

jest.mock('../../src/config.js', () => ({
  resolveProfileConfig: jest.fn(() => ({
    provider: 'test-provider',
    model: 'test-model',
    temperature: 0,
    maxTokens: 128,
    systemPrompt: 'sys',
  })),
}));

import { AgentController } from '../../src/runtime/agentController.js';
import type { AgentSession } from '../../src/runtime/agentSession.js';

function makeFakeSession(sendImpl: (message: string, allowTools: boolean) => Promise<void>): AgentSession {
  return {
    profileConfig: {
      provider: 'test-provider',
      model: 'test-model',
      temperature: 0,
      maxTokens: 128,
      systemPrompt: 'sys',
    },
    createAgent: (_selection, callbacks) => {
      let history: any[] = [];
      return {
        send: sendImpl,
        loadHistory: (h: any[]) => {
          history = h;
        },
        getHistory: () => history,
        onToolCall: callbacks?.onToolCall,
      } as any;
    },
  } as unknown as AgentSession;
}

afterEach(() => {
  delete process.env.VIGIL_AGENT_RUN_TIMEOUT_MS;
});

describe('AgentController cancellation and timeout (core-first)', () => {
  test('cancel stops an in-flight run and fails the stream', async () => {
    let resolveSend: (() => void) | null = null;
    const sendImpl = () =>
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      });

    const controller = new AgentController({
      runtime: { session: makeFakeSession(sendImpl) } as any,
      sinkRef: { current: null },
    });

    const iterator = controller.send('hello');
    const first = await iterator.next();
    expect(first.value?.type).toBe('message.start');

    controller.cancel('stop now');
    await expect(iterator.next()).rejects.toThrow(/stop now/i);

    resolveSend?.();
  });

  test('times out when run exceeds configured limit', async () => {
    process.env.VIGIL_AGENT_RUN_TIMEOUT_MS = '10';
    const sendImpl = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

    const controller = new AgentController({
      runtime: { session: makeFakeSession(sendImpl) } as any,
      sinkRef: { current: null },
    });

    const iterator = controller.send('hello');
    const first = await iterator.next();
    expect(first.value?.type).toBe('message.start');

    await expect(iterator.next()).rejects.toThrow(/timed out/i);
  });
});
