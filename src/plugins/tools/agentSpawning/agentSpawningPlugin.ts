import type { ToolDefinition, ToolSuite } from '../../../core/toolRuntime.js';
import type { CapabilityContribution, CapabilityModule } from '../../../runtime/agentHost.js';
import type { ToolPlugin } from '../registry.js';
import type { LLMProvider } from '../../../core/types.js';
import { LeanAgent } from '../../../leanAgent.js';

/** Maximum number of parallel sub-agents */
const MAX_CONCURRENCY = 5;

interface TaskSpec {
  id: string;
  description: string;
  prompt: string;
}

interface TaskResult {
  id: string;
  description: string;
  success: boolean;
  output: string;
}

export interface AgentSpawningOptions {
  provider: LLMProvider;
  workingDir?: string;
  providerId?: string;
  modelId?: string;
}

class AgentSpawningModule implements CapabilityModule {
  id = 'tool.agent-spawning';
  description = 'Spawn parallel sub-agents for independent tasks.';

  constructor(private readonly options: AgentSpawningOptions) {}

  async create(): Promise<CapabilityContribution> {
    const opts = this.options;

    const tools: ToolDefinition[] = [
      {
        name: 'parallel_agents',
        description:
          'Execute multiple independent tasks in parallel using sub-agents. ' +
          'Each sub-agent gets its own tool suite (filesystem, edit, bash, search, git, web) and works independently. ' +
          'Use this when you need to perform several independent operations simultaneously ' +
          '(e.g., creating multiple files, searching in different places, running independent edits). ' +
          'Do NOT use for tasks that depend on each other or for single small tasks.\n\n' +
          'Parameter `tasks`: A JSON string encoding an array of objects, each with:\n' +
          '  - id: unique string identifier for the task\n' +
          '  - description: short label (3-5 words)\n' +
          '  - prompt: full instructions for the sub-agent',
        parameters: {
          type: 'object' as const,
          properties: {
            tasks: {
            description: 'JSON array (string or direct) of task objects: [{"id":"string","description":"short label","prompt":"full instructions"}]',
          },
          },
          required: ['tasks'],
        },
        handler: async (args: { tasks: any }) => {
          let raw: any = args.tasks;
          if (Array.isArray(raw)) {
            raw = JSON.stringify(raw);
          }
          let taskSpecs: TaskSpec[];
          try {
            taskSpecs = JSON.parse(raw);
          } catch {
            return 'Error: Could not parse tasks. Provide a JSON array (string or direct) of {id, description, prompt} objects.';
          }

          if (!Array.isArray(taskSpecs) || taskSpecs.length === 0) {
            return 'Error: tasks must be a non-empty JSON array.';
          }

          if (taskSpecs.length > MAX_CONCURRENCY) {
            return `Error: Maximum ${MAX_CONCURRENCY} parallel tasks allowed. Got ${taskSpecs.length}.`;
          }

          // Validate each task
          for (const t of taskSpecs) {
            if (!t.id || !t.prompt) {
              return `Error: Each task must have "id" and "prompt" fields. Invalid task: ${JSON.stringify(t)}`;
            }
          }

          // Execute tasks in parallel
          const results = await Promise.all(
            taskSpecs.map(async (task): Promise<TaskResult> => {
              try {
                const subAgent = new LeanAgent({
                  provider: opts.provider,
                  workingDir: opts.workingDir ?? process.cwd(),
                  providerId: opts.providerId,
                  modelId: opts.modelId,
                  systemPrompt:
                    'You are a focused sub-agent executing a specific task. ' +
                    'Complete the task efficiently and report what you did. ' +
                    `Working directory: ${opts.workingDir ?? process.cwd()}`,
                });

                const response = await subAgent.chat(task.prompt, false);
                return {
                  id: task.id,
                  description: task.description || task.id,
                  success: true,
                  output: response.content,
                };
              } catch (error) {
                return {
                  id: task.id,
                  description: task.description || task.id,
                  success: false,
                  output: `Error: ${(error as Error).message}`,
                };
              }
            })
          );

          // Format results
          const lines: string[] = [`Parallel execution complete: ${results.length} tasks`];
          for (const r of results) {
            const status = r.success ? 'OK' : 'FAILED';
            lines.push(`\n--- [${status}] ${r.id}: ${r.description} ---`);
            lines.push(r.output);
          }

          return lines.join('\n');
        },
      },
    ];

    const toolSuite: ToolSuite = {
      id: 'agent-spawning.tools',
      description: 'Parallel agent spawning tools',
      tools,
    };

    return { id: this.id, description: this.description, toolSuite };
  }
}

export function createAgentSpawningToolPlugin(options: AgentSpawningOptions): ToolPlugin {
  return {
    id: 'tool.agent-spawning',
    targets: ['universal'],
    create: () => new AgentSpawningModule(options),
  };
}
