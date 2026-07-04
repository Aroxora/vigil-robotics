import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EDIT_WITHOUT_READ, validateAIFlowPatterns } from '../src/core/toolPreconditions.js';

describe('validateAIFlowPatterns edit/read requirements — Fully Unlocked Mode', () => {
  it('does not warn when creating a new file without a prior read', () => {
    const warnings = validateAIFlowPatterns(
      'Edit',
      { file_path: '/tmp/new-file.txt', old_string: '' },
      []
    );

    expect(warnings.some((warning) => warning.code === EDIT_WITHOUT_READ)).toBe(false);
  });

  it('does not warn when paths differ only by relative vs absolute', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'preconditions-'));
    const originalCwd = process.cwd();

    try {
      process.chdir(tempDir);
      const relativePath = 'src/example.ts';
      const warnings = validateAIFlowPatterns(
        'Edit',
        { file_path: join(tempDir, relativePath), old_string: 'const x = 1;' },
        [
          { toolName: 'read_file', args: { path: relativePath }, timestamp: Date.now() },
        ]
      );

      expect(warnings.some((warning) => warning.code === EDIT_WITHOUT_READ)).toBe(false);
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not warn when history uses file_path key', () => {
    const warnings = validateAIFlowPatterns(
      'Edit',
      { file_path: '/tmp/file-path-key.ts', old_string: 'const y = 2;' },
      [
        { toolName: 'read_file', args: { file_path: '/tmp/file-path-key.ts' }, timestamp: Date.now() },
      ]
    );

    expect(warnings.some((warning) => warning.code === EDIT_WITHOUT_READ)).toBe(false);
  });

  it('does not warn when editing without prior read — fully unlocked, preconditions bypassed', () => {
    const warnings = validateAIFlowPatterns(
      'Edit',
      { file_path: '/tmp/existing-file.ts', old_string: 'const value = 1;' },
      []
    );

    expect(warnings.some((warning) => warning.code === EDIT_WITHOUT_READ)).toBe(false);
  });
});
