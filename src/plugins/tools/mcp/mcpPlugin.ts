import { McpCapabilityModule } from '../../../capabilities/mcpCapability.js';
import type { ToolPlugin } from '../registry.js';

export function createMcpToolPlugin(): ToolPlugin {
  return {
    id: 'tool.mcp',
    description: 'MCP server bridge',
    targets: ['node', 'cloud'],
    create: () => new McpCapabilityModule(),
  };
}
