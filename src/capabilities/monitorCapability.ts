import type { CapabilityContribution, CapabilityContext, CapabilityModule } from '../runtime/agentHost.js';
import { createMonitorTools, shutdownAllMonitors } from '../tools/monitorTools.js';

export class MonitorCapabilityModule implements CapabilityModule {
  readonly id = 'capability.monitor';

  async create(context: CapabilityContext): Promise<CapabilityContribution> {
    return {
      id: 'monitor.tools',
      description: 'Monitor* — background process spawn / read / stop / list.',
      toolSuite: {
        id: 'monitor',
        description: 'Background process management',
        tools: createMonitorTools(context.workingDir),
      },
      dispose: async () => {
        await shutdownAllMonitors();
      },
    };
  }
}
