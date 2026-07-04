import { GitHistoryCapabilityModule } from '../../../capabilities/gitHistoryCapability.js';
import type { ToolPlugin } from '../registry.js';

export function createGitHistoryToolPlugin(): ToolPlugin {
  return {
    id: 'tool.git-history',
    targets: ['node', 'cloud'],
    create: () => new GitHistoryCapabilityModule(),
  };
}
