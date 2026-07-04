/**
 * Test Utilities and Helpers for User Flow Testing
 *
 * Provides reusable helpers for simulating user interactions,
 * managing test sessions, and validating user flows.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ConversationMessage, ProviderId } from '../../src/core/types.js';
import type { ProfileName } from '../../src/config.js';
import type { ToolDefinition } from '../../src/core/toolRuntime.js';

// ============================================================================
// Types
// ============================================================================

export interface MockUserSession {
  id: string;
  profile: ProfileName;
  provider: ProviderId;
  model: string;
  messages: ConversationMessage[];
  workspaceRoot: string;
  isFirstTime: boolean;
  preferences: UserPreferences;
}

export interface UserPreferences {
  theme?: 'light' | 'dark' | 'auto';
  autoSave?: boolean;
  verboseMode?: boolean;
  defaultProvider?: ProviderId;
}

export interface MockProviderResponse {
  content: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface UserFlowStep {
  description: string;
  userInput: string;
  expectedBehavior: string[];
  toolsExpected?: string[];
  validationFn?: (response: string) => boolean;
}

export interface FirstTimeUserScenario {
  name: string;
  description: string;
  steps: UserFlowStep[];
}

export interface ReturningUserScenario {
  name: string;
  description: string;
  previousSession: Partial<MockUserSession>;
  steps: UserFlowStep[];
}

// ============================================================================
// Test Environment Setup
// ============================================================================

export class TestEnvironment {
  private tempDirs: string[] = [];
  private originalEnv: Record<string, string | undefined> = {};

  /**
   * Creates a temporary directory for test isolation
   */
  createTempDir(prefix = 'vigil-test-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.tempDirs.push(dir);
    return dir;
  }

  /**
   * Creates a mock project directory with common files
   */
  createMockProject(options: {
    name?: string;
    framework?: 'react' | 'nextjs' | 'angular' | 'vue' | 'node';
    hasTests?: boolean;
    hasE2E?: boolean;
  } = {}): string {
    const {
      name = 'test-project',
      framework = 'react',
      hasTests = true,
      hasE2E = false,
    } = options;

    const projectDir = this.createTempDir(`${name}-`);

    // Create package.json
    const packageJson: Record<string, unknown> = {
      name,
      version: '1.0.0',
      scripts: {
        build: 'echo "Building..."',
        test: hasTests ? 'jest' : 'echo "No tests"',
        start: 'echo "Starting..."',
      },
      dependencies: {},
      devDependencies: {},
    };

    // Add framework-specific dependencies
    switch (framework) {
      case 'react':
        packageJson.dependencies = { react: '^18.0.0', 'react-dom': '^18.0.0' };
        break;
      case 'nextjs':
        packageJson.dependencies = { next: '^14.0.0', react: '^18.0.0' };
        break;
      case 'angular':
        packageJson.dependencies = { '@angular/core': '^17.0.0' };
        break;
      case 'vue':
        packageJson.dependencies = { vue: '^3.0.0' };
        break;
      case 'node':
        packageJson.dependencies = { express: '^4.0.0' };
        break;
    }

    if (hasTests) {
      (packageJson.devDependencies as Record<string, string>)['jest'] = '^29.0.0';
    }

    if (hasE2E) {
      (packageJson.devDependencies as Record<string, string>)['cypress'] = '^13.0.0';
    }

    writeFileSync(join(projectDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Create src directory
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'index.ts'), '// Entry point\n// TODO: Replace with logger\nconsole.log("Hello");\n');

    // Create build directory (simulating built output)
    mkdirSync(join(projectDir, 'build'), { recursive: true });
    writeFileSync(join(projectDir, 'build', 'index.html'), '<!DOCTYPE html><html><body></body></html>');

    return projectDir;
  }

  /**
   * Sets up environment variables for testing
   */
  setEnv(vars: Record<string, string>): void {
    for (const [key, value] of Object.entries(vars)) {
      this.originalEnv[key] = process.env[key];
      process.env[key] = value;
    }
  }

  /**
   * Cleans up all test resources
   */
  cleanup(): void {
    // Remove temp directories
    for (const dir of this.tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    this.tempDirs = [];

    // Restore environment
    for (const [key, value] of Object.entries(this.originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    this.originalEnv = {};
  }
}

// ============================================================================
// Mock LLM Provider
// ============================================================================

export class MockLLMProvider {
  private responses: MockProviderResponse[] = [];
  private callHistory: Array<{
    messages: ConversationMessage[];
    tools?: ToolDefinition[];
  }> = [];
  private responseIndex = 0;

  /**
   * Queue a response to be returned by the mock provider
   */
  queueResponse(response: MockProviderResponse): void {
    this.responses.push(response);
  }

  /**
   * Queue multiple responses
   */
  queueResponses(responses: MockProviderResponse[]): void {
    this.responses.push(...responses);
  }

  /**
   * Simulate generating a response
   */
  async generate(
    messages: ConversationMessage[],
    tools?: ToolDefinition[]
  ): Promise<MockProviderResponse> {
    this.callHistory.push({ messages, tools });

    if (this.responseIndex >= this.responses.length) {
      return {
        content: 'Default mock response',
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    }

    return this.responses[this.responseIndex++]!;
  }

  /**
   * Get the call history for assertions
   */
  getCallHistory(): typeof this.callHistory {
    return [...this.callHistory];
  }

  /**
   * Reset the provider state
   */
  reset(): void {
    this.responses = [];
    this.callHistory = [];
    this.responseIndex = 0;
  }

  /**
   * Get the last call made to the provider
   */
  getLastCall(): (typeof this.callHistory)[0] | undefined {
    return this.callHistory[this.callHistory.length - 1];
  }
}

// ============================================================================
// Session Simulator
// ============================================================================

export class SessionSimulator {
  private session: MockUserSession;
  private provider: MockLLMProvider;
  private env: TestEnvironment;

  constructor(options: {
    isFirstTime?: boolean;
    profile?: ProfileName;
    provider?: ProviderId;
    model?: string;
    workspaceRoot?: string;
  } = {}) {
    this.env = new TestEnvironment();
    this.provider = new MockLLMProvider();

    const workspaceRoot = options.workspaceRoot ?? this.env.createMockProject();

    this.session = {
      id: `session-${Date.now()}`,
      profile: options.profile ?? 'general',
      provider: options.provider ?? 'deepseek',
      model: options.model ?? 'deepseek-v4-pro',
      messages: [],
      workspaceRoot,
      isFirstTime: options.isFirstTime ?? true,
      preferences: {},
    };
  }

  /**
   * Simulate user sending a message
   */
  async sendMessage(input: string): Promise<{
    response: string;
    toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  }> {
    // Add user message
    this.session.messages.push({
      role: 'user',
      content: input,
    });

    // Get provider response
    const providerResponse = await this.provider.generate(this.session.messages);

    // Add assistant message
    this.session.messages.push({
      role: 'assistant',
      content: providerResponse.content,
    });

    return {
      response: providerResponse.content,
      toolCalls: providerResponse.toolCalls ?? [],
    };
  }

  /**
   * Queue a provider response
   */
  queueResponse(response: MockProviderResponse): void {
    this.provider.queueResponse(response);
  }

  /**
   * Get current session state
   */
  getSession(): MockUserSession {
    return { ...this.session };
  }

  /**
   * Get message history
   */
  getHistory(): ConversationMessage[] {
    return [...this.session.messages];
  }

  /**
   * Set user preferences
   */
  setPreferences(prefs: Partial<UserPreferences>): void {
    this.session.preferences = { ...this.session.preferences, ...prefs };
  }

  /**
   * Simulate session persistence (save)
   */
  saveSession(): { id: string; messageCount: number } {
    return {
      id: this.session.id,
      messageCount: this.session.messages.length,
    };
  }

  /**
   * Simulate loading a previous session
   */
  loadSession(previousMessages: ConversationMessage[]): void {
    this.session.messages = [...previousMessages];
    this.session.isFirstTime = false;
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    this.env.cleanup();
    this.provider.reset();
  }
}

// ============================================================================
// User Flow Validators
// ============================================================================

export const FlowValidators = {
  /**
   * Validates that a first-time user sees welcome/onboarding content
   */
  expectsWelcomeMessage(response: string): boolean {
    const welcomePatterns = [
      /welcome/i,
      /hello/i,
      /hi there/i,
      /how can i help/i,
      /get started/i,
    ];
    return welcomePatterns.some((pattern) => pattern.test(response));
  },

  /**
   * Validates that a response indicates successful tool usage
   */
  expectsToolSuccess(response: string, toolName: string): boolean {
    return (
      response.toLowerCase().includes(toolName.toLowerCase()) ||
      response.includes('successfully') ||
      response.includes('completed')
    );
  },

  /**
   * Validates that an error was handled gracefully
   */
  expectsGracefulError(response: string): boolean {
    const errorPatterns = [
      /error/i,
      /failed/i,
      /couldn't/i,
      /unable to/i,
      /sorry/i,
    ];
    const helpfulPatterns = [
      /try/i,
      /instead/i,
      /suggestion/i,
      /help/i,
      /alternative/i,
    ];
    return (
      errorPatterns.some((p) => p.test(response)) &&
      helpfulPatterns.some((p) => p.test(response))
    );
  },

  /**
   * Validates that session was restored correctly
   */
  expectsSessionRestored(currentHistory: ConversationMessage[], expectedCount: number): boolean {
    return currentHistory.length >= expectedCount;
  },

  /**
   * Validates that context is maintained across turns
   */
  expectsContextMaintained(history: ConversationMessage[], topic: string): boolean {
    const topicMentions = history.filter(
      (m) => m.content.toLowerCase().includes(topic.toLowerCase())
    );
    return topicMentions.length >= 2;
  },
};

// ============================================================================
// Predefined User Flow Scenarios
// ============================================================================

export const FirstTimeUserFlows: FirstTimeUserScenario[] = [
  {
    name: 'basic-greeting',
    description: 'First-time user sends a simple greeting',
    steps: [
      {
        description: 'User greets the assistant',
        userInput: 'Hello!',
        expectedBehavior: [
          'Assistant responds with a greeting',
          'Assistant may offer help or ask what user needs',
        ],
        validationFn: FlowValidators.expectsWelcomeMessage,
      },
    ],
  },
  {
    name: 'code-help-request',
    description: 'First-time user asks for help with code',
    steps: [
      {
        description: 'User asks for coding help',
        userInput: 'Can you help me write a function to calculate fibonacci numbers?',
        expectedBehavior: [
          'Assistant provides a fibonacci function',
          'Code is properly formatted',
          'Explanation is included',
        ],
        validationFn: (response) =>
          response.includes('function') || response.includes('fibonacci'),
      },
    ],
  },
  {
    name: 'project-exploration',
    description: 'First-time user wants to explore their project',
    steps: [
      {
        description: 'User asks about project structure',
        userInput: 'What files are in this project?',
        expectedBehavior: [
          'Assistant uses file listing tools',
          'Shows relevant project files',
        ],
        toolsExpected: ['glob', 'read'],
      },
      {
        description: 'User asks about a specific file',
        userInput: 'Can you show me the package.json?',
        expectedBehavior: [
          'Assistant reads and shows the file contents',
          'May provide insights about dependencies',
        ],
        toolsExpected: ['read'],
      },
    ],
  },
  {
    name: 'frontend-testing-request',
    description: 'First-time user wants to test their frontend',
    steps: [
      {
        description: 'User asks to verify their build',
        userInput: 'Can you verify my build output is correct?',
        expectedBehavior: [
          'Assistant uses verify_build_output tool',
          'Reports on bundle size and assets',
        ],
        toolsExpected: ['verify_build_output'],
      },
      {
        description: 'User asks to run E2E tests',
        userInput: 'Now run the E2E tests',
        expectedBehavior: [
          'Assistant attempts to run E2E tests',
          'Reports results or guides on setup',
        ],
        toolsExpected: ['run_e2e_tests'],
      },
    ],
  },
];

export const ReturningUserFlows: ReturningUserScenario[] = [
  {
    name: 'session-resume',
    description: 'Returning user resumes a previous conversation',
    previousSession: {
      messages: [
        { role: 'user', content: 'Help me with my React project' } as ConversationMessage,
        { role: 'assistant', content: 'I\'d be happy to help with your React project. What would you like to do?' } as ConversationMessage,
      ],
    },
    steps: [
      {
        description: 'User continues previous conversation',
        userInput: 'Let\'s continue with adding tests',
        expectedBehavior: [
          'Assistant remembers React context',
          'Provides React-specific testing guidance',
        ],
        validationFn: (response) =>
          response.toLowerCase().includes('test') ||
          response.toLowerCase().includes('react'),
      },
    ],
  },
  {
    name: 'preference-remembered',
    description: 'Returning user has preferences applied',
    previousSession: {
      preferences: {
        verboseMode: true,
        autoSave: true,
      },
    },
    steps: [
      {
        description: 'User makes a request expecting verbose output',
        userInput: 'Run the build',
        expectedBehavior: [
          'Response is detailed (verbose mode)',
          'Session auto-saves after interaction',
        ],
      },
    ],
  },
  {
    name: 'multi-session-context',
    description: 'User references work from a previous session',
    previousSession: {
      messages: [
        { role: 'user', content: 'I\'m working on the authentication module' } as ConversationMessage,
        { role: 'assistant', content: 'I see you\'re working on authentication. I can help you implement secure login.' } as ConversationMessage,
        { role: 'user', content: 'Add JWT token validation' } as ConversationMessage,
        { role: 'assistant', content: 'I\'ve added JWT validation to your auth module.' } as ConversationMessage,
      ],
    },
    steps: [
      {
        description: 'User references previous work',
        userInput: 'Remember when we added JWT validation? Can we now add refresh tokens?',
        expectedBehavior: [
          'Assistant recalls JWT work',
          'Builds upon previous context',
          'Provides refresh token implementation',
        ],
        validationFn: (response) =>
          response.toLowerCase().includes('jwt') ||
          response.toLowerCase().includes('refresh') ||
          response.toLowerCase().includes('token'),
      },
    ],
  },
  {
    name: 'deployment-verification-flow',
    description: 'Returning user continues deployment verification workflow',
    previousSession: {
      messages: [
        { role: 'user', content: 'I just pushed my frontend to production' } as ConversationMessage,
        { role: 'assistant', content: 'Great! Would you like me to verify the deployment?' } as ConversationMessage,
      ],
    },
    steps: [
      {
        description: 'User asks to verify deployment',
        userInput: 'Yes, verify the deployment at https://myapp.example.com',
        expectedBehavior: [
          'Assistant uses verify_deployment tool',
          'Checks URL health and assets',
        ],
        toolsExpected: ['verify_deployment'],
      },
      {
        description: 'User asks for accessibility check',
        userInput: 'Also check accessibility',
        expectedBehavior: [
          'Assistant uses accessibility testing tool',
          'Reports any a11y issues',
        ],
        toolsExpected: ['run_accessibility_tests'],
      },
    ],
  },
];

// ============================================================================
// Test Assertions Helpers
// ============================================================================

export const TestAssertions = {
  /**
   * Assert that a response contains expected content
   */
  responseContains(response: string, expected: string | string[]): void {
    const expectations = Array.isArray(expected) ? expected : [expected];
    for (const exp of expectations) {
      if (!response.toLowerCase().includes(exp.toLowerCase())) {
        throw new Error(`Expected response to contain "${exp}" but got: ${response.slice(0, 200)}...`);
      }
    }
  },

  /**
   * Assert that tools were called in the expected order
   */
  toolsCalledInOrder(
    callHistory: Array<{ name: string }>,
    expectedOrder: string[]
  ): void {
    const actualNames = callHistory.map((c) => c.name);
    for (let i = 0; i < expectedOrder.length; i++) {
      if (actualNames[i] !== expectedOrder[i]) {
        throw new Error(
          `Expected tool "${expectedOrder[i]}" at position ${i}, but got "${actualNames[i]}"`
        );
      }
    }
  },

  /**
   * Assert that session was persisted correctly
   */
  sessionPersisted(
    saved: { id: string; messageCount: number },
    expectedMinMessages: number
  ): void {
    if (saved.messageCount < expectedMinMessages) {
      throw new Error(
        `Expected at least ${expectedMinMessages} messages in session, got ${saved.messageCount}`
      );
    }
  },

  /**
   * Assert that context is maintained
   */
  contextMaintained(
    history: ConversationMessage[],
    contextKeyword: string,
    minMentions = 2
  ): void {
    const mentions = history.filter((m) =>
      m.content.toLowerCase().includes(contextKeyword.toLowerCase())
    ).length;
    if (mentions < minMentions) {
      throw new Error(
        `Expected "${contextKeyword}" to be mentioned at least ${minMentions} times, found ${mentions}`
      );
    }
  },
};

// ============================================================================
// Exports for convenience
// ============================================================================

export function createTestEnvironment(): TestEnvironment {
  return new TestEnvironment();
}

export function createSessionSimulator(options?: Parameters<typeof SessionSimulator['prototype']['constructor']>[0]): SessionSimulator {
  return new SessionSimulator(options);
}

export function createMockProvider(): MockLLMProvider {
  return new MockLLMProvider();
}
