/**
 * Public API: navigation tools for the agent.
 */
import { spatialContextToText, type SpatialContext } from '../../robotics/navigation.js';

export function describeSpatialContext(ctx: SpatialContext): string {
  return spatialContextToText(ctx);
}

export { type SpatialContext };
