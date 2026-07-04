/**
 * EnterPlanMode / ExitPlanMode — Claude-Code-parity planning workflow.
 *
 * The agent enters plan mode to write down a multi-step implementation
 * plan that the user reviews and approves before any tool that mutates
 * state runs. ExitPlanMode is called when the plan is approved.
 *
 * Plans are persisted to <workingDir>/.vigil/plans/<id>.json so the
 * portal can render them and the user can revisit them later.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '../core/toolRuntime.js';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  status: PlanStepStatus;
}

export interface PlanRecord {
  id: string;
  title: string;
  goal?: string;
  steps: PlanStep[];
  status: 'draft' | 'approved' | 'completed' | 'abandoned';
  createdAt: string;
  updatedAt: string;
}

let ACTIVE_PLAN: PlanRecord | null = null;

function planStore(workingDir: string): string {
  return join(workingDir, '.vigil', 'plans');
}

function planPath(workingDir: string, id: string): string {
  return join(planStore(workingDir), `${id}.json`);
}

function safeId(input: unknown): string {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s) return `plan-${Date.now().toString(36)}`;
  return s.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
}

function nowIso(): string {
  return new Date().toISOString();
}

function persist(workingDir: string, plan: PlanRecord): void {
  const dir = planStore(workingDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(planPath(workingDir, plan.id), JSON.stringify(plan, null, 2), 'utf-8');
}

export function getActivePlan(): PlanRecord | null {
  return ACTIVE_PLAN ? { ...ACTIVE_PLAN, steps: [...ACTIVE_PLAN.steps] } : null;
}

export function clearActivePlan(): void {
  ACTIVE_PLAN = null;
}

export function listStoredPlans(workingDir: string): PlanRecord[] {
  const dir = planStore(workingDir);
  if (!existsSync(dir)) return [];
  const out: PlanRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), 'utf-8')) as PlanRecord);
    } catch {
      // Skip malformed plan files.
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createPlanModeTools(workingDir: string): ToolDefinition[] {
  return [
    {
      name: 'EnterPlanMode',
      description:
        'Open a structured plan for a multi-step task and pause execution ' +
        'until the user approves it. Pass title + goal + steps[]. The plan ' +
        'is persisted to .vigil/plans/ and surfaced in the portal. Use ' +
        'this for any change spanning multiple files or systems.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Optional stable id (alnum/-/_, ≤96 chars).' },
          title: { type: 'string', description: 'Short title (≤120 chars).' },
          goal: { type: 'string', description: 'One-sentence goal/outcome.' },
          steps: {
            type: 'array',
            description: 'Ordered steps. Each: { title, detail? }.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                detail: { type: 'string' },
              },
              required: ['title'],
            },
          },
        },
        required: ['title', 'steps'],
      },
      handler: async (args) => {
        const id = safeId(args['id']);
        const title = String(args['title'] ?? '').trim().slice(0, 120) || 'Untitled plan';
        const goal = typeof args['goal'] === 'string' ? args['goal'].trim() : undefined;
        const rawSteps = Array.isArray(args['steps']) ? args['steps'] : [];
        if (rawSteps.length === 0) {
          return 'EnterPlanMode requires at least one step.';
        }
        const steps: PlanStep[] = rawSteps.map((raw, idx) => {
          const r = raw as Record<string, unknown>;
          return {
            id: `s${idx + 1}`,
            title: typeof r['title'] === 'string' ? r['title'].trim() : `Step ${idx + 1}`,
            detail: typeof r['detail'] === 'string' ? r['detail'] : undefined,
            status: 'pending',
          };
        });
        const plan: PlanRecord = {
          id,
          title,
          ...(goal ? { goal } : {}),
          steps,
          status: 'draft',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        ACTIVE_PLAN = plan;
        persist(workingDir, plan);
        return [
          `Plan "${id}" entered. Awaiting user approval before execution.`,
          `Title: ${title}`,
          goal ? `Goal: ${goal}` : null,
          `Steps:`,
          ...steps.map((s, i) => `  ${i + 1}. ${s.title}${s.detail ? ` — ${s.detail}` : ''}`),
        ]
          .filter(Boolean)
          .join('\n');
      },
    },
    {
      name: 'ExitPlanMode',
      description:
        'Close the active plan. Pass `outcome: "approved"` once the user has ' +
        'okayed the plan and the agent is moving to execute, `"completed"` ' +
        'once all steps are done, or `"abandoned"` if the plan was discarded.',
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: ['approved', 'completed', 'abandoned'],
            description: 'Terminal status for the plan.',
          },
          note: { type: 'string', description: 'Optional explanatory note.' },
        },
        required: ['outcome'],
      },
      handler: async (args) => {
        if (!ACTIVE_PLAN) {
          return 'No active plan; nothing to exit.';
        }
        const outcome = String(args['outcome']) as PlanRecord['status'];
        ACTIVE_PLAN = {
          ...ACTIVE_PLAN,
          status: outcome === 'approved' ? 'approved' : outcome,
          updatedAt: nowIso(),
        };
        persist(workingDir, ACTIVE_PLAN);
        const id = ACTIVE_PLAN.id;
        if (outcome !== 'approved') {
          ACTIVE_PLAN = null;
        }
        const note = typeof args['note'] === 'string' && args['note'].trim() ? ` — ${args['note'].trim()}` : '';
        return `Plan "${id}" exited (${outcome})${note}.`;
      },
    },
    {
      name: 'UpdatePlanStep',
      description:
        'Update the status of a single plan step. Use during execution to ' +
        'mark each step in_progress/completed/skipped as work proceeds.',
      parameters: {
        type: 'object',
        properties: {
          stepId: { type: 'string', description: 'Step id (e.g. "s1") or 1-based index.' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'skipped'],
          },
        },
        required: ['stepId', 'status'],
      },
      handler: async (args) => {
        if (!ACTIVE_PLAN) return 'No active plan.';
        const target = String(args['stepId']);
        const status = String(args['status']) as PlanStepStatus;
        let idx = ACTIVE_PLAN.steps.findIndex((s) => s.id === target);
        if (idx < 0) {
          const numeric = Number.parseInt(target, 10);
          if (Number.isFinite(numeric)) idx = numeric - 1;
        }
        if (idx < 0 || idx >= ACTIVE_PLAN.steps.length) {
          return `Step "${target}" not found.`;
        }
        ACTIVE_PLAN.steps[idx]!.status = status;
        ACTIVE_PLAN.updatedAt = nowIso();
        persist(workingDir, ACTIVE_PLAN);
        return `Step ${idx + 1} (${ACTIVE_PLAN.steps[idx]!.title}) → ${status}.`;
      },
    },
  ];
}
