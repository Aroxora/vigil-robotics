/**
 * ROS 1/2 integration layer for LLM-based autonomous robotics.
 *
 * ⚠️ CONCEPT: Type definitions for ROS graph state. No rclnodejs/rosnodejs
 * dependency. No actual ROS node. A real implementation needs a Python/C++
 * ROS 2 node that serializes topic data to JSON for the MCP bridge.
 *
 * Provides abstractions over ROS topics, services, actions, parameters,
 * TF2 transforms, URDF models, and ROS bags. Includes text translation
 * functions that convert ROS graph state into LLM-readable text context,
 * enabling the LLM to reason about the ROS ecosystem.
 *
 * @module robotics/ros
 */

// ─── QoS ──────────────────────────────────────────────────────────────

export interface RosQos {
  reliability: 'reliable' | 'best_effort';
  durability: 'volatile' | 'transient_local' | 'transient';
  history: 'keep_last' | 'keep_all';
  depth: number;
  lifespan?: number;
}

export const DEFAULT_QOS: RosQos = {
  reliability: 'reliable',
  durability: 'volatile',
  history: 'keep_last',
  depth: 10,
};

// ─── Topic ────────────────────────────────────────────────────────────

export interface RosTopic {
  name: string;
  messageType: string;
  qos: RosQos;
  latch: boolean;
  publishers: number;
  subscribers: number;
  frequencyHz?: number;
  bandwidthBytesPerSec?: number;
}

// ─── Service ──────────────────────────────────────────────────────────

export interface RosService {
  name: string;
  serviceType: string;
  timeoutMs: number;
}

// ─── Action ───────────────────────────────────────────────────────────

export interface RosAction {
  name: string;
  actionType: string;
  feedbackRateHz: number;
  active: boolean;
  state?: 'pending' | 'active' | 'preempted' | 'succeeded' | 'aborted' | 'rejected';
  progress?: number;
}

// ─── Node ─────────────────────────────────────────────────────────────

export interface RosNode {
  name: string;
  namespace: string;
  topicsSubscribed: string[];
  topicsPublished: string[];
  servicesProvided: string[];
  servicesUsed: string[];
  actionsProvided: string[];
  actionsUsed: string[];
}

// ─── Parameter ────────────────────────────────────────────────────────

export interface RosParam {
  name: string;
  type: 'string' | 'integer' | 'double' | 'boolean' | 'array' | 'struct';
  value: unknown;
  defaultValue?: unknown;
  description?: string;
  readOnly: boolean;
}

// ─── TF2 ──────────────────────────────────────────────────────────────

export interface TfTransform {
  parentFrame: string;
  childFrame: string;
  translation: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  timestamp: number;
}

export interface TfTree {
  transforms: TfTransform[];
  timestamp: number;
}

// ─── URDF ──────────────────────────────────────────────────────────────

export interface RobotLink {
  name: string;
  mass: number;
  inertia: { ixx: number; ixy: number; ixz: number; iyy: number; iyz: number; izz: number };
  visual?: { geometry: string; material?: { color: [number, number, number, number] } };
  collision?: { geometry: string };
}

export interface RobotJoint {
  name: string;
  type: 'revolute' | 'continuous' | 'prismatic' | 'fixed' | 'floating' | 'planar';
  parent: string;
  child: string;
  origin: { xyz: [number, number, number]; rpy: [number, number, number] };
  axis: [number, number, number];
  limits?: { lower: number; upper: number; effort: number; velocity: number };
}

export interface RobotModel {
  name: string;
  links: RobotLink[];
  joints: RobotJoint[];
  rootLink: string;
  endEffectors: { name: string; parentLink: string }[];
}

// ─── ROS Bag ──────────────────────────────────────────────────────────

export interface RosbagConfig {
  path: string;
  topics: string[];
  record: boolean;
  play: boolean;
  playSpeed: number;
  loop: boolean;
}

// ─── ROS Graph Context ────────────────────────────────────────────────

export interface RosGraphContext {
  rosVersion: 'ros1' | 'ros2';
  masterUri?: string;
  domainId?: number;
  nodes: RosNode[];
  topics: RosTopic[];
  services: RosService[];
  actions: RosAction[];
  tfTree?: TfTree;
  robotModel?: RobotModel;
  parameters: RosParam[];
  timestamp: number;
}

// ─── Text translators ─────────────────────────────────────────────────

export function tfTransformToText(tf: TfTransform): string {
  const t = tf.translation;
  const r = tf.rotation;
  return `${tf.parentFrame}→${tf.childFrame} T:(${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(3)}) Q:(${r.x.toFixed(3)},${r.y.toFixed(3)},${r.z.toFixed(3)},${r.w.toFixed(3)})`;
}

