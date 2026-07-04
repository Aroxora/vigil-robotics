/**
 * Control and motion planning for LLM-based autonomous robotics.
 *
 * ⚠️ CONCEPT: Type definitions for control schemes. No IK solver
 * (KDL/Trac-IK), no trajectory execution, no MoveIt/OMPL integration.
 * Real implementation needs C++ control libraries with hard real-time.
 *
 * Translates high-level motion intent from the LLM into concrete control
 * commands through trajectory generation, inverse kinematics, motion
 * planning, and various control schemes (PID, MPC, impedance, admittance,
 * hybrid position/force control).
 *
 * @module robotics/control
 */

// ─── Trajectory ───────────────────────────────────────────────────────

export interface JointTrajectoryPoint {
  positions: number[];
  velocities?: number[];
  accelerations?: number[];
  effort?: number[];
  timeFromStartS: number;
}

export interface JointTrajectory {
  jointNames: string[];
  points: JointTrajectoryPoint[];
  durationS: number;
  profileType: 'cubic' | 'quintic' | 'trapezoidal' | 'minimum_jerk' | 's_curve' | 'custom';
}

export interface CartesianTrajectoryPoint {
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
  timeFromStartS: number;
}

export interface CartesianTrajectory {
  frameId: string;
  points: CartesianTrajectoryPoint[];
  durationS: number;
  profileType: 'linear' | 'circular' | 'spline' | 'minimum_jerk' | 'trapezoidal' | 'custom';
}

export interface BlendTrajectory {
  segments: (JointTrajectory | CartesianTrajectory)[];
  blendRadius: number;
}

// ─── Inverse Kinematics ───────────────────────────────────────────────

export interface IkRequest {
  targetPose: { x: number; y: number; z: number; roll: number; pitch: number; yaw: number };
  frameId: string;
  seedJointPositions?: number[];
  tolerance?: { position: number; orientation: number };
  avoidCollisions?: boolean;
  avoidJointLimits?: boolean;
  redundancyResolution?: 'none' | 'joint_centering' | 'manipulability' | 'collision_avoidance' | 'custom';
}

export interface IkResult {
  success: boolean;
  jointPositions: number[];
  targetPose: { x: number; y: number; z: number; roll: number; pitch: number; yaw: number };
  achievedPose: { x: number; y: number; z: number; roll: number; pitch: number; yaw: number };
  positionError: number;
  orientationError: number;
  iterations: number;
  solver: 'analytic' | 'numerical' | 'trac_ik' | 'lma' | 'custom';
}

// ─── Motion Planner ───────────────────────────────────────────────────

export interface PlanningRequest {
  planner: 'ompl' | 'moveit' | 'stomp' | 'chomp' | 'sbpl' | 'prm' | 'rrt' | 'rrt_star' | 'custom';
  startState: number[];
  goalState: number[];
  allowedPlanningTimeS: number;
  workspaceConstraints?: { axis: string; min: number; max: number }[];
  pathConstraints?: { type: 'orientation' | 'position' | 'visibility' }[];
  optimizeFor?: 'shortest_path' | 'minimum_time' | 'minimum_energy' | 'smoothness';
}

export interface PlanningResult {
  success: boolean;
  planner: string;
  trajectory?: JointTrajectory;
  planningTimeMs: number;
  pathLength?: number;
  simplificationLevel: number;
  errorMessage?: string;
}

// ─── PID Controller ───────────────────────────────────────────────────

export interface PidGains {
  p: number;
  i: number;
  d: number;
  iClamp: number;
  antiWindup: boolean;
  filterCoefficient: number;
}

export interface PidControllerConfig {
  name: string;
  jointName: string;
  gains: PidGains;
  controlRateHz: number;
  feedforward?: number;
}

// ─── MPC Controller ───────────────────────────────────────────────────

