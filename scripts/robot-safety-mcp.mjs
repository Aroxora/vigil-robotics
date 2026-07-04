#!/usr/bin/env node
/**
 * Robot Safety MCP Server — safety monitoring tools for LLM-based robot control.
 *
 * Exposes safety-critical operations to the LLM:
 *   safety_check_limits, safety_watchdog_status, safety_emergency_stop,
 *   safety_release_stop, safety_set_velocity_limit, safety_set_force_limit
 *
 * Safety is the gatekeeper — these tools allow the LLM to query and enforce
 * safety constraints before issuing any actuator commands.
 *
 * @module scripts/robot-safety-mcp
 */

import { randomBytes } from 'node:crypto';

const VIGIL_SESSION_TOKEN = process.env.VIGIL_SESSION_TOKEN;
if (!VIGIL_SESSION_TOKEN) {
  process.stderr.write('[robot-safety-mcp] VIGIL_SESSION_TOKEN not set. Run via vigil-run.mjs or set the token.\n');
  process.exit(1);
}

// ─── Safety state ─────────────────────────────────────────────────────

const safetyState = {
  emergencyStopActive: false,
  emergencyStopReason: '',
  emergencyStopTime: 0,
  velocityLimit: 1.0,
  forceLimit: 100.0,
  torqueLimit: 50.0,
  watchdog: {
    lastHeartbeat: Date.now(),
    timeoutMs: 200,
    logged: false,
  },
  jointLimits: new Map(),
  workspaceBounds: {
    x: { min: -0.9, max: 0.9 },
    y: { min: -0.9, max: 0.9 },
    z: { min: -0.5, max: 1.2 },
  },
};

