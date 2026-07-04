import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createInteractionTools } from '../tools/interactionTools.js';

export class InteractionCapabilityModule implements CapabilityModule {
  readonly id = 'capability.interaction';

  async create(_context: CapabilityContext): Promise<CapabilityContribution> {
    void _context;
    return {
      id: 'interaction.tools',
      description: 'AskUserQuestion / PushNotification — structured prompts and OS notifications.',
      toolSuite: {
        id: 'interaction',
        description: 'User-interaction tools',
        tools: createInteractionTools(),
      },
    };
  }
}
