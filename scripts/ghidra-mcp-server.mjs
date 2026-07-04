#!/usr/bin/env node
// MCP stdio server for Vigil's Ghidra headless integration.
//
// Authorization: this server must be spawned by the Vigil CLI.
// VIGIL_SESSION_TOKEN must be set in the environment (Vigil generates it at
// startup and every child process it spawns inherits it). Direct invocations
// from outside Vigil (e.g. `node scripts/ghidra-mcp-server.mjs` or a
// foreign MCP client) are rejected immediately.

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write(
    '[vigil-ghidra] Error: VIGIL_SESSION_TOKEN is not set.\n' +
    'This server must be started by the Vigil CLI, not directly.\n'
  );
  process.exit(1);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  analyzeBinaryWithGhidra,
  decompileFunctionWithGhidra,
  getXrefsWithGhidra,
  listFunctionsWithGhidra,
  probeGhidraHeadless,
  searchStringsWithGhidra,
} from './_ghidra-headless.mjs';

const server = new McpServer({
  name: 'vigil-ghidra',
  version: '1.0.0',
});

const commonInput = {
  target: z.string().describe('Path to the binary to import into a temporary Ghidra project.'),
  ghidraHome: z.string().optional().describe('Optional Ghidra install directory override.'),
  timeoutMs: z.number().int().positive().optional().describe('Headless analyzer timeout in milliseconds.'),
  keepProject: z.boolean().optional().describe('Keep the temporary Ghidra project instead of deleting it.'),
  projectDir: z.string().optional().describe('Directory for temporary Ghidra projects.'),
};

server.registerTool(
  'ghidra_probe',
  {
    title: 'Probe Ghidra',
    description: 'Detect the local Ghidra headless analyzer and vendored Vigil Ghidra scripts.',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => jsonResult(probeGhidraHeadless()),
);

server.registerTool(
  'ghidra_export_info',
  {
    title: 'Export Binary Info',
    description: 'Import a binary with Ghidra headless and return program metadata, functions, imports, sections, and security signals.',
    inputSchema: commonInput,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => guarded(() => analyzeBinaryWithGhidra(args.target, toolOptions(args))),
);

server.registerTool(
  'ghidra_list_functions',
  {
    title: 'List Functions',
    description: 'Import a binary with Ghidra headless and list discovered functions.',
    inputSchema: {
      ...commonInput,
      maxFunctions: z.number().int().positive().max(10000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => guarded(() => listFunctionsWithGhidra(args.target, {
    ...toolOptions(args),
    maxFunctions: args.maxFunctions,
  })),
);

server.registerTool(
  'ghidra_decompile_function',
  {
    title: 'Decompile Function',
    description: 'Import a binary with Ghidra headless and decompile one function by name or address.',
    inputSchema: {
      ...commonInput,
      functionNameOrAddress: z.string(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => guarded(() => decompileFunctionWithGhidra(
    args.target,
    args.functionNameOrAddress,
    toolOptions(args),
  )),
);

server.registerTool(
  'ghidra_search_strings',
  {
    title: 'Search Strings',
    description: 'Import a binary with Ghidra headless and search printable strings.',
    inputSchema: {
      ...commonInput,
      pattern: z.string().optional(),
      maxResults: z.number().int().positive().max(5000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => guarded(() => searchStringsWithGhidra(args.target, args.pattern || '', {
    ...toolOptions(args),
    maxResults: args.maxResults,
  })),
);

server.registerTool(
  'ghidra_get_xrefs',
  {
    title: 'Get Xrefs',
    description: 'Import a binary with Ghidra headless and return references to/from an address.',
    inputSchema: {
      ...commonInput,
      address: z.string(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (args) => guarded(() => getXrefsWithGhidra(args.target, args.address, toolOptions(args))),
);

function toolOptions(args) {
  return {
    ghidraHome: args.ghidraHome,
    timeoutMs: args.timeoutMs,
    keepProject: !!args.keepProject,
    projectDir: args.projectDir,
  };
}

function jsonResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function guarded(fn) {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: String(error?.message || error),
        },
      ],
    };
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
