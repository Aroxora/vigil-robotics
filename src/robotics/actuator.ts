/**
 * Text-to-action pipeline for LLM-based robotics.
 * 
 * LLM output is text. It must be parsed into actuator commands
 * that physical robots can execute. This module provides the
 * translation layer from natural language intent to machine commands.
 */
export interface ActuatorCommand {
  actuatorId: string;
  actuatorType: 'motor' | 'servo' | 'gripper' | 'speaker' | 'display' | 'led' | 'custom';
  action: string;
  parameters: Record<string, number | string | boolean>;
  priority: 'immediate' | 'queued' | 'background';
}

export interface ActuatorResult {
  command: ActuatorCommand;
  success: boolean;
  timestamp: number;
  error?: string;
}

export function parseActionFromText(text: string): ActuatorCommand[] {
  const pattern = /ACTUATE:(\w+):(\w+):(\w+)\(([^)]*)\)/g;
  const commands: ActuatorCommand[] = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [, actuatorId, actuatorType, action, paramsStr] = match;
    const params: Record<string, number | string | boolean> = {};
    if (paramsStr) {
      for (const pair of paramsStr.split(',')) {
        const [k, v] = pair.split('=');
        if (k && v) params[k.trim()] = v.trim();
      }
    }
    commands.push({
      actuatorId,
      actuatorType: actuatorType as ActuatorCommand['actuatorType'],
      action,
      parameters: params,
      priority: 'queued',
    });
  }
  return commands;
}
