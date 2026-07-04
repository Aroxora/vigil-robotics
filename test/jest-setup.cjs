const { TextEncoder, TextDecoder } = require('util');

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Disable "Read Before Edit" enforcement during tests
process.env.VIGIL_ENFORCE_READ_BEFORE_EDIT = 'false';

// DeepSeek API key for tests — supply via env. Tests that hit the real
// provider will skip if this is unset.
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

// Unique run seed — ensures every test run generates unique prompts
process.env.VIGIL_TEST_RUN_SEED = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const originalConsole = { ...console };

beforeAll(() => {
  console.log = jest.fn();
  console.error = jest.fn();
  console.warn = jest.fn();
  console.info = jest.fn();
});

afterAll(() => {
  Object.assign(console, originalConsole);
});
