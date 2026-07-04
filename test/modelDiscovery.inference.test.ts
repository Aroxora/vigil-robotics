import type { ProviderId } from '../src/core/types.js';
import * as modelDiscovery from '../src/core/modelDiscovery.js';

const { inferProviderFromModelId, getLatestModelForProvider } = modelDiscovery;

describe('modelDiscovery provider inference', () => {
  it('infers providers from common model IDs', () => {
    expect(inferProviderFromModelId('deepseek-reasoner')).toBe('deepseek');
  });

  it('falls back to safe defaults when no discovered models exist', () => {
    const spy = jest.spyOn(modelDiscovery, 'getCachedDiscoveredModels').mockReturnValue([]);

    // Only deepseek is configured in PROVIDER_CONFIGS
    expect(getLatestModelForProvider('deepseek' as ProviderId)).toBe('deepseek-v4-pro');

    spy.mockRestore();
  });
});
