import { EnhancedGitCapabilityModule } from '../../../capabilities/enhancedGitCapability.js';
import type { ToolPlugin } from '../registry.js';

export function createEnhancedGitToolPlugin(): ToolPlugin {
  return {
    id: 'tool.enhanced-git',
    targets: ['node', 'cloud'],
    create: () => new EnhancedGitCapabilityModule(),
  };
}
