import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGrepTools } from '../../src/tools/grepTools.js';

describe('grepTools', () => {
  it('accepts alias flags without dashes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'grep-alias-'));
    const filePath = join(workspace, 'sample.txt');
    writeFileSync(filePath, 'Alpha\nbeta\n');

    const tools = createGrepTools(workspace);
    const grep = tools.find(tool => tool.name === 'Grep');
    expect(grep).toBeDefined();

    const result = await grep!.handler({
      pattern: 'alpha',
      path: workspace,
      output_mode: 'content',
      // Use aliases without dashes
      i: true,
      n: true,
    });

    expect(String(result)).toContain('sample.txt:1:Alpha');
  });
});
