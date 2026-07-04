import { OpenAIChatCompletionsProvider } from '../../../providers/openaiChatCompletionsProvider.js';
import { registerProvider } from '../../../providers/providerFactory.js';
import { withProviderResilience } from '../../../providers/resilientProvider.js';

let registered = false;

/**
 * DeepSeek Provider Plugin
 *
 * Registers the DeepSeek provider with hardened error handling for:
 * - Network failures (premature close, connection reset)
 * - Stream errors (gunzip, decompression failures)
 * - Rate limiting with exponential backoff
 * - Circuit breaker for cascading failure prevention
 */
export function registerDeepSeekProviderPlugin(): void {
  if (registered) {
    return;
  }

  registerProvider('deepseek', (config) => {
    const baseProvider = new OpenAIChatCompletionsProvider({
      apiKey: requireEnv('DEEPSEEK_API_KEY'),
      model: config.model,
      baseURL: 'https://api.deepseek.com',
      providerId: 'deepseek',
      // DeepSeek timeout - extended to 24 hours to allow for complex reasoning and prevent step timeout errors
      timeout: 24 * 60 * 60 * 1000, // 24 hours per API call
      // Built-in retries at provider level
      maxRetries: 3,
      ...(typeof config.temperature === 'number' ? { temperature: config.temperature } : {}),
      ...(typeof config.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}),
    });

    // Wrap with resilience layer for additional protection
    return withProviderResilience(baseProvider, 'deepseek', {
      // DeepSeek has lower rate limits
      maxRequestsPerMinute: 30,
      // More aggressive retries for DeepSeek's connection issues
      maxRetries: 5,
      baseDelayMs: 2000,
      maxDelayMs: 60000,
      // Enable circuit breaker to prevent cascading failures
      enableCircuitBreaker: true,
      circuitBreakerThreshold: 5,
      circuitBreakerResetMs: 120000, // 2 minutes
    });
  });

  registered = true;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}
