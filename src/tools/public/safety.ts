/**
 * Public API: safety tools for the agent.
 *
 * These functions are exposed as tools for LLM-invoked safety checks,
 * emergency stops, and operational envelope queries. Safety is the
 * gatekeeper — every actuator command must pass through safety validation
 * before execution.
 *
 * @module tools/public/safety
 */

import {
  type OperationalEnvelope,
  type EmergencyStopState,
  type SafetyCheckResult,
  type JointLimit,
  type WorkspaceBoundary,
  checkJointLimits,
  checkWorkspaceBoundary,
  checkForceLimit,
  checkCollisionRisk,
  aggregateSafetyChecks,
  createEmergencyStop,
  isEmergencyStopActive,
  releaseEmergencyStop,
  type StopType,
} from '../../robotics/safety.js';

/**
 * Run a comprehensive safety check across all dimensions.
 * Returns detailed per-check results with overall safety score.
 */
export function checkSafety(
  jointStates: { name: string; position: number; velocity: number; effort: number }[],
  tcpPosition: { x: number; y: number; z: number },
  force: { x: number; y: number; z: number },
  torque: { x: number; y: number; z: number },
  envelope: OperationalEnvelope,
  collisionPairs?: { link1: string; link2: string; minDistance: number }[],
  forceLimit?: { maxForce: number; maxTorque: number; rateLimit: number }
): SafetyCheckResult {
  const allChecks = [];

  for (const j of jointStates) {
    const limit = envelope.jointLimits.find((l) => l.jointName === j.name);
    if (limit) {
      allChecks.push(...checkJointLimits(j.name, j.position, j.velocity, j.effort, limit));
    }
  }

  allChecks.push(...checkWorkspaceBoundary(tcpPosition.x, tcpPosition.y, tcpPosition.z, envelope.workspaceBoundaries));

  if (forceLimit) {
    allChecks.push(...checkForceLimit(force, torque, {
      jointName: undefined,
      axis: undefined,
      maxForce: forceLimit.maxForce,
      maxTorque: forceLimit.maxTorque,
      rateLimit: forceLimit.rateLimit,
    }));
  }

  if (collisionPairs?.length) {
    allChecks.push(...checkCollisionRisk(
      collisionPairs.map((p) => ({
        link1: p.link1,
        link2: p.link2,
        minDistance: p.minDistance,
      })),
      0.05
    ));
  }

  return aggregateSafetyChecks(allChecks);
}

/**
 * Trigger an emergency stop.
 */
export function emergencyStop(
  reason: string,
  type: StopType = 'hard',
  currentStop?: EmergencyStopState
): EmergencyStopState {
  if (currentStop && isEmergencyStopActive(currentStop)) {
    return currentStop;
  }
  return createEmergencyStop(reason, type);
}

/**
 * Release an emergency stop if safe to do so.
 */
export function releaseStop(
  currentStop: EmergencyStopState,
  safetyCheckResult: SafetyCheckResult
): { stop: EmergencyStopState; released: boolean; message: string } {
  if (!isEmergencyStopActive(currentStop)) {
    return { stop: currentStop, released: false, message: 'No active emergency stop.' };
  }

  if (!safetyCheckResult.passed) {
    return {
      stop: currentStop,
      released: false,
      message: `Cannot release stop: safety check failed (score: ${safetyCheckResult.overallScore.toFixed(2)}). ${safetyCheckResult.checks.filter((c) => !c.passed).map((c) => c.message).join('; ')}`,
    };
  }

  return {
    stop: releaseEmergencyStop(currentStop),
    released: true,
    message: 'Emergency stop released. Safety checks passed.',
  };
}

/**
 * Get the current operational envelope as structured text for LLM context.
 */
export function getOperationalEnvelope(envelope: OperationalEnvelope): string {
  const lines: string[] = [];
  lines.push(`=== OPERATIONAL ENVELOPE ===`);
  lines.push(`Max Cartesian Velocity: ${envelope.maxCartesianVelocity.toFixed(1)} m/s`);
  lines.push(`Max TCP Force: ${envelope.maxTCPForce.toFixed(1)} N`);
  lines.push(`Force Limiting: ${envelope.enableForceLimiting}`);
  lines.push(`Collision Detection: ${envelope.enableCollisionDetection}`);
  lines.push(`Self-Collision Check: ${envelope.enableSelfCollisionCheck}`);

  if (envelope.jointLimits.length > 0) {
    lines.push(`Joint Limits (${envelope.jointLimits.length}):`);
    for (const j of envelope.jointLimits) {
      lines.push(`  ${j.jointName}: pos[${j.positionMin.toFixed(3)},${j.positionMax.toFixed(3)}] vel:${j.maxVelocity.toFixed(2)}rad/s eff:${j.maxEffort.toFixed(1)}Nm`);
    }
  }

  if (envelope.workspaceBoundaries.length > 0) {
    lines.push(`Workspace Boundaries (${envelope.workspaceBoundaries.length}):`);
    for (const b of envelope.workspaceBoundaries) {
      lines.push(`  ${b.axis}: [${b.min.toFixed(3)}, ${b.max.toFixed(3)}] m`);
    }
  }

  return lines.join('\n');
}
