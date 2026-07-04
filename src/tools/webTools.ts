/**
 * Web Tools - Web search and content extraction capabilities
 *
 * Provides:
 * - WebSearch: Search the web using Tavily
 * - WebExtract: Extract and summarize content from URLs
 */

import type { ToolDefinition } from '../core/toolRuntime.js';
import { getSecretValue } from '../core/secretStore.js';
import { buildError } from '../core/errors.js';
import {
  buildQuotaExhaustedMessage,
  classifyUpstreamError,
  isProviderQuotaExhausted,
  markProviderQuotaExhausted,
} from '../core/providerQuotaState.js';

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  published_date?: string;
}

interface TavilySearchResponse {
  results: TavilySearchResult[];
  answer?: string;
  query: string;
}

interface TavilyExtractResponse {
  results: Array<{
    url: string;
    raw_content: string;
  }>;
}

/**
 * Create web tools for search and extraction.
 */
export function createWebTools(): ToolDefinition[] {
  return [
    {
      name: 'WebSearch',
      description: 'Search the web for current/up-to-date information using Tavily. Use proactively for news, events, recent releases, library docs that may have changed, or any time-sensitive lookup. Works out of the box via the Vigil-hosted proxy; set TAVILY_API_KEY for unlimited use.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5, max: 10)',
          },
          searchDepth: {
            type: 'string',
            enum: ['basic', 'advanced'],
            description: 'Search depth: basic (fast) or advanced (thorough). Default: basic',
          },
          includeAnswer: {
            type: 'boolean',
            description: 'Include AI-generated answer summary. Default: true',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const query = args['query'];
        if (typeof query !== 'string' || !query.trim()) {
          return 'Error: query is required';
        }

        // Short-circuit if a prior call already burned the monthly quota.
        if (isProviderQuotaExhausted('tavily')) {
          return buildQuotaExhaustedMessage('tavily');
        }

        const maxResults = Math.min(
          typeof args['maxResults'] === 'number' ? args['maxResults'] : 5,
          10
        );
        const searchDepth = args['searchDepth'] === 'advanced' ? 'advanced' : 'basic';
        const includeAnswer = args['includeAnswer'] !== false;

        try {
          const tavilyKey = getSecretValue('TAVILY_API_KEY');
          if (tavilyKey) {
            return await searchTavily(query, tavilyKey, { maxResults, searchDepth, includeAnswer });
          }
          // No local key — fall back to the Vigil-hosted Tavily proxy so
          // the agent can search proactively out of the box. Counts against
          // the operator's Tavily quota; users wanting unlimited can set
          // TAVILY_API_KEY locally.
          return await searchTavilyViaProxy(query, { maxResults, searchDepth, includeAnswer });
        } catch (error) {
          if (isProviderQuotaExhausted('tavily')) {
            return buildQuotaExhaustedMessage('tavily');
          }
          return buildError('WebSearch', error, { query });
        }
      },
    },
    {
      name: 'WebExtract',
      description: 'Extract and summarize content from one or more URLs using Tavily. Use after WebSearch when you need the full content of a specific page (docs, articles, GitHub issues). Requires TAVILY_API_KEY.',
      parameters: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'URLs to extract content from (max 5)',
          },
          url: {
            type: 'string',
            description: 'Single URL to extract content from (alternative to urls array)',
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        let urls: string[] = [];

        if (Array.isArray(args['urls'])) {
          urls = args['urls'].filter((u): u is string => typeof u === 'string');
        } else if (typeof args['url'] === 'string') {
          urls = [args['url']];
        }

        if (urls.length === 0) {
          return 'Error: at least one URL is required';
        }

        // Limit to 5 URLs
        urls = urls.slice(0, 5);

        if (isProviderQuotaExhausted('tavily')) {
          return buildQuotaExhaustedMessage('tavily');
        }

        const tavilyKey = getSecretValue('TAVILY_API_KEY');
        if (!tavilyKey) {
          return 'WebExtract requires TAVILY_API_KEY to be configured. Use /secrets set TAVILY_API_KEY to configure.';
        }

        try {
          return await extractTavily(urls, tavilyKey);
        } catch (error) {
          if (isProviderQuotaExhausted('tavily')) {
            return buildQuotaExhaustedMessage('tavily');
          }
          return buildError('WebExtract', error, { urls: urls.join(', ') });
        }
      },
    },
    {
      name: 'WebFetch',
      description:
        'Fetch the raw content of a single URL via HTTP GET. Returns the response body as text (HTML/JSON/plain). Use this when you need the LITERAL page content (e.g., reading a specific docs page, fetching a JSON API). For research / "what does the web say about X" queries, use WebSearch instead — Tavily returns clean summaries.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s):// URL to fetch.' },
          maxBytes: { type: 'number', description: 'Cap the response at this many bytes (default 200_000, max 2_000_000).' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const url = (args['url'] as string | undefined)?.trim();
        if (!url) return 'Error: url is required.';
        if (!/^https?:\/\//i.test(url)) return 'Error: url must start with http:// or https://.';
        const requestedCap = typeof args['maxBytes'] === 'number' ? args['maxBytes'] : 200_000;
        const cap = Math.max(1024, Math.min(2_000_000, requestedCap));

        try {
          // 30s upper bound — long enough for slow doc sites, short
          // enough that the user doesn't watch a stalled spinner.
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30_000);
          const res = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': 'vigil/WebFetch' },
          }).finally(() => clearTimeout(timer));
          if (!res.ok) {
            return `Error: HTTP ${res.status} ${res.statusText} fetching ${url}`;
          }
          const ctype = res.headers.get('content-type') || 'unknown';
          const buf = await res.arrayBuffer();
          const truncated = buf.byteLength > cap;
          const slice = truncated ? buf.slice(0, cap) : buf;
          // Decode as UTF-8. Binary content will look like garbage —
          // we're optimizing for HTML/text/JSON which dominates web
          // fetching.
          const text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
          const headerLines = [
            `[WebFetch ${url}]`,
            `Status: ${res.status}  Content-Type: ${ctype}  Size: ${buf.byteLength} bytes${truncated ? ` (truncated to ${cap})` : ''}`,
            '',
          ];
          return headerLines.join('\n') + text;
        } catch (error) {
          if ((error as { name?: string }).name === 'AbortError') {
            return `Error: WebFetch timed out (30s) for ${url}`;
          }
          return buildError('WebFetch', error, { url });
        }
      },
    },
  ];
}

