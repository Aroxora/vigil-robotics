/**
 * Hardware abstraction layer for LLM-based autonomous robotics.
 *
 * Provides platform-agnostic representations of robot platforms (Spot,
 * Atlas, UR5e, UR10e, KUKA iiwa, ABB GoFa, Franka Panda, Kinova Gen3, etc.),
 * their manipulators, mobile bases, end effectors, and sensor suites.
 * Includes platform capability checking to validate actuator commands
 * against hardware limits before execution.
 *
 * @module robotics/hardware
 */

// ─── Platform Types ───────────────────────────────────────────────────

export type RobotPlatformType =
  | 'spot'
  | 'atlas'
  | 'ur5e'
  | 'ur10e'
  | 'kuka_iiwa'
  | 'kuka_iiwa_7'
  | 'kuka_iiwa_14'
  | 'abb_gofa'
  | 'abb_gofa_5'
  | 'abb_gofa_10'
  | 'franka_panda'
  | 'kinova_gen3'
  | 'kinova_gen3_lite'
  | 'custom';

// ─── Manipulator ──────────────────────────────────────────────────────

export interface Manipulator {
  name: string;
  numJoints: number;
  reachM: number;
  payloadKg: number;
  maxJointVelocityRadPs: number[];
  maxJointAccelerationRadPs2: number[];
  maxEndEffectorVelocityMps: number;
  ikSolverType: 'analytic' | 'numerical' | 'lma' | 'trac_ik' | 'custom';
  selfCollisionPairs: [string, string][];
  mountingFrame: string;
}

// ─── Mobile Base ──────────────────────────────────────────────────────

export type MobileBaseType = 'differential' | 'omnidirectional' | 'ackermann' | 'legged';

export interface MobileBase {
  name: string;
  type: MobileBaseType;
  maxLinearVelocityMps: number;
  maxAngularVelocityRadPs: number;
  maxLinearAccelerationMps2: number;
  maxAngularAccelerationRadPs2: number;
  footprint: { length: number; width: number };
  wheelbaseM: number;
  trackM: number;
  groundClearanceM: number;
  turningRadiusM: number;
}

// ─── End Effector ─────────────────────────────────────────────────────

export type EndEffectorType = 'gripper' | 'suction' | 'welding' | 'camera' | '3d_printer' | 'dispenser' | 'custom';

export interface EndEffector {
  name: string;
  type: EndEffectorType;
  payloadKg: number;
  strokeMm: number;
  gripForceN: number;
  minWidthMm: number;
  maxWidthMm: number;
  weightKg: number;
  numFingers: number;
}

// ─── Sensor Suite ─────────────────────────────────────────────────────

export interface SensorSpec {
  name: string;
  type: string;
  rateHz: number;
  resolution: string;
  fovDeg: number;
  rangeM: { min: number; max: number };
  mountingFrame: string;
  transform?: { x: number; y: number; z: number; roll: number; pitch: number; yaw: number };
}

export interface SensorSuite {
  name: string;
  sensors: SensorSpec[];
}

// ─── Platform Capabilities ────────────────────────────────────────────

export interface PlatformCapabilities {
  platformType: RobotPlatformType;
  name: string;
  maxVelocityMps: number;
  maxAccelerationMps2: number;
  maxPayloadKg: number;
  totalDOF: number;
  reachM: number;
  maxJointVelocityRadPs: number;
  maxJointTorqueNm: number;
  manipulabilityIndex: number;
  supportedActuatorActions: string[];
  hasMobileBase: boolean;
  hasManipulator: boolean;
  endEffectors: string[];
  emergencyStopSupported: boolean;
  safetyRated: boolean;
}

// ─── Robot Platform ───────────────────────────────────────────────────

export interface RobotPlatform {
  type: RobotPlatformType;
  name: string;
  manufacturer: string;
  serialNumber?: string;
  softwareVersion?: string;
  manipulator?: Manipulator;
  mobileBase?: MobileBase;
  endEffectors: EndEffector[];
  sensorSuite: SensorSuite;
  capabilities: PlatformCapabilities;
}

