/**
 * Sensor-to-text pipeline for LLM-based robotics.
 * 
 * LLMs can only consume text tokens. Every sensor — LIDAR, camera,
 * joint encoders, IMU, microphone — must translate its data into
 * text descriptions before the LLM can reason about it.
 */
export interface SensorReading {
  sensorId: string;
  sensorType: 'lidar' | 'camera' | 'imu' | 'joint_encoder' | 'microphone' | 'force_torque' | 'proximity' | 'custom';
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
}

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
