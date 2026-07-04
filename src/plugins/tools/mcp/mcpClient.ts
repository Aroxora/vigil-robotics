import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { logDebug } from '../../../utils/debugLogger.js';
import { profileMatches } from '../../../config.js';

export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  /**
   * Tenant-mount allow-list. When present, the server's tools only
   * surface for sessions running one of these agent profiles. When
   * absent, the server is mounted for all profiles (back-compat).
   */
  profiles?: string[];
}

export function serverMatchesProfile(spec: McpServerSpec, profile: string): boolean {
  if (!spec.profiles || spec.profiles.length === 0) {
    return true;
  }
  return spec.profiles.some((allowed) => profileMatches(allowed, profile));
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerSpec>;
}

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[]; [k: string]: unknown };
}

export interface McpServerConnection {
  name: string;
  spec: McpServerSpec;
  client: Client;
  tools: McpRemoteTool[];
  status: 'connected';
}

export interface McpServerError {
  name: string;
  spec: McpServerSpec;
  error: string;
  status: 'error';
}

export type McpServerEntry = McpServerConnection | McpServerError;

const CLIENT_INFO = { name: 'vigil', version: '1.0.0' };
const CLIENT_CAPABILITIES = {};

function readConfigAt(path: string): McpConfigFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as McpConfigFile;
  } catch (err) {
    logDebug(`[MCP] Failed to parse ${path}: ${(err as Error).message}`);
    return null;
  }
}

export function loadMcpConfig(workingDir: string): Record<string, McpServerSpec> {
  const userPath = join(homedir(), '.vigil', 'mcp.json');
  const projectPath = join(workingDir, '.vigil', 'mcp.json');
  const merged: Record<string, McpServerSpec> = {};
  for (const file of [readConfigAt(userPath), readConfigAt(projectPath)]) {
    if (!file?.mcpServers) continue;
    for (const [name, spec] of Object.entries(file.mcpServers)) {
      merged[name] = spec;
    }
  }
  return merged;
}

async function connectServer(name: string, spec: McpServerSpec): Promise<McpServerEntry> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: { ...process.env as Record<string, string>, ...(spec.env ?? {}) },
    cwd: spec.cwd,
    stderr: 'pipe',
  });
  const client = new Client(CLIENT_INFO, { capabilities: CLIENT_CAPABILITIES });
  await client.connect(transport);
  const listed = await client.listTools();
  const tools: McpRemoteTool[] = listed.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as McpRemoteTool['inputSchema'],
  }));
  return { name, spec, client, tools, status: 'connected' };
}

export class McpServerManager {
  private entries: McpServerEntry[] = [];
  private initPromise: Promise<void> | null = null;

  constructor(private readonly workingDir: string) {}

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const servers = loadMcpConfig(this.workingDir);
    const entries: McpServerEntry[] = [];
    for (const [name, spec] of Object.entries(servers)) {
      if (spec.disabled) continue;
      try {
        entries.push(await connectServer(name, spec));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logDebug(`[MCP] Failed to connect ${name}: ${message}`);
        entries.push({ name, spec, error: message, status: 'error' });
      }
    }
    this.entries = entries;
  }

  getEntries(): readonly McpServerEntry[] {
    return this.entries;
  }

  getConnections(): McpServerConnection[] {
    return this.entries.filter((e): e is McpServerConnection => e.status === 'connected');
  }

  async dispose(): Promise<void> {
    for (const entry of this.entries) {
      if (entry.status === 'connected') {
        try {
          await entry.client.close();
        } catch (err) {
          logDebug(`[MCP] Error closing ${entry.name}: ${(err as Error).message}`);
        }
      }
    }
    this.entries = [];
    this.initPromise = null;
  }
}

let sharedManager: McpServerManager | null = null;
let sharedManagerWorkingDir: string | null = null;

export function getSharedMcpManager(workingDir: string): McpServerManager {
  if (!sharedManager || sharedManagerWorkingDir !== workingDir) {
    sharedManager = new McpServerManager(workingDir);
    sharedManagerWorkingDir = workingDir;
  }
  return sharedManager;
}
