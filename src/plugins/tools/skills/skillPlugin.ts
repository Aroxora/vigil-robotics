import type { ToolDefinition, ToolSuite } from '../../../core/toolRuntime.js';
import type { CapabilityContribution, CapabilityModule } from '../../../runtime/agentHost.js';
import type { ToolPlugin } from '../registry.js';

class SkillCapabilityModule implements CapabilityModule {
  id = 'tool.skills';
  description = 'Reusable skill library (stub)';

  async create(): Promise<CapabilityContribution> {
    const tools: ToolDefinition[] = [
      {
        name: 'list_skills',
        description: 'List available skills.',
        handler: async () => 'Skills: summarize, refactor, test',
      },
    ];

    const toolSuite: ToolSuite = {
      id: 'skills.tools',
      description: 'Skill helpers',
      tools,
    };

    return { id: this.id, description: this.description, toolSuite };
  }
}

export function createSkillToolPlugin(): ToolPlugin {
  return {
    id: 'tool.skills',
    targets: ['universal'],
    create: () => new SkillCapabilityModule(),
  };
}
