/**
 * Full text-to-action pipeline for LLM-based autonomous robotics.
 *
 * ⚠️ CONCEPT: Protocol definition and parser. No hardware actuation code.
 * A real implementation needs ROS action clients, motor controller
 * interfaces (ros2_control, libfranka, RTDE), and real-time comms.
 *
 * The LLM outputs text. That text must be parsed into structured actuator
 * commands that physical robots can execute. This module provides the
 * complete translation layer: a structured protocol format parsable from
 * LLM output, command types for every common actuator class, validation
 * against platform capabilities, and result tracking.
 *
 * Protocol format: ACTUATE:<robot>.<part>:<action>(param1=val1,param2=val2)
 *
 * @module robotics/actuator
 */

// ─── Core actuator types ──────────────────────────────────────────────

export interface ActuatorCommand {
  actuatorId: string;
  actuatorType:
    | 'joint'
    | 'gripper'
    | 'mobile_base'
    | 'head'
    | 'pan_tilt'
    | 'led'
    | 'display'
    | 'speaker'
    | 'audio_output'
    | 'tool_io'
    | 'camera_trigger'
    | 'cartesian'
    | 'custom';
  action: string;
  parameters: Record<string, number | string | boolean>;
  priority: 'immediate' | 'queued' | 'background';
  timeoutMs?: number;
}

export interface ActuatorResult {
  command: ActuatorCommand;
  success: boolean;
  timestamp: number;
  elapsedMs: number;
  error?: string;
  feedback?: Record<string, number>;
}

export interface ActuatorCapabilities {
  actuatorId: string;
  supportedActions: string[];
  paramRanges: Record<string, { min: number; max: number; step?: number }>;
  maxVelocity: number;
  maxForce: number;
  maxAcceleration: number;
}

// ─── Joint commands ───────────────────────────────────────────────────

export interface JointPositionCommand {
  jointName: string;
  targetPositionRad: number;
  velocityRadPs?: number;
}

export interface JointVelocityCommand {
  jointName: string;
  targetVelocityRadPs: number;
  accelerationRadPs2?: number;
}

export interface JointTorqueCommand {
  jointName: string;
  torqueNm: number;
}

// ─── Cartesian commands ───────────────────────────────────────────────

export interface CartesianPoseCommand {
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
  frameId: string;
}

export interface CartesianVelocityCommand {
  linearX: number;
  linearY: number;
  linearZ: number;
  angularX: number;
  angularY: number;
  angularZ: number;
  frameId: string;
  durationMs: number;
}

export interface CartesianTrajectoryCommand {
  waypoints: CartesianPoseCommand[];
  velocityScaling: number;
  accelerationScaling: number;
  blendRadius: number;
}

// ─── Gripper commands ─────────────────────────────────────────────────

export interface GripperCommand {
  action: 'open' | 'close' | 'grasp' | 'release' | 'set_position' | 'set_force';
  position?: number;
  force?: number;
  speed?: number;
  width?: number;
}

// ─── Mobile base commands ─────────────────────────────────────────────

export interface MobileBaseCommand {
  linearX: number;
  linearY: number;
  angularZ: number;
  durationMs?: number;
}

// ─── Head / Pan-Tilt ──────────────────────────────────────────────────

export interface PanTiltCommand {
  panRad: number;
  tiltRad: number;
  velocityRadPs?: number;
}

// ─── Tool I/O ─────────────────────────────────────────────────────────

export interface ToolIOCommand {
  port: number;
  type: 'digital_out' | 'analog_out' | 'pwm' | 'digital_in' | 'analog_in';
  value?: number | boolean;
  frequencyHz?: number;
  dutyCycle?: number;
}

// ─── Camera trigger ───────────────────────────────────────────────────

export interface CameraTriggerCommand {
  cameraId: string;
  action: 'capture' | 'start_stream' | 'stop_stream' | 'set_exposure' | 'set_gain';
  params?: Record<string, number>;
}

// ─── LED / Display commands ───────────────────────────────────────────

export interface LedCommand {
  ledId: string;
  pattern: 'solid' | 'blink' | 'pulse' | 'rainbow' | 'off';
  color?: { r: number; g: number; b: number };
  durationMs?: number;
  frequencyHz?: number;
}

