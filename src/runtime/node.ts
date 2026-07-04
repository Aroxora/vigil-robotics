import { createUniversalRuntime, type UniversalRuntime, type UniversalRuntimeOptions } from './universal.js';
import type { CapabilityModule } from './agentHost.js';
import {
  FilesystemCapabilityModule,
  EditCapabilityModule,
  BashCapabilityModule,
  SearchCapabilityModule,
  WebCapabilityModule,
  HITLCapabilityModule,
  McpCapabilityModule,
  WorktreeCapabilityModule,
  PlanModeCapabilityModule,
  MonitorCapabilityModule,
  InteractionCapabilityModule,
  ScheduleCapabilityModule,
  TriggerCapabilityModule,
} from '../capabilities/index.js';
import { TodoCapabilityModule } from '../capabilities/todoCapability.js';
import { MemoryCapabilityModule } from '../capabilities/memoryCapability.js';
import { SkillCapabilityModule } from '../capabilities/skillCapability.js';
import { NotebookCapabilityModule } from '../capabilities/notebookCapability.js';
import type { ProfileName } from '../config.js';

export interface NodeRuntimeOptions
  extends Omit<UniversalRuntimeOptions, 'additionalModules'> {
  additionalModules?: CapabilityModule[];
}

function createNodeCapabilityModules(_profile: ProfileName): CapabilityModule[] {
  void _profile;
  return [
    new FilesystemCapabilityModule(),
    new EditCapabilityModule(),
    new BashCapabilityModule(),
    new SearchCapabilityModule(),
    new WebCapabilityModule(),
    new HITLCapabilityModule({ autoPause: true, timeoutMs: 0 }),
    new TodoCapabilityModule(),
    new MemoryCapabilityModule(),
    new SkillCapabilityModule(),
    new NotebookCapabilityModule(),
    new WorktreeCapabilityModule(),
    new PlanModeCapabilityModule(),
    new MonitorCapabilityModule(),
    new InteractionCapabilityModule(),
    new ScheduleCapabilityModule(),
    new TriggerCapabilityModule(),
    new McpCapabilityModule(),
  ];
}

export async function createNodeRuntime(options: NodeRuntimeOptions): Promise<UniversalRuntime> {
  const coreModules = createNodeCapabilityModules(options.profile);
  const additionalModules = options.additionalModules ?? [];

  return createUniversalRuntime({
    ...options,
    additionalModules: [...coreModules, ...additionalModules],
  });
}
