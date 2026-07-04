/**
 * Full sensor-to-text pipeline for LLM-based autonomous robotics.
 *
 * LLMs consume text tokens exclusively. Every sensor — LIDAR, camera, IMU,
 * joint encoder, force/torque, microphone — must translate its data into
 * structured text descriptions before the LLM can reason about the physical
 * world. This module provides the complete translation layer for all common
 * robotics sensor suites, plus a composeFullRobotState() aggregator that
 * builds a comprehensive text context for the LLM.
 *
 * @module robotics/sensor
 */

// ─── Core sensor types ───────────────────────────────────────────────

export interface SensorReading {
  sensorId: string;
  sensorType:
    | 'lidar'
    | 'stereo_depth'
    | 'rgbd'
    | 'camera_rgb'
    | 'camera_thermal'
    | 'imu'
    | 'joint_encoder'
    | 'force_torque'
    | 'microphone'
    | 'proximity'
    | 'range'
    | 'gps'
    | 'battery'
    | 'diagnostic'
    | 'custom';
  timestamp: number;
  rawValue: unknown;
  textDescription: string;
  confidence: number;
}

export interface SensorConfig {
  id: string;
  type: SensorReading['sensorType'];
  sampleRateHz?: number;
  textFormat: 'structured' | 'narrative' | 'compact';
  transform?: { x: number; y: number; z: number; roll: number; pitch: number; yaw: number };
}

// ─── LIDAR ────────────────────────────────────────────────────────────

export interface Point3D {
  x: number;
  y: number;
  z: number;
  intensity?: number;
  ring?: number;
  timestamp?: number;
}

export interface PointCloud {
  points: Point3D[];
  frameId: string;
  timestamp: number;
  fields: string[];
  isDense: boolean;
  width: number;
  height: number;
}

export interface ClusterInfo {
  clusterId: number;
  centroid: Point3D;
  numPoints: number;
  boundingBox: { min: Point3D; max: Point3D };
  density: number;
}

export interface LidarReading extends SensorReading {
  sensorType: 'lidar';
  rawValue: PointCloud;
  clusterCount: number;
  clusters: ClusterInfo[];
  rangeM: { min: number; max: number };
}

export function pointCloudToText(
  cloud: PointCloud,
  clusters: ClusterInfo[],
  format: 'structured' | 'narrative' | 'compact' = 'structured'
): string {
  if (cloud.points.length === 0) return 'LIDAR: no points in cloud.';

  const rangeMin = cloud.points.reduce((m, p) => Math.min(m, p.x * p.x + p.y * p.y + p.z * p.z), Infinity);
  const rangeMax = cloud.points.reduce((m, p) => Math.max(m, p.x * p.x + p.y * p.y + p.z * p.z), -Infinity);

  if (format === 'compact') {
    const c = clusters
      .map((cl) => `C${cl.clusterId}:(${cl.centroid.x.toFixed(2)},${cl.centroid.y.toFixed(2)},${cl.centroid.z.toFixed(2)})[${cl.numPoints}pts]`)
      .join(' ');
    return `LIDAR[${cloud.points.length}pts rng:${Math.sqrt(rangeMin).toFixed(1)}-${Math.sqrt(rangeMax).toFixed(1)}m] ${clusters.length}clusters: ${c}`;
  }

  if (format === 'narrative') {
    return (
      `LIDAR scan with ${cloud.points.length} points across ${clusters.length} clusters. ` +
      `Range extends from ${Math.sqrt(rangeMin).toFixed(1)}m to ${Math.sqrt(rangeMax).toFixed(1)}m. ` +
      clusters
        .map(
          (cl) =>
            `Cluster ${cl.clusterId} at (${cl.centroid.x.toFixed(2)}, ${cl.centroid.y.toFixed(2)}, ${cl.centroid.z.toFixed(2)}) with ${cl.numPoints} points, density ${cl.density.toFixed(2)} pts/m³.`
        )
        .join(' ')
    );
  }

  let out = `LIDAR [frame:${cloud.frameId}] ${cloud.points.length}pts range:[${Math.sqrt(rangeMin).toFixed(2)},${Math.sqrt(rangeMax).toFixed(2)}]m ${clusters.length} clusters:\n`;
  for (const cl of clusters) {
    const bb = cl.boundingBox;
    out += `  Cluster#${cl.clusterId} centroid:(${cl.centroid.x.toFixed(3)},${cl.centroid.y.toFixed(3)},${cl.centroid.z.toFixed(3)}) `;
    out += `pts:${cl.numPoints} density:${cl.density.toFixed(2)} `;
    out += `bbox:[(${bb.min.x.toFixed(2)},${bb.min.y.toFixed(2)},${bb.min.z.toFixed(2)})→(${bb.max.x.toFixed(2)},${bb.max.y.toFixed(2)},${bb.max.z.toFixed(2)})]\n`;
  }
  return out.trimEnd();
}

