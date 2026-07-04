import { SearchCapabilityModule } from '../../../capabilities/searchCapability.js';
import type { ToolPlugin } from '../registry.js';

export function createLocalSearchToolPlugin(): ToolPlugin {
  return {
    id: 'tool.search.local',
    description: 'Local ripgrep-based search tooling.',
    targets: ['node', 'cloud'],
    create: (context) => {
      return new SearchCapabilityModule({
        workingDir: context.workingDir,
      });
    },
  };
}
