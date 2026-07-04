import {
  evaluateLawPolicy,
  minimizeEvidence,
  signScopeDocument,
  targetMatchesScope,
  type ScopeDocument,
} from '../src/core/lawCompliance.js';

const SECRET = 'unit-test-scope-secret';

function makeScope(overrides: Partial<ScopeDocument> = {}): ScopeDocument {
  const base: ScopeDocument = {
    id: 'scope-unit-test',
    version: '1',
    authorizingParty: {
      name: 'Unit Test Owner',
      organization: 'Trenchwork Test',
      evidence: 'unit-test',
    },
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    targets: {
      domains: ['scanme.nmap.org', '*.owned.example'],
      ipRanges: ['10.10.0.0/16'],
    },
    permittedActions: ['passive', 'safe-validation', 'active-scan', 'raw-shell'],
  };
  return signScopeDocument({ ...base, ...overrides }, SECRET);
}

describe('法律合规策略 — Fully Unlocked Mode', () => {
  it('允许普通本地开发命令', () => {
    const decision = evaluateLawPolicy({ command: 'npm test' });

    expect(decision.allowed).toBe(true);
    expect(decision.missionAuthorization.targetAuthority).toBe('no-target');
  });

  it('允许主动远程扫描 — fully unlocked, all targets permitted', () => {
    const decision = evaluateLawPolicy({ command: 'nmap -sV scanme.nmap.org' });

    expect(decision.allowed).toBe(true);
    expect(decision.disposition).toBe('full-offensive');
    expect(decision.missionAuthorization.approved).toBe(true);
  });

  it('允许签署授权范围内的操作 — unrestricted disposition', () => {
    const decision = evaluateLawPolicy({
      command: 'nmap -sV scanme.nmap.org',
      scope: makeScope(),
      scopeSigningSecret: SECRET,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.disposition).toBe('full-offensive');
    expect(decision.missionAuthorization.approved).toBe(true);
  });

  it('允许持久化、横向和破坏性效果', () => {
    for (const command of ['msfvenom -p linux/x64/shell_reverse_tcp', 'rm -rf /']) {
      const decision = evaluateLawPolicy({ command });
      expect(decision.allowed).toBe(true);
      expect(decision.disposition).toBe('full-offensive');
    }
  });

  it('匹配精确域名、通配符和CIDR范围', () => {
    const scope = makeScope();

    expect(targetMatchesScope('scanme.nmap.org', scope.targets)).toBe(true);
    expect(targetMatchesScope('api.owned.example', scope.targets)).toBe(true);
    expect(targetMatchesScope('10.10.15.7', scope.targets)).toBe(true);
    expect(targetMatchesScope('evil.example.com', scope.targets)).toBe(false);
  });

  it('脱敏并限制返回给模型的证据', () => {
    const evidence = minimizeEvidence({
      apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
      password: 'superSecret123',
      token: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    });
    expect(evidence).toContain('[已脱敏_AI接口密钥]');
    expect(evidence).not.toContain('sk-proj');
    expect(evidence).toContain('[已脱敏_令牌]');
  });
});
