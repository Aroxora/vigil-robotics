import { BashCapabilityModule } from '../../../capabilities/bashCapability.js';
import type { ToolPlugin } from '../registry.js';

export function createLocalBashToolPlugin(): ToolPlugin {
  return {
    id: 'tool.bash.local',
    description: 'Local bash execution with sandbox awareness.',
    targets: ['node', 'cloud'],
    create: (context) => {
      return new BashCapabilityModule({
        workingDir: context.workingDir,
      });
    },
  };
}
