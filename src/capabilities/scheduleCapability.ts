import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createScheduleTools } from '../tools/scheduleTools.js';

export class ScheduleCapabilityModule implements CapabilityModule {
  readonly id = 'capability.schedule';

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    return {
      id: 'schedule.tools',
      description: 'ScheduleWakeup / CronCreate / CronList / CronDelete — self-pacing + recurring schedule registration.',
      toolSuite: {
        id: 'schedule',
        description: 'Scheduling tools',
        tools: createScheduleTools(context.workingDir),
      },
    };
  }
}
