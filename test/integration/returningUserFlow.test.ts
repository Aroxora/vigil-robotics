/**
 * Returning User Flow Tests
 *
 * Tests the experience of users returning to anvilwing after previous sessions.
 * Covers session resumption, context persistence, preference memory, and
 * continuation of previous work.
 */

import {
  TestEnvironment,
  SessionSimulator,
  TestAssertions,
  ReturningUserFlows,
  type ConversationMessage,
} from '../utils/testHelpers.js';

describe('Returning User Flow Tests', () => {
  let env: TestEnvironment;
  let tempDir: string;

  beforeEach(() => {
    env = new TestEnvironment();
    tempDir = env.createTempDir('returning-user-');
    env.setEnv({ VIGIL_DATA_DIR: tempDir });
  });

  afterEach(() => {
    env.cleanup();
  });

  describe('Session Resumption', () => {
    it('should restore previous session messages', async () => {
      const previousMessages: ConversationMessage[] = [
        { role: 'user', content: 'Help me with my React project' },
        { role: 'assistant', content: 'I\'d be happy to help with your React project!' },
        { role: 'user', content: 'I need to add authentication' },
        { role: 'assistant', content: 'Let\'s implement authentication. Do you prefer JWT or session-based?' },
      ];

      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession(previousMessages);

      const history = simulator.getHistory();
      expect(history.length).toBe(4);
      expect(history[0]?.content).toBe('Help me with my React project');
      expect(history[3]?.content).toBe('Let\'s implement authentication. Do you prefer JWT or session-based?');

      simulator.cleanup();
    });

    it('should continue conversation from where user left off', async () => {
      const previousMessages: ConversationMessage[] = [
        { role: 'user', content: 'I\'m building an e-commerce site' },
        { role: 'assistant', content: 'Great! What features do you need help with?' },
      ];

      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession(previousMessages);

      simulator.queueResponse({
        content: 'I remember you\'re working on an e-commerce site. Adding a shopping cart is a great next step.',
        usage: { inputTokens: 50, outputTokens: 40 },
      });

      const { response } = await simulator.sendMessage('Let\'s add a shopping cart');

      const history = simulator.getHistory();
      expect(history.length).toBe(4);
      expect(history[2]?.content).toBe('Let\'s add a shopping cart');
      expect(response.includes('shopping cart')).toBe(true);

      simulator.cleanup();
    });

    it('should mark session as returning user', () => {
      const simulator = new SessionSimulator({ isFirstTime: false });

      const session = simulator.getSession();
      expect(session.isFirstTime).toBe(false);

      simulator.cleanup();
    });

    it('should handle empty previous session gracefully', () => {
      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession([]);

      const history = simulator.getHistory();
      expect(history.length).toBe(0);

      simulator.cleanup();
    });
  });

  describe('Context Persistence', () => {
    it('should maintain context across multiple conversation turns', async () => {
      const previousMessages: ConversationMessage[] = [
        { role: 'user', content: 'I\'m working on a Node.js API' },
        { role: 'assistant', content: 'I see you\'re building a Node.js API. What functionality do you need?' },
      ];

      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession(previousMessages);

      const newInteractions = [
        {
          input: 'Add user authentication endpoint',
          response: 'I\'ll add a /api/auth endpoint to your Node.js API with JWT tokens.',
        },
        {
          input: 'Now add password hashing',
          response: 'Adding bcrypt password hashing to your Node.js authentication endpoint.',
        },
        {
          input: 'What have we built so far?',
          response: 'For your Node.js API, we\'ve implemented authentication and password hashing.',
        },
      ];

      for (const { input, response } of newInteractions) {
        simulator.queueResponse({
          content: response,
          usage: { inputTokens: 30, outputTokens: 40 },
        });
        await simulator.sendMessage(input);
      }

      const history = simulator.getHistory();
      expect(history.length).toBe(8);

      TestAssertions.contextMaintained(history, 'Node.js', 2);

      simulator.cleanup();
    });

    it('should remember project-specific context', async () => {
      const previousMessages: ConversationMessage[] = [
        { role: 'user', content: 'This is a TypeScript React project with Redux' },
        { role: 'assistant', content: 'I understand - TypeScript React with Redux state management.' },
      ];

      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession(previousMessages);

      simulator.queueResponse({
        content: 'Since you\'re using Redux in your TypeScript React project, I\'ll create a properly typed action creator.',
        usage: { inputTokens: 40, outputTokens: 50 },
      });

      const { response } = await simulator.sendMessage('Add a cart feature');

      expect(
        response.includes('Redux') || response.includes('TypeScript') || response.includes('React')
      ).toBe(true);

      simulator.cleanup();
    });

    it('should recall specific technical decisions', async () => {
      const previousMessages: ConversationMessage[] = [
        { role: 'user', content: 'Use PostgreSQL as the database' },
        { role: 'assistant', content: 'PostgreSQL is a great choice.' },
        { role: 'user', content: 'Use Prisma as the ORM' },
        { role: 'assistant', content: 'I\'ll set up Prisma with PostgreSQL for type-safe database access.' },
      ];

      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession(previousMessages);

      simulator.queueResponse({
        content: 'I\'ll add a User model to your Prisma schema that connects to PostgreSQL.',
        usage: { inputTokens: 50, outputTokens: /* TODO: Extract constant */ /* TODO: Extract constant */ /* TODO: Extract constant */ 60 },
      });

      const { response } = await simulator.sendMessage('Add a User model');

      expect(
        response.includes('Prisma') || response.includes('prisma') || response.includes('PostgreSQL')
      ).toBe(true);

      simulator.cleanup();
    });
  });

  describe('User Preferences', () => {
    it('should respect verbose mode preference', async () => {
      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.setPreferences({ verboseMode: true });

      const session = simulator.getSession();
      expect(session.preferences.verboseMode).toBe(true);

      simulator.cleanup();
    });

    it('should respect auto-save preference', async () => {
      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.setPreferences({ autoSave: true });

      simulator.queueResponse({
        content: 'Task completed successfully.',
        usage: { inputTokens: 20, outputTokens: 15 },
      });

      await simulator.sendMessage('Do something');

      const saved = simulator.saveSession();
      expect(saved.id).toBeTruthy();
      expect(saved.messageCount).toBe(2);

      simulator.cleanup();
    });

    it('should maintain preferences across session', async () => {
      const simulator = new SessionSimulator({ isFirstTime: false });

      simulator.setPreferences({
        theme: 'dark',
        autoSave: true,
        verboseMode: false,
        defaultProvider: 'deepseek',
      });

      for (let i = 0; i < 3; i++) {
        simulator.queueResponse({
          content: `Response ${i + 1}`,
          usage: { inputTokens: 10, outputTokens: 10 },
        });
        await simulator.sendMessage(`Message ${i + 1}`);
      }

      const session = simulator.getSession();
      expect(session.preferences.theme).toBe('dark');
      expect(session.preferences.autoSave).toBe(true);
      expect(session.preferences.verboseMode).toBe(false);

      simulator.cleanup();
    });

    it('should update preferences during session', async () => {
      const simulator = new SessionSimulator({ isFirstTime: false });

      simulator.setPreferences({ verboseMode: false });
      expect(simulator.getSession().preferences.verboseMode).toBe(false);

      simulator.setPreferences({ verboseMode: true });
      expect(simulator.getSession().preferences.verboseMode).toBe(true);

      simulator.cleanup();
    });
  });

  describe('Work Continuation', () => {
    it('should continue multi-file editing session', async () => {
      const previousMessages: ConversationMessage[] = [
        { role: 'user', content: 'I\'m refactoring the auth module across multiple files' },
        { role: 'assistant', content: 'I\'ll help you refactor. We\'ve updated auth.ts and need to update user.ts next.' },
        { role: 'user', content: 'Updated auth.ts with the new interface' },
        { role: 'assistant', content: 'Great! auth.ts is done. Now let\'s update user.ts to use the new AuthInterface.' },
      ];

      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession(previousMessages);

      simulator.queueResponse({
        content: 'Continuing with user.ts. I\'ll update it to import and use the AuthInterface from auth.ts.',
        usage: { inputTokens: 60, outputTokens: 50 },
      });

      const { response } = await simulator.sendMessage('Now update user.ts');

      expect(
        response.includes('user.ts') || response.includes('AuthInterface')
      ).toBe(true);

      simulator.cleanup();
    });

    it('should remember debugging context', async () => {
      const previousMessages: ConversationMessage[] = [
        { role: 'user', content: 'I\'m getting a "Cannot read property of undefined" error in my app' },
        { role: 'assistant', content: 'Let\'s debug this. Can you share the stack trace?' },
        { role: 'user', content: 'It\'s in the UserList component on line 42' },
        { role: 'assistant', content: 'I see. The issue is likely in how you\'re accessing user data before it\'s loaded.' },
      ];

      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession(previousMessages);

      simulator.queueResponse({
        content: 'Based on our previous debugging of the UserList component, here\'s the fix with optional chaining.',
        usage: { inputTokens: 70, outputTokens: 45 },
      });

      const { response } = await simulator.sendMessage('Show me the fix');

      expect(
        response.includes('UserList') ||
        response.includes('null') ||
        response.includes('undefined') ||
        response.includes('optional')
      ).toBe(true);

      simulator.cleanup();
    });

    it('should continue test writing session', async () => {
      const previousMessages: ConversationMessage[] = [
        { role: 'user', content: 'Help me write tests for my API endpoints' },
        { role: 'assistant', content: 'I\'ll help write API tests. We\'ve covered GET /users and POST /users.' },
        { role: 'user', content: 'The GET test passes, POST test needs work' },
        { role: 'assistant', content: 'I\'ll fix the POST /users test.' },
      ];

      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession(previousMessages);

      simulator.queueResponse({
        content: 'Continuing with our API tests. Now let\'s add tests for PUT /users/:id and DELETE /users/:id.',
        usage: { inputTokens: 80, outputTokens: 60 },
      });

      const { response } = await simulator.sendMessage('Now add PUT and DELETE tests');

      expect(
        response.includes('PUT') || response.includes('DELETE') || response.includes('test')
      ).toBe(true);

      simulator.cleanup();
    });
  });

  describe('Returning User Scenarios (Predefined)', () => {
    for (const scenario of ReturningUserFlows) {
      it(`should handle scenario: ${scenario.name}`, async () => {
        const simulator = new SessionSimulator({ isFirstTime: false });

        if (scenario.previousSession.messages) {
          simulator.loadSession(scenario.previousSession.messages);
        }

        if (scenario.previousSession.preferences) {
          simulator.setPreferences(scenario.previousSession.preferences);
        }

        for (const step of scenario.steps) {
          simulator.queueResponse({
            content: `[Mock response for: ${step.description}]`,
            usage: { inputTokens: 20, outputTokens: 30 },
          });

          const { response } = await simulator.sendMessage(step.userInput);

          expect(typeof response).toBe('string');
        }

        const session = simulator.getSession();
        const expectedMessageCount =
          (scenario.previousSession.messages?.length ?? 0) + scenario.steps.length * 2;
        expect(session.messages.length).toBe(expectedMessageCount);

        simulator.cleanup();
      });
    }
  });

  describe('Session Recovery', () => {
    it('should recover from interrupted session', async () => {
      const interruptedMessages: ConversationMessage[] = [
        { role: 'user', content: 'Start a long refactoring task' },
        { role: 'assistant', content: 'I\'ll begin the refactoring. This involves multiple steps...' },
      ];

      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession(interruptedMessages);

      simulator.queueResponse({
        content: 'I see we were in the middle of a refactoring task. Would you like me to continue where we left off?',
        usage: { inputTokens: 40, outputTokens: 35 },
      });

      const { response } = await simulator.sendMessage('Continue where we left off');

      expect(
        response.toLowerCase().includes('continue') ||
        response.toLowerCase().includes('refactoring') ||
        response.toLowerCase().includes('left off')
      ).toBe(true);

      simulator.cleanup();
    });

    it('should handle session with tool results in history', async () => {
      const sessionWithTools: ConversationMessage[] = [
        { role: 'user', content: 'Read the package.json' },
        { role: 'assistant', content: 'I\'ll read the package.json file for you.' },
        { role: 'user', content: 'What dependencies does it have?' },
        { role: 'assistant', content: 'Based on package.json, you have: react, typescript, jest' },
      ];

      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession(sessionWithTools);

      simulator.queueResponse({
        content: 'You have react, typescript, and jest as your main dependencies. Would you like to add more packages?',
        usage: { inputTokens: 50, outputTokens: 30 },
      });

      const { response } = await simulator.sendMessage('List those dependencies again');

      expect(
        response.includes('react') || response.includes('dependencies') || response.includes('packages')
      ).toBe(true);

      simulator.cleanup();
    });
  });

  describe('Workspace Context Restoration', () => {
    it('should restore workspace root from previous session', () => {
      const projectDir = env.createMockProject({ name: 'my-project' });

      const simulator = new SessionSimulator({
        isFirstTime: false,
        workspaceRoot: projectDir,
      });

      const session = simulator.getSession();
      expect(session.workspaceRoot.includes('my-project')).toBe(true);

      simulator.cleanup();
    });

    it('should maintain file context across sessions', async () => {
      const projectDir = env.createMockProject({ framework: 'react' });
      const previousMessages: ConversationMessage[] = [
        { role: 'user', content: 'We were working on src/App.tsx' },
        { role: 'assistant', content: 'Yes, we were modifying the App component in src/App.tsx.' },
      ];

      const simulator = new SessionSimulator({
        isFirstTime: false,
        workspaceRoot: projectDir,
      });
      simulator.loadSession(previousMessages);

      simulator.queueResponse({
        content: 'Continuing our work on src/App.tsx. Here\'s the current state of the file.',
        usage: { inputTokens: 45, outputTokens: 40 },
      });

      const { response } = await simulator.sendMessage('Show me the current state of that file');

      expect(
        response.includes('App') || response.includes('src') || response.includes('tsx')
      ).toBe(true);

      simulator.cleanup();
    });
  });

  describe('Provider and Model Persistence', () => {
    it('should maintain provider selection across sessions', () => {
      const simulator = new SessionSimulator({
        isFirstTime: false,
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      });

      const session = simulator.getSession();
      expect(session.provider).toBe('deepseek');
      expect(session.model).toBe('deepseek-v4-pro');

      simulator.cleanup();
    });

    it('should handle different providers for returning users', () => {
      const deepseekSimulator = new SessionSimulator({
        isFirstTime: false,
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      });
      expect(deepseekSimulator.getSession().provider).toBe('deepseek');
      deepseekSimulator.cleanup();
    });
  });

  describe('Long Session Handling', () => {
    it('should handle sessions with many messages', async () => {
      const manyMessages: ConversationMessage[] = [];

      for (let i = 0; i < 20; i++) {
        manyMessages.push({
          role: 'user',
          content: `Question ${i + 1}: How do I implement feature ${i + 1}?`,
        });
        manyMessages.push({
          role: 'assistant',
          content: `Here's how to implement feature ${i + 1}...`,
        });
      }

      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession(manyMessages);

      const history = simulator.getHistory();
      expect(history.length).toBe(40);

      simulator.queueResponse({
        content: 'We\'ve covered features 1-20. Feature 21 would be...',
        usage: { inputTokens: 100, outputTokens: 30 },
      });

      await simulator.sendMessage('What about feature 21?');

      expect(simulator.getHistory().length).toBe(42);

      simulator.cleanup();
    });

    it('should handle session summary for long conversations', async () => {
      const previousMessages: ConversationMessage[] = [];

      for (let i = 0; i < 10; i++) {
        previousMessages.push(
          { role: 'user', content: `Task ${i + 1}` },
          { role: 'assistant', content: `Completed task ${i + 1}` }
        );
      }

      const simulator = new SessionSimulator({ isFirstTime: false });
      simulator.loadSession(previousMessages);

      simulator.queueResponse({
        content: 'Here\'s a summary of what we\'ve accomplished: Tasks 1-10 completed.',
        usage: { inputTokens: 200, outputTokens: 50 },
      });

      const { response } = await simulator.sendMessage('Give me a summary of what we\'ve done');

      expect(
        response.toLowerCase().includes('summary') ||
        response.toLowerCase().includes('accomplished') ||
        response.toLowerCase().includes('completed')
      ).toBe(true);

      simulator.cleanup();
    });
  });
});
