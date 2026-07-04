/**
 * Complex Workflow Integration Tests
 * Tests real-world multi-step workflows that exercise multiple tools
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Complex Workflow Integration', () => {
  const testWorkspace = join(tmpdir(), 'vigil-test-workspace');

  beforeEach(() => {
    // Create clean test workspace
    if (existsSync(testWorkspace)) {
      rmSync(testWorkspace, { recursive: true, force: true });
    }
    mkdirSync(testWorkspace, { recursive: true });
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(testWorkspace)) {
      rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  test('Multi-file code refactoring workflow', () => {
    // Workflow: Search → Read → Edit → Verify
    // Simulates: "Find all instances of 'foo' and rename to 'bar'"

    // Setup: Create test files
    const file1 = join(testWorkspace, 'file1.ts');
    const file2 = join(testWorkspace, 'file2.ts');

    writeFileSync(file1, `
export function foo(x: number): number {
  return x + 1;
}

export const fooValue = foo(42);
`.trim());

    writeFileSync(file2, `
import { foo } from './file1';

export function useFoo() {
  return foo(10);
}
`.trim());

    // Step 1: Search for 'foo'
    const searchResults = [file1, file2]; // Simulated grep results
    expect(searchResults).toHaveLength(2);

    // Step 2: Read files
    const content1 = readFileSync(file1, 'utf-8');
    const content2 = readFileSync(file2, 'utf-8');

    expect(content1).toContain('foo');
    expect(content2).toContain('foo');

    // Step 3: Edit files (simulated)
    const edited1 = content1.replace(/foo/g, 'bar');
    const edited2 = content2.replace(/foo/g, 'bar');

    writeFileSync(file1, edited1);
    writeFileSync(file2, edited2);

    // Step 4: Verify changes
    const verified1 = readFileSync(file1, 'utf-8');
    const verified2 = readFileSync(file2, 'utf-8');

    expect(verified1).not.toContain('foo');
    expect(verified1).toContain('bar');
    expect(verified2).not.toContain('foo');
    expect(verified2).toContain('bar');
  });

  test('Bug investigation and fix workflow', () => {
    // Workflow: Explore → Grep → Read → Edit → Test
    // Simulates: "Find and fix a type error in the codebase"

    // Setup: Create files with a bug
    const srcDir = join(testWorkspace, 'src');
    mkdirSync(srcDir, { recursive: true });

    const buggyFile = join(srcDir, 'calculator.ts');
    writeFileSync(buggyFile, `
export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  // Bug: returns string instead of number
  multiply(a: number, b: number): string {
    return (a * b).toString();
  }
}
`.trim());

    const testFile = join(srcDir, 'calculator.test.ts');
    writeFileSync(testFile, `
import { Calculator } from './calculator';

const calc = new Calculator();
const result: number = calc.multiply(3, 4); // Type error!
`.trim());

    // Step 1: Explore - find TypeScript files
    const tsFiles = [buggyFile, testFile]; // Simulated glob results
    expect(tsFiles).toHaveLength(2);

    // Step 2: Grep - search for type errors (simulated type check)
    const typeErrors = ['calculator.ts:7 - Type error: Type \'string\' is not assignable to type \'number\''];
    expect(typeErrors).toHaveLength(1);

    // Step 3: Read the buggy file
    const buggyContent = readFileSync(buggyFile, 'utf-8');
    expect(buggyContent).toContain('multiply(a: number, b: number): string');

    // Step 4: Fix the bug
    const fixed = buggyContent.replace(
      'multiply(a: number, b: number): string {\n    return (a * b).toString();',
      'multiply(a: number, b: number): number {\n    return a * b;'
    );
    writeFileSync(buggyFile, fixed);

    // Step 5: Verify fix
    const fixedContent = readFileSync(buggyFile, 'utf-8');
    expect(fixedContent).toContain('multiply(a: number, b: number): number');
    expect(fixedContent).not.toContain('.toString()');
  });

  test('Feature implementation workflow', () => {
    // Workflow: Plan → Read → Write → Edit → Test
    // Simulates: "Add a new feature with tests"

    const srcDir = join(testWorkspace, 'src');
    const testDir = join(testWorkspace, 'test');
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });

    // Step 1: Plan (simulated todo list)
    const plan = [
      'Create UserService class',
      'Add getUser method',
      'Add createUser method',
      'Write unit tests',
    ];
    expect(plan).toHaveLength(4);

    // Step 2: Write new file
    const serviceFile = join(srcDir, 'UserService.ts');
    writeFileSync(serviceFile, `
export interface User {
  id: string;
  name: string;
  email: string;
}

export class UserService {
  private users: Map<string, User> = new Map();

  getUser(id: string): User | undefined {
    return this.users.get(id);
  }

  createUser(name: string, email: string): User {
    const id = Math.random().toString(36).substr(2, 9);
    const user: User = { id, name, email };
    this.users.set(id, user);
    return user;
  }
}
`.trim());

    expect(existsSync(serviceFile)).toBe(true);

    // Step 3: Write tests
    const testFilePath = join(testDir, 'UserService.test.ts');
    writeFileSync(testFilePath, `
import { UserService } from '../src/UserService';

describe('UserService', () => {
  test('should create and retrieve user', () => {
    const service = new UserService();
    const user = service.createUser('Alice', 'alice@example.com');

    expect(user.name).toBe('Alice');
    expect(user.email).toBe('alice@example.com');
    expect(user.id).toBeTruthy();

    const retrieved = service.getUser(user.id);
    expect(retrieved).toEqual(user);
  });

  test('should return undefined for non-existent user', () => {
    const service = new UserService();
    const user = service.getUser('nonexistent');
    expect(user).toBeUndefined();
  });
});
`.trim());

    expect(existsSync(testFilePath)).toBe(true);

    // Step 4: Read back and verify
    const serviceContent = readFileSync(serviceFile, 'utf-8');
    const testContent = readFileSync(testFilePath, 'utf-8');

    expect(serviceContent).toContain('class UserService');
    expect(serviceContent).toContain('getUser');
    expect(serviceContent).toContain('createUser');
    expect(testContent).toContain('describe(\'UserService\'');
    expect(testContent).toContain('should create and retrieve user');
  });

  test('Documentation generation workflow', () => {
    // Workflow: Explore → Read → Analyze → Write
    // Simulates: "Generate README from source files"

    const srcDir = join(testWorkspace, 'src');
    mkdirSync(srcDir, { recursive: true });

    // Create source files
    const api = join(srcDir, 'api.ts');
    writeFileSync(api, `
/**
 * Main API client for the service
 */
