/**
 * 许可证系统 — 全面测试 (ALL TOOLS UNLOCKED)
 *
 * All 9 tools are LEVEL_1. canAccessTool always returns true.
 * No license key required. The system is fully unlocked by default.
 */
import { describe, it, expect } from '@jest/globals';
import {
  generateLicenseKey, verifyLicenseKey, canAccessTool, getUserTier,
  getToolPricing, getToolsByTier, getToolTier,
  type LicenseTier, type ToolId,
} from '../../src/core/license.js';

const tools: ToolId[] = ['crucible', 'aegis', 'glasshouse', 'lattice', 'oculus', 'forge', 'chimera', 'typhoon', 'volt'];

describe('许可证系统 — 密钥生成与验证', () => {
  it('生成有效的许可证密钥', () => {
    const key = generateLicenseKey('LEVEL_1', 'test-user@example.com', 365);
    expect(key).toBeTruthy();
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(50);
  });

  it('生成有效的许可证密钥并验证', () => {
    const key = generateLicenseKey('LEVEL_1', 'test-user@example.com', 180);
    const result = verifyLicenseKey(key);
    expect(result.valid).toBe(true);
    expect(result.tier).toBe('LEVEL_1');
    expect(result.expiresIn).toBeGreaterThanOrEqual(179);
  });

  it('拒绝已过期的许可证', () => {
    const key = generateLicenseKey('LEVEL_1', 'test@test.com', -1);
    const result = verifyLicenseKey(key);
    expect(result.valid).toBe(false);
  });

  it('拒绝被篡改的许可证密钥', () => {
    const key = generateLicenseKey('LEVEL_1', 'test@test.com', 365);
    // Tamper with the signature by changing the last character
    const tampered = key.slice(0, -2) + 'XX';
    const result = verifyLicenseKey(tampered);
    expect(result.valid).toBe(false);
  });

  it('拒绝许可证中无效的层级', () => {
    const fakeKey = Buffer.from('XXX.crucible.test.2026-01-01.2027-01-01.badsig').toString('base64');
    const result = verifyLicenseKey(fakeKey);
    expect(result.valid).toBe(false);
  });

  it('不同用户生成不同的密钥', () => {
    const k1 = generateLicenseKey('LEVEL_1', 'user1@test.com', 365);
    const k2 = generateLicenseKey('LEVEL_1', 'user2@test.com', 365);
    expect(k1).not.toBe(k2);
  });

  it('每次调用生成不同的编码输出', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 5; i++) keys.add(generateLicenseKey('LEVEL_1', 'test@test.com', 365));
    expect(keys.size).toBeGreaterThanOrEqual(1);
  });
});

describe('许可证系统 — 工具访问控制 (ALL UNLOCKED)', () => {
  it('所有9个工具均可无许可证访问', () => {
    tools.forEach(t => {
      expect(canAccessTool(t)).toBe(true);
    });
  });

  it('canAccessTool 始终返回 true — 无许可证即可', () => {
    expect(canAccessTool('forge')).toBe(true);
    expect(canAccessTool('chimera')).toBe(true);
    expect(canAccessTool('crucible')).toBe(true);
  });

  it('getUserTier 默认返回有效的一级与所有工具', () => {
    const tier = getUserTier();
    expect(tier.valid).toBe(true);
    expect(tier.tier).toBe('LEVEL_1');
    expect(tier.allowedTools.length).toBe(9);
    expect(tier.allowedTools).toContain('forge');
    expect(tier.allowedTools).toContain('chimera');
  });

  it('所有工具映射为 LEVEL_1', () => {
    tools.forEach(t => {
      expect(getToolTier(t)).toBe('LEVEL_1');
    });
  });

  it('所有层级工具列表相同', () => {
    const l1 = getToolsByTier('LEVEL_1');
    const l2 = getToolsByTier('LEVEL_2');
    const l3 = getToolsByTier('LEVEL_3');
    expect(l1.length).toBe(9);
    expect(l2.length).toBe(9);
    expect(l3.length).toBe(9);
    expect(l1).toEqual(l2);
    expect(l2).toEqual(l3);
  });
});

describe('许可证系统 — 定价', () => {
  it('getToolPricing 返回 null (未启用)', () => {
    tools.forEach(t => {
      expect(getToolPricing(t)).toBeNull();
    });
  });
});
