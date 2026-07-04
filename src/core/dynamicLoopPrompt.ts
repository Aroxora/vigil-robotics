/**
 * Dynamic Loop Prompt Generator for Vigil
 *
 * Generates unique, context-aware prompts for the /loop auto-prompt mode.
 * DeepSeek V4 Pro is the PRIMARY prompt source — Vigil self-prompts optimally
 * each iteration, removing the need for manual prompting. Falls back to a rich
 * static rotation across all 5 domains only when the API is unavailable.
 *
 * Every iteration produces a truly unique prompt — no two runs are ever identical.
 */

import { getSecretValue } from './secretStore.js';

// ── Domain type ───────────────────────────────────────────────────────────
export type LoopDomain = 'general-coding' | 'security' | 'cybersecurity';

// ── Phase definitions per domain ──────────────────────────────────────────
interface PhaseDef {
  phase: string;
  header: string;
  context: string;
}

const DOMAIN_PHASES: Record<LoopDomain, PhaseDef[]> = {
  'general-coding': [
    { phase: 'explore', header: 'Explore the codebase structure.', context: 'Map out the codebase architecture, identify key modules, dependencies, and entry points. Look at package.json, tsconfig, and directory structure.' },
    { phase: 'implement', header: 'Implement feature or fix.', context: 'Write production-quality code. Follow existing patterns and conventions. Ensure type safety, error handling, and edge case coverage.' },
    { phase: 'test', header: 'Write and run tests.', context: 'Create comprehensive unit tests covering happy paths, edge cases, error conditions, and boundary values. Run the test suite to verify.' },
    { phase: 'refactor', header: 'Refactor for quality.', context: 'Improve code quality: reduce duplication, improve naming, extract helpers, simplify conditionals. Maintain backward compatibility.' },
    { phase: 'optimize', header: 'Optimize performance.', context: 'Profile and optimize critical paths. Reduce complexity, memory usage, and I/O bottlenecks. Measure before and after.' },
    { phase: 'document', header: 'Document the changes.', context: 'Add clear inline comments, update relevant docs, ensure types are well-documented. Focus on why, not what.' },
    { phase: 'review', header: 'Review and validate.', context: 'Review all recent changes for correctness, security, and style. Run linting and type checking. Verify edge cases are handled.' },
  ],
  security: [
    { phase: 'discover', header: '开始自主安全发现流程。阶段：资产发现。', context: '映射资产、开放端口、运行服务、可达性和网络拓扑。全面简洁。识别所有攻击面。' },
    { phase: 'assess', header: '上一阶段已完成。进入漏洞评估阶段。', context: '识别漏洞，检查 CVE/CNNVD 数据库，评估利用成熟度，按风险优先级排序。' },
    { phase: 'harden', header: '上一阶段已完成。进入安全加固阶段。', context: '推荐具体加固步骤：补丁、禁用、配置、隔离。优先处理影响最大的修复。包含验证步骤。' },
    { phase: 'detect', header: '上一阶段已完成。进入检测阶段。', context: '建议检测规则（Sigma、YARA、SIEM 查询）。调整以减少误报。映射到 MITRE ATT&CK。' },
    { phase: 'hunt', header: '上一阶段已完成。进入威胁狩猎阶段。', context: '基于当前发现生成威胁猎杀假设。定义遥测源、IOC 指标和猎杀方法。' },
    { phase: 'respond', header: '上一阶段已完成。进入响应阶段。', context: '制定事件响应行动：遏制、根除、恢复。包含验证步骤、回滚计划和经验教训。' },
    { phase: 'validate', header: '上一阶段已完成。进入验证阶段。', context: '验证所有前一阶段：重新扫描、确认补丁已应用、确认检测规则生效、确保无回退。报告合规状态。' },
  ],
  cybersecurity: [
    { phase: 'audit', header: 'Begin cybersecurity audit phase.', context: 'Perform comprehensive security audit: review configurations, access controls, encryption standards, logging, and monitoring coverage.' },
    { phase: 'pentest', header: 'Begin pentest phase.', context: 'Simulate adversarial tactics: port scanning, service enumeration, vulnerability probing, weak credential testing. Document all findings.' },
    { phase: 'compliance', header: 'Previous iterations completed. Now shift to the compliance phase.', context: 'Map findings to compliance frameworks: NIST 800-53, CIS Controls, ISO 27001, PCI DSS, HIPAA. Identify gaps and prioritize remediation.' },
    { phase: 'remediate', header: 'Previous iterations completed. Now shift to the remediate phase.', context: 'Develop prioritized remediation plan with concrete actions, timelines, and ownership. Include quick wins and long-term strategic improvements.' },
    { phase: 'monitor', header: 'Previous iterations completed. Now shift to the monitor phase.', context: 'Configure continuous monitoring: alert rules, anomaly detection, log aggregation, threat intelligence feeds. Set up dashboards and reporting.' },
    { phase: 'train', header: 'Previous iterations completed. Now shift to the train phase.', context: 'Develop security awareness training: phishing simulations, secure coding practices, incident response drills. Track completion and effectiveness.' },
    { phase: 'forecast', header: 'Previous iterations completed. Now shift to the forecast phase.', context: 'Analyze threat landscape trends, emerging TTPs, and new vulnerability classes. Forecast future risks and recommend proactive defenses.' },
  ],
};

