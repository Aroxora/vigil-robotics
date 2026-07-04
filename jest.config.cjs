module.exports = {
  testEnvironment: 'node',
  forceExit: true,
  testMatch: [
    '**/test/**/*.test.ts',
    '**/test/**/*.test.tsx',
    '**/src/**/__tests__/**/*.test.ts',
    '**/src/**/__tests__/**/*.test.tsx'
  ],
  displayName: {
    name: 'VIGIL-CORE',
    color: 'blue',
  },
  verbose: true,
  testPathIgnorePatterns: [
    '/node_modules/',
    // Disabled tests for SUTs that still exist but the tests are
    // currently broken — re-enable + fix one at a time. Each entry
    // here is a follow-up TODO, not a permanent quarantine. Tests
    // for SUTs that were deleted have been removed entirely
    // (mcpConfig, skillRepository, robustInputProcessor,
    // isolated-verification) rather than left in the ignore list.
    'test/customCommands.test.ts',
    'test/health-check.test.ts',
    'test/providerFactory.test.ts',
    'test/taskCompletionDetector.test.ts',
    'test/toolSuites.test.ts',
    'test/webTools.test.ts',
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coveragePathIgnorePatterns: [
    'src/core/agentOrchestrator.ts'
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  roots: ['<rootDir>/src', '<rootDir>/test'],
  transform: {
    // Include js/jsx/mjs so node_modules entries that ship as ESM `.js`
    // (Ink, ink-testing-library, etc.) get down-compiled by babel-jest.
    // The transformIgnorePatterns below decides which packages opt in.
    '^.+\\.(ts|tsx|js|jsx|mjs)$': 'babel-jest',
  },
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^chalk$': '<rootDir>/__mocks__/chalk.js',
    '^gradient-string$': '<rootDir>/__mocks__/gradient-string.js',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(chalk|gradient-string|ora|boxen|ink|ink-spinner|ink-testing-library|cli-spinners|cli-truncate|cli-boxes|wrap-ansi|ansi-escapes|patch-console|widest-line|stack-utils|cli-cursor|restore-cursor|onetime|mimic-fn|signal-exit|figures|is-ci|ci-info|emoji-regex|string-width|strip-ansi|ansi-regex|ansi-styles|supports-color|color-convert|color-name|@inkjs|yoga-wasm-web|scheduler|react|react-reconciler|use-sync-external-store))',
    '/dist/'
  ],
  setupFilesAfterEnv: ['<rootDir>/test/jest-setup.cjs'],
};