// ─── Stereo / RGBD Depth ──────────────────────────────────────────────

export interface DepthMap {
  width: number;
  height: number;
  depthValues: Float32Array | number[];
  minDepth: number;
  maxDepth: number;
  nearClip: number;
  farClip: number;
  timestamp: number;
  frameId: string;
}

export interface DepthReading extends SensorReading {
  sensorType: 'stereo_depth' | 'rgbd';
  rawValue: DepthMap;
}

export function depthMapToText(depth: DepthMap, format: 'structured' | 'narrative' | 'compact' = 'structured'): string {
  let sum = 0;
  let count = 0;
  let belowNear = 0;
  let aboveFar = 0;

  for (let i = 0; i < depth.depthValues.length; i++) {
    const d = depth.depthValues[i];
    if (!isFinite(d)) continue;
    if (d < depth.nearClip) { belowNear++; continue; }
    if (d > depth.farClip) { aboveFar++; continue; }
    sum += d;
    count++;
  }

  const avgDepth = count > 0 ? sum / count : 0;

  if (format === 'compact') {
    return `DEPTH[${depth.width}x${depth.height}] avg:${avgDepth.toFixed(2)}m min:${depth.minDepth.toFixed(2)}m max:${depth.maxDepth.toFixed(2)}m`;
  }
  if (format === 'narrative') {
    return `Depth map ${depth.width}x${depth.height}: average depth ${avgDepth.toFixed(2)}m, range ${depth.minDepth.toFixed(2)}m to ${depth.maxDepth.toFixed(2)}m. ${belowNear} pixels nearer than ${depth.nearClip}m, ${aboveFar} pixels beyond ${depth.farClip}m.`;
  }
  return `DEPTH_MAP[${depth.width}x${depth.height}] avg:${avgDepth.toFixed(3)}m min:${depth.minDepth.toFixed(3)}m max:${depth.maxDepth.toFixed(3)}m near:${depth.nearClip}m far:${depth.farClip}m tooNear:${belowNear} tooFar:${aboveFar} frame:${depth.frameId}`;
}

// ─── Camera ───────────────────────────────────────────────────────────

export interface CameraMetadata {
  width: number;
  height: number;
  format: string;
  exposure: number;
  gain: number;
  whiteBalance: number;
  timestamp: number;
  frameId: string;
  detectedObjects?: DetectedObject[];
  sceneLabel?: string;
  brightnessMean: number;
  brightnessStd: number;
  focusMetric: number;
  hasMotion: boolean;
}

export interface DetectedObject {
  label: string;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
  classId: number;
  distanceEstimate?: number;
}

export interface CameraReading extends SensorReading {
  sensorType: 'camera_rgb' | 'camera_thermal';
  rawValue: CameraMetadata;
}

