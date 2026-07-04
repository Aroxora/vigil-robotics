#!/usr/bin/env node
/**
 * Gazebo MCP Server — stdio-based Model Context Protocol server for Gazebo.
 *
 * Bridges LLM reasoning with simulated physics. Tools:
 *   gazebo_spawn_model, gazebo_delete_model, gazebo_set_pose,
 *   gazebo_get_pose, gazebo_apply_force, gazebo_reset_world,
 *   gazebo_pause, gazebo_step
 *
 * @module scripts/gazebo-mcp
 */

import { randomBytes } from 'node:crypto';

const VIGIL_SESSION_TOKEN = process.env.VIGIL_SESSION_TOKEN;
if (!VIGIL_SESSION_TOKEN) {
  process.stderr.write('[gazebo-mcp] VIGIL_SESSION_TOKEN not set. Run via vigil-run.mjs or set the token.\n');
  process.exit(1);
}

// ─── Mock Gazebo state (real impl would use gazebo-ros or Ignition Transport) ──

const GAZEBO_MASTER_URI = process.env.GAZEBO_MASTER_URI || 'http://localhost:11345';

const worldState = {
  paused: false,
  simTime: 0,
  realTime: Date.now(),
  models: new Map(),
};

function timeStr() {
  return `sim=${worldState.simTime.toFixed(2)}s paused=${worldState.paused}`;
}

// ─── Handlers ─────────────────────────────────────────────────────────

const handlers = {
  gazebo_spawn_model: (args) => {
    const modelName = args?.model_name;
    const modelType = args?.model_type || 'sdf';
    const modelPath = args?.model_path || `model://${modelName}`;
    const x = args?.x ?? 0;
    const y = args?.y ?? 0;
    const z = args?.z ?? 0;
    const roll = args?.roll ?? 0;
    const pitch = args?.pitch ?? 0;
    const yaw = args?.yaw ?? 0;

    if (!modelName) {
      return { content: [{ type: 'text', text: 'Error: model_name parameter required.' }], isError: true };
    }

    if (worldState.models.has(modelName)) {
      return { content: [{ type: 'text', text: `Model '${modelName}' already exists. Delete it first with gazebo_delete_model.` }], isError: true };
    }

    worldState.models.set(modelName, {
      name: modelName,
      type: modelType,
      path: modelPath,
      pose: { x, y, z, roll, pitch, yaw },
      spawnedAt: worldState.simTime,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'ok',
          action: 'spawn_model',
          model_name: modelName,
          pose: { x, y, z, roll, pitch, yaw },
          time: timeStr(),
        }, null, 2),
      }],
    };
  },

  gazebo_delete_model: (args) => {
    const modelName = args?.model_name;

    if (!modelName) {
      return { content: [{ type: 'text', text: 'Error: model_name parameter required.' }], isError: true };
    }

    if (!worldState.models.has(modelName)) {
      return { content: [{ type: 'text', text: `Model '${modelName}' not found. Existing models: ${[...worldState.models.keys()].join(', ') || 'none'}` }], isError: true };
    }

    worldState.models.delete(modelName);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'ok', action: 'delete_model', model_name: modelName, time: timeStr() }, null, 2),
      }],
    };
  },

  gazebo_set_pose: (args) => {
    const modelName = args?.model_name;
    const x = args?.x;
    const y = args?.y;
    const z = args?.z;
    const roll = args?.roll ?? 0;
    const pitch = args?.pitch ?? 0;
    const yaw = args?.yaw ?? 0;

    if (!modelName || x === undefined || y === undefined || z === undefined) {
      return { content: [{ type: 'text', text: 'Error: model_name, x, y, z parameters required.' }], isError: true };
    }

    const model = worldState.models.get(modelName);
    if (!model) {
      return { content: [{ type: 'text', text: `Model '${modelName}' not found.` }], isError: true };
    }

    model.pose = { x, y, z, roll, pitch, yaw };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'ok',
          action: 'set_pose',
          model_name: modelName,
          pose: { x, y, z, roll, pitch, yaw },
          time: timeStr(),
        }, null, 2),
      }],
    };
  },

  gazebo_get_pose: (args) => {
    const modelName = args?.model_name;

    if (!modelName) {
      return { content: [{ type: 'text', text: 'Error: model_name parameter required.' }], isError: true };
    }

    const model = worldState.models.get(modelName);
    if (!model) {
      return { content: [{ type: 'text', text: `Model '${modelName}' not found.` }], isError: true };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          model_name: modelName,
          pose: model.pose,
          time: timeStr(),
        }, null, 2),
      }],
    };
  },

  gazebo_apply_force: (args) => {
    const modelName = args?.model_name;
    const linkName = args?.link_name || 'link';
    const fx = args?.force_x ?? 0;
    const fy = args?.force_y ?? 0;
    const fz = args?.force_z ?? 0;
    const tx = args?.torque_x ?? 0;
    const ty = args?.torque_y ?? 0;
    const tz = args?.torque_z ?? 0;
    const durationMs = args?.duration_ms ?? 100;

    if (!modelName) {
      return { content: [{ type: 'text', text: 'Error: model_name parameter required.' }], isError: true };
    }

    const model = worldState.models.get(modelName);
    if (!model) {
      return { content: [{ type: 'text', text: `Model '${modelName}' not found.` }], isError: true };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'ok',
          action: 'apply_force',
          model_name: modelName,
          link_name: linkName,
          force: { x: fx, y: fy, z: fz },
          torque: { x: tx, y: ty, z: tz },
          duration_ms: durationMs,
          time: timeStr(),
        }, null, 2),
      }],
    };
  },

  gazebo_reset_world: () => {
    worldState.models.clear();
    worldState.simTime = 0;
    worldState.paused = false;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'ok', action: 'reset_world', time: timeStr() }, null, 2),
      }],
    };
  },

  gazebo_pause: (args) => {
    const pause = args?.pause !== undefined ? !!args.pause : true;
    worldState.paused = pause;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'ok', action: 'pause', paused: worldState.paused, time: timeStr() }, null, 2),
      }],
    };
  },

  gazebo_step: (args) => {
    const steps = args?.steps ?? 1;

    if (worldState.paused) {
      // When paused, stepping advances simulation
    }

    worldState.simTime += steps * 0.001; // 1ms default timestep

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'ok', action: 'step', steps, time: timeStr() }, null, 2),
      }],
    };
  },
};