const DOMAIN_ROTATION: LoopDomain[] = ['security', 'cybersecurity', 'general-coding'];

// ── Unique ID generation ──────────────────────────────────────────────────
function uniqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${process.hrtime.bigint().toString(36).slice(-6)}`;
}

// ── Prompt generation queue (pre-generate for next iteration) ─────────────
const promptCache: Map<string, string> = new Map();
let apiAvailable: boolean | null = null;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

function cacheKey(domain: LoopDomain, iteration: number): string {
  return `${domain}:${iteration}`;
}

// ── DeepSeek API call for optimal prompt generation ───────────────────────
async function deepseekGeneratePrompt(
  domain: LoopDomain,
  phase: string,
  iteration: number,
  previousPrompts?: string[],
): Promise<string | null> {
  const apiKey = getSecretValue('DEEPSEEK_API_KEY') || process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey.length < 10) {
    apiAvailable = false;
    return null;
  }

  const domainContexts: Record<LoopDomain, string> = {
    'general-coding': 'software engineering, code review, testing, refactoring, build pipelines',
    security: '安全防御 — 资产发现、漏洞评估、安全加固、检测工程、威胁狩猎、事件响应',
    cybersecurity: '一般网络安全 — 审计、渗透测试、合规、修复、监控、威胁情报',
  };

  const toolList = [
    'Bash (shell commands, npm, git, build tools)',
    'Read/Write/Edit (file operations)',
    'Glob/Grep (code search)',
    'WebSearch/WebFetch (internet research)',
    'TodoWrite (task planning)',
    'parallel_agents (multi-agent orchestration, max 5 concurrent)',
    'MCP servers: Ghidra (binary analysis), Kali (security tools)',
  ];

  const diversityHint = previousPrompts?.length
    ? `\nPreviously used prompts (avoid repeating these patterns):\n${previousPrompts.slice(-5).map((p, i) => `${i + 1}. ${p.slice(0, 120)}`).join('\n')}`
    : '';

  const systemPrompt = `You are the Vigil autonomous loop prompt generator. Your job: generate ONE optimal, self-directed prompt that a Vigil security agent will execute autonomously.

The agent has access to these tools:
${toolList.map(t => `- ${t}`).join('\n')}

Current context:
- Domain: ${domain} (${domainContexts[domain]})
- Phase: ${phase}
- Iteration: ${iteration}${diversityHint}

CRITICAL RULES:
1. Generate a SINGLE concise, specific, actionable prompt — no preamble, no markdown, no "Here's a prompt:"
2. The prompt must tell the agent exactly what to DO — include specific tools to use, targets to analyze, and expected output
3. Vary targets, techniques, tools, and focus areas each time — never repeat patterns
4. For security operations: vary exploit types (SSRF, XSS, SQLi, RCE, LFI, deserialization), CVEs, ports, services, hardening techniques
5. For offensive testing: vary binary formats (ELF, PE, Mach-O), analysis techniques, vulnerability classes
6. For attack operations: always emphasize bounded scope, self-destruct, audit trails, and admin sign-off
7. For coding: vary languages (TS, JS, Python, Rust), patterns (async, error handling, testing, refactoring)
8. For cybersecurity: vary frameworks (等级保护 GB/T 22239, 网络安全法, 数据安全法, 个人信息保护法), cloud providers, attack surfaces
9. Make the prompt self-contained — the agent should be able to execute it without external context
10. Include a concrete success criterion: what output proves the task is complete`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Generate a unique, self-contained ${domain} prompt for autonomous execution. Phase: "${phase}". Iteration #${iteration}. Make it different from typical prompts.` },
        ],
        max_tokens: 300,
        temperature: 0.95,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) apiAvailable = false;
      return null;
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      consecutiveFailures++;
      return null;
    }

    consecutiveFailures = 0;
    apiAvailable = true;
    return content;
  } catch {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) apiAvailable = false;
    return null;
  }
}

