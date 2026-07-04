import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

function runResolveProfile(
  envOverrides: Record<string, string | undefined>,
  profile = 'vigil-code'
): SpawnSyncReturns<string> {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return spawnSync(
    'node',
    [
      '--loader',
      'ts-node/esm',
      '-e',
      `
        import { resolveProfileConfig } from './src/config.js';
        const cfg = resolveProfileConfig(${JSON.stringify(profile)}, null);
        console.log(JSON.stringify({ profile: cfg.profile, provider: cfg.provider, model: cfg.model, providerLocked: cfg.providerLocked }));
      `,
    ],
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    }
  );
}

describe('resolveProfileConfig model/provider alignment (ts-node)', () => {
  it('infers provider from model when provider env is absent', () => {
    const result = runResolveProfile({
      VIGIL_CODE_MODEL: 'deepseek-v4-pro',
      VIGIL_CODE_PROVIDER: undefined,
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as { profile: string; provider: string; model: string; providerLocked: boolean };
    expect(payload.profile).toBe('vigil-code');
    expect(payload.model).toBe('deepseek-v4-pro');
    expect(payload.provider).toBe('deepseek');
    expect(payload.providerLocked).toBe(false);
  });

  it('keeps default model when no provider env specified', () => {
    const result = runResolveProfile({
      VIGIL_CODE_MODEL: undefined,
      VIGIL_CODE_PROVIDER: undefined,
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as { provider: string; model: string; providerLocked: boolean };
    expect(payload.provider).toBe('deepseek');
    expect(payload.model).toBe('deepseek-v4-pro');
  });

  it('normalizes retired profile names to the single default profile', () => {
    const result = runResolveProfile({
      VIGIL_CNE_MODEL: 'deepseek-chat',
      VIGIL_CODE_MODEL: undefined,
      VIGIL_CODE_PROVIDER: undefined,
    }, 'vigil-cne');

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout.trim()) as { profile: string; provider: string; model: string };
    expect(payload.profile).toBe('vigil-code');
    expect(payload.provider).toBe('deepseek');
    expect(payload.model).toBe('deepseek-chat');
  });
});
