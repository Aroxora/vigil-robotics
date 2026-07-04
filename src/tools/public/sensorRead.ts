/**
 * Public API: sensor reading tools for the agent.
 */
import { composeSensorContext, type SensorReading } from '../../robotics/sensor.js';

export function describeSensor(readings: SensorReading[]): string {
  return composeSensorContext(readings);
}

export { type SensorReading };
