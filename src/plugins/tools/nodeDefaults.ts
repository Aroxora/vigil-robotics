import { registerToolPlugin } from './registry.js';
import { createLocalFilesystemToolPlugin } from './filesystem/localFilesystemPlugin.js';
import { createEditToolPlugin } from './edit/editPlugin.js';
import { createLocalSearchToolPlugin } from './search/localSearchPlugin.js';
import { createLocalBashToolPlugin } from './bash/localBashPlugin.js';
import { createEnhancedGitToolPlugin } from './enhancedGit/enhancedGitPlugin.js';
import { createGitHistoryToolPlugin } from './gitHistory/gitHistoryPlugin.js';
import { createTodoToolPlugin } from './todo/todoPlugin.js';
import { createMcpToolPlugin } from './mcp/mcpPlugin.js';

let registered = false;

/**
 * Register default Node.js tool plugins
 *
 * Core plugins:
 * - filesystem: Read files
 * - edit: Edit files
 * - search: Unified search (files, content, definitions)
 * - bash: Execute commands
 * - enhanced-git: Git operations
 * - git-history: Git history search and file restoration
 */
export function registerDefaultNodeToolPlugins(): void {
  if (registered) return;

  registerToolPlugin(createLocalFilesystemToolPlugin());
  registerToolPlugin(createEditToolPlugin());
  registerToolPlugin(createLocalSearchToolPlugin());
  registerToolPlugin(createLocalBashToolPlugin());
  registerToolPlugin(createEnhancedGitToolPlugin());
  registerToolPlugin(createGitHistoryToolPlugin());
  registerToolPlugin(createTodoToolPlugin());
  registerToolPlugin(createMcpToolPlugin());

  registered = true;
}
