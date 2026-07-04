/**
 * Public API: navigation tools for the agent.
 *
 * These functions are exposed as tools that the LLM can invoke to plan
 * paths, follow waypoints, check spatial context, and verify collision
 * safety before movement.
 *
 * @module tools/public/navigate
 */

import {
  type SpatialContext,
  type Pose,
  type Waypoint,
  type Path,
  type Obstacle,
  spatialContextToText,
  poseToText,
  pathToText,
  obstacleToText,
} from '../../robotics/navigation.js';
import {
  type OperationalEnvelope,
  type SafetyCheckResult,
  checkWorkspaceBoundary,
  aggregateSafetyChecks,
} from '../../robotics/safety.js';

/**
 * Plan a path from current position to a goal pose.
 * Returns a structured path with waypoints and cost.
 */
export function planPath(
  start: Pose,
  goal: Pose,
  obstacles: Obstacle[],
  planner: string = 'rrt_star',
  planningTimeS: number = 5.0
): { path: Path; obstacles: string } {
  const dx = goal.x - start.x;
  const dy = goal.y - start.y;
  const dz = goal.z - start.z;
  const dist = Math.sqrt(dx ** 2 + dy ** 2 + dz ** 2);

  const numWaypoints = Math.max(2, Math.ceil(dist / 0.1));
  const waypoints: Waypoint[] = [];

  for (let i = 0; i < numWaypoints; i++) {
    const t = i / (numWaypoints - 1);
    waypoints.push({
      id: `wp_${i}`,
      pose: {
        x: start.x + dx * t,
        y: start.y + dy * t,
        z: start.z + dz * t,
        roll: start.roll + (goal.roll - start.roll) * t,
        pitch: start.pitch + (goal.pitch - start.pitch) * t,
        yaw: start.yaw + (goal.yaw - start.yaw) * t,
      },
      label: `WP${i}`,
      tolerance: { positionM: 0.05, orientationRad: 0.1 },
    });
  }

  const path: Path = {
    id: `path_${Date.now()}`,
    waypoints,
    cost: dist * 1.0,
    lengthM: dist,
    plannerUsed: planner,
    timestamp: Date.now(),
  };

  const obsText = obstacles.length > 0
    ? `Note: ${obstacles.length} obstacles present. Path may need re-planning. ${obstacles.map(obstacleToText).join('; ')}`
    : 'No obstacles detected.';

  return { path, obstacles: obsText };
}

/**
 * Generate waypoint-following instructions with arrival tolerances.
 */
export function followWaypoints(
  waypoints: Waypoint[],
  envelope?: OperationalEnvelope
): { instructions: string; path: Path; safe: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let safe = true;

  if (envelope) {
    for (const wp of waypoints) {
      const checks = checkWorkspaceBoundary(wp.pose.x, wp.pose.y, wp.pose.z, envelope.workspaceBoundaries);
      const result = aggregateSafetyChecks(checks);
      if (!result.passed) {
        safe = false;
        warnings.push(...result.checks.filter((c) => !c.passed).map((c) => c.message));
      }
    }
  }

  const path: Path = {
    id: `follow_${Date.now()}`,
    waypoints,
    cost: waypoints.length * 1.0,
    lengthM: 0,
    plannerUsed: 'waypoint_follower',
    timestamp: Date.now(),
  };

  const instructions = waypoints
    .map((wp, i) => `[${i}] ${wp.label}: move to ${poseToText(wp.pose)} (tolerance: ${wp.tolerance.positionM}m/${wp.tolerance.orientationRad}rad)${wp.action ? ` then ${wp.action}` : ''}`)
    .join('\n');

  return { instructions, path, safe, warnings };
}

/**
 * Get the full spatial context as structured text for LLM reasoning.
 */
export function getSpatialContext(
  ctx: SpatialContext,
  mode: 'full' | 'summary' | 'obstacles_only' = 'full'
): string {
  switch (mode) {
    case 'summary':
      return `Robot at ${poseToText(ctx.robotPose.pose)}. ${ctx.obstacles.length} obstacles, ${ctx.waypoints.length} waypoints.`;
    case 'obstacles_only':
      return ctx.obstacles.length > 0
        ? ctx.obstacles.map(obstacleToText).join('\n')
        : 'No obstacles detected.';
    default:
      return spatialContextToText(ctx);
  }
}

/**
 * Check if a planned trajectory would cause a collision.
 * Returns safety assessment with clearance information.
 */
export function checkCollision(
  start: Pose,
  goal: Pose,
  obstacles: Obstacle[],
  clearanceMarginM: number = 0.1
): { safe: boolean; minClearance: number; colliding: string[]; message: string } {
  const colliding: string[] = [];
  let minClearance = Infinity;

  const dx = goal.x - start.x;
  const dy = goal.y - start.y;
  const dz = goal.z - start.z;
  const dist = Math.sqrt(dx ** 2 + dy ** 2 + dz ** 2);

  if (dist === 0) return { safe: true, minClearance: Infinity, colliding: [], message: 'Start and goal are the same position.' };

  const steps = Math.max(20, Math.ceil(dist / 0.05));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = start.x + dx * t;
    const py = start.y + dy * t;
    const pz = start.z + dz * t;

    for (const obs of obstacles) {
      let obsRadius = 0;
      const p = obs.pose;
      switch (obs.geometry.type) {
        case 'sphere': obsRadius = obs.geometry.radius; break;
        case 'cylinder': obsRadius = obs.geometry.radius; break;
        case 'box': obsRadius = Math.max(obs.geometry.dims.x, obs.geometry.dims.y, obs.geometry.dims.z) / 2; break;
        default: obsRadius = 0.5;
      }
      const ox = obs.pose ? p.x : 0;
      const oy = obs.pose ? p.y : 0;
      const oz = obs.pose ? p.z : 0;
      const clearance = Math.sqrt((px - ox) ** 2 + (py - oy) ** 2 + (pz - oz) ** 2) - obsRadius;
      if (clearance < minClearance) minClearance = clearance;
      if (clearance < clearanceMarginM) {
        if (!colliding.includes(obs.id)) colliding.push(obs.id);
      }
    }
  }

  const safe = colliding.length === 0;
  return {
    safe,
    minClearance: minClearance === Infinity ? 999 : minClearance,
    colliding,
    message: safe
      ? `Path is clear. Minimum clearance: ${minClearance.toFixed(3)}m (margin: ${clearanceMarginM}m)`
      : `COLLISION RISK: path intersects ${colliding.join(', ')}. Min clearance: ${minClearance.toFixed(3)}m (needed: ${clearanceMarginM}m)`,
  };
}

export { type SpatialContext, type Pose, type Waypoint, type Path, type Obstacle };
