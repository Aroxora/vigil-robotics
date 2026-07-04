/**
 * Simulation bridge for LLM-based autonomous robotics.
 *
 * Provides types and text translation for interacting with physics
 * simulators (Gazebo, Isaac Sim, PyBullet, MuJoCo). The LLM can reason
 * about simulated environments, spawn/despawn models, adjust physics,
 * apply domain randomization, and monitor sim2real transfer parameters.
 *
 * @module robotics/simulation
 */

// ─── Simulator Engine ─────────────────────────────────────────────────

export type SimulatorEngine = 'gazebo' | 'isaac_sim' | 'pybullet' | 'mujoco' | 'webots' | 'coppelia' | 'custom';

export interface SimulatorConfig {
  engine: SimulatorEngine;
  worldName: string;
  physicsTimestepS: number;
  realtimeFactor: number;
  maxStepSize: number;
  gravity: { x: number; y: number; z: number };
  useGpu?: boolean;
  headless: boolean;
  guiPort?: number;
}

// ─── Simulated Robot ──────────────────────────────────────────────────

export interface SimulatedRobot {
  name: string;
  modelName: string;
  urdfPath?: string;
  spawnPose: { x: number; y: number; z: number; roll: number; pitch: number; yaw: number };
  controllerPlugin?: string;
  sensorPlugins: string[];
  parentNamespace?: string;
}

// ─── Sim World ────────────────────────────────────────────────────────

export interface SimLight {
  name: string;
  type: 'directional' | 'point' | 'spot';
  diffuse: [number, number, number, number];
  specular: [number, number, number, number];
  pose: { x: number; y: number; z: number; roll: number; pitch: number; yaw: number };
  castShadows: boolean;
  intensity: number;
}

export interface SimModel {
  name: string;
  modelType: string;
  pose: { x: number; y: number; z: number; roll: number; pitch: number; yaw: number };
  isStatic: boolean;
  scale: number;
}

export interface SimWorld {
  models: SimModel[];
  lights: SimLight[];
  physics: {
    solverType: string;
    iters: number;
    sor: number;
    cfm: number;
    erp: number;
    maxContacts: number;
  };
}

// ─── Domain Randomization ─────────────────────────────────────────────

export interface LightingRandomization {
  enabled: boolean;
  ambientRange: [number, number];
  diffuseRange: [number, number];
  specularRange: [number, number];
  directionRange: { roll: [number, number]; pitch: [number, number] };
}

export interface TextureRandomization {
  enabled: boolean;
  colorJitterH: [number, number];
  colorJitterS: [number, number];
  colorJitterV: [number, number];
  texturePool: string[];
}

export interface PhysicsRandomization {
  enabled: boolean;
  massScale: [number, number];
  frictionScale: [number, number];
  dampingScale: [number, number];
  restitutionScale: [number, number];
}

export interface CameraNoiseRandomization {
  enabled: boolean;
  gaussianMean: number;
  gaussianStd: [number, number];
  saltPepperProb: [number, number];
  motionBlurKernel: [number, number];
}

export interface DomainRandomization {
  lighting: LightingRandomization;
  textures: TextureRandomization;
  physics: PhysicsRandomization;
  cameraNoise: CameraNoiseRandomization;
}

// ─── Sim-to-Real Transfer ─────────────────────────────────────────────

export interface SimToRealTransfer {
  enabled: boolean;
  transferMethod: 'domain_adaptation' | 'system_identification' | 'progressive_networks' | 'custom';
  observationNoise: { position: number; velocity: number; force: number };
  actionNoise: { position: number; velocity: number; force: number };
  latencyMs: number;
  calibrationOffsets: { joint: string; offsetRad: number }[];
}

// ─── Simulation State ─────────────────────────────────────────────────

export interface SimulationState {
  simTime: number;
  realTime: number;
  paused: boolean;
  realtimeFactor: number;
  modelCount: number;
  collisionCount: number;
  solverIterations: number;
  fps: number;
}

// ─── Application Results ──────────────────────────────────────────────

export interface AppliedForce {
  modelName: string;
  linkName: string;
  force: { x: number; y: number; z: number };
  torque: { x: number; y: number; z: number };
  durationMs?: number;
}

export interface ModelPose {
  modelName: string;
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
}

// ─── Text translators ─────────────────────────────────────────────────

export function simConfigToText(config: SimulatorConfig): string {
  return `SIM_CONFIG[${config.engine}] world:"${config.worldName}" dt:${config.physicsTimestepS}s rtf:${config.realtimeFactor} grav:(${config.gravity.x},${config.gravity.y},${config.gravity.z}) gpu:${config.useGpu ?? false} headless:${config.headless}`;
}

