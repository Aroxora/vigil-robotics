/**
 * Spatial reasoning and navigation for LLM-based robotics.
 * 
 * Robots operate in physical space. The LLM needs structured
 * spatial context — position, orientation, obstacles, waypoints —
 * to reason about movement and manipulation.
 */
export interface Pose {
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
}

export interface Waypoint {
  pose: Pose;
  label: string;
  tolerance: number;
}

export interface Obstacle {
  id: string;
  type: 'static' | 'dynamic';
  bounds: { min: Pose; max: Pose };
  confidence: number;
}

export interface SpatialContext {
  robotPose: Pose;
  goalPose?: Pose;
  waypoints: Waypoint[];
  obstacles: Obstacle[];
  timestamp: number;
}

export function spatialContextToText(ctx: SpatialContext): string {
  const pose = ctx.robotPose;
  const lines = [
    `POSITION: (${pose.x.toFixed(2)}, ${pose.y.toFixed(2)}, ${pose.z.toFixed(2)})`,
    `ORIENTATION: roll=${pose.roll.toFixed(2)}° pitch=${pose.pitch.toFixed(2)}° yaw=${pose.yaw.toFixed(2)}°`,
  ];
  if (ctx.goalPose) {
    lines.push(`GOAL: (${ctx.goalPose.x.toFixed(2)}, ${ctx.goalPose.y.toFixed(2)}, ${ctx.goalPose.z.toFixed(2)})`);
  }
  if (ctx.obstacles.length > 0) {
    lines.push(`OBSTACLES: ${ctx.obstacles.map(o => `${o.id}(${o.type})`).join(', ')}`);
  }
  if (ctx.waypoints.length > 0) {
    lines.push(`WAYPOINTS: ${ctx.waypoints.map(w => w.label).join(' → ')}`);
  }
  return lines.join('\n');
}
