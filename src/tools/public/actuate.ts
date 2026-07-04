/**
 * Public API: actuator command tools for the agent.
 */
import { parseActionFromText, type ActuatorCommand } from '../../robotics/actuator.js';

export function executeActuatorCommands(text: string): ActuatorCommand[] {
  return parseActionFromText(text);
}

export { type ActuatorCommand };
