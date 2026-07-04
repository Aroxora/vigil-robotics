import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createTodoTools } from '../tools/todoTools.js';

/**
 * Exposes the TodoWrite tool for agent task-list management.
 * Stateless module; the underlying tool keeps its list in module
 * scope so it persists across turns within a single process.
 */
export class TodoCapabilityModule implements CapabilityModule {
  readonly id = 'capability.todo';

  async create(_context: CapabilityContext): Promise<CapabilityContribution> {
    return {
      id: 'todo.tools',
      description: 'TodoWrite — agent task list (Claude-Code-style).',
      toolSuite: {
        id: 'todo',
        description: 'Task list management',
        tools: createTodoTools(),
      },
      metadata: {},
    };
  }
}