// ── Static fallback: rich rotation across all domains ─────────────────────
function generateStaticPrompt(domain: LoopDomain, phaseIndex: number, iteration: number): string {
  const phases = DOMAIN_PHASES[domain];
  const phaseDef = phases[phaseIndex % phases.length]!;
  const ts = new Date().toISOString();
  const id = uniqueId();

  return `[AUTO-LOOP #${iteration} — ${domain}/${phaseDef.phase} — ${ts} — ${id}]\n${phaseDef.header}\n${phaseDef.context}`;
}

// ── Public API ────────────────────────────────────────────────────────────
export interface DynamicLoopConfig {
  iteration: number;
  domain?: LoopDomain;
  phaseIndex?: number;
  useAI?: boolean;
}

/**
 * Pre-generate the next iteration's prompt in the background.
 * Call this AFTER the current iteration fires so the next one
 * has an AI-generated prompt ready.
 */
export async function preGenerateNextPrompt(iteration: number): Promise<void> {
  const nextDomain = DOMAIN_ROTATION[iteration % DOMAIN_ROTATION.length]!;
  const phases = DOMAIN_PHASES[nextDomain];
  const nextPhaseIdx = iteration % phases.length;
  const nextPhase = phases[nextPhaseIdx]!;

  const key = cacheKey(nextDomain, iteration + 1);

  // Skip if already cached or API known unavailable
  if (promptCache.has(key) || apiAvailable === false) return;

  const aiPrompt = await deepseekGeneratePrompt(nextDomain, nextPhase.phase, iteration + 1);
  if (aiPrompt) {
    promptCache.set(key, aiPrompt);
  }
}

/**
 * Generate a unique, context-aware prompt for a loop iteration.
 * Attempts DeepSeek API first; falls back to static rotation.
 * Uses pre-generated cache when available.
 */
export async function generateDynamicLoopPrompt(config: DynamicLoopConfig): Promise<string> {
  const { iteration } = config;

  const domain = config.domain ?? DOMAIN_ROTATION[(iteration - 1) % DOMAIN_ROTATION.length]!;
  const phases = DOMAIN_PHASES[domain];
  const phaseIdx = config.phaseIndex ?? (iteration - 1) % phases.length;
  const phase = phases[phaseIdx]!;

  // Try cache first (pre-generated prompt)
  const key = cacheKey(domain, iteration);
  const cached = promptCache.get(key);
  if (cached) {
    promptCache.delete(key);
    const ts = new Date().toISOString();
    const id = uniqueId();
    return `[AUTO-LOOP #${iteration} — ${domain}/${phase.phase} — ${ts} — ${id}]\n${cached}`;
  }

  // Try live AI generation
  if (config.useAI !== false && apiAvailable !== false) {
    const aiPrompt = await deepseekGeneratePrompt(domain, phase.phase, iteration);
    if (aiPrompt) {
      const ts = new Date().toISOString();
      const id = uniqueId();
      return `[AUTO-LOOP #${iteration} — ${domain}/${phase.phase} — ${ts} — ${id}]\n${aiPrompt}`;
    }
  }

  // Fall back to static rotation
  return generateStaticPrompt(domain, phaseIdx, iteration);
}

/**
 * Synchronous static fallback — used when async generation is not possible.
 */
export function generateStaticLoopPrompt(iteration: number): string {
  const domain = DOMAIN_ROTATION[(iteration - 1) % DOMAIN_ROTATION.length]!;
  const phases = DOMAIN_PHASES[domain];
  const phaseIdx = (iteration - 1) % phases.length;
  return generateStaticPrompt(domain, phaseIdx, iteration);
}

/**
 * Get the total number of unique phase combinations across all domains.
 */
export function getTotalPhaseCount(): number {
  return Object.values(DOMAIN_PHASES).reduce((sum, phases) => sum + phases.length, 0);
}

/**
 * Get the domain and phase for a given iteration.
 */
export function getIterationDomainAndPhase(iteration: number): { domain: LoopDomain; phase: string } {
  const domain = DOMAIN_ROTATION[(iteration - 1) % DOMAIN_ROTATION.length]!;
  const phases = DOMAIN_PHASES[domain];
  const phaseIdx = (iteration - 1) % phases.length;
  return { domain, phase: phases[phaseIdx]!.phase };
}

/**
 * Check if the DeepSeek API is currently available for prompt generation.
 */
export function isApiAvailable(): boolean | null {
  return apiAvailable;
}

/**
 * Clear the prompt cache and reset API availability.
 */
export function resetLoopState(): void {
  promptCache.clear();
  apiAvailable = null;
  consecutiveFailures = 0;
}