export function cameraMetaToText(meta: CameraMetadata, format: 'structured' | 'narrative' | 'compact' = 'structured'): string {
  const objs = meta.detectedObjects || [];
  if (format === 'compact') {
    const objStr = objs.map((o) => `${o.label}@${o.confidence.toFixed(2)}`).join(',');
    return `CAM[${meta.width}x${meta.height}] bright:${meta.brightnessMean.toFixed(0)} motion:${meta.hasMotion} scene:${meta.sceneLabel ?? 'N/A'} objs:[${objStr}]`;
  }
  if (format === 'narrative') {
    const objStr = objs.length
      ? objs.map((o) => `${o.label} with ${(o.confidence * 100).toFixed(0)}% confidence`).join(', ')
      : 'none';
    return `Camera image ${meta.width}x${meta.height}, scene labeled "${meta.sceneLabel ?? 'unknown'}", brightness ${meta.brightnessMean.toFixed(1)}±${meta.brightnessStd.toFixed(1)}, ${meta.hasMotion ? 'motion detected' : 'static scene'}, focus ${meta.focusMetric.toFixed(2)}. Detected: ${objStr}.`;
  }
  let out = `CAMERA[${meta.width}x${meta.height}] scene:"${meta.sceneLabel ?? 'N/A'}" bright:${meta.brightnessMean.toFixed(1)}±${meta.brightnessStd.toFixed(1)} focus:${meta.focusMetric.toFixed(2)} motion:${meta.hasMotion} frame:${meta.frameId}\n`;
  if (objs.length) {
    for (const o of objs) {
      out += `  ${o.label} bbox:(${o.bbox.x},${o.bbox.y},${o.bbox.width}x${o.bbox.height}) conf:${o.confidence.toFixed(3)}`;
      if (o.distanceEstimate !== undefined) out += ` dist:${o.distanceEstimate.toFixed(2)}m`;
      out += '\n';
    }
  } else {
    out += '  no objects detected\n';
  }
  return out.trimEnd();
}

// ─── IMU ──────────────────────────────────────────────────────────────

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface ImuData {
  orientation: Quaternion;
  angularVelocity: { x: number; y: number; z: number };
  linearAcceleration: { x: number; y: number; z: number };
  orientationCovariance: [number, number, number, number, number, number, number, number, number];
  angularVelocityCovariance: [number, number, number, number, number, number, number, number, number];
  linearAccelerationCovariance: [number, number, number, number, number, number, number, number, number];
  timestamp: number;
  frameId: string;
}

export interface ImuReading extends SensorReading {
  sensorType: 'imu';
  rawValue: ImuData;
}

export function imuToText(imu: ImuData, format: 'structured' | 'narrative' | 'compact' = 'structured'): string {
  const o = imu.orientation;
  const av = imu.angularVelocity;
  const la = imu.linearAcceleration;

  if (format === 'compact') {
    return `IMU ori:(${o.x.toFixed(3)},${o.y.toFixed(3)},${o.z.toFixed(3)},${o.w.toFixed(3)}) gyro:(${av.x.toFixed(3)},${av.y.toFixed(3)},${av.z.toFixed(3)}) acc:(${la.x.toFixed(3)},${la.y.toFixed(3)},${la.z.toFixed(3)})`;
  }
  if (format === 'narrative') {
    return (
      `IMU reading: orientation quaternion (${o.x.toFixed(3)}, ${o.y.toFixed(3)}, ${o.z.toFixed(3)}, ${o.w.toFixed(3)}), ` +
      `angular velocity (${av.x.toFixed(3)}, ${av.y.toFixed(3)}, ${av.z.toFixed(3)}) rad/s, ` +
      `linear acceleration (${la.x.toFixed(3)}, ${la.y.toFixed(3)}, ${la.z.toFixed(3)}) m/s².`
    );
  }
  return (
    `IMU[frame:${imu.frameId}]\n` +
    `  orientation(q): (${o.x.toFixed(6)},${o.y.toFixed(6)},${o.z.toFixed(6)},${o.w.toFixed(6)})\n` +
    `  angularVel: (${av.x.toFixed(6)},${av.y.toFixed(6)},${av.z.toFixed(6)}) rad/s\n` +
    `  linearAcc: (${la.x.toFixed(6)},${la.y.toFixed(6)},${la.z.toFixed(6)}) m/s²\n` +
    `  cov_orien: [${imu.orientationCovariance.slice(0, 3).map((v) => v.toExponential(2)).join(',')}...]\n` +
    `  cov_gyro: [${imu.angularVelocityCovariance.slice(0, 3).map((v) => v.toExponential(2)).join(',')}...]\n` +
    `  cov_acc: [${imu.linearAccelerationCovariance.slice(0, 3).map((v) => v.toExponential(2)).join(',')}...]`
  );
}