function safetyStatus() {
  return {
    emergency_stop: safetyState.emergencyStopActive,
    stop_reason: safetyState.emergencyStopReason || 'N/A',
    velocity_limit: safetyState.velocityLimit,
    force_limit: safetyState.forceLimit,
    torque_limit: safetyState.torqueLimit,
    watchdog_alive: Date.now() - safetyState.watchdog.lastHeartbeat < safetyState.watchdog.timeoutMs,
    workspace_bounds: safetyState.workspaceBounds,
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────

const handlers = {
  safety_check_limits: (args) => {
    const jointName = args?.joint_name;
    const position = args?.position;
    const velocity = args?.velocity;
    const effort = args?.effort;
    const tcpX = args?.tcp_x;
    const tcpY = args?.tcp_y;
    const tcpZ = args?.tcp_z;
    const forceX = args?.force_x ?? 0;
    const forceY = args?.force_y ?? 0;
    const forceZ = args?.force_z ?? 0;

    const checks = [];

    if (jointName && position !== undefined) {
      const limit = safetyState.jointLimits.get(jointName);
      if (limit) {
        const posOk = position >= limit.min && position <= limit.max;
        checks.push({
          name: `joint_position_${jointName}`,
          passed: posOk,
          severity: posOk ? 'info' : 'critical',
          message: `Joint ${jointName} position ${position} (limit: [${limit.min}, ${limit.max}])`,
        });
      }
    }

    if (jointName && velocity !== undefined) {
      checks.push({
        name: `joint_velocity_${jointName}`,
        passed: Math.abs(velocity) <= safetyState.velocityLimit,
        severity: Math.abs(velocity) > safetyState.velocityLimit ? 'critical' : 'info',
        message: `Velocity ${velocity} (limit: ${safetyState.velocityLimit})`,
      });
    }

    if (effort !== undefined) {
      checks.push({
        name: 'joint_effort',
        passed: Math.abs(effort) <= safetyState.torqueLimit,
        severity: Math.abs(effort) > safetyState.torqueLimit ? 'critical' : 'info',
        message: `Effort ${effort} Nm (limit: ${safetyState.torqueLimit})`,
      });
    }

    if (tcpX !== undefined) {
      const ok = tcpX >= safetyState.workspaceBounds.x.min && tcpX <= safetyState.workspaceBounds.x.max;
      checks.push({
        name: 'workspace_x',
        passed: ok,
        severity: ok ? 'info' : 'critical',
        message: `TCP X=${tcpX} (bounds: [${safetyState.workspaceBounds.x.min}, ${safetyState.workspaceBounds.x.max}])`,
      });
    }

    if (tcpY !== undefined) {
      const ok = tcpY >= safetyState.workspaceBounds.y.min && tcpY <= safetyState.workspaceBounds.y.max;
      checks.push({
        name: 'workspace_y',
        passed: ok,
        severity: ok ? 'info' : 'critical',
        message: `TCP Y=${tcpY} (bounds: [${safetyState.workspaceBounds.y.min}, ${safetyState.workspaceBounds.y.max}])`,
      });
    }

    if (tcpZ !== undefined) {
      const ok = tcpZ >= safetyState.workspaceBounds.z.min && tcpZ <= safetyState.workspaceBounds.z.max;
      checks.push({
        name: 'workspace_z',
        passed: ok,
        severity: ok ? 'info' : 'critical',
        message: `TCP Z=${tcpZ} (bounds: [${safetyState.workspaceBounds.z.min}, ${safetyState.workspaceBounds.z.max}])`,
      });
    }

    const forceMag = Math.sqrt(forceX ** 2 + forceY ** 2 + forceZ ** 2);
    checks.push({
      name: 'force_magnitude',
      passed: forceMag <= safetyState.forceLimit,
      severity: forceMag > safetyState.forceLimit ? 'critical' : 'info',
      message: `Force magnitude ${forceMag.toFixed(2)} N (limit: ${safetyState.forceLimit} N)`,
    });

    checks.push({
      name: 'emergency_stop',
      passed: !safetyState.emergencyStopActive,
      severity: safetyState.emergencyStopActive ? 'critical' : 'info',
      message: safetyState.emergencyStopActive ? `EMERGENCY STOP ACTIVE: ${safetyState.emergencyStopReason}` : 'Emergency stop not active',
    });

    const allPassed = checks.every((c) => c.passed);
    const score = allPassed ? 1.0 : checks.filter((c) => !c.passed && c.severity === 'critical').length > 0 ? 0 : 0.5;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          passed: allPassed,
          score,
          checks,
          safety_status: safetyStatus(),
        }, null, 2),
      }],
    };
  },

  safety_watchdog_status: () => {
    const elapsed = Date.now() - safetyState.watchdog.lastHeartbeat;
    const alive = elapsed < safetyState.watchdog.timeoutMs;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          alive,
          last_heartbeat_ms_ago: elapsed,
          timeout_ms: safetyState.watchdog.timeoutMs,
          missed: alive ? 0 : Math.floor((elapsed - safetyState.watchdog.timeoutMs) / safetyState.watchdog.timeoutMs) + 1,
          emergency_stop_active: safetyState.emergencyStopActive,
        }, null, 2),
      }],
    };
  },

  safety_emergency_stop: (args) => {
    const reason = args?.reason || 'Manual stop via MCP tool';
    const type = args?.type || 'hard';

    safetyState.emergencyStopActive = true;
    safetyState.emergencyStopReason = reason;
    safetyState.emergencyStopTime = Date.now();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'EMERGENCY_STOP_ACTIVATED',
          type,
          reason,
          time: new Date().toISOString(),
          note: 'All actuator commands are now blocked until safety_release_stop is called.',
        }, null, 2),
      }],
    };
  },

  safety_release_stop: (args) => {
    if (!safetyState.emergencyStopActive) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'ok', message: 'No active emergency stop to release.' }, null, 2),
        }],
      };
    }

    const checksRun = args?.checks_run !== false;

    if (checksRun) {
      const velInLimit = safetyState.velocityLimit > 0;
      const forceInLimit = safetyState.forceLimit > 0;

      if (!velInLimit || !forceInLimit) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'REJECTED',
              message: 'Cannot release stop: safety limits are at zero. Set velocity and force limits first.',
              safety_status: safetyStatus(),
            }, null, 2),
          }],
        };
      }
    }

    safetyState.emergencyStopActive = false;
    safetyState.emergencyStopReason = '';
    safetyState.emergencyStopTime = 0;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'STOP_RELEASED',
          message: 'Emergency stop released. Robot can resume operation.',
          safety_status: safetyStatus(),
        }, null, 2),
      }],
    };
  },

  safety_set_velocity_limit: (args) => {
    const limit = args?.limit;

    if (limit === undefined || typeof limit !== 'number' || limit < 0) {
      return { content: [{ type: 'text', text: 'Error: limit must be a non-negative number.' }], isError: true };
    }

    const oldLimit = safetyState.velocityLimit;
    safetyState.velocityLimit = limit;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'ok',
          parameter: 'velocity_limit',
          old_value: oldLimit,
          new_value: limit,
          unit: 'rad/s',
          note: limit < oldLimit ? 'Speed reduced — safety margin increased.' : 'Speed limit raised.',
        }, null, 2),
      }],
    };
  },

  safety_set_force_limit: (args) => {
    const limit = args?.limit;
    const axis = args?.axis;

    if (limit === undefined || typeof limit !== 'number' || limit < 0) {
      return { content: [{ type: 'text', text: 'Error: limit must be a non-negative number.' }], isError: true };
    }

    const oldLimit = safetyState.forceLimit;
    safetyState.forceLimit = limit;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'ok',
          parameter: axis ? `force_limit_${axis}` : 'force_limit',
          old_value: oldLimit,
          new_value: limit,
          unit: axis?.startsWith('r') ? 'Nm' : 'N',
        }, null, 2),
      }],
    };
  },
};

