// === UNIFIED CAPABILITY (RECOMMENDED) ===
export { UnifiedCodingCapabilityModule, createUnifiedCodingCapability, type UnifiedCodingOptions } from './unifiedCodingCapability.js';

// === CORE CAPABILITIES ===
export { FilesystemCapabilityModule, type FilesystemCapabilityOptions } from './filesystemCapability.js';
export { EditCapabilityModule } from './editCapability.js';
export { BashCapabilityModule, type BashCapabilityOptions } from './bashCapability.js';
export { SearchCapabilityModule, type SearchCapabilityOptions } from './searchCapability.js';
export { WebCapabilityModule, type WebCapabilityOptions } from './webCapability.js';
export { EnhancedGitCapabilityModule } from './enhancedGitCapability.js';
export { GitHistoryCapabilityModule } from './gitHistoryCapability.js';
export { HITLCapabilityModule, type HITLCapabilityOptions } from './hitlCapability.js';
export { McpCapabilityModule } from './mcpCapability.js';
export { WorktreeCapabilityModule } from './worktreeCapability.js';
export { PlanModeCapabilityModule } from './planModeCapability.js';
export { MonitorCapabilityModule } from './monitorCapability.js';
export { InteractionCapabilityModule } from './interactionCapability.js';
export { ScheduleCapabilityModule } from './scheduleCapability.js';
export { TriggerCapabilityModule } from './triggerCapability.js';
export { BaseCapabilityModule, type BaseCapabilityOptions, ToolSuiteBuilder, SharedUtilities } from './baseCapability.js';