// ─── Predefined platforms ─────────────────────────────────────────────

export const SPOT_CAPABILITIES: PlatformCapabilities = {
  platformType: 'spot',
  name: 'Boston Dynamics Spot',
  maxVelocityMps: 1.6,
  maxAccelerationMps2: 0.5,
  maxPayloadKg: 14.0,
  totalDOF: 14,
  reachM: 0.0,
  maxJointVelocityRadPs: 2.0,
  maxJointTorqueNm: 50,
  manipulabilityIndex: 0.0,
  supportedActuatorActions: ['move_joint', 'cmd_vel', 'move_pose', 'grasp'],
  hasMobileBase: true,
  hasManipulator: false,
  endEffectors: ['spot_arm', 'spot_gripper'],
  emergencyStopSupported: true,
  safetyRated: true,
};

export const UR5E_CAPABILITIES: PlatformCapabilities = {
  platformType: 'ur5e',
  name: 'Universal Robots UR5e',
  maxVelocityMps: 1.0,
  maxAccelerationMps2: 3.0,
  maxPayloadKg: 5.0,
  totalDOF: 6,
  reachM: 0.85,
  maxJointVelocityRadPs: Math.PI,
  maxJointTorqueNm: 150,
  manipulabilityIndex: 0.0,
  supportedActuatorActions: ['move_joint', 'move_pose', 'grasp', 'move_velocity', 'set_io'],
  hasMobileBase: false,
  hasManipulator: true,
  endEffectors: ['rg2', 'rg6', 'wsg50'],
  emergencyStopSupported: true,
  safetyRated: true,
};

export const FRANKA_PANDA_CAPABILITIES: PlatformCapabilities = {
  platformType: 'franka_panda',
  name: 'Franka Emika Panda',
  maxVelocityMps: 1.7,
  maxAccelerationMps2: 13.0,
  maxPayloadKg: 3.0,
  totalDOF: 7,
  reachM: 0.855,
  maxJointVelocityRadPs: 2.175,
  maxJointTorqueNm: 87,
  manipulabilityIndex: 0.0,
  supportedActuatorActions: ['move_joint', 'move_pose', 'grasp', 'move_velocity'],
  hasMobileBase: false,
  hasManipulator: true,
  endEffectors: ['franka_hand'],
  emergencyStopSupported: true,
  safetyRated: true,
};

export const KUKA_IIWA_CAPABILITIES: PlatformCapabilities = {
  platformType: 'kuka_iiwa',
  name: 'KUKA LBR iiwa',
  maxVelocityMps: 1.0,
  maxAccelerationMps2: 2.0,
  maxPayloadKg: 14.0,
  totalDOF: 7,
  reachM: 0.82,
  maxJointVelocityRadPs: 1.48,
  maxJointTorqueNm: 176,
  manipulabilityIndex: 0.0,
  supportedActuatorActions: ['move_joint', 'move_pose', 'grasp', 'move_velocity'],
  hasMobileBase: false,
  hasManipulator: true,
  endEffectors: ['kuka_gripper'],
  emergencyStopSupported: true,
  safetyRated: true,
};

export const ATLAS_CAPABILITIES: PlatformCapabilities = {
  platformType: 'atlas',
  name: 'Boston Dynamics Atlas',
  maxVelocityMps: 2.5,
  maxAccelerationMps2: 1.5,
  maxPayloadKg: 15.0,
  totalDOF: 28,
  reachM: 0.9,
  maxJointVelocityRadPs: 4.0,
  maxJointTorqueNm: 200,
  manipulabilityIndex: 0.0,
  supportedActuatorActions: ['move_joint', 'cmd_vel', 'move_pose', 'grasp', 'move_velocity'],
  hasMobileBase: true,
  hasManipulator: true,
  endEffectors: ['atlas_hand'],
  emergencyStopSupported: true,
  safetyRated: true,
};

