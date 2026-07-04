import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  '.next',
  'build',
  'coverage',
  '.turbo',
  '.cache',
]);


export function createGrepTools(workingDir: string): ToolDefinition[] {
  return [
    {
      name: 'Grep',
      description: 'Search file contents for a pattern with optional flags (case-insensitive, line numbers).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or plain text pattern to search for.' },
          path: { type: 'string', description: 'Directory or file to search (defaults to working directory).' },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'How to return results: full content, file list, or match count.',
          },
          ignore_case: { type: 'boolean', description: 'Case-insensitive search (alias: i).' },
          i: { type: 'boolean', description: 'Alias for ignore_case.' },
          line_numbers: { type: 'boolean', description: 'Include line numbers (alias: n).' },
          n: { type: 'boolean', description: 'Alias for line_numbers.' },
        },
        required: ['pattern'],
        additionalProperties: true,
      },
      handler: async (args) => {
        const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : '';
        if (!pattern.trim()) {
          return 'Error: pattern is required';
        }

        const outputMode = (args['output_mode'] as string) || 'content';
        const ignoreCase = args['ignore_case'] === true || args['i'] === true;
        const includeLineNumbers = args['line_numbers'] === true || args['n'] === true;
        const searchRootInput = typeof args['path'] === 'string' && args['path'].trim()
          ? args['path'].trim()
          : workingDir;
        const searchRoot = isAbsolute(searchRootInput)
          ? searchRootInput
          : join(workingDir, searchRootInput);

        const regex = new RegExp(pattern, ignoreCase ? 'i' : undefined);
        const matches: string[] = [];
        const filesWithMatches = new Set<string>();

        function walk(dir: string): void {
          let entries;
          try {
            entries = readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }

          for (const entry of entries) {
            if (IGNORED_DIRS.has(entry.name)) continue;
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(fullPath);
              continue;
            }

            let stats;
            try {
              stats = statSync(fullPath);
            } catch {
              continue;
            }

            if (!stats.isFile()) {
              continue;
            }

            let content: string;
            try {
              content = readFileSync(fullPath, 'utf-8');
            } catch {
              continue;
            }

            const lines = content.split(/\r?\n/);
            for (let index = 0; index < lines.length; index++) {
              const line = lines[index] ?? '';
              if (!regex.test(line)) {
                continue;
              }

              const relativePath = relative(workingDir, fullPath);
              filesWithMatches.add(relativePath);

              if (outputMode === 'files_with_matches') {
                // Only need the filename once
                break;
              }

              const lineNumber = includeLineNumbers ? `${index + 1}:` : '';
              matches.push(`${relativePath}:${lineNumber}${line}`);
            }
          }
        }

        walk(searchRoot);

        const MAX_DISPLAY_LINES = 5;

        if (outputMode === 'files_with_matches') {
          if (!filesWithMatches.size) {
            return 'No matches found';
          }
          const files = Array.from(filesWithMatches).sort();
          if (files.length <= MAX_DISPLAY_LINES) {
            return files.join('\n');
          }
          return `${files.slice(0, MAX_DISPLAY_LINES).join('\n')}\n... +${files.length - MAX_DISPLAY_LINES} more files`;
        }

        if (outputMode === 'count') {
          return `Matches: ${matches.length}`;
        }

        if (!matches.length) return 'No matches found';
        if (matches.length <= MAX_DISPLAY_LINES) {
          return matches.join('\n');
        }
        return `${matches.slice(0, MAX_DISPLAY_LINES).join('\n')}\n... +${matches.length - MAX_DISPLAY_LINES} more matches`;
      },
    },
  ];
}
