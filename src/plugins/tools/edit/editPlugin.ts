import type { ToolPlugin } from '../registry.js';
import { EditCapabilityModule } from '../../../capabilities/editCapability.js';

/**
 * Edit Tool Plugin
 *
 * Registers the Edit capability for surgical file modifications.
 * Available in node and cloud runtimes.
 */
export function createEditToolPlugin(): ToolPlugin {
  return {
    id: 'tool.edit',
    targets: ['node', 'cloud'],
    create: () => new EditCapabilityModule(),
  };
}