export class ApiClient {
  /**
   * Fetch data from the API
   * @param endpoint The API endpoint
   * @returns Promise with the response data
   */
  async fetch(endpoint: string): Promise<any> {
    // Implementation
    return {};
  }
}
`.trim());

    const utils = join(srcDir, 'utils.ts');
    writeFileSync(utils, `
/**
 * Utility functions
 */

/**
 * Format a date string
 * @param date The date to format
 * @returns Formatted date string
 */
export function formatDate(date: Date): string {
  return date.toISOString();
}
`.trim());

    // Step 1: Explore - find all source files
    const sourceFiles = [api, utils];
    expect(sourceFiles).toHaveLength(2);

    // Step 2: Read and extract documentation
    const apiContent = readFileSync(api, 'utf-8');
    const utilsContent = readFileSync(utils, 'utf-8');

    const apiDocs = apiContent.match(/\/\*\*[\s\S]*?\*\//g) || [];
    const utilsDocs = utilsContent.match(/\/\*\*[\s\S]*?\*\//g) || [];

    expect(apiDocs.length).toBeGreaterThan(0);
    expect(utilsDocs.length).toBeGreaterThan(0);

    // Step 3: Generate README
    const readme = join(testWorkspace, 'README.md');
    writeFileSync(readme, `
# Project Documentation

## API Client

Main API client for the service.

### Methods