export function simRobotToText(robot: SimulatedRobot): string {
  const p = robot.spawnPose;
  return `SIM_ROBOT ${robot.name} (${robot.modelName}) @ (${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) roll:${p.roll.toFixed(2)}° pitch:${p.pitch.toFixed(2)}° yaw:${p.yaw.toFixed(2)}° sensors:[${robot.sensorPlugins.join(',')}]`;
}

export function simWorldToText(world: SimWorld): string {
  const lines = [`SIM_WORLD: ${world.models.length} models, ${world.lights.length} lights.`];
  lines.push(`  Physics: solver=${world.physics.solverType} iters=${world.physics.iters} SOR=${world.physics.sor}`);

  if (world.models.length > 0) {
    lines.push('  Models:');
    for (const m of world.models) {
      lines.push(`    ${m.name}[${m.modelType}] @ (${m.pose.x.toFixed(2)},${m.pose.y.toFixed(2)},${m.pose.z.toFixed(2)}) static:${m.isStatic} scale:${m.scale}`);
    }
  }

  if (world.lights.length > 0) {
    lines.push('  Lights:');
    for (const l of world.lights) {
      lines.push(`    ${l.name}[${l.type}] diffuse:(${l.diffuse.join(',')}) shadows:${l.castShadows} intensity:${l.intensity}`);
    }
  }

  return lines.join('\n');
}

export function domainRandomizationToText(dr: DomainRandomization): string {
  const lines: string[] = ['DOMAIN_RANDOMIZATION:'];

  if (dr.lighting.enabled) {
    lines.push(`  Lighting: amb[${dr.lighting.ambientRange.join(',')}] diff[${dr.lighting.diffuseRange.join(',')}]`);
  } else {
    lines.push('  Lighting: disabled');
  }

  if (dr.textures.enabled) {
    lines.push(`  Textures: H[${dr.textures.colorJitterH.join(',')}] S[${dr.textures.colorJitterS.join(',')}] V[${dr.textures.colorJitterV.join(',')}] pool:${dr.textures.texturePool.length} textures`);
  } else {
    lines.push('  Textures: disabled');
  }

  if (dr.physics.enabled) {
    lines.push(`  Physics: mass[${dr.physics.massScale.join(',')}] friction[${dr.physics.frictionScale.join(',')}] damping[${dr.physics.dampingScale.join(',')}]`);
  } else {
    lines.push('  Physics: disabled');
  }

  if (dr.cameraNoise.enabled) {
    lines.push(`  Camera: gauss(${dr.cameraNoise.gaussianMean},[${dr.cameraNoise.gaussianStd.join(',')}]) sp[${dr.cameraNoise.saltPepperProb.join(',')}] blur[${dr.cameraNoise.motionBlurKernel.join(',')}]`);
  } else {
    lines.push('  Camera: disabled');
  }

  return lines.join('\n');
}

export function simToRealToText(str: SimToRealTransfer): string {
  if (!str.enabled) return 'SIM2REAL: disabled.';
  return `SIM2REAL[${str.transferMethod}] obsNoise(pos=${str.observationNoise.position},vel=${str.observationNoise.velocity},frc=${str.observationNoise.force}) actNoise(pos=${str.actionNoise.position},vel=${str.actionNoise.velocity},frc=${str.actionNoise.force}) latency:${str.latencyMs}ms calib:${str.calibrationOffsets.length} offsets`;
}

export function simulationStateToText(state: SimulationState): string {
  return `SIM_STATE time:${state.simTime.toFixed(2)}s real:${state.realTime.toFixed(2)}s rtf:${state.realtimeFactor.toFixed(2)} paused:${state.paused} models:${state.modelCount} collisions:${state.collisionCount} fps:${state.fps}`;
}

/**
 * Describes the full simulation state to the LLM in a structured text format.
 */
export function simContextToText(
  config: SimulatorConfig,
  world: SimWorld,
  robots: SimulatedRobot[],
  state: SimulationState,
  dr?: DomainRandomization
): string {
  const lines: string[] = [];
  lines.push(`=== SIMULATION CONTEXT @ ${new Date().toISOString()} ===`);
  lines.push(simConfigToText(config));
  lines.push(simulationStateToText(state));

  if (robots.length > 0) {
    for (const r of robots) lines.push(simRobotToText(r));
  }

  lines.push(simWorldToText(world));

  if (dr) {
    lines.push(domainRandomizationToText(dr));
  }

  return lines.join('\n');
}
