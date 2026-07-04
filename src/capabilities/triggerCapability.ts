import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createTriggerTools } from '../tools/triggerTools.js';

export class TriggerCapabilityModule implements CapabilityModule {
  readonly id = 'capability.trigger';

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    return {
      id: 'trigger.tools',
      description: 'RemoteTrigger* — webhook-shaped event ingest with local drop-file fallback.',
      toolSuite: {
        id: 'trigger',
        description: 'Webhook trigger tools',
        tools: createTriggerTools(context.workingDir),
      },
    };
  }
}
