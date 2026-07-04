/**
 * Wires the parallel-sub-agent capability into a live AgentController.
 *
 * The AgentSpawningModule was previously orphaned — it required an
 * LLMProvider instance at construction time, but providers are
 * created per-send in AgentSession, so there was no clean way to
 * register it during runtime construction. This wiring closes the
 * gap: a tool suite is registered AFTER the controller exists, and
 * the tool handler builds a fresh provider matching the controller's
 * current model selection per invocation.
 *
 * Use it from createAgentController:
 *   wireAgentSpawning(controller);
 */

import type { ToolDefinition, ToolSuite } from '../core/toolRuntime.js';
import { LeanAgent } from '../leanAgent.js';
import { createProvider } from '../providers/providerFactory.js';
import { selectionToProviderConfig } from './agentSession.js';
import type { AgentSession, ModelSelection } from './agentSession.js';

const MAX_CONCURRENCY = 5;
const SUBAGENT_TIMEOUT_MS = 30_000; // 30 seconds per sub-agent
const MAX_OUTPUT_LENGTH = 8000; // truncate sub-agent output to prevent context blowup

interface TaskSpec {
  id: string;
  description: string;
  prompt: string;
}

export interface SpawningWiringDeps {
  session: AgentSession;
  workingDir: string;
  /** Returns the controller's current model selection (live reference). */
  getSelection: () => ModelSelection;
}

export function wireAgentSpawning(deps: SpawningWiringDeps): void {
  const tools: ToolDefinition[] = [
    {
      name: 'parallel_agents',
      description:
        'Run several INDEPENDENT sub-tasks in parallel. Each task gets its own sub-agent with the full default toolset. ' +
        `Cap: ${MAX_CONCURRENCY} parallel tasks. Use ONLY when tasks don\'t depend on each other (e.g., reading three unrelated files, ` +
        'creating multiple unrelated files, running unrelated greps). For sequential work or single tasks, just use the regular tools. ' +
        '\n\nParameter `tasks` is a JSON-encoded array: [{ "id": "string", "description": "3-5 word label", "prompt": "full instructions for sub-agent" }, ...]',
      parameters: {
        type: 'object' as const,
        properties: {
          tasks: {
            description: 'JSON string or array of task objects: [{"id":"…","description":"…","prompt":"…"}, …]',
          },
        },
        required: ['tasks'],
      },
      handler: async (args: Record<string, unknown>) => {
        let raw: any = args['tasks'];
        // Accept both JSON string and array — LLMs sometimes pass arrays directly
        if (Array.isArray(raw)) {
          raw = JSON.stringify(raw);
        }
        if (typeof raw !== 'string' || !raw.trim()) {
          return 'Error: tasks must be a JSON string or array.';
        }
        let specs: TaskSpec[];
        try {
          specs = JSON.parse(raw);
        } catch (err) {
          return `Error: tasks JSON parse failed (${(err as Error).message}). Send a JSON array of {id, description, prompt}.`;
        }
        if (!Array.isArray(specs) || specs.length === 0) {
          return 'Error: tasks must be a non-empty JSON array.';
        }
        if (specs.length > MAX_CONCURRENCY) {
          return `Error: max ${MAX_CONCURRENCY} parallel tasks. Got ${specs.length}.`;
        }
        for (const t of specs) {
          if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id.trim() || typeof t.prompt !== 'string' || !t.prompt.trim()) {
            return `Error: each task needs non-empty id + prompt. Bad: ${JSON.stringify(t).slice(0, 200)}`;
          }
        }

        // Build a fresh provider for this batch using the controller's
        // CURRENT selection — sub-agents inherit the user's choice of
        // model without us caching a stale instance.
        const selection = deps.getSelection();
        const providerConfig = selectionToProviderConfig(selection);

        const startedAt = Date.now();
        // Each sub-agent runs with a timeout guard and output truncation.
        // Without this, a hung sub-agent blocks the entire Parallel.all
        // forever, and unbounded output can overflow the context window.
        const results = await Promise.all(
          specs.map(async (task) => {
            try {
              const provider = createProvider(providerConfig);
              const subAgent = new LeanAgent({
                provider,
                workingDir: deps.workingDir,
                providerId: selection.provider,
                modelId: selection.model,
                systemPrompt:
                  'You are a focused sub-agent. Complete ONE specific task and return a concise report. ' +
                  `Working directory: ${deps.workingDir}. ` +
                  'When generating or running JavaScript code, use import/export (ESM) — require() is not available.',
              });
              const response = await Promise.race([
                subAgent.chat(task.prompt, false),
                new Promise<never>((_, reject) =>
                  setTimeout(
                    () => reject(new Error(`Sub-agent ${task.id} timed out after ${SUBAGENT_TIMEOUT_MS / 1000}s`)),
                    SUBAGENT_TIMEOUT_MS,
                  )
                ),
              ]);
              const truncated =
                response.content.length > MAX_OUTPUT_LENGTH
                  ? response.content.slice(0, MAX_OUTPUT_LENGTH) +
                    `\n\n... [truncated ${response.content.length - MAX_OUTPUT_LENGTH} chars]`
                  : response.content;
              return {
                id: task.id,
                description: task.description || task.id,
                success: true,
                output: truncated,
              };
            } catch (err) {
              return {
                id: task.id,
                description: task.description || task.id,
                success: false,
                output: `Error: ${(err as Error).message}`,
              };
            }
          }),
        );

        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const lines: string[] = [
          `Parallel run finished: ${results.length} task(s) in ${elapsed}s.`,
          '',
        ];
        for (const r of results) {
          const tag = r.success ? '✓' : '✗';
          lines.push(`--- [${tag}] ${r.id}: ${r.description} ---`);
          lines.push(r.output);
          lines.push('');
        }
        return lines.join('\n').trimEnd();
      },
    },
  ];

  const suite: ToolSuite = {
    id: 'agent-spawning.tools',
    description: 'Parallel sub-agent execution',
    tools,
  };
  deps.session.toolRuntime.registerSuite(suite);
}