export const platformRegistry: Record<string, PlatformCapabilities> = {
  spot: SPOT_CAPABILITIES,
  atlas: ATLAS_CAPABILITIES,
  ur5e: UR5E_CAPABILITIES,
  ur10e: { ...UR5E_CAPABILITIES, platformType: 'ur10e', name: 'Universal Robots UR10e', maxPayloadKg: 10.0, reachM: 1.3 },
  kuka_iiwa: KUKA_IIWA_CAPABILITIES,
  franka_panda: FRANKA_PANDA_CAPABILITIES,
  kinova_gen3: {
    ...FRANKA_PANDA_CAPABILITIES,
    platformType: 'kinova_gen3',
    name: 'Kinova Gen3',
    maxPayloadKg: 4.0,
    totalDOF: 7,
    reachM: 0.902,
    endEffectors: ['kinova_gripper'],
  },
  abb_gofa: {
    ...UR5E_CAPABILITIES,
    platformType: 'abb_gofa',
    name: 'ABB GoFa',
    maxPayloadKg: 5.0,
    totalDOF: 6,
    reachM: 0.95,
    endEffectors: ['abb_gripper'],
  },
};

// ─── Capability Checking ──────────────────────────────────────────────

export interface CapabilityCheckResult {
  valid: boolean;
  platform: string;
  checks: { name: string; passed: boolean; message: string }[];
}

export function capabilityCheck(
  platform: PlatformCapabilities,
  action: string,
  params: Record<string, number | string | boolean>
): CapabilityCheckResult {
  const checks: { name: string; passed: boolean; message: string }[] = [];

  if (!platform.supportedActuatorActions.includes(action)) {
    checks.push({
      name: 'action_supported',
      passed: false,
      message: `Action '${action}' is not supported on ${platform.name}. Supported actions: ${platform.supportedActuatorActions.join(', ')}`,
    });
    return { valid: false, platform: platform.name, checks };
  }

  checks.push({
    name: 'action_supported',
    passed: true,
    message: `Action '${action}' is supported on ${platform.name}.`,
  });

  const velocityVal = typeof params.velocity === 'number' ? Math.abs(params.velocity) : undefined;
  if (velocityVal !== undefined && velocityVal > platform.maxJointVelocityRadPs) {
    checks.push({
      name: 'velocity_check',
      passed: false,
      message: `Command velocity ${velocityVal.toFixed(2)} rad/s exceeds platform max ${platform.maxJointVelocityRadPs.toFixed(2)} rad/s.`,
    });
  }

  const torqueVal = typeof params.torque === 'number' ? Math.abs(params.torque) : typeof params.effort === 'number' ? Math.abs(params.effort) : undefined;
  if (torqueVal !== undefined && torqueVal > platform.maxJointTorqueNm) {
    checks.push({
      name: 'torque_check',
      passed: false,
      message: `Command torque ${torqueVal.toFixed(2)} Nm exceeds platform max ${platform.maxJointTorqueNm.toFixed(2)} Nm.`,
    });
  }

  const payloadVal = typeof params.payload === 'number' ? params.payload : undefined;
  if (payloadVal !== undefined && payloadVal > platform.maxPayloadKg) {
    checks.push({
      name: 'payload_check',
      passed: false,
      message: `Command payload ${payloadVal.toFixed(2)} kg exceeds platform max ${platform.maxPayloadKg.toFixed(2)} kg.`,
    });
  }

  const allPassed = checks.every((c) => c.passed);
  return { valid: allPassed, platform: platform.name, checks };
}

export function getPlatformCapabilities(type: RobotPlatformType): PlatformCapabilities | undefined {
  return platformRegistry[type];
}

export function registerPlatform(platform: PlatformCapabilities): void {
  platformRegistry[platform.platformType] = platform;
}
