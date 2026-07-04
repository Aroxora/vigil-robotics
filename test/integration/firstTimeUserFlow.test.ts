/**
 * First-Time User Flow Tests
 *
 * Tests the complete experience of a new user interacting with anvilwing
 * for the first time. Covers onboarding, initial setup, first interactions,
 * and common first-time use cases.
 */

import {
  TestEnvironment,
  SessionSimulator,
  FlowValidators,
  FirstTimeUserFlows,
} from '../utils/testHelpers.js';

describe('First-Time User Flow Tests', () => {
  let env: TestEnvironment;
  let tempDir: string;

  beforeEach(() => {
    env = new TestEnvironment();
    tempDir = env.createTempDir('first-time-user-');
    env.setEnv({ VIGIL_DATA_DIR: tempDir });
  });

  afterEach(() => {
    env.cleanup();
  });

  describe('Initial Launch Experience', () => {
    it('should detect first-time user and provide welcome experience', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      simulator.queueResponse({
        content: 'Hello! Welcome to anvilwing. I\'m here to help you with coding tasks. How can I assist you today?',
        usage: { inputTokens: 50, outputTokens: 30 },
      });

      const { response } = await simulator.sendMessage('Hi');

      expect(FlowValidators.expectsWelcomeMessage(response)).toBe(true);
      expect(simulator.getSession().isFirstTime).toBe(true);

      simulator.cleanup();
    });

    it('should initialize empty session state for new user', () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      const session = simulator.getSession();
      expect(session.messages.length).toBe(0);
      expect(session.isFirstTime).toBe(true);
      expect(session.id).toBeTruthy();

      simulator.cleanup();
    });

    it('should use default profile for new users', () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      const session = simulator.getSession();
      expect(session.profile).toBe('general');

      simulator.cleanup();
    });
  });

  describe('First Interaction Patterns', () => {
    it('should handle basic greeting from first-time user', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      simulator.queueResponse({
        content: 'Hello! I\'m your AI coding assistant. I can help you with writing code, debugging, testing, and more. What would you like to work on today?',
        usage: { inputTokens: 20, outputTokens: 40 },
      });

      const { response } = await simulator.sendMessage('Hello!');

      expect(response.length).toBeGreaterThan(0);
      expect(
        response.toLowerCase().includes('help') ||
        response.toLowerCase().includes('assist') ||
        response.toLowerCase().includes('hello')
      ).toBe(true);

      const history = simulator.getHistory();
      expect(history.length).toBe(2);
      expect(history[0]?.role).toBe('user');
      expect(history[1]?.role).toBe('assistant');

      simulator.cleanup();
    });

    it('should provide coding help when requested', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      simulator.queueResponse({
        content: `Here's a function to calculate Fibonacci numbers:

\`\`\`typescript
function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
\`\`\`

This recursive implementation calculates the nth Fibonacci number.`,
        usage: { inputTokens: 30, outputTokens: 80 },
      });

      const { response } = await simulator.sendMessage(
        'Can you help me write a function to calculate fibonacci numbers?'
      );

      expect(response.includes('function')).toBe(true);
      expect(response.includes('fibonacci') || response.includes('Fibonacci')).toBe(true);
      expect(response.includes('```')).toBe(true);

      simulator.cleanup();
    });

    it('should handle unclear requests gracefully', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      simulator.queueResponse({
        content: 'I\'d be happy to help! Could you tell me more about what you\'re trying to accomplish?',
        usage: { inputTokens: 15, outputTokens: 45 },
      });

      const { response } = await simulator.sendMessage('help');

      expect(
        response.toLowerCase().includes('help') ||
        response.toLowerCase().includes('what') ||
        response.toLowerCase().includes('tell me')
      ).toBe(true);

      simulator.cleanup();
    });
  });

  describe('Project Exploration (First Time)', () => {
    it('should help user explore their project structure', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      simulator.queueResponse({
        content: `I found the following files in your project:

- package.json (project configuration)
- src/index.ts (entry point)
- build/index.html (built output)`,
        usage: { inputTokens: 40, outputTokens: /* TODO: Extract constant */ 60 },
      });

      const { response } = await simulator.sendMessage('What files are in this project?');

      expect(
        response.includes('package.json') ||
        response.includes('files') ||
        response.includes('project')
      ).toBe(true);

      simulator.cleanup();
    });

    it('should read and explain specific files', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      simulator.queueResponse({
        content: `Here's your package.json:

\`\`\`json
{
  "name": "test-project",
  "version": "1.0.0"
}
\`\`\``,
        usage: { inputTokens: 50, outputTokens: 70 },
      });

      const { response } = await simulator.sendMessage('Show me the package.json');

      expect(response.includes('package.json') || response.includes('{')).toBe(true);

      simulator.cleanup();
    });
  });

  describe('First-Time Error Handling', () => {
    it('should handle missing files gracefully for new users', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      simulator.queueResponse({
        content: 'I couldn\'t find a file named "nonexistent.ts" in your project. Would you like me to list the available files?',
        usage: { inputTokens: 30, outputTokens: 50 },
      });

      const { response } = await simulator.sendMessage('Read nonexistent.ts');

      expect(
        FlowValidators.expectsGracefulError(response) ||
        response.toLowerCase().includes('couldn\'t find') ||
        response.toLowerCase().includes('not found')
      ).toBe(true);

      simulator.cleanup();
    });

    it('should guide user when command is unclear', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      simulator.queueResponse({
        content: 'I\'m not sure I understand what you\'d like me to do. Could you provide more context?',
        usage: { inputTokens: 20, outputTokens: 45 },
      });

      const { response } = await simulator.sendMessage('xyz123');

      expect(
        response.toLowerCase().includes('understand') ||
        response.toLowerCase().includes('help') ||
        response.toLowerCase().includes('what')
      ).toBe(true);

      simulator.cleanup();
    });
  });

  describe('Session Persistence for New Users', () => {
    it('should save first session for future reference', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      simulator.queueResponse({
        content: 'I\'ve noted that you want to build a todo app.',
        usage: { inputTokens: 25, outputTokens: 30 },
      });

      await simulator.sendMessage('I want to build a todo app');

      const saved = simulator.saveSession();

      expect(saved.id).toBeTruthy();
      expect(saved.messageCount).toBe(2);

      simulator.cleanup();
    });

    it('should track conversation history correctly', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      simulator.queueResponse({
        content: 'Sure! Let\'s build a React todo app.',
        usage: { inputTokens: 20, outputTokens: 25 },
      });

      simulator.queueResponse({
        content: 'Here\'s a basic TodoItem component.',
        usage: { inputTokens: 30, outputTokens: 40 },
      });

      await simulator.sendMessage('Help me build a todo app in React');
      await simulator.sendMessage('Start with the TodoItem component');

      const history = simulator.getHistory();

      expect(history.length).toBe(4);
      expect(history[0]?.role).toBe('user');
      expect(history[1]?.role).toBe('assistant');
      expect(history[2]?.role).toBe('user');
      expect(history[3]?.role).toBe('assistant');

      simulator.cleanup();
    });
  });

  describe('First-Time User Scenarios (Predefined)', () => {
    for (const scenario of FirstTimeUserFlows) {
      it(`should handle scenario: ${scenario.name}`, async () => {
        const simulator = new SessionSimulator({ isFirstTime: true });

        for (const step of scenario.steps) {
          simulator.queueResponse({
            content: `[Mock response for: ${step.description}]`,
            usage: { inputTokens: 20, outputTokens: 30 },
          });

          const { response } = await simulator.sendMessage(step.userInput);

          expect(typeof response).toBe('string');
        }

        const session = simulator.getSession();
        expect(session.messages.length).toBeGreaterThan(0);

        simulator.cleanup();
      });
    }
  });

  describe('First-Time Frontend Testing Flow', () => {
    it('should guide first-time user through build verification', async () => {
      const projectDir = env.createMockProject({ framework: 'react', hasTests: true });
      const simulator = new SessionSimulator({
        isFirstTime: true,
        workspaceRoot: projectDir,
      });

      simulator.queueResponse({
        content: `I'll verify your build output...

Build Output Verification
Framework: React

Build directory exists
index.html found

Bundle within size limit`,
        usage: { inputTokens: 40, outputTokens: 80 },
      });

      const { response } = await simulator.sendMessage('Can you verify my build output?');

      expect(response.includes('Build') || response.includes('build')).toBe(true);
      expect(response.includes('exists') || response.includes('found')).toBe(true);

      simulator.cleanup();
    });

    it('should explain E2E testing options to new users', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      simulator.queueResponse({
        content: `I don't see an E2E testing framework set up yet. Here are your options:

**Cypress** (Recommended for beginners)
- Easy to set up and use

**Playwright** (Recommended for cross-browser)
- Supports multiple browsers`,
        usage: { inputTokens: 35, outputTokens: 70 },
      });

      const { response } = await simulator.sendMessage('How do I run E2E tests?');

      expect(
        response.toLowerCase().includes('cypress') ||
        response.toLowerCase().includes('playwright') ||
        response.toLowerCase().includes('e2e')
      ).toBe(true);

      simulator.cleanup();
    });

    it('should run complete frontend test workflow for first-time user', async () => {
      const projectDir = env.createMockProject({
        framework: 'react',
        hasTests: true,
        hasE2E: false,
      });
      const simulator = new SessionSimulator({
        isFirstTime: true,
        workspaceRoot: projectDir,
      });

      simulator.queueResponse({
        content: `Frontend Testing Workflow

Step 1: Build Verification
Build succeeded

Step 2: Unit Tests
Unit tests passed

WORKFLOW SUMMARY
Build: PASS
Unit Tests: PASS

WORKFLOW PASSED`,
        usage: { inputTokens: 50, outputTokens: 120 },
      });

      const { response } = await simulator.sendMessage(
        'Run the complete frontend testing workflow'
      );

      expect(response.includes('WORKFLOW')).toBe(true);
      expect(response.includes('Build') || response.includes('build')).toBe(true);
      expect(response.includes('PASS') || response.includes('passed')).toBe(true);

      simulator.cleanup();
    });
  });

  describe('Onboarding Completeness', () => {
    it('should track that user has completed first interaction', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      expect(simulator.getSession().isFirstTime).toBe(true);
      expect(simulator.getHistory().length).toBe(0);

      simulator.queueResponse({
        content: 'Hello! How can I help you today?',
        usage: { inputTokens: 10, outputTokens: 15 },
      });

      await simulator.sendMessage('Hi there');

      const history = simulator.getHistory();
      expect(history.length).toBe(2);

      const session = simulator.getSession();
      expect(session.messages.length).toBeGreaterThan(0);

      simulator.cleanup();
    });

    it('should handle multiple first interactions building context', async () => {
      const simulator = new SessionSimulator({ isFirstTime: true });

      const interactions = [
        { input: 'Hello!', response: 'Hello! Welcome to anvilwing.' },
        { input: 'What can you do?', response: 'I can help you with coding, testing, debugging, and more.' },
        { input: 'I\'m working on a React app', response: 'Great! I can help with React development.' },
      ];

      for (const { input, response } of interactions) {
        simulator.queueResponse({
          content: response,
          usage: { inputTokens: 20, outputTokens: 25 },
        });
        await simulator.sendMessage(input);
      }

      const history = simulator.getHistory();
      expect(history.length).toBe(6);

      const userMessages = history.filter((m) => m.role === 'user');
      expect(userMessages.length).toBe(3);

      simulator.cleanup();
    });
  });
});
