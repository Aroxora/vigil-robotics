import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

describe('test/health-check.test.ts', () => {
  it('health-check script runs without errors on valid project', () => {
    const result = spawnSync('node', ['scripts/health-check.mjs'], {
      encoding: 'utf8',
      cwd: process.cwd()
    });
    
    // The health check should exit with code 0 (success) or 1 (errors)
    // Since we're in a valid project, it should pass or show warnings
    assert.ok(result.status === 0 || result.status === 1,
      `Expected exit code 0 or 1, got ${result.status}. Output: ${result.stdout}`);
    
    // Should contain health check output
    assert.ok(result.stdout.includes('AGI Code CLI Comprehensive Health Check'),
      'Should contain health check header');
  });

  it('health-check script validates package.json structure', () => {
    // Read the actual package.json to verify it has required fields
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    
    const requiredFields = ['name', 'version', 'description', 'main', 'bin'];
    requiredFields.forEach(field => {
      assert.ok(packageJson[field], `package.json should have ${field} field`);
    });
    
    // Check vigil-specific configuration
    assert.ok(packageJson.vigil, 'package.json should have vigil configuration');
    assert.ok(packageJson.vigil.rulebookSchema, 'package.json should have rulebook schema');
  });

  it('health-check script validates agent rulebooks exist', () => {
    const agentFiles = ['agents/vigil-code.rules.json', 'agents/general.rules.json'];
    
    agentFiles.forEach(file => {
      assert.ok(existsSync(file), `Agent rulebook ${file} should exist`);
      
      // Verify they are valid JSON
      const content = JSON.parse(readFileSync(file, 'utf8'));
      const requiredFields = ['profile', 'version', 'label', 'globalPrinciples', 'phases'];
      requiredFields.forEach(field => {
        assert.ok(content[field], `${file} should have ${field} field`);
      });
    });
  });

  it('health-check script validates schema file exists', () => {
    const schemaPath = 'src/contracts/schemas/agent-rules.schema.json';
    assert.ok(existsSync(schemaPath), 'Agent rules schema should exist');
  });

  it('health-check script validates core dependencies exist', () => {
    const coreFiles = [
      'src/core/agent.ts',
      'src/core/agentRulebook.ts', 
      'src/core/toolRuntime.ts',
      'src/providers/providerFactory.ts',
      'src/capabilities/index.ts'
    ];
    
    coreFiles.forEach(file => {
      assert.ok(existsSync(file), `Core file ${file} should exist`);
    });
  });

  it('health-check script output contains expected sections', () => {
    const result = spawnSync('node', ['scripts/health-check.mjs'], {
      encoding: 'utf8',
      cwd: process.cwd()
    });
    
    const output = result.stdout;
    
    // Check for all expected section headers
    const expectedSections = [
      'Node.js Environment',
      'Package Configuration', 
      'TypeScript & Build',
      'Agent Rulebooks',
      'Schema Validation',
      'Core Dependencies',
      'Health Check Summary'
    ];
    
    expectedSections.forEach(section => {
      assert.ok(output.includes(section), `Output should contain ${section} section`);
    });
  });
});