export interface MpcConfig {
  name: string;
  horizon: number;
  dt: number;
  stateWeights: number[];
  inputWeights: number[];
  inputRateWeights: number[];
  maxIterations: number;
  solverTolerance: number;
}

// ─── Impedance Control ────────────────────────────────────────────────

export interface ImpedanceControlConfig {
  stiffness: { x: number; y: number; z: number; rx: number; ry: number; rz: number };
  damping: { x: number; y: number; z: number; rx: number; ry: number; rz: number };
  referencePose: { x: number; y: number; z: number; roll: number; pitch: number; yaw: number };
  mass?: { x: number; y: number; z: number; rx: number; ry: number; rz: number };
  frameId: string;
}

// ─── Admittance Control ───────────────────────────────────────────────

export interface AdmittanceControlConfig {
  mass: { x: number; y: number; z: number; rx: number; ry: number; rz: number };
  damping: { x: number; y: number; z: number; rx: number; ry: number; rz: number };
  maxDisplacement: { x: number; y: number; z: number; rx: number; ry: number; rz: number };
  forceDeadband: { x: number; y: number; z: number; rx: number; ry: number; rz: number };
  frameId: string;
}

// ─── Hybrid Position/Force Control ────────────────────────────────────

export interface HybridControlConfig {
  selectionMatrix: {
    x: 'position' | 'force' | 'none';
    y: 'position' | 'force' | 'none';
    z: 'position' | 'force' | 'none';
    rx: 'position' | 'force' | 'none';
    ry: 'position' | 'force' | 'none';
    rz: 'position' | 'force' | 'none';
  };
  desiredForceTorque: { x: number; y: number; z: number; rx: number; ry: number; rz: number };
  desiredPosition: { x: number; y: number; z: number; roll: number; pitch: number; yaw: number };
  frameId: string;
}

// ─── Controller Context ───────────────────────────────────────────────

export interface ControllerContext {
  pidControllers: PidControllerConfig[];
  mpcController?: MpcConfig;
  impedanceControl?: ImpedanceControlConfig;
  admittanceControl?: AdmittanceControlConfig;
  hybridControl?: HybridControlConfig;
  activeMode: 'position' | 'velocity' | 'torque' | 'impedance' | 'admittance' | 'hybrid' | 'idle';
  timestamp: number;
}

// ─── Text Translators ─────────────────────────────────────────────────

export function jointTrajectoryToText(traj: JointTrajectory): string {
  const pts = traj.points.length;
  const dur = traj.durationS;
  const jStr = traj.jointNames.join(',');
  return `JOINT_TRAJ[${traj.profileType}] joints:[${jStr}] ${pts}pts/${dur.toFixed(2)}s`;
}

export function cartesianTrajectoryToText(traj: CartesianTrajectory): string {
  const first = traj.points[0];
  const last = traj.points[traj.points.length - 1];
  return `CART_TRAJ[${traj.profileType}] frame:${traj.frameId} from:(${first.x.toFixed(2)},${first.y.toFixed(2)},${first.z.toFixed(2)}) to:(${last.x.toFixed(2)},${last.y.toFixed(2)},${last.z.toFixed(2)}) ${traj.points.length}pts/${traj.durationS.toFixed(2)}s`;
}

export function ikResultToText(result: IkResult): string {
  if (!result.success) {
    return `IK[${result.solver}] FAILED after ${result.iterations} iterations`;
  }
  const jointStr = result.jointPositions.map((j) => j.toFixed(3)).join(',');
  return `IK[${result.solver}] joints:[${jointStr}] posErr:${result.positionError.toFixed(4)}m oriErr:${result.orientationError.toFixed(4)}rad iters:${result.iterations}`;
}

export function planningResultToText(result: PlanningResult): string {
  if (!result.success) {
    return `PLANNING[${result.planner}] FAILED (${result.planningTimeMs}ms): ${result.errorMessage ?? 'unknown error'}`;
  }
  let traj = '';
  if (result.trajectory) {
    traj = ` traj:${jointTrajectoryToText(result.trajectory)}`;
  }
  return `PLANNING[${result.planner}] SUCCESS ${result.planningTimeMs}ms length:${result.pathLength?.toFixed(2) ?? 'N/A'} simplification:${result.simplificationLevel}${traj}`;
}

