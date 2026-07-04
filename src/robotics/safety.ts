/**
 * Safety layer for LLM-based autonomous robotics.
 *
 * Every actuator command must pass through safety validation before
 * execution. This module provides comprehensive safety abstractions:
 * bounds monitoring, emergency stop, operational envelopes, collision
 * checking, force limits, safety-rated monitoring (SIL 1-3), and
 * watchdog/heartbeat mechanisms. The LLM's output is never trusted
 * directly — safety validation is the gatekeeper.
 *
 * @module robotics/safety
 */

// ─── Safety Levels ────────────────────────────────────────────────────

export type SafetyIntegrityLevel = 'SIL-1' | 'SIL-2' | 'SIL-3';

export interface SafetyMonitoringRate {
  level: SafetyIntegrityLevel;
  jointCheckHz: number;
  collisionCheckHz: number;
  forceCheckHz: number;
  watchdogTimeoutMs: number;
  emergencyStopResponseMs: number;
}

export const SAFETY_MONITORING_RATES: Record<SafetyIntegrityLevel, Omit<SafetyMonitoringRate, 'level'>> = {
  'SIL-1': { jointCheckHz: 50, collisionCheckHz: 20, forceCheckHz: 100, watchdogTimeoutMs: 500, emergencyStopResponseMs: 200 },
  'SIL-2': { jointCheckHz: 100, collisionCheckHz: 50, forceCheckHz: 200, watchdogTimeoutMs: 200, emergencyStopResponseMs: 100 },
  'SIL-3': { jointCheckHz: 200, collisionCheckHz: 100, forceCheckHz: 500, watchdogTimeoutMs: 100, emergencyStopResponseMs: 50 },
};

// ─── Joint / Axis Limits ──────────────────────────────────────────────

export interface JointLimit {
  jointName: string;
  positionMin: number;
  positionMax: number;
  maxVelocity: number;
  maxEffort: number;
}

export interface WorkspaceBoundary {
  axis: 'x' | 'y' | 'z';
  min: number;
  max: number;
}

export interface OperationalEnvelope {
  jointLimits: JointLimit[];
  workspaceBoundaries: WorkspaceBoundary[];
  maxCartesianVelocity: number;
  maxTCPForce: number;
  enableForceLimiting: boolean;
  enableCollisionDetection: boolean;
  enableSelfCollisionCheck: boolean;
}

// ─── Force Limit ──────────────────────────────────────────────────────

export interface ForceLimit {
  jointName?: string;
  axis?: 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz';
  maxForce: number;
  maxTorque: number;
  rateLimit: number; // N/s or Nm/s
}

// ─── Collision ────────────────────────────────────────────────────────

export interface CollisionModel {
  linkName: string;
  geometry: CollisionGeometry;
}

export type CollisionGeometry =
  | { type: 'box'; dims: { x: number; y: number; z: number } }
  | { type: 'cylinder'; radius: number; height: number }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; length: number }
  | { type: 'mesh'; vertices: number; faces: number };

export interface CollisionPair {
  link1: string;
  link2: string;
  minDistance: number;
  contactNormal?: { x: number; y: number; z: number };
  contactPoint?: { x: number; y: number; z: number };
}

export interface TrajectoryCollisionCheck {
  trajectoryId: string;
  collisions: CollisionPair[];
  minClearanceM: number;
  safe: boolean;
}

// ─── Emergency Stop ───────────────────────────────────────────────────

export type StopType = 'graceful' | 'hard' | 'power_off';

export interface EmergencyStopState {
  active: boolean;
  type: StopType;
  triggeredBy: string;
  triggeredAt: number;
  reason: string;
}

// ─── Watchdog ─────────────────────────────────────────────────────────

export interface WatchdogState {
  alive: boolean;
  lastHeartbeat: number;
  timeoutMs: number;
  missedHeartbeats: number;
  consecutiveMisses: number;
}

// ─── Safety Monitor ───────────────────────────────────────────────────

export interface SafetyCheckResult {
  passed: boolean;
  checks: SafetyCheck[];
  timestamp: number;
  overallScore: number; // 0.0 - 1.0 where 1.0 = fully safe
}

export interface SafetyCheck {
  name: string;
  passed: boolean;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  value?: number;
  limit?: number;
}

// ─── Safety Functions ─────────────────────────────────────────────────

export function createOperationalEnvelope(
  joints: JointLimit[],
  workspace: WorkspaceBoundary[],
  opts?: {
    maxCartesianVelocity?: number;
    maxTCPForce?: number;
  }
): OperationalEnvelope {
  return {
    jointLimits: joints,
    workspaceBoundaries: workspace,
    maxCartesianVelocity: opts?.maxCartesianVelocity ?? 1.0,
    maxTCPForce: opts?.maxTCPForce ?? 100,
    enableForceLimiting: true,
    enableCollisionDetection: true,
    enableSelfCollisionCheck: true,
  };
}