// ─── MCP Tool list ────────────────────────────────────────────────────

const TOOL_LIST = {
  tools: [
    {
      name: 'safety_check_limits',
      description: 'Run comprehensive safety limit checks for a planned action. Checks joint limits, workspace boundaries, velocity, force, torque, and emergency stop state.',
      inputSchema: {
        type: 'object',
        properties: {
          joint_name: { type: 'string', description: 'Joint name to check position/velocity against' },
          position: { type: 'number', description: 'Joint position in radians' },
          velocity: { type: 'number', description: 'Joint velocity in rad/s' },
          effort: { type: 'number', description: 'Joint effort in Nm' },
          tcp_x: { type: 'number', description: 'TCP X position in meters' },
          tcp_y: { type: 'number', description: 'TCP Y position in meters' },
          tcp_z: { type: 'number', description: 'TCP Z position in meters' },
          force_x: { type: 'number', description: 'Force X component in N' },
          force_y: { type: 'number', description: 'Force Y component in N' },
          force_z: { type: 'number', description: 'Force Z component in N' },
        },
        required: [],
      },
    },
    {
      name: 'safety_watchdog_status',
      description: 'Check the current watchdog/heartbeat status.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'safety_emergency_stop',
      description: 'Trigger an immediate emergency stop. Blocks all actuator commands.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Reason for the emergency stop' },
          type: { type: 'string', enum: ['graceful', 'hard', 'power_off'], description: 'Stop type (default: hard)' },
        },
        required: [],
      },
    },
    {
      name: 'safety_release_stop',
      description: 'Release an active emergency stop after verifying safety conditions.',
      inputSchema: {
        type: 'object',
        properties: { checks_run: { type: 'boolean', description: 'Whether safety checks have been run (default: true)' } },
        required: [],
      },
    },
    {
      name: 'safety_set_velocity_limit',
      description: 'Set the maximum allowed joint velocity limit.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'New velocity limit in rad/s' } },
        required: ['limit'],
      },
    },
    {
      name: 'safety_set_force_limit',
      description: 'Set the maximum allowed force/torque limit.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'New force/torque limit' },
          axis: { type: 'string', description: 'Axis: force (x/y/z) or torque (rx/ry/rz)' },
        },
        required: ['limit'],
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
          serverInfo: { name: 'vigil-robot-safety-mcp', version: '0.1.0' },
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
      process.stderr.write(`[robot-safety-mcp] parse error: ${err.message}\n`);
    }
  }
});

process.stdin.on('end', () => {
  process.stderr.write('[robot-safety-mcp] stdin closed, shutting down.\n');
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

process.stderr.write('[robot-safety-mcp] Robot safety MCP server started.\n');
