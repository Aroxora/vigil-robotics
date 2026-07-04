/**
 * Plugin System - Root Index
 *
 * Aggregates all plugin functionality for easy import.
 *
 * Plugin system for the Vigil agent.
 * Framework: agi-cli
 */

// Re-export tool plugin system
export {
  registerToolPlugin,
  unregisterToolPlugin,
  listRegisteredToolPlugins,
  instantiateToolPlugins,
  type ToolPlugin,
  type ToolPluginContext,
  type ToolPluginTarget,
} from './tools/index.js';

export { registerDefaultNodeToolPlugins } from './tools/nodeDefaults.js';

// Plugin loading state and builtin list
export interface LoadedPlugin {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
}

// Track loaded plugins
const loadedPlugins = new Map<string, LoadedPlugin>();

/**
 * Register a plugin as loaded
 */
export function markPluginLoaded(plugin: LoadedPlugin): void {
  loadedPlugins.set(plugin.id, plugin);
}

/**
 * Get a loaded plugin by ID
 */
export function getLoadedPlugin(id: string): LoadedPlugin | undefined {
  return loadedPlugins.get(id);
}

/**
 * List all loaded plugins
 */
export function listLoadedPlugins(): LoadedPlugin[] {
  return Array.from(loadedPlugins.values());
}

/**
 * List available plugins (combines loaded + builtin)
 */
export function listAvailablePlugins(): string[] {
  const available = new Set<string>();
  for (const id of BUILTIN_PLUGINS) {
    available.add(id);
  }
  for (const id of loadedPlugins.keys()) {
    available.add(id);
  }
  return Array.from(available);
}

/**
 * Get all plugin tool suites
 */
export function getAllPluginToolSuites(): LoadedPlugin[] {
  return listLoadedPlugins().filter((p) => p.enabled);
}

/**
 * Load a plugin by ID
 */
export async function loadPlugin(id: string): Promise<LoadedPlugin | null> {
  // Check if already loaded
  const existing = loadedPlugins.get(id);
  if (existing) {
    return existing;
  }

  // Check if it's a builtin plugin
  if (!BUILTIN_PLUGINS.includes(id as typeof BUILTIN_PLUGINS[number])) {
    return null;
  }

  // Create a loaded plugin entry
  const plugin: LoadedPlugin = {
    id,
    name: id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    version: '1.0.0',
    enabled: true,
  };

  loadedPlugins.set(id, plugin);
  return plugin;
}

/**
 * Get plugin IDs from command line flags
 */
export function getPluginIdsFromFlags(flags: Record<string, boolean>): string[] {
  const ids = new Set<string>();

  // Convenience flags
  if (flags['allPlugins']) {
    BUILTIN_PLUGINS.forEach((id) => ids.add(id));
  }
  if (flags['coding']) {
    ids.add('tool.enhanced-git');
  }

  for (const [flag, enabled] of Object.entries(flags)) {
    if (enabled && BUILTIN_PLUGINS.includes(flag as typeof BUILTIN_PLUGINS[number])) {
      ids.add(flag);
    }
  }

  return Array.from(ids);
}

/**
 * Builtin plugin identifiers
 */
export const BUILTIN_PLUGINS = [
  'tool.filesystem.local',
  'tool.bash.local',
  'tool.search.local',
  'tool.edit',
  'tool.enhanced-git',
  'tool.git-history',
] as const;