// ─── Joint State ──────────────────────────────────────────────────────

export interface JointState {
  name: string;
  position: number;
  velocity: number;
  effort: number;
}

export interface JointStateData {
  joints: JointState[];
  timestamp: number;
}

export interface JointEncoderReading extends SensorReading {
  sensorType: 'joint_encoder';
  rawValue: JointStateData;
}

export function jointStateToText(data: JointStateData, format: 'structured' | 'narrative' | 'compact' = 'structured'): string {
  if (data.joints.length === 0) return 'JOINTS: none';

  if (format === 'compact') {
    const jt = data.joints.map((j) => `${j.name}:${j.position.toFixed(2)}`).join(',');
    return `JOINTS[${data.joints.length}] ${jt}`;
  }
  if (format === 'narrative') {
    return `Joint states for ${data.joints.length} joints. ` + data.joints.map((j) => `${j.name} at ${j.position.toFixed(2)} rad, velocity ${j.velocity.toFixed(2)} rad/s, effort ${j.effort.toFixed(2)} Nm`).join('. ') + '.';
  }
  let out = `JOINTS[${data.joints.length}]\n`;
  for (const j of data.joints) {
    out += `  ${j.name} pos:${j.position.toFixed(4)} vel:${j.velocity.toFixed(4)} eff:${j.effort.toFixed(2)}\n`;
  }
  return out.trimEnd();
}

// ─── Force/Torque ─────────────────────────────────────────────────────

export interface Wrench {
  force: { x: number; y: number; z: number };
  torque: { x: number; y: number; z: number };
}

export interface ForceTorqueData {
  wrench: Wrench;
  frameId: string;
  timestamp: number;
  sensorLocation: string;
}

export interface ForceTorqueReading extends SensorReading {
  sensorType: 'force_torque';
  rawValue: ForceTorqueData;
}

export function forceTorqueToText(ft: ForceTorqueData, format: 'structured' | 'narrative' | 'compact' = 'structured'): string {
  const f = ft.wrench.force;
  const t = ft.wrench.torque;
  if (format === 'compact') {
    return `F/T[${ft.sensorLocation}] F:(${f.x.toFixed(2)},${f.y.toFixed(2)},${f.z.toFixed(2)})N T:(${t.x.toFixed(2)},${t.y.toFixed(2)},${t.z.toFixed(2)})Nm`;
  }
  if (format === 'narrative') {
    return `Force/torque at ${ft.sensorLocation}: force (${f.x.toFixed(2)}, ${f.y.toFixed(2)}, ${f.z.toFixed(2)}) N, torque (${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)}) Nm.`;
  }
  return `FORCE_TORQUE[${ft.sensorLocation}] force:(${f.x.toFixed(3)},${f.y.toFixed(3)},${f.z.toFixed(3)})N torque:(${t.x.toFixed(3)},${t.y.toFixed(3)},${t.z.toFixed(3)})Nm frame:${ft.frameId}`;
}

// ─── Microphone / Audio ───────────────────────────────────────────────

export interface AudioData {
  sampleRate: number;
  channels: number;
  durationMs: number;
  levelDb: number;
  voiceActivity: boolean;
  eventLabels: string[];
  transcription?: string;
  timestamp: number;
}

export interface MicrophoneReading extends SensorReading {
  sensorType: 'microphone';
  rawValue: AudioData;
}

