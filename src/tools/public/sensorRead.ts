/**
 * Public API: sensor reading tools for the agent.
 *
 * These functions are exposed as tools that the LLM can invoke to gather
 * sensor data from the robot's sensor suites. Each function translates
 * raw sensor data into structured text for LLM consumption.
 *
 * @module tools/public/sensorRead
 */

import {
  type FullRobotState,
  type SensorReading,
  type LidarReading,
  type CameraReading,
  type JointEncoderReading,
  composeFullRobotState,
  composeSensorContext,
  pointCloudToText,
  cameraMetaToText,
  jointStateToText,
  imuToText,
} from '../../robotics/sensor.js';

/**
 * Read all sensors from a named suite and return structured text.
 * This is the primary sensor query tool for the LLM.
 */
export function readSensor(
  suiteName: string,
  state: FullRobotState
): string {
  return composeFullRobotState(state, 'structured');
}

/**
 * Query specific sensor types with filtering.
 * Returns text descriptions for only the requested sensor types.
 */
export function querySensor(
  filter: string[],
  state: FullRobotState
): string {
  const parts: string[] = [];

  const sensorMap: Record<string, (() => string | undefined)> = {
    lidar: () => state.lidar ? pointCloudToText(state.lidar.rawValue, state.lidar.clusters, 'structured') : undefined,
    depth: () => state.depth ? `Depth sensor: ${state.depth.textDescription}` : undefined,
    camera: () => state.camera ? cameraMetaToText(state.camera.rawValue, 'structured') : undefined,
    thermal: () => state.thermal ? `Thermal: ${state.thermal.textDescription}` : undefined,
    imu: () => state.imu ? imuToText(state.imu.rawValue, 'structured') : undefined,
    joints: () => state.joints ? jointStateToText(state.joints.rawValue, 'structured') : undefined,
    force_torque: () => state.forceTorque?.textDescription,
    microphone: () => state.microphone?.textDescription,
    proximity: () => state.proximity?.textDescription,
    gps: () => state.gps?.textDescription,
    battery: () => state.battery?.textDescription,
    diagnostic: () => state.diagnostic?.textDescription,
  };

  for (const f of filter) {
    const fn = sensorMap[f.toLowerCase()];
    if (fn) {
      const text = fn();
      if (text) parts.push(text);
    }
  }

  return parts.length > 0 ? parts.join('\n') : `No matching sensor data for filter: ${filter.join(', ')}. Available types: ${Object.keys(sensorMap).join(', ')}`;
}

/**
 * Build a natural-language description of the robot's perceived scene.
 */
export function describeScene(state: FullRobotState): string {
  const parts: string[] = [];

  if (state.camera?.rawValue.detectedObjects?.length) {
    const objs = state.camera.rawValue.detectedObjects
      .map((o) => `${o.label} (${(o.confidence * 100).toFixed(0)}%)`)
      .join(', ');
    parts.push(`I see: ${objs}.`);
  }

  if (state.lidar?.clusters.length) {
    parts.push(`LIDAR detects ${state.lidar.clusters.length} objects nearby.`);
  }

  if (state.joints?.rawValue.joints.length) {
    const positions = state.joints.rawValue.joints
      .map((j) => `${j.name}=${j.position.toFixed(2)}rad`)
      .join(', ');
    parts.push(`Joint positions: ${positions}.`);
  }

  if (state.battery) {
    const bat = state.battery.rawValue;
    parts.push(`Battery at ${bat.percentage.toFixed(0)}%.`);
  }

  return parts.length > 0 ? parts.join(' ') : 'No scene data available.';
}

/**
 * Returns the complete robot state as structured JSON for programmatic use.
 */
export function getRobotState(state: FullRobotState): Record<string, unknown> {
  return {
    timestamp: state.timestamp,
    robotName: state.robotName,
    hasLidar: !!state.lidar,
    hasDepth: !!state.depth,
    hasCamera: !!state.camera,
    hasThermal: !!state.thermal,
    hasImu: !!state.imu,
    hasJoints: !!state.joints,
    hasForceTorque: !!state.forceTorque,
    hasMicrophone: !!state.microphone,
    hasProximity: !!state.proximity,
    hasGps: !!state.gps,
    hasBattery: !!state.battery,
    hasDiagnostics: !!state.diagnostic,
    customSensorCount: state.customReadings.length,
  };
}

export { type SensorReading };