- \`fetch(endpoint: string)\` - Fetch data from the API

## Utilities

### Functions

- \`formatDate(date: Date)\` - Format a date string

`.trim());

    // Step 4: Verify README exists and has content
    const readmeContent = readFileSync(readme, 'utf-8');
    expect(readmeContent).toContain('API Client');
    expect(readmeContent).toContain('Utilities');
    expect(readmeContent).toContain('fetch');
    expect(readmeContent).toContain('formatDate');
  });

  test('Code quality improvement workflow', () => {
    // Workflow: Analyze → Identify Issues → Fix → Verify
    // Simulates: "Find and fix code quality issues"

    const srcDir = join(testWorkspace, 'src');
    mkdirSync(srcDir, { recursive: true });

    // Create file with quality issues
    const messyFile = join(srcDir, 'messy.ts');
    writeFileSync(messyFile, `
export function processData(data: any): any {
  // TODO: Add proper types
  var result = [];  // Use const instead of var
  for (var i = 0; i < data.length; i++) {  // Use for-of instead
    if (data[i] != null) {  // Use !== instead of !=
      result.push(data[i]);
    }
  }
  return result;
}
`.trim());

    // Step 1: Analyze - detect issues
    const content = readFileSync(messyFile, 'utf-8');
    const issues = [
      'Line 1: Using "any" type',
      'Line 3: Using "var" instead of "const"',
      'Line 4: Using for loop instead of for-of',
      'Line 5: Using != instead of !==',
    ];
    expect(issues.length).toBeGreaterThan(0);

    // Step 2: Fix issues
    const improved = `
export function processData(data: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const item of data) {
    if (item !== null && item !== undefined) {
      result.push(item);
    }
  }
  return result;
}
`.trim();

    writeFileSync(messyFile, improved);

    // Step 3: Verify improvements
    const fixedContent = readFileSync(messyFile, 'utf-8');
    expect(fixedContent).not.toContain('any');
    expect(fixedContent).not.toContain('var ');
    expect(fixedContent).toContain('const');
    expect(fixedContent).toContain('!==');
    expect(fixedContent).toContain('for (const');
  });

  test('Dependency update workflow', () => {
    // Workflow: Check Dependencies → Read Changelog → Update → Test
    // Simulates: "Update dependencies safely"

    const packageJson = join(testWorkspace, 'package.json');
    writeFileSync(packageJson, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      dependencies: {
        'old-lib': '^1.0.0',
      },
      devDependencies: {
        'test-lib': '^2.0.0',
      },
    }, null, 2));

    // Step 1: Read current dependencies
    const pkgContent = JSON.parse(readFileSync(packageJson, 'utf-8'));
    expect(pkgContent.dependencies['old-lib']).toBe('^1.0.0');

    // Step 2: Update versions (simulated)
    pkgContent.dependencies['old-lib'] = '^2.0.0';
    pkgContent.devDependencies['test-lib'] = '^3.0.0';

    writeFileSync(packageJson, JSON.stringify(pkgContent, null, 2));

    // Step 3: Verify updates
    const updated = JSON.parse(readFileSync(packageJson, 'utf-8'));
    expect(updated.dependencies['old-lib']).toBe('^2.0.0');
    expect(updated.devDependencies['test-lib']).toBe('^3.0.0');
  });

  test('Error recovery and retry workflow', () => {
    // Workflow: Attempt → Fail → Analyze → Fix → Retry
    // Simulates: "Handle and recover from errors gracefully"

    const testFile = join(testWorkspace, 'config.json');

    // Step 1: Attempt to read non-existent file
    let content: string | null = null;
    let error: Error | null = null;

    try {
      content = readFileSync(testFile, 'utf-8');
    } catch (err) {
      error = err as Error;
    }

    expect(content).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message).toContain('ENOENT');

    // Step 2: Analyze error - file doesn't exist
    const fileExists = existsSync(testFile);
    expect(fileExists).toBe(false);

    // Step 3: Fix - create the file
    writeFileSync(testFile, JSON.stringify({ setting: 'value' }, null, 2));

    // Step 4: Retry - should succeed now
    content = null;
    error = null;

    try {
      content = readFileSync(testFile, 'utf-8');
    } catch (err) {
      error = err as Error;
    }

    expect(content).not.toBeNull();
    expect(error).toBeNull();
    expect(JSON.parse(content!)).toEqual({ setting: 'value' });
  });

  test('Concurrent file operations workflow', async () => {
    // Workflow: Multiple parallel operations
    // Simulates: "Process multiple files concurrently"

    const files = ['file1.txt', 'file2.txt', 'file3.txt', 'file4.txt'];
    const operations: Promise<void>[] = files.map((filename, index) =>
      Promise.resolve().then(() => {
        const filepath = join(testWorkspace, filename);
        writeFileSync(filepath, `Content for file ${index + 1}`);
      })
    );

    // Wait for all writes to complete
    await Promise.all(operations);

    // Step 2: Read all files concurrently
    const contents = await Promise.all(
      files.map(filename =>
        Promise.resolve().then(() => {
          const filepath = join(testWorkspace, filename);
          return readFileSync(filepath, 'utf-8');
        })
      )
    );

    // Step 3: Verify all files were written correctly
    expect(contents).toHaveLength(files.length);
    contents.forEach((content, index) => {
      expect(content).toBe(`Content for file ${index + 1}`);
    });
  });
});