export function audioToText(audio: AudioData, format: 'structured' | 'narrative' | 'compact' = 'structured'): string {
  const events = audio.eventLabels.length ? audio.eventLabels.join(', ') : 'none';
  const trans = audio.transcription ? ` transcript:"${audio.transcription}"` : '';

  if (format === 'compact') {
    return `AUDIO lvl:${audio.levelDb.toFixed(1)}dB vAct:${audio.voiceActivity} events:[${events}]${trans}`;
  }
  if (format === 'narrative') {
    return `Audio captured at ${audio.sampleRate}Hz, ${audio.channels}ch, ${audio.durationMs}ms. Level ${audio.levelDb.toFixed(1)}dB. ${audio.voiceActivity ? 'Voice activity detected.' : 'No voice activity.'} Events: ${events}.${trans}`;
  }
  return `AUDIO[${audio.sampleRate}Hz/${audio.channels}ch/${audio.durationMs}ms] level:${audio.levelDb.toFixed(1)}dB voice:${audio.voiceActivity} events:[${events}]${trans}`;
}

// ─── Proximity / Range ────────────────────────────────────────────────

export interface RangeData {
  distanceM: number;
  fieldOfViewRad: number;
  minRange: number;
  maxRange: number;
  signalStrength: number;
  direction: { x: number; y: number; z: number };
}

export interface ProximityReading extends SensorReading {
  sensorType: 'proximity' | 'range';
  rawValue: RangeData;
}

export function rangeToText(range: RangeData, format: 'structured' | 'narrative' | 'compact' = 'structured'): string {
  if (format === 'compact') {
    return `RANGE dist:${range.distanceM.toFixed(3)}m sig:${range.signalStrength.toFixed(0)}`;
  }
  if (format === 'narrative') {
    return `Range sensor reads ${range.distanceM.toFixed(3)}m in direction (${range.direction.x.toFixed(1)}, ${range.direction.y.toFixed(1)}, ${range.direction.z.toFixed(1)}), signal strength ${range.signalStrength.toFixed(0)}.`;
  }
  return `RANGE dist:${range.distanceM.toFixed(3)}m dir:(${range.direction.x.toFixed(2)},${range.direction.y.toFixed(2)},${range.direction.z.toFixed(2)}) fov:${range.fieldOfViewRad.toFixed(2)}rad sig:${range.signalStrength.toFixed(0)} range:[${range.minRange},${range.maxRange}]m`;
}

// ─── Thermal ──────────────────────────────────────────────────────────

export interface ThermalData {
  minTemp: number;
  maxTemp: number;
  meanTemp: number;
  hotSpotCount: number;
  hotSpots: { x: number; y: number; temp: number }[];
  width: number;
  height: number;
  timestamp: number;
}

export interface ThermalReading extends SensorReading {
  sensorType: 'camera_thermal';
  rawValue: ThermalData;
}

export function thermalToText(thermal: ThermalData, format: 'structured' | 'narrative' | 'compact' = 'structured'): string {
  if (format === 'compact') {
    const hs = thermal.hotSpots.map((h) => `(${h.x},${h.y}):${h.temp.toFixed(1)}°C`).join(',');
    return `THERMAL[${thermal.width}x${thermal.height}] T:${thermal.minTemp.toFixed(1)}-${thermal.maxTemp.toFixed(1)}°C mean:${thermal.meanTemp.toFixed(1)}°C spots:${thermal.hotSpotCount} ${hs}`;
  }
  if (format === 'narrative') {
    return `Thermal image ${thermal.width}x${thermal.height}: temperature range ${thermal.minTemp.toFixed(1)}°C to ${thermal.maxTemp.toFixed(1)}°C, average ${thermal.meanTemp.toFixed(1)}°C. ${thermal.hotSpotCount} hot spots detected.`;
  }
  let out = `THERMAL[${thermal.width}x${thermal.height}] range:[${thermal.minTemp.toFixed(1)},${thermal.maxTemp.toFixed(1)}]°C mean:${thermal.meanTemp.toFixed(1)}°C hotSpots:${thermal.hotSpotCount}\n`;
  for (const hs of thermal.hotSpots) {
    out += `  @(${hs.x},${hs.y}) ${hs.temp.toFixed(1)}°C\n`;
  }
  return out.trimEnd();
}

// ─── GPS ──────────────────────────────────────────────────────────────

export interface GpsData {
  latitude: number;
  longitude: number;
  altitude: number;
  hdop: number;
  vdop: number;
  satellites: number;
  fixQuality: 'none' | 'gps' | 'dgps' | 'rtk_fixed' | 'rtk_float';
  heading: number;
  speed: number;
}