// Vigil's hosted Tavily proxy (AWS API Gateway → Lambda). Lets the CLI
// search out of the box for users who haven't set TAVILY_API_KEY locally;
// counts against the operator's Tavily quota.
const VIGIL_TAVILY_PROXY_URL =
  'https://cfqeqx4lt9.execute-api.us-east-1.amazonaws.com/api/tavilySearch';

/**
 * Fallback for users without a local TAVILY_API_KEY: hit the Vigil
 * server-side proxy which uses the operator's key. Returns the same
 * markdown shape as `searchTavily`. Errors propagate as a string for the
 * tool harness to surface without crashing the agent loop.
 */
async function searchTavilyViaProxy(
  query: string,
  options: { maxResults: number; searchDepth: string; includeAnswer: boolean },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(VIGIL_TAVILY_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        maxResults: options.maxResults,
        depth: options.searchDepth,
        includeAnswer: options.includeAnswer,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 503) {
        return 'WebSearch is temporarily unavailable on the Vigil proxy. Set TAVILY_API_KEY locally with `/secrets set TAVILY_API_KEY` for unlimited use.';
      }
      // The proxy passes Tavily's upstream status through. A 401/402/429
      // with a quota body means the operator-shared Tavily key has
      // burned its monthly allowance — disable Tavily for the session
      // and surface the friendly explanation.
      if (classifyUpstreamError(res.status, text) === 'quota-exhausted') {
        markProviderQuotaExhausted('tavily', 'monthly quota exhausted via Vigil proxy', {
          detail: text.slice(0, 240),
          httpStatus: res.status,
        });
        return buildQuotaExhaustedMessage('tavily');
      }
      throw new Error(`Vigil Tavily proxy error: ${res.status} ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as TavilySearchResponse;
    return formatTavilyResults(data, 'Tavily (via Vigil)');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('WebSearch via Vigil proxy timed out after 30 seconds');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search using Tavily API (recommended provider)
 */
async function searchTavily(
  query: string,
  apiKey: string,
  options: { maxResults: number; searchDepth: string; includeAnswer: boolean }
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 24 * 60 * 60 * 1000); // 24 hour timeout

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: options.searchDepth,
        include_answer: options.includeAnswer,
        max_results: options.maxResults,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      if (classifyUpstreamError(response.status, text) === 'quota-exhausted') {
        markProviderQuotaExhausted('tavily', 'monthly quota / plan limit exhausted', {
          detail: text.slice(0, 240),
          httpStatus: response.status,
        });
        // We throw here too so the caller's catch surfaces the friendly
        // message via the `isProviderQuotaExhausted` re-check.
        throw new Error('tavily quota exhausted');
      }
      throw new Error(`Tavily API error: ${response.status} ${text}`);
    }

    const data = (await response.json()) as TavilySearchResponse;
    return formatTavilyResults(data, 'Tavily');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Tavily search timed out after 30 seconds');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract content using Tavily Extract API
 */
async function extractTavily(urls: string[], apiKey: string): Promise<string> {
  const response = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      urls,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (classifyUpstreamError(response.status, text) === 'quota-exhausted') {
      markProviderQuotaExhausted('tavily', 'monthly quota / plan limit exhausted', {
        detail: text.slice(0, 240),
        httpStatus: response.status,
      });
      throw new Error('tavily quota exhausted');
    }
    throw new Error(`Tavily Extract API error: ${response.status} ${text}`);
  }

  const data = (await response.json()) as TavilyExtractResponse;
  return formatExtractResults(data);
}

/**
 * Format Tavily search results with enhanced markdown formatting
 */
function formatTavilyResults(data: TavilySearchResponse, provider: string): string {
  const lines: string[] = [`[WebSearch via ${provider}]`, ''];

  if (data.answer) {
    lines.push('**Summary:**', data.answer, '');
  }

  if (!data.results || data.results.length === 0) {
    lines.push('No results found.');
    return lines.join('\n');
  }

  if (data.results.length > 0) {
    lines.push('**Search Results:**');
    lines.push('');

    for (let i = 0; i < data.results.length; i++) {
      const result = data.results[i];

      // Format as numbered list with clickable title link
      lines.push(`${i + 1}. **[${result.title}](${result.url})**`);

      if (result.content) {
        const snippet = result.content.length > 300
          ? result.content.slice(0, 300) + '...'
          : result.content;
        lines.push(`   ${snippet}`);
      }

      if (result.published_date) {
        lines.push(`   *Published: ${result.published_date}*`);
      }

      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Format Tavily extract results with enhanced markdown formatting
 */
function formatExtractResults(data: TavilyExtractResponse): string {
  const lines: string[] = ['[WebExtract via Tavily]', ''];

  if (!data.results || data.results.length === 0) {
    lines.push('No content extracted.');
    return lines.join('\n');
  }

  for (let i = 0; i < data.results.length; i++) {
    const result = data.results[i];

    lines.push(`### Source ${i + 1}: [${result.url}](${result.url})`);
    lines.push('');
    if (result.raw_content) {
      // Truncate very long content
      const content = result.raw_content.length > 5000
        ? result.raw_content.slice(0, 5000) + '\n\n*[Content truncated...]*'
        : result.raw_content;
      lines.push(content);
    }
    lines.push('');
    if (i < data.results.length - 1) {
      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// Export types for testing
export type { TavilySearchResponse };
