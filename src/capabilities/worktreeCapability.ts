import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createWorktreeTools } from '../tools/worktreeTools.js';

export class WorktreeCapabilityModule implements CapabilityModule {
  readonly id = 'capability.worktree';

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    return {
      id: 'worktree.tools',
      description: 'EnterWorktree / ExitWorktree / ListWorktrees — git worktree isolation.',
      toolSuite: {
        id: 'worktree',
        description: 'Git worktree isolation tools',
        tools: createWorktreeTools(context.workingDir),
      },
    };
  }
}