export interface DisplayCommand {
  displayId: string;
  content: string;
  durationMs?: number;
  scrollSpeed?: number;
}

// ─── Audio / Speech ───────────────────────────────────────────────────

export interface SpeechCommand {
  text: string;
  voice?: string;
  volume?: number;
  language?: string;
}

// ─── Protocol parser ──────────────────────────────────────────────────

const ACTION_PATTERN = /ACTUATE:(\w+)\.(\w+):(\w+)\(([^)]*)\)/g;

function parseParams(paramsStr: string): Record<string, number | string | boolean> {
  const params: Record<string, number | string | boolean> = {};
  if (!paramsStr.trim()) return params;

  for (const pair of paramsStr.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const rawVal = pair.slice(eq + 1).trim();
    if (!key) continue;

    if (rawVal === 'true') params[key] = true;
    else if (rawVal === 'false') params[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(rawVal)) params[key] = parseFloat(rawVal);
    else params[key] = rawVal.replace(/^"|"$/g, '');
  }
  return params;
}

/**
 * Parses LLM-generated text for actuator commands using the structured
 * ACTUATE protocol format. Returns all valid commands found in the text.
 */
export function parseActionFromText(text: string): ActuatorCommand[] {
  const commands: ActuatorCommand[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(ACTION_PATTERN.source, ACTION_PATTERN.flags);
  while ((match = regex.exec(text)) !== null) {
    const [, robot, part, action, paramsStr] = match;
    commands.push({
      actuatorId: `${robot}.${part}`,
      actuatorType: inferActuatorType(part, action),
      action,
      parameters: parseParams(paramsStr),
      priority: 'queued',
    });
  }
  return commands;
}

function inferActuatorType(
  part: string,
  action: string
): ActuatorCommand['actuatorType'] {
  if (/^(joint|arm|shoulder|elbow|wrist|hip|knee|ankle)/i.test(part)) return 'joint';
  if (/^(gripper|grip|hand|finger)/i.test(part)) return 'gripper';
  if (/^(base|mobile|chassis|wheels?|tracks?)/i.test(part)) return 'mobile_base';
  if (/^(head|neck|pan|tilt|ptu)/i.test(part)) return 'pan_tilt';
  if (/^(led|light|indicator)/i.test(part)) return 'led';
  if (/^(display|screen|monitor)/i.test(part)) return 'display';
  if (/^(speaker|audio|voice|sound)/i.test(part)) return 'speaker';
  if (/^(tool|io|gpio|dout|aout|pwm)/i.test(part)) return 'tool_io';
  if (/^(cam|camera)/i.test(part)) return 'camera_trigger';
  if (/^(cartesian|ee|end_effector|tcp)/i.test(part)) return 'cartesian';
  return 'custom';
}

// ─── Command builders ─────────────────────────────────────────────────

export function buildJointPositionCommand(jointName: string, targetRad: number, velocity?: number): ActuatorCommand {
  const params: Record<string, number | string | boolean> = { position: targetRad };
  if (velocity !== undefined) params.velocity = velocity;
  return {
    actuatorId: `arm.${jointName}`,
    actuatorType: 'joint',
    action: 'move_joint',
    parameters: params,
    priority: 'queued',
  };
}

export function buildJointVelocityCommand(jointName: string, velocityRadPs: number, acceleration?: number): ActuatorCommand {
  const params: Record<string, number | string | boolean> = { velocity: velocityRadPs };
  if (acceleration !== undefined) params.acceleration = acceleration;
  return {
    actuatorId: `arm.${jointName}`,
    actuatorType: 'joint',
    action: 'move_velocity',
    parameters: params,
    priority: 'queued',
  };
}

export function buildGripperCommand(action: 'open' | 'close' | 'grasp' | 'release', width?: number, force?: number): ActuatorCommand {
  const params: Record<string, number | string | boolean> = {};
  if (width !== undefined) params.width = width;
  if (force !== undefined) params.force = force;
  return {
    actuatorId: 'arm.gripper',
    actuatorType: 'gripper',
    action,
    parameters: params,
    priority: 'immediate',
  };
}

export function buildMobileBaseCommand(linearX: number, linearY: number, angularZ: number, durationMs?: number): ActuatorCommand {
  const params: Record<string, number | string | boolean> = {
    linear_x: linearX,
    linear_y: linearY,
    angular_z: angularZ,
  };
  if (durationMs !== undefined) params.duration_ms = durationMs;
  return {
    actuatorId: 'base.mobile',
    actuatorType: 'mobile_base',
    action: 'cmd_vel',
    parameters: params,
    priority: 'queued',
  };
}

export function buildCartesianPoseCommand(pose: CartesianPoseCommand): ActuatorCommand {
  return {
    actuatorId: 'arm.cartesian',
    actuatorType: 'cartesian',
    action: 'move_pose',
    parameters: {
      x: pose.x,
      y: pose.y,
      z: pose.z,
      roll: pose.roll,
      pitch: pose.pitch,
      yaw: pose.yaw,
      frame_id: pose.frameId,
    },
    priority: 'queued',
  };
}

export function buildSpeechCommand(text: string, voice?: string, volume?: number): ActuatorCommand {
  const params: Record<string, number | string | boolean> = { text };
  if (voice) params.voice = voice;
  if (volume !== undefined) params.volume = volume;
  return {
    actuatorId: 'audio.speaker',
    actuatorType: 'speaker',
    action: 'speak',
    parameters: params,
    priority: 'background',
  };
}

export function buildToolIOCommand(port: number, type: ToolIOCommand['type'], value?: number | boolean): ActuatorCommand {
  const params: Record<string, number | string | boolean> = { port, io_type: type };
  if (value !== undefined) params.value = value;
  return {
    actuatorId: `tool.${type}`,
    actuatorType: 'tool_io',
    action: 'set_io',
    parameters: params,
    priority: 'queued',
  };
}

// ─── Validation ───────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateCommand(
  command: ActuatorCommand,
  capabilities: ActuatorCapabilities
): ValidationResult {
  const result: ValidationResult = { valid: true, errors: [], warnings: [] };

  if (command.actuatorId !== capabilities.actuatorId) {
    if (!command.actuatorId.startsWith(capabilities.actuatorId + '.')) {
      result.errors.push(`Actuator ID mismatch: command=${command.actuatorId}, capability=${capabilities.actuatorId}`);
    }
  }

  if (!capabilities.supportedActions.includes(command.action)) {
    result.errors.push(`Unsupported action '${command.action}' for actuator '${command.actuatorId}'. Supported: ${capabilities.supportedActions.join(', ')}`);
  }

  for (const [key, value] of Object.entries(command.parameters)) {
    if (typeof value !== 'number') continue;
    const range = capabilities.paramRanges[key];
    if (!range) {
      result.warnings.push(`Parameter '${key}' is not declared in capabilities, cannot validate range.`);
      continue;
    }
    if (value < range.min || value > range.max) {
      result.errors.push(
        `Parameter '${key}' = ${value} out of range [${range.min}, ${range.max}] for actuator '${command.actuatorId}'.`
      );
    }
  }

  result.valid = result.errors.length === 0;
  return result;
}

export function validateCommands(
  commands: ActuatorCommand[],
  capabilities: ActuatorCapabilities[]
): ValidationResult[] {
  const capMap = new Map(capabilities.map((c) => [c.actuatorId, c]));
  return commands.map((cmd) => {
    const cap = capMap.get(cmd.actuatorId);
    if (!cap) {
      return {
        valid: false,
        errors: [`No capabilities registered for actuator '${cmd.actuatorId}'.`],
        warnings: [],
      };
    }
    return validateCommand(cmd, cap);
  });
}

// ─── Command serialization ────────────────────────────────────────────

export function commandToProtocolText(cmd: ActuatorCommand): string {
  const params = Object.entries(cmd.parameters)
    .map(([k, v]) => (typeof v === 'string' ? `${k}="${v}"` : `${k}=${v}`))
    .join(',');
  return `ACTUATE:${cmd.actuatorId}:${cmd.action}(${params})`;
}

export function commandsToProtocolText(cmds: ActuatorCommand[]): string {
  return cmds.map(commandToProtocolText).join('\n');
}