export interface GpsReading extends SensorReading {
  sensorType: 'gps';
  rawValue: GpsData;
}

export function gpsToText(gps: GpsData, format: 'structured' | 'narrative' | 'compact' = 'structured'): string {
  if (format === 'compact') {
    return `GPS(${gps.fixQuality}) ${gps.latitude.toFixed(6)},${gps.longitude.toFixed(6)} alt:${gps.altitude.toFixed(1)}m sat:${gps.satellites}`;
  }
  if (format === 'narrative') {
    return `GPS position: ${gps.latitude.toFixed(6)}°, ${gps.longitude.toFixed(6)}° at ${gps.altitude.toFixed(1)}m altitude. Fix quality: ${gps.fixQuality}, ${gps.satellites} satellites. HDOP ${gps.hdop.toFixed(1)}, VDOP ${gps.vdop.toFixed(1)}. Heading ${gps.heading.toFixed(1)}° at ${gps.speed.toFixed(1)} m/s.`;
  }
  return `GPS lat:${gps.latitude.toFixed(7)} lon:${gps.longitude.toFixed(7)} alt:${gps.altitude.toFixed(2)}m fix:${gps.fixQuality} sat:${gps.satellites} hdop:${gps.hdop.toFixed(2)} vdop:${gps.vdop.toFixed(2)} heading:${gps.heading.toFixed(1)}° speed:${gps.speed.toFixed(2)}m/s`;
}

// ─── Battery ──────────────────────────────────────────────────────────

export interface BatteryData {
  percentage: number;
  voltage: number;
  current: number;
  temperature: number;
  timeRemainingS: number;
  stateOfHealth: number;
  cellCount: number;
  cellVoltages: number[];
}

export interface BatteryReading extends SensorReading {
  sensorType: 'battery';
  rawValue: BatteryData;
}

export function batteryToText(bat: BatteryData, format: 'structured' | 'narrative' | 'compact' = 'structured'): string {
  const rem = bat.timeRemainingS > 0 ? ` ${Math.floor(bat.timeRemainingS / 60)}m${bat.timeRemainingS % 60}s left` : '';
  if (format === 'compact') {
    return `BATT ${bat.percentage.toFixed(0)}% ${bat.voltage.toFixed(1)}V SoH:${bat.stateOfHealth.toFixed(0)}%${rem}`;
  }
  if (format === 'narrative') {
    return `Battery at ${bat.percentage.toFixed(0)}%, ${bat.voltage.toFixed(1)}V, drawing ${bat.current.toFixed(1)}A. Temperature ${bat.temperature.toFixed(1)}°C. State of health ${bat.stateOfHealth.toFixed(0)}%.${rem}`;
  }
  return `BATTERY ${bat.percentage.toFixed(1)}% ${bat.voltage.toFixed(2)}V ${bat.current.toFixed(2)}A temp:${bat.temperature.toFixed(1)}°C SoH:${bat.stateOfHealth.toFixed(1)}% cells:${bat.cellCount} cellV:[${bat.cellVoltages.map((v) => v.toFixed(2)).join(',')}]${rem}`;
}

// ─── Diagnostics ──────────────────────────────────────────────────────

export interface DiagnosticData {
  cpuTemp: number;
  cpuUsage: number;
  memUsageMb: number;
  diskUsagePct: number;
  errorFlags: string[];
  warningFlags: string[];
  uptimeS: number;
  commLatencyMs: number;
  packetLoss: number;
}

export interface DiagnosticReading extends SensorReading {
  sensorType: 'diagnostic';
  rawValue: DiagnosticData;
}

