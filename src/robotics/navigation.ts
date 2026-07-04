/**
 * Full spatial reasoning and navigation for LLM-based autonomous robotics.
 *
 * Robots operate in physical 3D space. The LLM needs structured spatial
 * context — position, orientation, obstacles, waypoints, paths, maps,
 * localization, SLAM — to reason about movement, navigation, and
 * manipulation tasks. This module provides all the spatial data types and
 * text translation functions needed to build a rich spatial context.
 *
 * @module robotics/navigation
 */

// ─── Pose ─────────────────────────────────────────────────────────────

export interface Pose {
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
}

export interface PoseWithCovariance {
  pose: Pose;
  covariance: [
    number, number, number, number, number, number,
    number, number, number, number, number, number,
    number, number, number, number, number, number,
    number, number, number, number, number, number,
    number, number, number, number, number, number,
    number, number, number, number, number, number
  ];
}

// ─── Waypoint ─────────────────────────────────────────────────────────

export interface Waypoint {
  id: string;
  pose: Pose;
  label: string;
  tolerance: { positionM: number; orientationRad: number };
  action?: string;
  stayDurationMs?: number;
  metadata?: Record<string, string>;
}

// ─── Obstacle ─────────────────────────────────────────────────────────

export type ObstacleGeometry =
  | { type: 'box'; dims: { x: number; y: number; z: number } }
  | { type: 'cylinder'; radius: number; height: number }
  | { type: 'sphere'; radius: number }
  | { type: 'mesh'; vertices: number; faces: number };

export interface Obstacle {
  id: string;
  type: 'static' | 'dynamic' | 'human' | 'vehicle' | 'custom';
  pose: Pose;
  geometry: ObstacleGeometry;
  confidence: number;
  velocity?: { linear: { x: number; y: number; z: number }; angular: { x: number; y: number; z: number } };
  lastUpdated: number;
  ttlMs?: number;
}

// ─── Path ─────────────────────────────────────────────────────────────

export interface Path {
  id: string;
  waypoints: Waypoint[];
  cost: number;
  lengthM: number;
  plannerUsed: string;
  timestamp: number;
  metadata?: Record<string, string>;
}

// ─── Occupancy Grid Map ───────────────────────────────────────────────

export interface OccupancyGrid {
  width: number;
  height: number;
  resolutionM: number;
  origin: Pose;
  data: Int8Array | number[];
  frameId: string;
  timestamp: number;
}

// ─── Costmap ──────────────────────────────────────────────────────────

export interface Costmap {
  width: number;
  height: number;
  resolutionM: number;
  origin: Pose;
  data: Uint8Array | number[];
  inflationRadiusM: number;
  lethalThreshold: number;
  frameId: string;
  timestamp: number;
}

// ─── Localization ─────────────────────────────────────────────────────

export interface Localization {
  pose: PoseWithCovariance;
  referenceFrame: string;
  mapFrame: string;
  timestamp: number;
  method: 'amcl' | 'ekf' | 'ukf' | 'gmapping' | 'cartographer' | 'gps' | 'fiducial' | 'custom';
  convergenceScore: number;
}

// ─── SLAM ─────────────────────────────────────────────────────────────

export interface SlamContext {
  running: boolean;
  algorithm: string;
  mapResolution: number;
  loopClosures: number;
  keyframes: number;
  mapSizeM: { x: number; y: number; z: number };
  lastClosureDistance: number;
  uncertainty: number;
}

// ─── GPS Waypoint Following ───────────────────────────────────────────

export interface GpsWaypoint {
  latitude: number;
  longitude: number;
  altitude: number;
  label: string;
  arrivalRadiusM: number;
  action?: string;
}

// ─── Spatial Context ──────────────────────────────────────────────────

export interface SpatialContext {
  robotPose: PoseWithCovariance;
  goalPose?: PoseWithCovariance;
  waypoints: Waypoint[];
  obstacles: Obstacle[];
  currentPath?: Path;
  occupancyGrid?: OccupancyGrid;
  costmap?: Costmap;
  localization?: Localization;
  slamContext?: SlamContext;
  gpsWaypoints?: GpsWaypoint[];
  timestamp: number;
  referenceFrame: string;
}

// ─── Text translators ─────────────────────────────────────────────────

export function poseToText(pose: Pose, precision: number = 3): string {
  return `(${pose.x.toFixed(precision)}, ${pose.y.toFixed(precision)}, ${pose.z.toFixed(precision)}) roll:${pose.roll.toFixed(2)}° pitch:${pose.pitch.toFixed(2)}° yaw:${pose.yaw.toFixed(2)}°`;
}

export function obstacleToText(o: Obstacle): string {
  let geo = '';
  switch (o.geometry.type) {
    case 'box':
      geo = `${o.geometry.dims.x.toFixed(2)}x${o.geometry.dims.y.toFixed(2)}x${o.geometry.dims.z.toFixed(2)}m`;
      break;
    case 'cylinder':
      geo = `r=${o.geometry.radius.toFixed(2)}m h=${o.geometry.height.toFixed(2)}m`;
      break;
    case 'sphere':
      geo = `r=${o.geometry.radius.toFixed(2)}m`;
      break;
    case 'mesh':
      geo = `${o.geometry.vertices}v/${o.geometry.faces}f`;
      break;
  }
  let vel = '';
  if (o.velocity) {
    const lv = o.velocity.linear;
    vel = ` vel:(${lv.x.toFixed(2)},${lv.y.toFixed(2)},${lv.z.toFixed(2)})m/s`;
  }
  return `${o.type}:${o.id}[${geo}] @ (${o.pose.x.toFixed(2)},${o.pose.y.toFixed(2)},${o.pose.z.toFixed(2)}) conf:${o.confidence.toFixed(2)}${vel}`;
}

