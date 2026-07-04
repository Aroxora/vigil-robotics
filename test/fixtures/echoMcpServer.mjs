#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '0.0.1' });

server.registerTool(
  'echo',
  {
    description: 'Echo back the provided text.',
    inputSchema: { text: z.string().describe('Text to echo') },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: `echo: ${text}` }],
  })
);

server.registerTool(
  'add',
  {
    description: 'Add two numbers.',
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
