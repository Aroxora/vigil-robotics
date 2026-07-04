import { FilesystemCapabilityModule } from '../../../capabilities/filesystemCapability.js';
import type { ToolPlugin } from '../registry.js';

export function createLocalFilesystemToolPlugin(): ToolPlugin {
  return {
    id: 'tool.filesystem.local',
    description: 'Local file system access for Node/Cloud runtimes.',
    targets: ['node', 'cloud'],
    create: (context) => {
      return new FilesystemCapabilityModule({
        workingDir: context.workingDir,
      });
    },
  };
}
