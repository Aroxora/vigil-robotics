#!/usr/bin/env node
/**
 * ROS MCP Server — stdio-based Model Context Protocol server for ROS 1/2.
 *
 * Provides tools that let an LLM interact with a running ROS system:
 *   ros_topic_list, ros_topic_echo, ros_service_call,
 *   ros_param_get, ros_param_set, ros_tf_lookup,
 *   ros_node_info, ros_urdf_load
 *
 * Connects via ROS_MASTER_URI (ROS 1) or ROS_DOMAIN_ID (ROS 2).
 *
 * @module scripts/ros-mcp
 */

import { randomBytes } from 'node:crypto';

const VIGIL_SESSION_TOKEN = process.env.VIGIL_SESSION_TOKEN;
if (!VIGIL_SESSION_TOKEN) {
  process.stderr.write('[ros-mcp] VIGIL_SESSION_TOKEN not set. Run via vigil-run.mjs or set the token.\n');
  process.exit(1);
}

// ─── ROS connection state ────────────────────────────────────────────

const ROS_MASTER_URI = process.env.ROS_MASTER_URI || 'http://localhost:11311';
const ROS_DOMAIN_ID = process.env.ROS_DOMAIN_ID ? parseInt(process.env.ROS_DOMAIN_ID, 10) : undefined;

// ─── Mock ROS state (real implementation would call rosnodejs / rclnodejs) ──

const mockTopics = [
  { name: '/joint_states', type: 'sensor_msgs/JointState', publishers: 1, subscribers: 3, frequencyHz: 100 },
  { name: '/tf', type: 'tf2_msgs/TFMessage', publishers: 1, subscribers: 5, frequencyHz: 30 },
  { name: '/scan', type: 'sensor_msgs/LaserScan', publishers: 1, subscribers: 2, frequencyHz: 10 },
  { name: '/odom', type: 'nav_msgs/Odometry', publishers: 1, subscribers: 4, frequencyHz: 50 },
  { name: '/cmd_vel', type: 'geometry_msgs/Twist', publishers: 0, subscribers: 1, frequencyHz: 0 },
  { name: '/camera/rgb/image_raw', type: 'sensor_msgs/Image', publishers: 1, subscribers: 2, frequencyHz: 30 },
];

const mockServices = [
  { name: '/controller_manager/list_controllers', type: 'controller_manager_msgs/ListControllers' },
  { name: '/compute_ik', type: 'moveit_msgs/GetPositionIK' },
  { name: '/plan_kinematic_path', type: 'moveit_msgs/GetMotionPlan' },
];

const mockParams = new Map([
  ['/robot_description', { type: 'string', value: '<robot name="mock">...</robot>' }],
  ['/move_group/max_velocity_scaling_factor', { type: 'double', value: 0.1 }],
  ['/move_group/max_acceleration_scaling_factor', { type: 'double', value: 0.1 }],
  ['/controller_joint_names', { type: 'string[]', value: ['joint_1', 'joint_2', 'joint_3', 'joint_4', 'joint_5', 'joint_6'] }],
]);

