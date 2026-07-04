/**
 * Public API: actuator command tools for the agent.
 *
 * These functions are exposed as tools that the LLM can invoke to execute
 * actuator commands. Each function validates the command against platform
 * capabilities and safety constraints before execution.
 *
 * @module tools/public/actuate
 */

import {
  type ActuatorCommand,
  type ActuatorResult,
  type GripperCommand,
  type MobileBaseCommand,
  type CartesianPoseCommand,
  parseActionFromText,
  buildJointPositionCommand,
  buildGripperCommand,
  buildMobileBaseCommand,
  buildCartesianPoseCommand,
  commandToProtocolText,
} from '../../robotics/actuator.js';
import {
  type PlatformCapabilities,
  capabilityCheck,
} from '../../robotics/hardware.js';

/**
 * Execute raw actuator commands from text (LLM output).
 * Parses ACTUATE: protocol and validates against platform capabilities.
 */
export function executeActuatorCommands(
  text: string,
  platformCapabilities?: PlatformCapabilities
): { commands: ActuatorCommand[]; valid: boolean; checks: string[] } {
  const commands = parseActionFromText(text);
  const checks: string[] = [];

  if (commands.length === 0) {
    return { commands: [], valid: false, checks: ['No actuator commands found in text.'] };
  }

  let allValid = true;
  if (platformCapabilities) {
    for (const cmd of commands) {
      const result = capabilityCheck(platformCapabilities, cmd.action, cmd.parameters);
      for (const c of result.checks) {
        checks.push(`[${c.name}] ${c.message}`);
      }
      if (!result.valid) allValid = false;
    }
  }

  return { commands, valid: allValid, checks };
}

/**
 * Execute a single joint position command.
 */
export function executeJointCommand(
  jointName: string,
  targetRad: number,
  velocity?: number,
  platformCapabilities?: PlatformCapabilities
): { command: ActuatorCommand; valid: boolean; message: string } {
  const cmd = buildJointPositionCommand(jointName, targetRad, velocity);

  if (platformCapabilities) {
    const check = capabilityCheck(platformCapabilities, cmd.action, cmd.parameters);
    return {
      command: cmd,
      valid: check.valid,
      message: check.checks.map((c) => c.message).join('; '),
    };
  }

  return {
    command: cmd,
    valid: true,
    message: `Joint ${jointName} → ${targetRad.toFixed(3)} rad.`,
  };
}

/**
 * Execute a joint space or Cartesian trajectory.
 */
export function executeTrajectory(
  trajectoryType: 'joint' | 'cartesian',
  waypoints: Record<string, number>[],
  durationMs: number,
  platformCapabilities?: PlatformCapabilities
): { text: string; valid: boolean; checks: string[] } {
  const points = waypoints.map((wp, i) => {
    const timeFromStart = (i / waypoints.length) * (durationMs / 1000);
    return { ...wp, timeFromStart };
  });

  const text = `EXECUTE_TRAJECTORY:${trajectoryType} waypoints:${waypoints.length} duration:${durationMs}ms\n` +
    points.map((p, i) => {
      const params = Object.entries(p)
        .filter(([k]) => k !== 'timeFromStart')
        .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(3) : v}`)
        .join(',');
      return `  [${i}] t=${p.timeFromStart.toFixed(3)}s ${params}`;
    }).join('\n');

  const checks: string[] = [];
  if (platformCapabilities) {
    for (const wp of waypoints) {
      for (const [key, val] of Object.entries(wp)) {
        if (typeof val === 'number' && key === 'velocity' && Math.abs(val) > platformCapabilities.maxJointVelocityRadPs) {
          checks.push(`WARNING: velocity ${val} exceeds platform max ${platformCapabilities.maxJointVelocityRadPs}`);
        }
      }
    }
  }

  return { text, valid: true, checks };
}

/**
 * Control the gripper (open, close, grasp, release).
 */
export function controlGripper(
  action: 'open' | 'close' | 'grasp' | 'release',
  width?: number,
  force?: number,
  platformCapabilities?: PlatformCapabilities
): { command: ActuatorCommand; valid: boolean; message: string } {
  const cmd = buildGripperCommand(action, width, force);

  if (platformCapabilities) {
    const check = capabilityCheck(platformCapabilities, cmd.action, cmd.parameters);
    return {
      command: cmd,
      valid: check.valid,
      message: check.checks.map((c) => c.message).join('; '),
    };
  }

  return {
    command: cmd,
    valid: true,
    message: `Gripper → ${action}${width !== undefined ? ` width:${width.toFixed(1)}mm` : ''}`,
  };
}

/**
 * Command the mobile base with cmd_vel style velocity control.
 */
export function moveBase(
  linearX: number,
  linearY: number,
  angularZ: number,
  durationMs?: number,
  platformCapabilities?: PlatformCapabilities
): { command: ActuatorCommand; valid: boolean; message: string } {
  const cmd = buildMobileBaseCommand(linearX, linearY, angularZ, durationMs);

  if (platformCapabilities) {
    const speed = Math.sqrt(linearX ** 2 + linearY ** 2);
    const checks: string[] = [];

    if (speed > platformCapabilities.maxVelocityMps) {
      checks.push(`Velocity ${speed.toFixed(2)} m/s exceeds max ${platformCapabilities.maxVelocityMps} m/s`);
    }

    if (Math.abs(angularZ) > platformCapabilities.maxJointVelocityRadPs) {
      checks.push(`Angular velocity ${angularZ.toFixed(2)} rad/s exceeds max ${platformCapabilities.maxJointVelocityRadPs} rad/s`);
    }

    return {
      command: cmd,
      valid: checks.length === 0,
      message: checks.length > 0 ? checks.join('; ') : `Base moving at [${linearX},${linearY},${angularZ}]`,
    };
  }

  return {
    command: cmd,
    valid: true,
    message: `Base cmd_vel: linear(${linearX},${linearY}) angular(${angularZ})`,
  };
}

/**
 * Set the end effector to a target Cartesian pose.
 */
export function setEndEffector(
  x: number,
  y: number,
  z: number,
  roll: number,
  pitch: number,
  yaw: number,
  frameId: string = 'base_link',
  platformCapabilities?: PlatformCapabilities
): { command: ActuatorCommand; valid: boolean; message: string } {
  const cmd = buildCartesianPoseCommand({ x, y, z, roll, pitch, yaw, frameId });

  if (platformCapabilities) {
    const dist = Math.sqrt(x ** 2 + y ** 2 + z ** 2);
    if (dist > platformCapabilities.reachM) {
      return {
        command: cmd,
        valid: false,
        message: `Target distance ${dist.toFixed(2)}m exceeds platform reach ${platformCapabilities.reachM}m`,
      };
    }
  }

  return {
    command: cmd,
    valid: true,
    message: `End effector → (${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}) RPY:(${roll.toFixed(2)},${pitch.toFixed(2)},${yaw.toFixed(2)}) [${frameId}]`,
  };
}

export { type ActuatorCommand, type ActuatorResult, type GripperCommand, type MobileBaseCommand, type CartesianPoseCommand };