export function buildTfContext(tree: TfTree): string {
  if (tree.transforms.length === 0) return 'TF tree: empty (no transforms available).';
  const lines = [`TF transforms (${tree.transforms.length}):`];
  for (const tf of tree.transforms) {
    lines.push(`  ${tfTransformToText(tf)}`);
  }
  return lines.join('\n');
}

export function robotJointToText(joint: RobotJoint): string {
  let lim = '';
  if (joint.limits) {
    lim = ` limits:[${joint.limits.lower.toFixed(3)},${joint.limits.upper.toFixed(3)}] vel:${joint.limits.velocity.toFixed(3)} eff:${joint.limits.effort.toFixed(1)}`;
  }
  return `${joint.name}[${joint.type}] ${joint.parent}→${joint.child} origin:(${joint.origin.xyz.join(',')}) rpy:(${joint.origin.rpy.join(',')}) axis:(${joint.axis.join(',')})${lim}`;
}

export function urdfToRobotModel(
  name: string,
  links: RobotLink[],
  joints: RobotJoint[],
  endEffectors: { name: string; parentLink: string }[]
): RobotModel {
  const rootLink = links[0]?.name ?? 'base_link';
  return { name, links, joints, rootLink, endEffectors };
}

export function urdfSummaryText(model: RobotModel): string {
  const lines = [
    `ROBOT: ${model.name} (${model.links.length} links, ${model.joints.length} joints)`,
    `  Root: ${model.rootLink}`,
    `  End effectors: ${model.endEffectors.map((e) => `${e.name}@${e.parentLink}`).join(', ')}`,
    `  Joints:`,
  ];
  for (const j of model.joints) {
    lines.push(`    ${robotJointToText(j)}`);
  }
  return lines.join('\n');
}

export function rosTopicToText(topic: RosTopic): string {
  return `${topic.name} [${topic.messageType}] pub:${topic.publishers} sub:${topic.subscribers} ${topic.latch ? 'LATCHED' : ''}${topic.frequencyHz ? ` ${topic.frequencyHz.toFixed(1)}Hz` : ''}`;
}

export function rosNodeToText(node: RosNode): string {
  return `${node.namespace}${node.name} publish:[${node.topicsPublished.join(',')}] subscribe:[${node.topicsSubscribed.join(',')}] services:[${node.servicesProvided.join(',')}]`;
}

export function rosParamToText(param: RosParam): string {
  return `${param.name}: ${param.type} = ${JSON.stringify(param.value)}${param.readOnly ? ' [RO]' : ''}${param.description ? ` — ${param.description}` : ''}`;
}

/**
 * Builds a comprehensive LLM-readable text context from the ROS graph state.
 * Includes nodes, topics, services, actions, TF tree, URDF model, and parameters.
 */
export function toRosContext(ctx: RosGraphContext): string {
  const lines: string[] = [];

  lines.push(`=== ROS${ctx.rosVersion === 'ros2' ? '2' : '1'} GRAPH STATE @ ${new Date(ctx.timestamp).toISOString()} ===`);
  if (ctx.rosVersion === 'ros1' && ctx.masterUri) lines.push(`Master URI: ${ctx.masterUri}`);
  if (ctx.rosVersion === 'ros2' && ctx.domainId !== undefined) lines.push(`Domain ID: ${ctx.domainId}`);

  lines.push(`\nTopology: ${ctx.nodes.length} nodes, ${ctx.topics.length} topics, ${ctx.services.length} services, ${ctx.actions.length} actions`);

  if (ctx.nodes.length > 0) {
    lines.push('\n--- Nodes ---');
    for (const n of ctx.nodes) lines.push(rosNodeToText(n));
  }

  if (ctx.topics.length > 0) {
    lines.push('\n--- Topics ---');
    for (const t of ctx.topics) lines.push(`  ${rosTopicToText(t)}`);
  }

  if (ctx.services.length > 0) {
    lines.push('\n--- Services ---');
    for (const s of ctx.services) lines.push(`  ${s.name} [${s.serviceType}] timeout:${s.timeoutMs}ms`);
  }

  if (ctx.actions.length > 0) {
    lines.push('\n--- Actions ---');
    for (const a of ctx.actions) {
      lines.push(`  ${a.name} [${a.actionType}] fb:${a.feedbackRateHz}Hz state:${a.state ?? 'idle'}`);
    }
  }

  if (ctx.tfTree) {
    lines.push('\n--- TF Tree ---');
    lines.push(buildTfContext(ctx.tfTree));
  }

  if (ctx.robotModel) {
    lines.push('\n--- URDF Model ---');
    lines.push(urdfSummaryText(ctx.robotModel));
  }

  if (ctx.parameters.length > 0) {
    lines.push('\n--- Parameters ---');
    for (const p of ctx.parameters) lines.push(`  ${rosParamToText(p)}`);
  }

  return lines.join('\n');
}
