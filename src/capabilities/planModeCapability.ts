import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createPlanModeTools } from '../tools/planModeTools.js';

export class PlanModeCapabilityModule implements CapabilityModule {
  readonly id = 'capability.planMode';

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    return {
      id: 'planMode.tools',
      description: 'EnterPlanMode / ExitPlanMode / UpdatePlanStep — explore→plan→execute workflow with persisted plans.',
      toolSuite: {
        id: 'planMode',
        description: 'Plan mode tools',
        tools: createPlanModeTools(context.workingDir),
      },
    };
  }
}