export function pidConfigToText(config: PidControllerConfig): string {
  const g = config.gains;
  return `PID[${config.name}/${config.jointName}] P:${g.p} I:${g.i} D:${g.d} clamp:${g.iClamp} aw:${g.antiWindup} rate:${config.controlRateHz}Hz${config.feedforward !== undefined ? ` ff:${config.feedforward}` : ''}`;
}

export function impedanceToText(cfg: ImpedanceControlConfig): string {
  const k = cfg.stiffness;
  const d = cfg.damping;
  const ref = cfg.referencePose;
  return `IMPEDANCE frame:${cfg.frameId} K:[${k.x.toFixed(0)},${k.y.toFixed(0)},${k.z.toFixed(0)}|${k.rx.toFixed(0)},${k.ry.toFixed(0)},${k.rz.toFixed(0)}] D:[${d.x.toFixed(0)},${d.y.toFixed(0)},${d.z.toFixed(0)}|${d.rx.toFixed(0)},${d.ry.toFixed(0)},${d.rz.toFixed(0)}] ref:(${ref.x.toFixed(2)},${ref.y.toFixed(2)},${ref.z.toFixed(2)})`;
}

export function admittanceToText(cfg: AdmittanceControlConfig): string {
  const m = cfg.mass;
  const d = cfg.damping;
  return `ADMITTANCE frame:${cfg.frameId} M:[${m.x.toFixed(1)},${m.y.toFixed(1)},${m.z.toFixed(1)}|${m.rx.toFixed(1)},${m.ry.toFixed(1)},${m.rz.toFixed(1)}] D:[${d.x.toFixed(1)},${d.y.toFixed(1)},${d.z.toFixed(1)}|${d.rx.toFixed(1)},${d.ry.toFixed(1)},${d.rz.toFixed(1)}]`;
}

export function hybridControlToText(cfg: HybridControlConfig): string {
  const sm = cfg.selectionMatrix;
  const axes = ['x', 'y', 'z', 'rx', 'ry', 'rz'] as const;
  const modeStr = axes.map((a) => `${a}:${sm[a]}`).join(', ');
  return `HYBRID frame:${cfg.frameId} select:[${modeStr}] desiredF/T:(${cfg.desiredForceTorque.x},${cfg.desiredForceTorque.y},${cfg.desiredForceTorque.z}) desiredP:(${cfg.desiredPosition.x.toFixed(2)},${cfg.desiredPosition.y.toFixed(2)},${cfg.desiredPosition.z.toFixed(2)})`;
}

/**
 * Builds a text description of all active controllers for LLM context.
 */
export function controlContextToText(ctx: ControllerContext): string {
  const lines: string[] = [];
  lines.push(`=== CONTROL STATE [mode:${ctx.activeMode}] @ ${new Date(ctx.timestamp).toISOString()} ===`);
  lines.push(`Active mode: ${ctx.activeMode}`);
  lines.push(`PID controllers: ${ctx.pidControllers.length}`);

  for (const pid of ctx.pidControllers) {
    lines.push(`  ${pidConfigToText(pid)}`);
  }

  if (ctx.mpcController) {
    const m = ctx.mpcController;
    lines.push(`MPC horizon:${m.horizon} dt:${m.dt}s tol:${m.solverTolerance}`);
  }

  if (ctx.impedanceControl) {
    lines.push(impedanceToText(ctx.impedanceControl));
  }

  if (ctx.admittanceControl) {
    lines.push(admittanceToText(ctx.admittanceControl));
  }

  if (ctx.hybridControl) {
    lines.push(hybridControlToText(ctx.hybridControl));
  }

  return lines.join('\n');
}