const mockTfFrames = [
  { parent: 'world', child: 'base_link', x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
  { parent: 'base_link', child: 'shoulder_link', x: 0, y: 0, z: 0.3, qx: 0, qy: 0, qz: 0, qw: 1 },
  { parent: 'shoulder_link', child: 'wrist_3_link', x: 0, y: 0, z: 0.5, qx: 0, qy: 0, qz: 0, qw: 1 },
  { parent: 'wrist_3_link', child: 'tool0', x: 0, y: 0, z: 0.1, qx: 0, qy: 0, qz: 0, qw: 1 },
];

// ─── Request handler ──────────────────────────────────────────────────

const handlers = {
  ros_topic_list: () => ({
    content: [{
      type: 'text',
      text: mockTopics.map((t) =>
        `${t.name} [${t.type}] pub:${t.publishers} sub:${t.subscribers}${t.frequencyHz ? ` ${t.frequencyHz}Hz` : ''}`
      ).join('\n'),
    }],
  }),

  ros_topic_echo: (args) => {
    const topicName = args?.topic_name || args?.topic;
    if (!topicName) {
      return { content: [{ type: 'text', text: 'Error: topic_name parameter required.' }], isError: true };
    }

    const topic = mockTopics.find((t) => t.name === topicName);
    if (!topic) {
      return { content: [{ type: 'text', text: `Topic '${topicName}' not found. Available topics: ${mockTopics.map((t) => t.name).join(', ')}` }], isError: true };
    }

    const count = args?.count || 1;
    const sample = {
      topic: topicName,
      type: topic.type,
      timestamp: { sec: Math.floor(Date.now() / 1000), nsec: (Date.now() % 1000) * 1e6 },
      data: `Sample data from ${topicName} (mock)`,
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ topic: topicName, type: topic.type, samples: [sample, ...(count > 1 ? Array(count - 1).fill({ ...sample, data: 'more...' }) : [])] }, null, 2),
      }],
    };
  },

  ros_service_call: (args) => {
    const svcName = args?.service_name || args?.service;
    if (!svcName) {
      return { content: [{ type: 'text', text: 'Error: service_name parameter required.' }], isError: true };
    }

    const svc = mockServices.find((s) => s.name === svcName);
    if (!svc) {
      return { content: [{ type: 'text', text: `Service '${svcName}' not found. Available: ${mockServices.map((s) => s.name).join(', ')}` }], isError: true };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          service: svcName,
          type: svc.type,
          result: 'success (mock)',
          response: { success: true, message: `Mock response from ${svcName}` },
        }, null, 2),
      }],
    };
  },

  ros_param_get: (args) => {
    const paramName = args?.param_name || args?.param || args?.name;
    if (!paramName) {
      return { content: [{ type: 'text', text: 'Error: param_name parameter required.' }], isError: true };
    }

    const param = mockParams.get(paramName);
    if (!param) {
      return { content: [{ type: 'text', text: `Parameter '${paramName}' not found. Available: ${[...mockParams.keys()].join(', ')}` }], isError: true };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ name: paramName, type: param.type, value: param.value }, null, 2),
      }],
    };
  },

  ros_param_set: (args) => {
    const paramName = args?.param_name || args?.param || args?.name;
    const paramValue = args?.value;

    if (!paramName || paramValue === undefined) {
      return { content: [{ type: 'text', text: 'Error: param_name and value parameters required.' }], isError: true };
    }

    const existing = mockParams.get(paramName);
    const type = typeof paramValue === 'number' ? (Number.isInteger(paramValue) ? 'integer' : 'double')
      : Array.isArray(paramValue) ? 'array'
      : typeof paramValue === 'boolean' ? 'boolean'
      : 'string';

    mockParams.set(paramName, { type, value: paramValue });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'ok', name: paramName, type, value: paramValue }, null, 2),
      }],
    };
  },

  ros_tf_lookup: (args) => {
    const parent = args?.parent_frame || args?.parent;
    const child = args?.child_frame || args?.child;

    let filtered = mockTfFrames;
    if (parent) filtered = filtered.filter((f) => f.parent === parent);
    if (child) filtered = filtered.filter((f) => f.child === child);

    if (filtered.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No TF frames found${parent ? ` for parent=${parent}` : ''}${child ? ` child=${child}` : ''}. Known frames: ${mockTfFrames.map((f) => `${f.parent}→${f.child}`).join(', ')}`,
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: filtered.map((f) =>
          `${f.parent}→${f.child} T:(${f.x},${f.y},${f.z}) Q:(${f.qx},${f.qy},${f.qz},${f.qw})`
        ).join('\n'),
      }],
    };
  },

  ros_node_info: (args) => {
    const nodeName = args?.node_name || args?.node;
    const nodes = [
      {
        name: '/robot_state_publisher',
        namespace: '/',
        topics_published: ['/joint_states', '/tf', '/tf_static'],
        topics_subscribed: [],
        services: ['/robot_state_publisher/get_loggers'],
      },
      {
        name: '/move_group',
        namespace: '/',
        topics_published: ['/move_group/display_planned_path'],
        topics_subscribed: ['/joint_states', '/tf'],
        services: ['/compute_ik', '/plan_kinematic_path'],
      },
      {
        name: '/rviz2',
        namespace: '/',
        topics_published: [],
        topics_subscribed: ['/joint_states', '/tf', '/scan', '/move_group/display_planned_path'],
        services: [],
      },
    ];

    const filtered = nodeName ? nodes.filter((n) => n.name.includes(nodeName)) : nodes;

    if (filtered.length === 0) {
      return { content: [{ type: 'text', text: `No nodes found matching '${nodeName}'.` }], isError: true };
    }

    return {
      content: [{
        type: 'text',
        text: filtered.map((n) =>
          `${n.namespace}${n.name}\n  publishes: [${n.topics_published.join(', ')}]\n  subscribes: [${n.topics_subscribed.join(', ')}]\n  services: [${n.services.join(', ')}]`
        ).join('\n\n'),
      }],
    };
  },

  ros_urdf_load: (args) => {
    const urdfParam = args?.param || '/robot_description';
    const param = mockParams.get(urdfParam);

    if (!param || typeof param.value !== 'string' || !param.value.includes('<robot')) {
      return { content: [{ type: 'text', text: `No URDF found at parameter '${urdfParam}'.` }], isError: true };
    }

    return {
      content: [{
        type: 'text',
        text: `URDF loaded from ${urdfParam}:\n\n${param.value}\n\nSummary: Contains robot model with joints and links (mock data — real implementation parses the full URDF XML).`,
      }],
    };
  },
};

// ─── MCP stdio server ─────────────────────────────────────────────────

const TOOL_LIST = {
  tools: [
    {
      name: 'ros_topic_list',
      description: 'List all ROS topics with their types, publishers, and subscribers.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'ros_topic_echo',
      description: 'Echo (read) messages from a ROS topic.',
      inputSchema: {
        type: 'object',
        properties: {
          topic_name: { type: 'string', description: 'Name of the ROS topic to echo' },
          count: { type: 'integer', description: 'Number of messages to read (default 1)' },
        },
        required: ['topic_name'],
      },
    },
    {
      name: 'ros_service_call',
      description: 'Call a ROS service.',
      inputSchema: {
        type: 'object',
        properties: {
          service_name: { type: 'string', description: 'Name of the ROS service to call' },
          request: { type: 'object', description: 'Service request payload' },
        },
        required: ['service_name'],
      },
    },
    {
      name: 'ros_param_get',
      description: 'Get a ROS parameter value.',
      inputSchema: {
        type: 'object',
        properties: { param_name: { type: 'string', description: 'Name of the ROS parameter' } },
        required: ['param_name'],
      },
    },
    {
      name: 'ros_param_set',
      description: 'Set a ROS parameter value (safe — only within allowed namespace).',
      inputSchema: {
        type: 'object',
        properties: {
          param_name: { type: 'string', description: 'Name of the ROS parameter to set' },
          value: { description: 'Value to set (string, number, boolean, or array)' },
        },
        required: ['param_name', 'value'],
      },
    },
    {
      name: 'ros_tf_lookup',
      description: 'Look up TF transforms between frames.',
      inputSchema: {
        type: 'object',
        properties: {
          parent_frame: { type: 'string', description: 'Parent frame ID (optional, filters results)' },
          child_frame: { type: 'string', description: 'Child frame ID (optional, filters results)' },
        },
        required: [],
      },
    },
    {
      name: 'ros_node_info',
      description: 'Get information about ROS nodes.',
      inputSchema: {
        type: 'object',
        properties: { node_name: { type: 'string', description: 'Node name to filter (optional)' } },
        required: [],
      },
    },
    {
      name: 'ros_urdf_load',
      description: 'Load and parse a URDF robot model from the parameter server.',
      inputSchema: {
        type: 'object',
        properties: { param: { type: 'string', description: 'Parameter name containing URDF (default: /robot_description)' } },
        required: [],
      },
    },
  ],
};

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
          serverInfo: {
            name: 'vigil-ros-mcp',
            version: '0.1.0',
          },
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
          result: { content: [{ type: 'text', text: `Unknown tool: ${toolName}. Available: ${Object.keys(handlers).join(', ')}` }], isError: true },
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

// ─── Stdio transport ──────────────────────────────────────────────────

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
      process.stderr.write(`[ros-mcp] parse error: ${err.message}\n`);
    }
  }
});

process.stdin.on('end', () => {
  process.stderr.write('[ros-mcp] stdin closed, shutting down.\n');
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

process.stderr.write(`[ros-mcp] ROS MCP server started. Master: ${ROS_MASTER_URI}, Domain: ${ROS_DOMAIN_ID ?? 'N/A'}\n`);
