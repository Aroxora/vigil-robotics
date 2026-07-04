import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectCliMode } from '../src/bin/cliMode.js';
import { readPackageVersion } from '../src/utils/packageInfo.js';

describe('detectCliMode', () => {
  it('prefers version flag over other modes', () => {
    const result = detectCliMode(['--version', '--json', '--self-test']);
    expect(result.mode).toBe('version');
    expect(result.argv).toEqual(['--version', '--json', '--self-test']);
  });

  it('prefers help flag over lower-priority modes', () => {
    const result = detectCliMode(['-h', '--json']);
    expect(result.mode).toBe('help');
  });

  it('detects self-test, json, and eval modes in order', () => {
    expect(detectCliMode(['--self-test']).mode).toBe('self-test');
    expect(detectCliMode(['--json']).mode).toBe('json');
    expect(detectCliMode(['-e', 'prompt']).mode).toBe('eval');
  });

  it('defaults to shell mode when no flags match', () => {
    expect(detectCliMode(['prompt text']).mode).toBe('shell');
  });

  it('returns a defensive copy of argv', () => {
    const input = ['--json'];
    const result = detectCliMode(input);
    input.push('--extra');
    expect(result.argv).toEqual(['--json']);
  });
});

describe('readPackageVersion', () => {
  it('reads the nearest package.json version', () => {
    const expected = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    ).version;
    const version = readPackageVersion(pathToFileURL(__filename));
    expect(version).toBe(expected);
  });
});