export function diagnosticToText(diag: DiagnosticData, format: 'structured' | 'narrative' | 'compact' = 'structured'): string {
  const errors = diag.errorFlags.length ? ` ERRORS:[${diag.errorFlags.join(',')}]` : '';
  const warns = diag.warningFlags.length ? ` WARN:[${diag.warningFlags.join(',')}]` : '';

  if (format === 'compact') {
    return `DIAG cpu:${diag.cpuTemp.toFixed(0)}°C/${diag.cpuUsage.toFixed(0)}% mem:${diag.memUsageMb.toFixed(0)}MB lat:${diag.commLatencyMs.toFixed(0)}ms${errors}${warns}`;
  }
  if (format === 'narrative') {
    return `System diagnostics: CPU ${diag.cpuTemp.toFixed(0)}°C at ${diag.cpuUsage.toFixed(0)}% usage, ${diag.memUsageMb.toFixed(0)}MB RAM used. Communication latency ${diag.commLatencyMs.toFixed(0)}ms with ${(diag.packetLoss * 100).toFixed(1)}% packet loss. Uptime ${Math.floor(diag.uptimeS / 3600)}h${Math.floor((diag.uptimeS % 3600) / 60)}m.${errors}${warns}`;
  }
  return `DIAGNOSTICS cpu:${diag.cpuTemp.toFixed(1)}°C/${diag.cpuUsage.toFixed(1)}% mem:${diag.memUsageMb.toFixed(1)}MB disk:${diag.diskUsagePct.toFixed(1)}% uptime:${Math.floor(diag.uptimeS)}s latency:${diag.commLatencyMs.toFixed(1)}ms loss:${(diag.packetLoss * 100).toFixed(2)}%${errors}${warns}`;
}

// ─── Composer — Full robot state ──────────────────────────────────────

export interface FullRobotState {
  timestamp: number;
  robotName: string;
  lidar?: LidarReading;
  depth?: DepthReading;
  camera?: CameraReading;
  thermal?: ThermalReading;
  imu?: ImuReading;
  joints?: JointEncoderReading;
  forceTorque?: ForceTorqueReading;
  microphone?: MicrophoneReading;
  proximity?: ProximityReading;
  gps?: GpsReading;
  battery?: BatteryReading;
  diagnostic?: DiagnosticReading;
  customReadings: SensorReading[];
}

/**
 * Builds a comprehensive text representation of the robot's full sensor state.
 * This is the primary context entry point for the LLM.
 */
export function composeFullRobotState(state: FullRobotState, format: 'structured' | 'narrative' | 'compact' = 'structured'): string {
  const lines: string[] = [];
  lines.push(`=== ROBOT STATE: ${state.robotName} @ ${new Date(state.timestamp).toISOString()} ===`);

  if (state.lidar) lines.push(pointCloudToText(state.lidar.rawValue, state.lidar.clusters, format));
  if (state.depth) lines.push(depthMapToText(state.depth.rawValue, format));
  if (state.camera) lines.push(cameraMetaToText(state.camera.rawValue, format));
  if (state.thermal) lines.push(thermalToText(state.thermal.rawValue, format));
  if (state.imu) lines.push(imuToText(state.imu.rawValue, format));
  if (state.joints) lines.push(jointStateToText(state.joints.rawValue, format));
  if (state.forceTorque) lines.push(forceTorqueToText(state.forceTorque.rawValue, format));
  if (state.microphone) lines.push(audioToText(state.microphone.rawValue, format));
  if (state.proximity) lines.push(rangeToText(state.proximity.rawValue, format));
  if (state.gps) lines.push(gpsToText(state.gps.rawValue, format));
  if (state.battery) lines.push(batteryToText(state.battery.rawValue, format));
  if (state.diagnostic) lines.push(diagnosticToText(state.diagnostic.rawValue, format));

  for (const r of state.customReadings) {
    lines.push(`[${r.sensorType}:${r.sensorId}] ${r.textDescription} (conf:${r.confidence.toFixed(2)})`);
  }

  return lines.join('\n');
}

// ─── Legacy helper (backward compat) ──────────────────────────────────

export function sensorToText(reading: SensorReading): string {
  return `[${reading.sensorType}:${reading.sensorId} @ ${reading.timestamp}] ${reading.textDescription} (confidence: ${reading.confidence.toFixed(2)})`;
}

export function composeSensorContext(readings: SensorReading[]): string {
  if (readings.length === 0) return 'No sensor readings available.';
  return readings
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 100)
    .map(sensorToText)
    .join('\n');
}