export function pathToText(path: Path): string {
  const wpList = path.waypoints.map((w) => `${w.label}(${w.pose.x.toFixed(2)},${w.pose.y.toFixed(2)},${w.pose.z.toFixed(2)})`).join(' → ');
  return `PATH[${path.plannerUsed}] len:${path.lengthM.toFixed(2)}m cost:${path.cost.toFixed(2)} ${path.waypoints.length} waypoints: ${wpList}`;
}

export function occupancyGridToText(grid: OccupancyGrid): string {
  let occupied = 0;
  let free = 0;
  let unknown = 0;
  for (const v of grid.data) {
    if (v === -1) unknown++;
    else if (v >= 50) occupied++;
    else free++;
  }
  const total = grid.data.length || 1;
  return `OCCUPANCY[${grid.width}x${grid.height} @ ${grid.resolutionM}m/px] origin:(${grid.origin.x.toFixed(2)},${grid.origin.y.toFixed(2)}) free:${((free / total) * 100).toFixed(1)}% occupied:${((occupied / total) * 100).toFixed(1)}% unknown:${((unknown / total) * 100).toFixed(1)}% frame:${grid.frameId}`;
}

export function costmapToText(cm: Costmap): string {
  const total = cm.data.length || 1;
  let lethal = 0;
  for (const v of cm.data) {
    if (v >= cm.lethalThreshold) lethal++;
  }
  return `COSTMAP[${cm.width}x${cm.height} @ ${cm.resolutionM}m/px] lethal:${((lethal / total) * 100).toFixed(1)}% inflateR:${cm.inflationRadiusM}m frame:${cm.frameId}`;
}

export function localizationToText(loc: Localization): string {
  const p = loc.pose.pose;
  const cov = loc.pose.covariance;
  const posUncert = Math.sqrt(Math.max(0, cov[0], cov[7], cov[14]));
  return `LOCALIZATION[${loc.method}] frame:${loc.referenceFrame}→${loc.mapFrame} (${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}) yaw:${p.yaw.toFixed(2)}° posUncert:${posUncert.toFixed(3)}m converge:${loc.convergenceScore.toFixed(2)}`;
}

export function slamContextToText(slam: SlamContext): string {
  if (!slam.running) return 'SLAM: not running';
  return `SLAM[${slam.algorithm}] map:${slam.mapSizeM.x.toFixed(1)}x${slam.mapSizeM.y.toFixed(1)}m res:${slam.mapResolution.toFixed(3)}m kf:${slam.keyframes} loops:${slam.loopClosures} uncert:${slam.uncertainty.toFixed(3)} lastClose:${slam.lastClosureDistance.toFixed(2)}m`;
}

export function gpsWaypointToText(wp: GpsWaypoint): string {
  return `GPS_WP:${wp.label} (${wp.latitude.toFixed(6)},${wp.longitude.toFixed(6)},${wp.altitude.toFixed(1)}m) radius:${wp.arrivalRadiusM}m${wp.action ? ` act:${wp.action}` : ''}`;
}

/**
 * Builds a rich text representation of the full spatial context for LLM consumption.
 * This aggregates position, orientation, goal, obstacles, maps, and navigation state
 * into a single structured text block.
 */
export function spatialContextToText(ctx: SpatialContext): string {
  const lines: string[] = [];
  const p = ctx.robotPose.pose;

  lines.push(`=== SPATIAL CONTEXT [${ctx.referenceFrame}] @ ${new Date(ctx.timestamp).toISOString()} ===`);
  lines.push(`ROBOT: position ${poseToText(p)}`);
  lines.push(`  covariance diagonals: pos=[${ctx.robotPose.covariance[0].toExponential(2)}, ${ctx.robotPose.covariance[7].toExponential(2)}, ${ctx.robotPose.covariance[14].toExponential(2)}] ori=[${ctx.robotPose.covariance[21].toExponential(2)}, ${ctx.robotPose.covariance[28].toExponential(2)}, ${ctx.robotPose.covariance[35].toExponential(2)}]`);

  if (ctx.goalPose) {
    lines.push(`GOAL: position ${poseToText(ctx.goalPose.pose)}`);
  }

  if (ctx.obstacles.length > 0) {
    lines.push(`OBSTACLES (${ctx.obstacles.length}):`);
    for (const o of ctx.obstacles) {
      lines.push(`  ${obstacleToText(o)}`);
    }
  } else {
    lines.push(`OBSTACLES: none detected`);
  }

  if (ctx.currentPath) {
    lines.push(pathToText(ctx.currentPath));
  }

  if (ctx.waypoints.length > 0) {
    lines.push(`WAYPOINTS: ${ctx.waypoints.map((w) => w.label).join(' → ')}`);
  }

  if (ctx.occupancyGrid) {
    lines.push(occupancyGridToText(ctx.occupancyGrid));
  }

  if (ctx.costmap) {
    lines.push(costmapToText(ctx.costmap));
  }

  if (ctx.localization) {
    lines.push(localizationToText(ctx.localization));
  }

  if (ctx.slamContext) {
    lines.push(slamContextToText(ctx.slamContext));
  }

  if (ctx.gpsWaypoints && ctx.gpsWaypoints.length > 0) {
    lines.push(`GPS WAYPOINTS:`);
    for (const w of ctx.gpsWaypoints) {
      lines.push(`  ${gpsWaypointToText(w)}`);
    }
  }

  return lines.join('\n');
}