// ─── MCP Tool list ────────────────────────────────────────────────────

const TOOL_LIST = {
  tools: [
    {
      name: 'gazebo_spawn_model',
      description: 'Spawn a model (SDF/URDF) into the Gazebo world at a given pose.',
      inputSchema: {
        type: 'object',
        properties: {
          model_name: { type: 'string', description: 'Name for the spawned model' },
          model_type: { type: 'string', enum: ['sdf', 'urdf'], description: 'Model format (default: sdf)' },
          model_path: { type: 'string', description: 'Path or URI to model file' },
          x: { type: 'number', description: 'X position (default: 0)' },
          y: { type: 'number', description: 'Y position (default: 0)' },
          z: { type: 'number', description: 'Z position (default: 0)' },
          roll: { type: 'number', description: 'Roll in radians (default: 0)' },
          pitch: { type: 'number', description: 'Pitch in radians (default: 0)' },
          yaw: { type: 'number', description: 'Yaw in radians (default: 0)' },
        },
        required: ['model_name'],
      },
    },
    {
      name: 'gazebo_delete_model',
      description: 'Delete/remove a model from the Gazebo world.',
      inputSchema: {
        type: 'object',
        properties: { model_name: { type: 'string', description: 'Name of the model to delete' } },
        required: ['model_name'],
      },
    },
    {
      name: 'gazebo_set_pose',
      description: 'Teleport a model to a new pose instantaneously.',
      inputSchema: {
        type: 'object',
        properties: {
          model_name: { type: 'string', description: 'Name of the model' },
          x: { type: 'number', description: 'X position' },
          y: { type: 'number', description: 'Y position' },
          z: { type: 'number', description: 'Z position' },
          roll: { type: 'number', description: 'Roll in radians (default: 0)' },
          pitch: { type: 'number', description: 'Pitch in radians (default: 0)' },
          yaw: { type: 'number', description: 'Yaw in radians (default: 0)' },
        },
        required: ['model_name', 'x', 'y', 'z'],
      },
    },
    {
      name: 'gazebo_get_pose',
      description: 'Get the current pose of a model.',
      inputSchema: {
        type: 'object',
        properties: { model_name: { type: 'string', description: 'Name of the model' } },
        required: ['model_name'],
      },
    },
    {
      name: 'gazebo_apply_force',
      description: 'Apply a force/torque to a model link.',
      inputSchema: {
        type: 'object',
        properties: {
          model_name: { type: 'string', description: 'Name of the model' },
          link_name: { type: 'string', description: 'Name of the link to apply force to (default: link)' },
          force_x: { type: 'number', description: 'Force X component (N)' },
          force_y: { type: 'number', description: 'Force Y component (N)' },
          force_z: { type: 'number', description: 'Force Z component (N)' },
          torque_x: { type: 'number', description: 'Torque X component (Nm)' },
          torque_y: { type: 'number', description: 'Torque Y component (Nm)' },
          torque_z: { type: 'number', description: 'Torque Z component (Nm)' },
          duration_ms: { type: 'integer', description: 'Duration in ms (default: 100)' },
        },
        required: ['model_name'],
      },
    },
    {
      name: 'gazebo_reset_world',
      description: 'Reset the entire Gazebo world, removing all models.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'gazebo_pause',
      description: 'Pause or unpause Gazebo simulation.',
      inputSchema: {
        type: 'object',
        properties: { pause: { type: 'boolean', description: 'True to pause, false to unpause' } },
        required: [],
      },
    },
    {
      name: 'gazebo_step',
      description: 'Advance the simulation by N steps (useful when paused).',
      inputSchema: {
        type: 'object',
        properties: { steps: { type: 'integer', description: 'Number of steps to advance (default: 1)' } },
        required: [],
      },
    },
  ],
};

// ─── MCP stdio transport ──────────────────────────────────────────────

async function handleRequest(request) {
  const { method, id, params } = request;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'vigil-gazebo-mcp', version: '0.1.0' },
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: TOOL_LIST };

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const handler = handlers[toolName];

      if (!handler) {
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true },
        };
      }

      try {
        const result = handler(toolArgs);
        return { jsonrpc: '2.0', id, result };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
        };
      }
    }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const request = JSON.parse(trimmed);
      const response = await handleRequest(request);
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (err) {
      process.stderr.write(`[gazebo-mcp] parse error: ${err.message}\n`);
    }
  }
});

process.stdin.on('end', () => {
  process.stderr.write('[gazebo-mcp] stdin closed, shutting down.\n');
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

process.stderr.write(`[gazebo-mcp] Gazebo MCP server started. Master: ${GAZEBO_MASTER_URI}\n`);
