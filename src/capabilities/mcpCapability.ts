import type { ToolDefinition, ToolSuite } from '../core/toolRuntime.js';
import type { JSONSchemaObject } from '../core/types.js';
import type { CapabilityContext, CapabilityContribution, CapabilityModule } from '../runtime/agentHost.js';
import {
  getSharedMcpManager,
  serverMatchesProfile,
  type McpServerConnection,
} from '../plugins/tools/mcp/mcpClient.js';

const TOOL_NAME_RE = /[^a-zA-Z0-9_]/g;

function sanitizeForToolName(input: string): string {
  return input.replace(TOOL_NAME_RE, '_');
}

function buildToolName(server: string, tool: string): string {
  return `mcp__${sanitizeForToolName(server)}__${sanitizeForToolName(tool)}`;
}

function stringifyToolResult(result: { content: unknown; isError?: boolean }): string {
  const lines: string[] = [];
  const content = result.content;
  if (Array.isArray(content)) {
    for (const item of content as Array<{ type?: string; text?: string }>) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        lines.push(item.text);
      } else {
        lines.push(JSON.stringify(item));
      }
    }
  } else if (typeof content === 'string') {
    lines.push(content);
  } else if (content !== undefined) {
    lines.push(JSON.stringify(content));
  }
  const text = lines.join('\n');
  return result.isError ? `MCP tool error: ${text}` : text;
}

function buildToolDefinitions(connection: McpServerConnection): ToolDefinition[] {
  return connection.tools.map((tool): ToolDefinition => ({
    name: buildToolName(connection.name, tool.name),
    description: tool.description ?? `MCP tool ${tool.name} on server ${connection.name}`,
    parameters: tool.inputSchema as unknown as JSONSchemaObject,
    handler: async (args: Record<string, unknown>) => {
      const result = await connection.client.callTool({
        name: tool.name,
        arguments: args,
      });
      return stringifyToolResult(result as { content: unknown; isError?: boolean });
    },
  }));
}

export class McpCapabilityModule implements CapabilityModule {
  readonly id = 'capability.mcp';
  readonly description = 'MCP server bridge — exposes remote MCP tools as native capability tools.';

  async create(context: CapabilityContext): Promise<CapabilityContribution | null> {
    const manager = getSharedMcpManager(context.workingDir);
    await manager.init();
    const connections = manager
      .getConnections()
      .filter((c) => serverMatchesProfile(c.spec, context.profile));
    if (connections.length === 0) {
      return null;
    }

    const tools: ToolDefinition[] = [];
    for (const connection of connections) {
      tools.push(...buildToolDefinitions(connection));
    }

    if (tools.length === 0) {
      return null;
    }

    const toolSuite: ToolSuite = {
      id: 'mcp.tools',
      description: 'Tools provided by configured MCP servers',
      tools,
    };

    return {
      id: this.id,
      description: this.description,
      toolSuite,
      metadata: {
        servers: connections.map((c) => ({ name: c.name, toolCount: c.tools.length })),
      },
      dispose: async () => {
        await manager.dispose();
      },
    };
  }
}