export function checkJointLimits(
  jointName: string,
  position: number,
  velocity: number,
  effort: number,
  limits: JointLimit
): SafetyCheck[] {
  const checks: SafetyCheck[] = [];

  checks.push({
    name: `joint_position_${jointName}`,
    passed: position >= limits.positionMin && position <= limits.positionMax,
    severity: 'critical',
    message: `Joint ${jointName} position ${position.toFixed(3)} rad (limit: [${limits.positionMin.toFixed(3)}, ${limits.positionMax.toFixed(3)}])`,
    value: position,
    limit: position < limits.positionMin ? limits.positionMin : limits.positionMax,
  });

  checks.push({
    name: `joint_velocity_${jointName}`,
    passed: Math.abs(velocity) <= limits.maxVelocity,
    severity: 'critical',
    message: `Joint ${jointName} velocity ${velocity.toFixed(3)} rad/s (limit: ${limits.maxVelocity.toFixed(3)})`,
    value: Math.abs(velocity),
    limit: limits.maxVelocity,
  });

  checks.push({
    name: `joint_effort_${jointName}`,
    passed: Math.abs(effort) <= limits.maxEffort,
    severity: 'warning',
    message: `Joint ${jointName} effort ${effort.toFixed(2)} Nm (limit: ${limits.maxEffort.toFixed(2)})`,
    value: Math.abs(effort),
    limit: limits.maxEffort,
  });

  return checks;
}

export function checkWorkspaceBoundary(
  x: number,
  y: number,
  z: number,
  boundaries: WorkspaceBoundary[]
): SafetyCheck[] {
  const checks: SafetyCheck[] = [];
  const axes: Record<string, number> = { x, y, z };

  for (const b of boundaries) {
    const val = axes[b.axis];
    checks.push({
      name: `workspace_${b.axis}`,
      passed: val >= b.min && val <= b.max,
      severity: 'critical',
      message: `TCP ${b.axis}=${val.toFixed(3)} (workspace: [${b.min.toFixed(3)}, ${b.max.toFixed(3)}])`,
      value: val,
      limit: val < b.min ? b.min : b.max,
    });
  }

  return checks;
}

export function checkForceLimit(
  force: { x: number; y: number; z: number },
  torque: { x: number; y: number; z: number },
  limits: ForceLimit
): SafetyCheck[] {
  const checks: SafetyCheck[] = [];
  const forceMag = Math.sqrt(force.x ** 2 + force.y ** 2 + force.z ** 2);
  const torqueMag = Math.sqrt(torque.x ** 2 + torque.y ** 2 + torque.z ** 2);

  checks.push({
    name: 'force_magnitude',
    passed: forceMag <= limits.maxForce,
    severity: 'critical',
    message: `Force magnitude ${forceMag.toFixed(2)} N (limit: ${limits.maxForce.toFixed(2)} N)`,
    value: forceMag,
    limit: limits.maxForce,
  });

  checks.push({
    name: 'torque_magnitude',
    passed: torqueMag <= limits.maxTorque,
    severity: 'critical',
    message: `Torque magnitude ${torqueMag.toFixed(2)} Nm (limit: ${limits.maxTorque.toFixed(2)} Nm)`,
    value: torqueMag,
    limit: limits.maxTorque,
  });

  return checks;
}

export function checkCollisionRisk(
  pairs: CollisionPair[],
  thresholdM: number = 0.05
): SafetyCheck[] {
  const checks: SafetyCheck[] = [];
  for (const pair of pairs) {
    const safe = pair.minDistance > thresholdM;
    checks.push({
      name: `collision_${pair.link1}_${pair.link2}`,
      passed: safe,
      severity: safe ? 'info' : 'critical',
      message: `Distance between ${pair.link1} and ${pair.link2}: ${pair.minDistance.toFixed(4)}m (threshold: ${thresholdM.toFixed(4)}m)`,
      value: pair.minDistance,
      limit: thresholdM,
    });
  }
  return checks;
}

export function aggregateSafetyChecks(allChecks: SafetyCheck[]): SafetyCheckResult {
  const passed = allChecks.every((c) => c.passed);
  const critical = allChecks.filter((c) => c.severity === 'critical' && !c.passed).length;
  const warnings = allChecks.filter((c) => c.severity === 'warning' && !c.passed).length;
  const total = allChecks.length || 1;

  let score = 1.0;
  if (critical > 0) score = Math.max(0, score - critical * 0.3);
  if (warnings > 0) score = Math.max(0, score - warnings * 0.1);

  return {
    passed,
    checks: allChecks,
    timestamp: Date.now(),
    overallScore: Math.max(0, Math.min(1, score)),
  };
}

export function createEmergencyStop(reason: string, type: StopType = 'hard'): EmergencyStopState {
  return {
    active: true,
    type,
    triggeredBy: 'safety_monitor',
    triggeredAt: Date.now(),
    reason,
  };
}

export function isEmergencyStopActive(stop: EmergencyStopState): boolean {
  return stop.active;
}

export function releaseEmergencyStop(stop: EmergencyStopState): EmergencyStopState {
  return { ...stop, active: false };
}

export function createWatchdog(timeoutMs: number): WatchdogState {
  return {
    alive: true,
    lastHeartbeat: Date.now(),
    timeoutMs,
    missedHeartbeats: 0,
    consecutiveMisses: 0,
  };
}

export function heartbeat(watchdog: WatchdogState): WatchdogState {
  const wd = { ...watchdog, lastHeartbeat: Date.now(), alive: true, consecutiveMisses: 0 };
  return wd;
}

export function checkWatchdog(watchdog: WatchdogState): { alive: boolean; missedMs: number } {
  const elapsed = Date.now() - watchdog.lastHeartbeat;
  const alive = elapsed < watchdog.timeoutMs;
  return { alive, missedMs: alive ? 0 : elapsed - watchdog.timeoutMs };
}

export function createSafetyMonitoringRate(level: SafetyIntegrityLevel): SafetyMonitoringRate {
  return { level, ...SAFETY_MONITORING_RATES[level] };
}
