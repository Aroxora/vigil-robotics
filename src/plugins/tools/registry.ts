import type { CapabilityModule } from '../../runtime/agentHost.js';

export type ToolPluginTarget = 'node' | 'browser' | 'cloud' | 'universal';

export interface ToolPluginContext {
  workingDir: string;
  env: Record<string, string | undefined>;
}

export type ToolPluginResult =
  | CapabilityModule
  | CapabilityModule[]
  | null
  | undefined
  | Promise<CapabilityModule | CapabilityModule[] | null | undefined>;

export interface ToolPlugin {
  id: string;
  description?: string;
  targets: ToolPluginTarget[];
  create(context: ToolPluginContext): ToolPluginResult;
}

interface InstantiateOptions {
  filter?: (plugin: ToolPlugin) => boolean;
}

const registry = new Map<string, ToolPlugin>();

export function registerToolPlugin(plugin: ToolPlugin): void {
  if (!plugin?.id?.trim()) {
    throw new Error('Tool plugin id cannot be blank.');
  }
  registry.set(plugin.id, normalizePlugin(plugin));
}

export function unregisterToolPlugin(id: string): void {
  registry.delete(id);
}

export function listRegisteredToolPlugins(): ToolPlugin[] {
  return Array.from(registry.values());
}

export async function instantiateToolPlugins(
  target: ToolPluginTarget,
  context: ToolPluginContext,
  options: InstantiateOptions = {}
): Promise<CapabilityModule[]> {
  const modules: CapabilityModule[] = [];

  for (const plugin of registry.values()) {
    if (!supportsTarget(plugin, target)) {
      continue;
    }

    if (options.filter && !options.filter(plugin)) {
      continue;
    }

    const result = await plugin.create(context);
    if (!result) {
      continue;
    }

    if (Array.isArray(result)) {
      for (const entry of result) {
        if (entry) {
          modules.push(entry);
        }
      }
    } else {
      modules.push(result);
    }
  }

  return modules;
}

function normalizePlugin(plugin: ToolPlugin): ToolPlugin {
  if (!plugin.targets?.length) {
    return {
      ...plugin,
      targets: ['universal'],
    };
  }

  return {
    ...plugin,
    targets: Array.from(new Set(plugin.targets)),
  };
}

function supportsTarget(plugin: ToolPlugin, target: ToolPluginTarget): boolean {
  if (plugin.targets.includes('universal')) {
    return true;
  }
  return plugin.targets.includes(target);
}
