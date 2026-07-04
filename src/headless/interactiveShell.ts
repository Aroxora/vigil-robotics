/**
 * Interactive Shell - Full interactive CLI experience with rich UI.
 *
 * Usage:
 *   agi                    # Start interactive shell
 *   agi "initial prompt"   # Start with initial prompt
 *
 * Features:
 * - Rich terminal UI with status bar
 * - Command history
 * - Streaming responses
 * - Tool execution display
 * - Ctrl+C to interrupt
 */

import { stdin, stdout, exit } from 'node:process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exec as childExec } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import gradientString from 'gradient-string';

// Readable muted color for dark terminals (replaces chalk.dim which is often invisible on dark backgrounds)
const muted = (s: string) => chalk.hex('#9CA4B0')(s);
import { getHITL, hitlEvents } from '../core/hitl.js';
// Auth/login removed — Vigil is local-only with user-provided keys.

// Stub functions (antiTermination removed)
const initializeProtection = (_config?: unknown) => {};
const enterCriticalSection = (_name?: string) => {};
const exitCriticalSection = (_name?: string) => {};

// Import real shutdown handler for reliable Ctrl+C handling
import { authorizedShutdown, installSignalHandlers, onShutdown, isShutdownInProgress } from '../core/shutdown.js';

import type { ProfileName, ResolvedProfileConfig } from '../config.js';
import { DEFAULT_PROFILE_NAME, normalizeProfileName, resolveProfileConfig } from '../config.js';
import { hasAgentProfile } from '../core/agentProfiles.js';
import { createAgentController, type AgentController } from '../runtime/agentController.js';
import { resolveWorkspaceCaptureOptions, buildWorkspaceContext } from '../workspace.js';
import { loadAllSecrets, listSecretDefinitions, setSecretValue, getSecretValue, type SecretName } from '../core/secretStore.js';
import { type MenuItem } from '../ui/ink/InkPromptController.js';
import { getConfiguredProviders, getProvidersStatus, quickCheckProviders, getCachedDiscoveredModels, sortModelsByPriority, type QuickProviderStatus, type ProviderInfo } from '../core/modelDiscovery.js';
import type { ModelConfig } from '../core/agentSchemaLoader.js';
import { saveModelPreference } from '../core/preferences.js';
import { setDebugMode, debugSnippet, logDebug } from '../utils/debugLogger.js';
import type { AgentEventUnion } from '../contracts/v1/agent.js';
import type { ProviderId } from '../core/types.js';

const exec = promisify(childExec);
import { ensureNextSteps } from '../core/finalResponseFormatter.js';
import { getTaskCompletionDetector, detectFailingTestOrBuild } from '../core/taskCompletionDetector.js';
import { checkForUpdates, formatUpdateNotification, hasPendingSession, loadSessionState, clearSessionState, performBackgroundUpdate, type UpdateInfo } from '../core/updateChecker.js';
import { theme } from '../ui/theme.js';
import { startNewRun } from '../tools/fileChangeTracker.js';
import { reportStatus, setStatusSink } from '../utils/statusReporter.js';
import { getSharedMcpManager } from '../plugins/tools/mcp/mcpClient.js';
import { loadAgentRulebook } from '../core/agentRulebook.js';
import { generateDynamicLoopPrompt, generateStaticLoopPrompt, getTotalPhaseCount, preGenerateNextPrompt, resetLoopState } from '../core/dynamicLoopPrompt.js';

// Timeout constants for regular prompt processing (reasoning models like DeepSeek)
const PROMPT_REASONING_TIMEOUT_MS = 60 * 1000; // 60 seconds max for reasoning-only without action
// Per-step timeout: how long we'll wait for the *next* event before
// declaring the stream stuck and bailing out. Set generously (10 min) so
// long-running tool calls (a build, a slow `npm install`, etc.) don't
// trip it, but short enough that a dead provider / network drop doesn't
// leave the user staring at a forever-spinner with Ctrl+C as their only
// escape. iterateWithTimeout resets this per-event, so it only fires on
// genuine inactivity. Override with VIGIL_STEP_TIMEOUT_MS for tests.
const PROMPT_STEP_TIMEOUT_MS = (() => {
  const env = process.env['VIGIL_STEP_TIMEOUT_MS'];
  const parsed = env ? Number(env) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 10 * 60 * 1000;
})();
const HITL_TOOL_PREFIX = 'HITL_';

const isHitlToolName = (toolName: string): boolean => toolName.startsWith(HITL_TOOL_PREFIX);

/**
 * Iterate over an async iterator with a timeout per iteration.
 * If no event is received within the timeout, yields a special timeout marker.
 * Emits timeout markers without aborting the underlying iterator.
 * Pass Infinity to disable timeouts entirely.
 */
async function* iterateWithTimeout<T>(
  iterator: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout?: () => void
): AsyncGenerator<T | { __timeout: true }> {
  const asyncIterator = iterator[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<T>> | null = null;
  let done = false;

  // If timeout is Infinity or not a positive finite number, disable timeout entirely
  const timeoutDisabled = !Number.isFinite(timeoutMs) || timeoutMs <= 0;

  try {
    while (true) {
      if (!pending) {
        pending = asyncIterator.next();
      }

      let result: IteratorResult<T> | { __timeout: true };

      if (timeoutDisabled) {
        // No timeout - just wait for the next value
        result = await pending;
      } else {
        // Race between pending result and timeout
        const timeoutPromise = new Promise<{ __timeout: true }>((resolve) =>
          setTimeout(() => resolve({ __timeout: true }), timeoutMs)
        );
        result = await Promise.race([pending, timeoutPromise]);
      }

      if ('__timeout' in result) {
        onTimeout?.();
        yield result;
        continue;
      }

      pending = null;
      if (result.done) {
        done = true;
        return;
      }

      yield result.value;
    }
  } finally {
    if (!done && typeof asyncIterator.return === 'function') {
      try {
        await asyncIterator.return(undefined);
      } catch {
        // Ignore return errors
      }
    }
  }
}

let cachedVersion: string | null = null;

// Get version from package.json
function getVersion(): string {
  if (cachedVersion) return cachedVersion;

  try {
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = resolve(dirname(__filename), '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    cachedVersion = pkg.version || '0.0.0';
    return cachedVersion!;
  } catch {
    return '0.0.0';
  }
}

// Clean minimal banner with premium visual polish
const BANNER_GRADIENT = gradientString(['#6366F1', '#8B5CF6', '#A78BFA']);
const VIGIL_BANNER_RENDERED = BANNER_GRADIENT('  ◈  Vigil') + chalk.hex('#94A3B8')('  ·  Robotics Control CLI');


export interface InteractiveShellOptions {
  argv: string[];
}

interface ParsedArgs {
  initialPrompt?: string | null;
}

/**
 * Run the fully interactive shell with rich UI.
 */
export async function runInteractiveShell(options: InteractiveShellOptions): Promise<void> {
  // Install signal handlers FIRST for reliable Ctrl+C handling
  installSignalHandlers();

  // Initialize protection systems
  initializeProtection({
    interceptSignals: true,
    monitorResources: true,
    armorExceptions: true,
    enableWatchdog: true,
    verbose: process.env['VIGIL_DEBUG'] === '1',
  });

  // The CLI is interactive-only. There is no piped / one-shot / headless
  // mode — every session runs through the Ink renderer against a live
  // terminal. If stdin or stdout isn't a TTY, fail fast with a clear
  // message rather than emitting unrenderable escape sequences into a
  // pipe.
  if (!stdin.isTTY || !stdout.isTTY) {
    reportStatus('vigil requires an interactive terminal. Run it directly in a TTY (no pipes, no shell redirection).');
    exit(1);
  }

  loadAllSecrets();

  const parsed = parseArgs(options.argv);
  const profile = resolveProfile();
  const workingDir = process.cwd();

  const workspaceOptions = resolveWorkspaceCaptureOptions(process.env);
  const workspaceContext = buildWorkspaceContext(workingDir, workspaceOptions);

  // Resolve profile config for model info
  const profileConfig = resolveProfileConfig(profile, workspaceContext);

  // Create agent controller
  const controller = await createAgentController({
    profile,
    workingDir,
    workspaceContext,
    env: process.env,
  });

  // Create the interactive shell instance
  const shell = new InteractiveShell(controller, profile, profileConfig, workingDir);

  // Handle initial prompt if provided
  if (parsed.initialPrompt) {
    shell.queuePrompt(parsed.initialPrompt);
  }

  await shell.run();
}

// ── 安全阶段自动路由 ────────────────────────────────────────────────────

/** Maps each phase id to keyword signals that indicate the user wants that phase. */
const PHASE_KEYWORD_MAP: Record<string, string[]> = {
  'phase.discover':         ['discover', 'enumerate', 'inventory', 'nmap', 'masscan', 'scan network', 'attack surface', 'asset register', 'map hosts', 'find hosts', 'port scan', 'subnet', 'cidr', 'fingerprint', 'service detection', 'banner grab', 'shodan', 'censys', 'fofa', 'recon', 'reconnaissance', 'passive recon', 'dns enum', 'zone transfer', 'subdomain', 'whois', 'asn', 'cloud asset', 's3 bucket', 'exposed endpoint'],
  'phase.assess':           ['cve', 'vuln', 'vulnerability', 'trivy', 'grype', 'nuclei', 'openvas', 'nessus', 'risk assessment', 'exploit', 'patch level', 'cisa kev', 'cvss', 'cpe', 'epss', 'nvd', 'osv', 'ghsa', 'advisory', 'security advisory', 'affected version', 'severity', 'critical finding', 'high severity', 'zero day', '0day', 'rce', 'remote code execution', 'sqli', 'xss', 'ssrf', 'lfi', 'rfi', 'deserialization', 'privilege escalation'],
  'phase.baseline':         ['cis benchmark', 'stig', 'nist 800', 'compliance', 'configuration audit', 'hardening benchmark', 'baseline audit', 'scap', 'openscap', 'lynis', 'disa', 'pci dss', 'hipaa', 'fedramp', 'iso 27001', 'center for internet security', 'security configuration', 'misconfiguration', 'default credential', 'default password', 'exposed admin'],
  'phase.harden':           ['harden', 'hardening', 'close port', 'disable service', 'attack surface reduction', 'firewall rule', 'ufw', 'selinux', 'apparmor', 'least privilege', 'remove unused', 'disable unused', 'tls config', 'cipher suite', 'headers', 'csp header', 'hsts', 'secure cookie', 'password policy', 'mfa', 'network segmentation', 'vlan', 'dmz', 'egress filter'],
  'phase.detect':           ['sigma', 'suricata', 'snort', 'yara', 'detection rule', 'alert rule', 'mitre att&ck', 'ttp', 'technique t1', 'edr rule', 'splunk query', 'elastic query', 'siem', 'kql', 'kibana', 'detection logic', 'write a rule', 'create a rule', 'generate a rule', 'log source', 'event id', 'windows event', 'audit log', 'cloudtrail', 'guardduty'],
  'phase.hunt':             ['threat hunt', 'hunt for', 'search for ioc', 'lateral movement', 'beaconing', 'anomalous', 'indicator of compromise', 'ioc', 'psexec', 'mimikatz', 'cobalt strike', 'c2', 'command and control', 'persistence mechanism', 'scheduled task', 'registry run key', 'startup folder', 'cron job', 'web shell', 'living off the land', 'lolbin', 'powershell encoded', 'wmi abuse', 'unusual process', 'unusual connection'],
  'phase.respond':          ['incident', 'breach', 'contain', 'isolate', 'eradicate', 'malware', 'ransomware', 'active attack', 'incident response', 'ir playbook', 'forensic', 'triage', 'compromised', 'we were hacked', 'under attack', 'intrusion', 'unauthorized access', 'data exfiltration', 'disk image', 'memory dump', 'volatility', 'chain of custody'],
  'phase.remediate':        ['remediate', 'patch', 'apply fix', 'close finding', 'update package', 'upgrade dep', 'fix cve', 'backlog', 'upgrade to', 'update to', 'install patch', 'mitigation', 'workaround', 'compensating control', 'pin version', 'dependency update'],
  'phase.review':           ['lessons learned', 'post-incident', 'post incident', 'retrospective', 'detection gap', 'after action', 'review incident', 'blameless', 'timeline reconstruction', 'root cause', 'contributing factor', 'mean time to detect', 'mttd', 'mean time to respond', 'mttr'],
  'phase.regression_analysis': ['regression analysis', 'regression check', 'regression risk', 'affected tests', 'test selection', 'release risk', 'validate changes', 'verify no regressions'],
  'phase.variant_analysis': ['variant analysis', 'patchpivot', 'n-day', '0-day variant', 'patch pivot', 'sibling cve', 'root cause analysis cve', 'similar vuln', 'diff the patch', 'patch diff', 'binary diff', 'bindiff', 'ghidra', 'ida pro', 'decompile', 'reverse engineer', 'adjacent cve', 'related vulnerability'],
  'phase.engage':           ['full assessment', 'end-to-end assessment', 'pentest', 'penetration test', 'red team', 'full engagement', 'engagement report', 'security assessment', 'assess and report', 'find and exploit', 'autonomous scan'],
};

/**
 * Build the full phase context block from the rulebook for the given phase id.
 * Returns null if the rulebook can't be loaded or the phase isn't found.
 */
function buildPhaseContext(profile: ProfileName, phaseId: string): string | null {
  try {
    const manifest = loadAgentRulebook(profile);
    const phase = manifest.phases.find((p) => p.id === phaseId);
    if (!phase) return null;

    const lines: string[] = [
      `== 当前安全阶段: ${phase.id} — ${phase.label || phase.id} ==`,
    ];
    if (phase.description) lines.push(phase.description);
    if (phase.trigger) lines.push(`Trigger context: ${phase.trigger}`);

    for (const step of phase.steps ?? []) {
      lines.push(`\nSTEP ${step.id}: ${step.title}`);
      if (step.intent) lines.push(`  Intent: ${step.intent}`);
      if (step.entryCriteria?.length) lines.push(`  Entry: ${step.entryCriteria.join('; ')}`);
      if (step.exitCriteria?.length) lines.push(`  Exit: ${step.exitCriteria.join('; ')}`);
      for (const rule of step.rules ?? []) {
        lines.push(`  [${(rule.severity ?? 'info').toUpperCase()}] (${rule.id}) ${rule.summary}`);
      }
    }

    lines.push('== END PHASE CONTEXT ==\n');
    return lines.join('\n');
  } catch {
    return null;
  }
}

/**
 * 检测用户自由格式消息对应哪个安全阶段.
 * Returns the phase id or null if no phase signal is found.
 * Only fires for messages that look 属于安全相关操作 (not code editing).
 */
function autoDetectPhase(message: string): string | null {
  const lower = message.toLowerCase();
  // Skip if this already has a phase tag (came from a slash command)
  if (lower.startsWith('[cne phase:')) return null;
  // Skip short messages and greetings — they're usually conversational
  if (message.trim().length < 15) return null;

  for (const [phaseId, keywords] of Object.entries(PHASE_KEYWORD_MAP)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return phaseId;
    }
  }
  return null;
}

// ── Session persistence ───────────────────────────────────────────────────────
// Targets and active phase are saved to ~/.vigil/session.json so they survive
// CLI restarts. Load on startup, save on every mutation.

interface PersistedSession {
  targets: string[];
  activePhase: string | null;
  savedAt: string;
}

function sessionFilePath(): string {
  const home = process.env['VIGIL_HOME']?.trim() || join(homedir(), '.vigil');
  return join(home, 'session.json');
}

function loadPersistedSession(): PersistedSession | null {
  try {
    const p = sessionFilePath();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8')) as PersistedSession;
  } catch {
    return null;
  }
}

function savePersistedSession(targets: string[], activePhase: string | null): void {
  try {
    const home = process.env['VIGIL_HOME']?.trim() || join(homedir(), '.vigil');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const data: PersistedSession = { targets, activePhase, savedAt: new Date().toISOString() };
    writeFileSync(sessionFilePath(), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  } catch { /* best-effort */ }
}

// ── Persistent findings store ─────────────────────────────────────────────────
// Findings are saved to ~/.vigil/findings.json so discoveries persist across
// sessions. Each entry is a lightweight record — id, severity, title, target,
// cve (optional), notes, timestamp.

interface FindingRecord {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  target?: string;
  cve?: string;
  notes?: string;
  ts: string;
  // Enrichment fields (populated by /enrich or _finding-enricher.mjs)
  cvss?: number;
  cvss_severity?: string;
  cvss_vector?: string;
  epss?: number;
  epss_percentile?: number;
  kev?: boolean;
  enriched_at?: string;
}

function findingsPath(): string {
  const home = process.env['VIGIL_HOME']?.trim() || join(homedir(), '.vigil');
  return join(home, 'findings.json');
}

function loadFindings(): FindingRecord[] {
  try {
    const p = findingsPath();
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, 'utf-8')) as FindingRecord[];
  } catch {
    return [];
  }
}

function saveFindings(records: FindingRecord[]): void {
  const p = findingsPath();
  mkdirSync(join(homedir(), '.vigil'), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
}

function addFinding(partial: Omit<FindingRecord, 'id' | 'ts'>): FindingRecord {
  const records = loadFindings();
  const id = `F-${Date.now().toString(36).toUpperCase()}`;
  const rec: FindingRecord = { id, ts: new Date().toISOString(), ...partial };
  records.push(rec);
  saveFindings(records);
  return rec;
}

// ── IOC store ─────────────────────────────────────────────────────────────────

interface IocRecord {
  id: string;
  type: 'ip' | 'domain' | 'hash' | 'url' | 'email' | 'mutex' | 'regkey' | 'filename' | 'other';
  value: string;
  context?: string;   // malware family, campaign, incident
  source?: string;    // where it came from
  ts: string;
}

function iocPath(): string {
  const home = process.env['VIGIL_HOME']?.trim() || join(homedir(), '.vigil');
  return join(home, 'iocs.json');
}

function loadIocs(): IocRecord[] {
  try {
    const p = iocPath();
    if (!existsSync(p)) return [];
    return JSON.parse(readFileSync(p, 'utf-8')) as IocRecord[];
  } catch { return []; }
}

function saveIocs(records: IocRecord[]): void {
  const p = iocPath();
  mkdirSync(join(homedir(), '.vigil'), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
}

function inferIocType(value: string): IocRecord['type'] {
  if (/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(value)) return 'ip';
  if (/^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/.test(value)) return 'hash';
  if (/^https?:\/\//.test(value)) return 'url';
  if (/^[^@]+@[^@]+\.[^@]+$/.test(value)) return 'email';
  if (/\.[a-z]{2,}$/i.test(value) && !value.includes('/')) return 'domain';
  if (/^HKEY_|^HKLM\\|^HKCU\\/i.test(value)) return 'regkey';
  return 'other';
}

/**
 * Extract a short, meaningful snippet from the model's reasoning stream
 * for displaying in the status line. Strips leading thinking markers
 * ("Okay,", "I need to", "Let me", "The user") and returns the last
 * meaningful sentence up to 70 chars as a preview of what the model is
 * actively working on.
 */
function extractReasoningSnippet(content: string): string {
  const cleaned = content
    .replace(/^(Okay,?\s*|I (need|should|will|can|want|must)\s+|Let me\s+|The user\s+|First,?\s*)/i, '')
    .replace(/^\n+/, '')
    .trim();
  const maxLen = 70;
  if (cleaned.length <= maxLen) return cleaned || 'Thinking...';
  // Try to break at a word boundary
  const truncated = cleaned.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.6) {
    return truncated.slice(0, lastSpace) + '...';
  }
  return truncated + '...';
}

class InteractiveShell {
  private controller: AgentController;
  private readonly profile: ProfileName;
  private profileConfig: ResolvedProfileConfig;
  private readonly workingDir: string;
  // Always an InkPromptController instance (Ink is the only renderer
  // — the legacy PromptController was removed 2026-05-09). The `any`
  // keeps call sites unchanged across the IPromptController surface
  // without forcing every caller to declare nullability up-front.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private promptController: any = null;
  private isProcessing = false;
  private shouldExit = false;
  private pendingPrompts: string[] = [];
  private debugEnabled = false;
  private ctrlCCount = 0;
  private lastCtrlCTime = 0;
  // Set when the user Ctrl+C interrupts a run; suppresses the auto-continue
  // re-launch in the finally block of processPrompt so the agent doesn't
  // immediately resume the work the user just cancelled. Cleared when the
  // user submits a fresh prompt.
  private userInterruptedRun = false;
  // Session-level aggregates rolled up across every processPrompt call,
  // exposed via /stats while the shell is live.
  private readonly sessionToolsUsed = new Set<string>();
  private readonly sessionFilesModified = new Set<string>();
  private sessionTokensIn = 0;
  private sessionTokensOut = 0;
  private cachedProviders: QuickProviderStatus[] | null = null;
  private secretInputMode: { active: boolean; secretId: SecretName | null; queue: SecretName[] } = {
    active: false,
    secretId: null,
    queue: [],
  };
  private pendingModelSwitch: { provider: ProviderId; model: string | null } | null = null;
  private currentResponseBuffer = '';
  // Store original prompt for auto-continuation
  private originalPromptForAutoContinue: string | null = null;
  // ── Session-scoped vuln-ops state ────────────────────────────────────────
  /** Targets registered with /target for this session (hosts, CIDRs, URLs). */
  private sessionTargets: string[] = [];
  /** Active phase override set by /phase command or last slash-phase command. */
  private sessionActivePhase: string | null = null;
  // ── /loop state ──────────────────────────────────────────────────────────
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private loopPrompt: string = '';
  private loopIntervalMs: number = 0;
  private loopIteration: number = 0;
  private loopTotalIterations: number = 0;
  private loopActive: boolean = false;
  /** Cached result from async DeepSeek prompt generation for the next loop iteration. */
  private _lastGeneratedPrompt: string | null = null;
  /** Whether the next iteration should use the AI-generated prompt (auto-prompt mode). */
  private _loopUseAI: boolean = false;
  /** Background KEV watch — timer handle and sentinel PID. */
  private _kevWatchTimer: ReturnType<typeof setInterval> | undefined = undefined;
  private _kevWatchPid: number | undefined = undefined;
  // (Pinned prompt removed per request — field intentionally absent.)

  constructor(controller: AgentController, profile: ProfileName, profileConfig: ResolvedProfileConfig, workingDir: string) {
    this.controller = controller;
    this.profile = profile;
    this.profileConfig = profileConfig;
    this.workingDir = workingDir;

    // Pre-fetch provider status in background
    void this.fetchProviders();
  }

  private async fetchProviders(): Promise<void> {
    try {
      this.cachedProviders = await quickCheckProviders();
    } catch {
      this.cachedProviders = [];
    }
  }

  private validateRequiredApiKeys(): void {
    const missingKeys: SecretName[] = [];

    // Check DeepSeek API key (required)
    if (!getSecretValue('DEEPSEEK_API_KEY')) {
      missingKeys.push('DEEPSEEK_API_KEY');
    }

    // Prompt for missing keys directly without showing warning
    if (missingKeys.length > 0 && this.promptController) {
      // Queue all missing keys for input
      this.secretInputMode.queue = missingKeys.slice(1); // Rest of the keys
      const first = missingKeys[0];
      if (first) {
        // Set secret mode immediately to mask input
        this.secretInputMode.active = true;
        this.secretInputMode.secretId = first;
        this.promptController.setSecretMode(true);

        // Show the inline panel with instructions
        const secrets = listSecretDefinitions();
        const secret = secrets.find(s => s.id === first);
        if (secret && this.promptController.supportsInlinePanel()) {
          const lines = [
            chalk.bold.hex('#6366F1')(`Set ${secret.label}`),
            muted(secret.description),
            '',
            muted('Enter value (or press Enter to skip)'),
          ];
          this.promptController.setInlinePanel(lines);
          this.promptController.setStatusMessage(`Enter ${secret.label}...`);
        }
      }
    }
  }

  queuePrompt(prompt: string): void {
    this.pendingPrompts.push(prompt);
  }

  async run(): Promise<void> {
    // Ink is the only renderer; createPromptController always returns
    // an InkPromptController. The dynamic import keeps the React + Ink
    // parse cost off the cold-start path of `--version` / `--help` etc.
    const { createPromptController } = await import('../ui/ink/InkPromptController.js');
    this.promptController = await createPromptController(
      stdin as NodeJS.ReadStream,
      stdout as NodeJS.WriteStream,
      {
        onSubmit: (text: string) => this.handleSubmit(text),
        onQueue: (text: string) => this.queuePrompt(text),
        onInterrupt: () => this.handleInterrupt(),
        onExit: () => this.handleExit(),
        onCtrlC: (info: { hadBuffer: boolean }) => this.handleCtrlC(info),
        onToggleAutoContinue: () => this.handleAutoContinueToggle(),
        onToggleHITL: () => this.handleHITLToggle(),
      }
    );

    // Register cleanup callback for graceful shutdown
    onShutdown(() => {
      this.shouldExit = true;
      this.promptController?.stop();
      setStatusSink(null);
    });

    setStatusSink((message) => this.promptController?.setStatusMessage(message));

    // Hand the terminal off to the HITL prompt while it's open: suspend
    // prompt rendering and detach our keypress handler so arrow keys aren't
    // double-consumed. Restore both when the prompt closes so the next turn's
    // input works correctly.
    const onHitlOpen = () => {
      const r = this.promptController?.getRenderer();
      if (!r) return;
      try { r.suspendPromptRendering(); } catch { /* ignore */ }
      try { r.suspendInputCapture(); } catch { /* ignore */ }
    };
    const onHitlClose = () => {
      const r = this.promptController?.getRenderer();
      if (!r) return;
      try { r.resumeInputCapture(); } catch { /* ignore */ }
      try { r.resumePromptRendering(true); } catch { /* ignore */ }
    };
    hitlEvents.on('prompt-open', onHitlOpen);
    hitlEvents.on('prompt-close', onHitlClose);
    onShutdown(() => {
      hitlEvents.removeListener('prompt-open', onHitlOpen);
      hitlEvents.removeListener('prompt-close', onHitlClose);
    });

    // Start the UI
    this.promptController.start();
    this.applyDebugState(this.debugEnabled);

    // Set up sudo password prompt handler
    this.setupSudoPasswordHandler();

    // Set initial status
    this.promptController.setChromeMeta({
      directory: this.workingDir,
    });

    // Register all slash commands for tab completion / suggestion UI
    this.registerSlashCommands();

    // Restore persisted session targets from last run
    this.restoreSession();

    // Seed the status bar badge with initial findings/target counts
    this.syncVigilBadge();

    // Show welcome message
    await this.showWelcome();

    // Pinned prompt loading removed — feature stripped per request.

    // Process any queued prompts
    if (this.pendingPrompts.length > 0) {
      const prompts = this.pendingPrompts.splice(0);
      for (const prompt of prompts) {
        await this.processPrompt(prompt);
      }
    }

    // Keep running until exit
    await this.waitForExit();
  }

  private async showWelcome(): Promise<void> {
    const renderer = this.promptController?.getRenderer();
    if (!renderer) return;

    const version = getVersion();

    const hasApiKey = (process.env.DEEPSEEK_API_KEY?.trim() || '').length > 0;
    const hasTavily = Boolean(process.env['TAVILY_API_KEY']);

    const updateLines: string[] = [];
    const updatePromise: Promise<UpdateInfo | null> = Promise.race([
      checkForUpdates(version).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);

    const updateInfo = await updatePromise;
    if (updateInfo?.updateAvailable) {
      updateLines.push(
        chalk.cyan('  ⬆ ') +
        muted('Update available: ') +
        chalk.yellow(`v${updateInfo.current}`) +
        muted(' → ') +
        chalk.green(`v${updateInfo.latest}`) +
        muted(' · installing in background…'),
      );
      this.runBackgroundUpdate(updateInfo);
    }

    const welcomeLines = [
      '',
      VIGIL_BANNER_RENDERED + chalk.hex('#64748B')('  v' + version),
      '',
      chalk.hex('#475569')('  ┌') + chalk.hex('#475569')('─────────────────────────────────────────'),
      chalk.hex('#475569')('  │ ') + chalk.hex('#3B82F6').bold('Model') + chalk.hex('#64748B')('  ' + this.profileConfig.model + '  ') + chalk.hex('#334155')('·') + chalk.hex('#64748B')('  ') + chalk.hex('#3B82F6').bold('Provider') + chalk.hex('#64748B')('  ' + this.profileConfig.provider),
      chalk.hex('#475569')('  │ ') + chalk.hex('#10B981').bold('DeepSeek') + chalk.hex('#64748B')(hasApiKey ? '  ✓ connected' : '  ✗ unset') + chalk.hex('#334155')('  │  ') + chalk.hex('#10B981').bold('Tavily') + chalk.hex('#64748B')(hasTavily ? '  ✓ connected' : '  ✗ unset'),
      chalk.hex('#475569')('  │ ') + chalk.hex('#F59E0B').bold('Tools') + chalk.hex('#64748B')('  9 unlocked') + chalk.hex('#334155')('  ·  ') + chalk.hex('#F59E0B').bold('License') + chalk.hex('#64748B')('  none required'),
      chalk.hex('#475569')('  │ ') + chalk.hex('#64748B')('Context  1M tokens') + chalk.hex('#334155')('  ·  ') + chalk.hex('#64748B')('pricing  ' + chalk.hex('#22D3EE')('$0.435') + chalk.hex('#64748B')('/$0.14 per 1M')),
      chalk.hex('#475569')('  │'),
      chalk.hex('#475569')('  │ ') + chalk.hex('#94A3B8')('Type a robotics task or ') + chalk.hex('#A78BFA').bold('/help') + chalk.hex('#94A3B8')(' for commands'),
      chalk.hex('#475569')('  └') + chalk.hex('#475569')('─────────────────────────────────────────'),
      ...updateLines,
      '',
    ];

    const welcomeContent = welcomeLines.join('\n');
    renderer.addEvent('banner', welcomeContent);

    this.promptController?.setModelContext({
      model: this.profileConfig.model,
      provider: this.profileConfig.provider,
    });
  }

  /**
   * Kick off `npm install -g <pkg>@latest` in a background process. When it
   * completes, surface a renderer event so the user sees the result without
   * any blocking. The running CLI keeps the old code — the new version is
   * picked up on next launch.
   */
  private runBackgroundUpdate(info: UpdateInfo): void {
    const renderer = this.promptController?.getRenderer();
    void performBackgroundUpdate(info, (msg) => {
      try { renderer?.addEvent('system', msg); } catch { /* ignore */ }
    }).then((res) => {
      if (!res.started) return;
      try {
        renderer?.addEvent('system',
          chalk.green(`✓ Update installer launched for v${info.latest}. `) +
          muted('Exit and reopen the CLI to use the new version.'),
        );
      } catch { /* ignore */ }
    }).catch(() => { /* best-effort */ });
  }

  private setupSudoPasswordHandler(): void {
    // stub: sudo password manager removed in robotics refactor
  }

  private applyDebugState(enabled: boolean, statusMessage?: string): void {
    this.debugEnabled = enabled;
    setDebugMode(enabled);
    this.promptController?.setDebugMode(enabled);
    // Show transient status message instead of chat banner
    if (statusMessage) {
      this.promptController?.setStatusMessage(statusMessage);
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
    }
  }

  private describeEventForDebug(event: AgentEventUnion): string {
    switch (event.type) {
      case 'message.start':
        return 'message.start';
      case 'message.delta': {
        const snippet = debugSnippet(event.content);
        return snippet ? `message.delta → ${snippet}` : 'message.delta (empty)';
      }
      case 'message.complete': {
        const snippet = debugSnippet(event.content);
        return snippet
          ? `message.complete → ${snippet} (${event.elapsedMs}ms)`
          : `message.complete (${event.elapsedMs}ms)`;
      }
      case 'tool.start':
        return `tool.start ${event.toolName}`;
      case 'tool.complete': {
        const snippet = debugSnippet(event.result);
        return snippet
          ? `tool.complete ${event.toolName} → ${snippet}`
          : `tool.complete ${event.toolName}`;
      }
      case 'tool.error':
        return `tool.error ${event.toolName} → ${event.error}`;
      case 'edit.explanation': {
        const snippet = debugSnippet(event.content);
        return snippet ? `edit.explanation → ${snippet}` : 'edit.explanation';
      }
      case 'error':
        return `error → ${event.error}`;
      case 'usage': {
        const parts = [];
        if (event.inputTokens != null) parts.push(`in:${event.inputTokens}`);
        if (event.outputTokens != null) parts.push(`out:${event.outputTokens}`);
        if (event.totalTokens != null) parts.push(`total:${event.totalTokens}`);
        return `usage ${parts.length ? parts.join(', ') : '(no tokens)'}`;
      }
      default:
        return event.type;
    }
  }

  private handleDebugCommand(arg?: string): boolean {
    const normalized = arg?.toLowerCase();

    // /debug alone - toggle
    if (!normalized) {
      const targetState = !this.debugEnabled;
      this.applyDebugState(targetState, `Debug ${targetState ? 'on' : 'off'}`);
      return true;
    }

    // /debug status - show current state
    if (normalized === 'status') {
      this.promptController?.setStatusMessage(`Debug is ${this.debugEnabled ? 'on' : 'off'}`);
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
      return true;
    }

    // /debug on|enable
    if (normalized === 'on' || normalized === 'enable') {
      if (this.debugEnabled) {
        this.promptController?.setStatusMessage('Debug already on');
        setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
        return true;
      }
      this.applyDebugState(true, 'Debug on');
      return true;
    }

    // /debug off|disable
    if (normalized === 'off' || normalized === 'disable') {
      if (!this.debugEnabled) {
        this.promptController?.setStatusMessage('Debug already off');
        setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
        return true;
      }
      this.applyDebugState(false, 'Debug off');
      return true;
    }

    // Invalid argument
    this.promptController?.setStatusMessage(`Invalid: /debug ${arg}. Use on|off|status`);
    setTimeout(() => this.promptController?.setStatusMessage(null), 2500);
    return true;
  }


  /**
   * Synthesize a user-facing response from reasoning content when the model
   * provides reasoning but no actual response (common with deepseek-v4-pro).
   * Extracts key conclusions and formats them as a concise response.
   */
  /** Restore targets and active phase from last session, show a notice if targets were restored. */
  private restoreSession(): void {
    const saved = loadPersistedSession();
    if (!saved?.targets?.length) return;
    this.sessionTargets = saved.targets;
    this.sessionActivePhase = saved.activePhase ?? null;
    // Announce restoration after welcome (via deferred microtask so welcome renders first)
    Promise.resolve().then(() => {
      const renderer = this.promptController?.getRenderer();
      if (renderer && this.sessionTargets.length > 0) {
        renderer.addEvent('system',
          muted('↩ Restored from last session: ') +
          this.sessionTargets.map((t) => chalk.hex('#22D3EE')(t)).join(muted(', ')) +
          muted('  · /target clear to reset')
        );
      }
    });
  }

  /** Push current target + findings counts to the status bar badge. */
  private syncVigilBadge(): void {
    const stored = loadFindings();
    const critHigh = stored.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
    this.promptController?.setVigilContext?.({
      targets: this.sessionTargets.length,
      findings: stored.length,
      critHigh,
    });
  }

  /**
   * Scan a completed agent response for CVE-YYYY-NNNNN patterns.
   * For any CVE not already in the findings store, emit a dim hint
   * suggesting the operator save it with /findings add.
   */
  private autoExtractCVEs(text: string, renderer: ReturnType<typeof this.promptController.getRenderer> | undefined): void {
    if (!renderer || !text) return;
    const matches = text.match(/CVE-\d{4}-\d{4,}/gi);
    if (!matches || matches.length === 0) return;
    const unique = [...new Set(matches.map((c) => c.toUpperCase()))];
    const existing = new Set(loadFindings().map((f) => f.cve?.toUpperCase()).filter(Boolean) as string[]);
    const novel = unique.filter((c) => !existing.has(c));
    if (novel.length === 0) return;

    // Infer severity from surrounding context for each CVE
    const inferSeverity = (cveId: string): FindingRecord['severity'] => {
      // Look for severity keywords within ~150 chars of the CVE mention
      const idx = text.toUpperCase().indexOf(cveId);
      if (idx < 0) return 'high';
      const ctx = text.slice(Math.max(0, idx - 150), idx + 150).toUpperCase();
      if (/CRITICAL|CVSS\s*[:\s]?\s*([89]|10|9\.\d)/.test(ctx)) return 'critical';
      if (/\bHIGH\b|CVSS\s*[:\s]?\s*[78]/.test(ctx)) return 'high';
      if (/\bMEDIUM\b|MODERATE|CVSS\s*[:\s]?\s*[456]/.test(ctx)) return 'medium';
      if (/\bLOW\b|CVSS\s*[:\s]?\s*[123]/.test(ctx)) return 'low';
      return 'high';
    };

    // Auto-save Critical and High CVEs; trigger background enrichment for new ones
    const autoSaved: string[] = [];
    const toHint: string[] = [];

    for (const cve of novel) {
      const sev = inferSeverity(cve);
      if (sev === 'critical' || sev === 'high') {
        const lines = text.split('\n');
        const line = lines.find((l) => l.toUpperCase().includes(cve)) || '';
        const title = line.replace(/\*\*/g, '').replace(/^[-*#\s]+/, '').trim().slice(0, 120) || cve;
        const target = this.sessionTargets[0];
        addFinding({ severity: sev, title, cve, target });
        autoSaved.push(cve);
        existing.add(cve);
      } else {
        toHint.push(cve);
      }
    }

    if (autoSaved.length > 0) {
      this.syncVigilBadge();
      renderer.addEvent('system',
        chalk.red('⚠ Auto-saved CRIT/HIGH: ') +
        autoSaved.map((c) => chalk.white(c)).join(', ') +
        muted('  · /findings to review')
      );
      // Background enrichment — fire-and-forget; best-effort
      if (process.env.VIGIL_SESSION_TOKEN) {
        void import('node:child_process').then(({ spawn }) => {
          const proc = spawn(
            process.execPath,
            ['scripts/vigil-run.mjs', 'scripts/_finding-enricher.mjs'],
            { detached: true, stdio: 'ignore', env: { ...process.env } }
          );
          proc.unref();
        }).catch(() => {/* enrichment best-effort */});
      }
    }
    if (toHint.length > 0) {
      const hint = toHint.length === 1
        ? `  ${muted('New CVE:')}  ${toHint[0]}  ${muted('· /findings add medium <title> to track')}`
        : `  ${muted(`${toHint.length} CVEs mentioned:`)}  ${toHint.slice(0, 5).join(', ')}${toHint.length > 5 ? '…' : ''}  ${muted('· /findings add <sev> <title>')}`;
      renderer.addEvent('system', hint);
    }
  }

  private synthesizeFromReasoning(reasoning: string): string | null {
    if (!reasoning || reasoning.trim().length < 50) {
      return null;
    }

    // Filter out internal meta-reasoning patterns that shouldn't be shown to user
    const metaPatterns = [
      /according to the rules?:?/gi,
      /let me (?:use|search|look|check|find|think|analyze)/gi,
      /I (?:should|need to|will|can|must) (?:use|search|look|check|find)/gi,
      /⚡\s*Executing\.*/gi,
      /use web\s?search/gi,
      /for (?:non-)?coding (?:questions|tasks)/gi,
      /answer (?:directly )?from knowledge/gi,
      /this is a (?:general knowledge|coding|security)/gi,
      /the user (?:is asking|wants|might be)/gi,
      /however,? (?:the user|I|we)/gi,
      /(?:first|next),? (?:I should|let me|I need)/gi,
    ];

    let filtered = reasoning;
    for (const pattern of metaPatterns) {
      filtered = filtered.replace(pattern, '');
    }

    // Split into sentences
    const sentences = filtered
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 20 && !/^[•\-–—*]/.test(s)); // Skip bullets and short fragments

    if (sentences.length === 0) {
      return null;
    }

    // Look for actual content (not process descriptions)
    const contentPatterns = [
      /(?:refers? to|involves?|relates? to|is about|concerns?)/i,
      /(?:scandal|deal|agreement|proposal|plan|policy)/i,
      /(?:Trump|Biden|Ukraine|Russia|president|congress)/i,
      /(?:the (?:main|key|primary)|importantly)/i,
    ];

    const contentSentences: string[] = [];
    for (const sentence of sentences) {
      // Skip sentences that are clearly meta-reasoning
      if (/^(?:so|therefore|thus|hence|accordingly)/i.test(sentence)) continue;
      if (/(?:I should|let me|I will|I need|I can)/i.test(sentence)) continue;

      for (const pattern of contentPatterns) {
        if (pattern.test(sentence)) {
          contentSentences.push(sentence);
          break;
        }
      }
    }

    // Use content sentences if found, otherwise take last few sentences (often conclusions)
    const useSentences = contentSentences.length > 0
      ? contentSentences.slice(0, 3)
      : sentences.slice(-3);

    if (useSentences.length === 0) {
      return null;
    }

    const response = useSentences.join('. ').replace(/\.{2,}/g, '.').trim();

    // Don't prefix with "Based on my analysis" - just return clean content
    return response.endsWith('.') ? response : response + '.';
  }
  private async runLocalCommand(command: string): Promise<void> {
    const renderer = this.promptController?.getRenderer();
    if (!command) {
      this.promptController?.setStatusMessage('Usage: /bash <command>');
      setTimeout(() => this.promptController?.setStatusMessage(null), 2500);
      return;
    }

    this.promptController?.setStatusMessage(`bash: ${command}`);
    try {
      const { stdout: out, stderr } = await exec(command, {
        cwd: this.workingDir,
        maxBuffer: 4 * 1024 * 1024,
      });
      const output = [out, stderr].filter(Boolean).join('').trim() || '(no output)';
      renderer?.addEvent('tool', `$ ${command}\n${output}`);
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim();
      renderer?.addEvent('error', `$ ${command}\n${output || 'command failed'}`);
    } finally {
      this.promptController?.setStatusMessage(null);
    }
  }

  private handleSlashCommand(command: string): boolean | Promise<boolean> {
    const trimmed = command.trim();
    const lower = trimmed.toLowerCase();

    // Handle /model with arguments - silent model switch
    if (lower.startsWith('/model ') || lower.startsWith('/m ')) {
      const arg = trimmed.slice(trimmed.indexOf(' ') + 1).trim();
      if (arg) {
        void this.switchModel(arg);
        return true;
      }
    }

    // Handle /model or /m alone - show interactive model picker menu
    if (lower === '/model' || lower === '/m') {
      this.showModelMenu();
      return true;
    }

    // Handle /secrets with subcommands
    if (lower.startsWith('/secrets') || lower.startsWith('/s ') || lower === '/s') {
      const parts = trimmed.split(/\s+/);
      const subCmd = parts[1]?.toLowerCase();
      if (subCmd === 'set') {
        const secretArg = parts[2];
        void this.startSecretInput(secretArg);
        return true;
      }
      // /secrets or /s alone - show status
      this.showSecrets();
      return true;
    }

    // /key — set API key directly
    if (lower === '/key' || lower.startsWith('/key ')) {
      this.showConnectionsMenu();
      return true;
    }

    // --- /authorization — 安全/攻击/防御 doctrine + tier status ---
    if (lower === '/authorization' || lower === '/auth' || lower === '/tiers') {
      this.showAuthorization();
      return true;
    }

    // --- /equation — robot kinematics and constraint framework ---
    if (lower === '/equation' || lower === '/eq') {
      const renderer = this.promptController?.getRenderer();
      if (renderer) {
        renderer.addEvent('banner', [
          chalk.hex('#A78BFA').bold('Robot Control Architecture  —  SENSE → REASON → PLAN → ACT → VERIFY'),
          '',
          'OPERATIONAL PHASES:',
          chalk.cyan('  SENSE:') + '   Gather sensor readings, translate to text, establish spatial context',
          chalk.cyan('  REASON:') + ' Analyze context, identify constraints, evaluate options',
          chalk.cyan('  PLAN:') + '   Generate actuator sequence, verify within bounds',
          chalk.cyan('  ACT:') + '     Emit verified actuator commands, monitor execution',
          chalk.cyan('  VERIFY:') + ' Compare expected vs actual state, feed back to SENSE',
          '',
          'SAFETY CONSTRAINTS:',
          '  1. BOUNDED AUTONOMY — Commands exceeding force/velocity/range limits are rejected',
          '  2. COLLISION AVOIDANCE — No actuator command executes with active collision paths',
          '  3. SENSOR GROUNDING — All decisions based on verified sensor data, not stale context',
          '  4. EMERGENCY STOP — stop, halt, emergency, abort, kill halt all actuation',
          '',
          muted('  The robot operates within its operational envelope at all times.'),
        ].join('\n'));
      }
      return true;
    }

    if (lower === '/help' || lower === '/h' || lower === '/?') {
      this.showHelp();
      return true;
    }

    if (lower === '/clear' || lower === '/c') {
      stdout.write('\x1b[2J\x1b[H');
      return true;
    }

    // --- /login — account login ---
    if (lower === '/login' || lower === '/l') {
      this.showLoginFlow();
      return true;
    }

    // --- /connections — provider key management ---
    if (lower === '/connections' || lower === '/conn' || lower === '/cn') {
      this.showConnectionsMenu();
      return true;
    }

    if (lower === '/clear' || lower === '/c') {
      stdout.write('\x1b[2J\x1b[H');
      void this.showWelcome();
      return true;
    }

    if (lower.startsWith('/bash') || lower.startsWith('/sh ')) {
      const cmd = trimmed.replace(/^\/(bash|sh)\s*/i, '').trim();
      void this.runLocalCommand(cmd);
      return true;
    }


    // Pin/unpin slash commands removed. The pinned prompt UI was
    // pulled per request; commands now silently no-op so existing
    // bindings don't error.
    if (lower.startsWith('/pin ') || lower === '/unpin' || lower === '/clearpin') {
      return true;
    }

    // Toggle auto mode: off → on → dual → off (excludes /loop — now standalone)
    if (lower === '/auto' || lower === '/continue' || lower === '/dual') {
      this.promptController?.toggleAutoContinue();
      const mode = this.promptController?.getAutoMode() ?? 'off';
      this.promptController?.setStatusMessage(`Auto: ${mode}`);
      setTimeout(() => this.promptController?.setStatusMessage(null), 1500);
      return true;
    }

    // /loop <interval> <prompt> — run a prompt on a timer
    // /loop stop — stop the active loop
    // /loop status — show loop state
    if (lower === '/loop' || lower.startsWith('/loop ')) {
      return this.handleLoopCommand(trimmed);
    }

    if (lower === '/exit' || lower === '/quit' || lower === '/q') {
      this.handleExit();
      return true;
    }

    if (lower.startsWith('/debug')) {
      const parts = trimmed.split(/\s+/);
      this.handleDebugCommand(parts[1]);
      return true;
    }

    // Keyboard shortcuts help
    if (lower === '/keys' || lower === '/shortcuts' || lower === '/kb') {
      this.showKeyboardShortcuts();
      return true;
    }

    // === Phase 2: Rich Vuln Explorer (upgraded comprehensive discovery + safe PoC code) ===
    if (lower === '/vuln' || lower === '/explorer' || lower === '/vulns') {
      const renderer = this.promptController?.getRenderer();
      if (renderer) {
        renderer.addEvent('response', 'Launching Vuln Explorer (Phase 2 upgrade)...');
      }
      // Launch takeover explorer — points at the latest comprehensive run by default
      import('../ui/ink/VulnExplorer.js').then(({ showVulnExplorer }) => {
        showVulnExplorer().then(() => {
          if (renderer) {
            renderer.addEvent('response', 'Vuln Explorer closed. Back to Vigil shell.');
          }
        });
      });
      return true;
    }

    // /email and /mail are intentionally unimplemented in the CLI.
    // All transactional email is handled by Cloud Functions (site/functions/index.js).
    if (lower.startsWith('/email') || lower.startsWith('/mail')) {
      const renderer = this.promptController?.getRenderer();
      const msg = 'Email sending is handled by the Cloud Functions backend, not the CLI. See site/functions/index.js (sendProtonEmail, requestHuman, onUserCreate, maybeNotifyBalance).';
      if (renderer) {
        renderer.addEvent('response', msg);
      } else {
        console.log(msg);
      }
      return true;
    }

    // Session stats
    if (lower === '/stats' || lower === '/status') {
      this.showSessionStats();
      return true;
    }

    // ── /findings — persistent findings store ────────────────────────────────
    // /findings                  list all findings
    // /findings add <sev> <title>  add a finding (sev: critical|high|medium|low)
    // /findings rm <id>           remove a finding by id
    // /findings clear             clear all findings
    // /findings export [md|json]  export findings to stdout
    if (lower === '/findings' || lower.startsWith('/findings ') || lower === '/finding') {
      const renderer = this.promptController?.getRenderer();
      const rest = trimmed.replace(/^\/findings?\s*/i, '').trim();
      const parts = rest.split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      if (!sub || sub === 'list') {
        const recs = loadFindings();
        if (recs.length === 0) {
          renderer?.addEvent('system', muted('No findings saved. Use /findings add <severity> <title>'));
        } else {
          const sevColor = (s: string) =>
            s === 'critical' ? chalk.red(s.toUpperCase()) :
            s === 'high'     ? chalk.hex('#F87171')(s.toUpperCase()) :
            s === 'medium'   ? chalk.yellow(s.toUpperCase()) :
            s === 'low'      ? chalk.green(s.toUpperCase()) :
                               muted(s.toUpperCase());
          const sevOrder = ['critical', 'high', 'medium', 'low', 'info'];
          const sorted = [...recs].sort((a, b) => sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity));
          const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
          for (const r of recs) counts[r.severity] = (counts[r.severity] || 0) + 1;
          const kevCount = recs.filter((r) => r.kev).length;
          const summary = [
            counts.critical ? chalk.red(`${counts.critical} CRIT`) : '',
            counts.high     ? chalk.hex('#F87171')(`${counts.high} HIGH`) : '',
            counts.medium   ? chalk.yellow(`${counts.medium} MED`) : '',
            counts.low      ? chalk.green(`${counts.low} LOW`) : '',
            kevCount        ? chalk.red(`${kevCount} KEV`) : '',
          ].filter(Boolean).join(muted('  ·  '));
          const lines = sorted.map((r) => {
            const badge = r.kev ? chalk.red(' KEV') : r.epss != null && r.epss >= 0.5 ? chalk.yellow(' EPSS') : '';
            const cvssStr = r.cvss != null ? muted(` CVSS:${r.cvss}`) : '';
            return `  ${muted(r.id)}  ${sevColor(r.severity)}${badge}${cvssStr}  ${chalk.white(r.title)}` +
              (r.cve ? muted(` [${r.cve}]`) : '') +
              (r.target ? muted(` @ ${r.target}`) : '');
          });
          renderer?.addEvent('system',
            chalk.hex('#22D3EE')(`Findings (${recs.length}):  `) + summary + '\n' + lines.join('\n') +
            (recs.some((r) => r.cvss == null && r.cve) ? muted('\n  · Run /enrich to fetch CVSS/EPSS/KEV data') : ''));
        }
      } else if (sub === 'add') {
        const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
        const sev = parts[1]?.toLowerCase() as FindingRecord['severity'];
        const title = parts.slice(2).join(' ').trim();
        if (!SEVERITIES.includes(sev as never) || !title) {
          renderer?.addEvent('system', chalk.yellow('Usage: /findings add <critical|high|medium|low|info> <title>'));
        } else {
          const targetStr = this.sessionTargets[0];
          const rec = addFinding({ severity: sev, title, target: targetStr });
          this.syncVigilBadge();
          renderer?.addEvent('system', chalk.green(`Finding saved: ${rec.id} [${sev.toUpperCase()}] ${title}`));
        }
      } else if (sub === 'rm' || sub === 'remove' || sub === 'del') {
        const id = parts[1]?.toUpperCase();
        if (!id) { renderer?.addEvent('system', chalk.yellow('Usage: /findings rm <id>')); }
        else {
          const recs = loadFindings().filter((r) => r.id !== id);
          saveFindings(recs);
          renderer?.addEvent('system', chalk.yellow(`Finding ${id} removed.`));
        }
      } else if (sub === 'clear') {
        saveFindings([]);
        renderer?.addEvent('system', chalk.yellow('All findings cleared.'));
      } else if (sub === 'export') {
        const fmt = parts[1]?.toLowerCase() || 'md';
        const recs = loadFindings();
        if (fmt === 'json') {
          renderer?.addEvent('system', JSON.stringify(recs, null, 2));
        } else {
          const rows = recs.map((r) =>
            `| ${r.id} | ${r.severity.toUpperCase()} | ${r.title} | ${r.cve ?? '—'} | ${r.target ?? '—'} | ${r.ts.slice(0, 10)} |`
          );
          renderer?.addEvent('system',
            `# Vigil Findings Export\n\n| ID | Severity | Title | CVE | Target | Date |\n|---|---|---|---|---|---|\n${rows.join('\n')}`
          );
        }
      } else {
        renderer?.addEvent('system', chalk.yellow('Usage: /findings [list|add|rm|clear|export]'));
      }
      return true;
    }

    // ── /playbook <scenario> — 预置 安全/IR 剧本 ─────────────────────
    const PLAYBOOKS: Record<string, string> = {
      ransomware:      'ransomware incident response',
      phishing:        'phishing / BEC (business email compromise) response',
      supplychain:     'software supply chain compromise',
      'supply-chain':  'software supply chain compromise',
      insider:         'insider threat investigation',
      ddos:            'DDoS / volumetric attack response',
      cloudbreach:     'cloud environment breach (AWS/GCP/Azure)',
      'cloud-breach':  'cloud environment breach (AWS/GCP/Azure)',
      webshell:        'web shell / server-side implant response',
      cred:            'credential stuffing / account takeover',
      'data-breach':   'data exfiltration / breach notification',
      lateral:         'lateral movement detection and containment',
      ot:              'OT/ICS/SCADA incident response',
    };
    if (lower.startsWith('/playbook') && (lower === '/playbook' || lower[9] === ' ')) {
      const key = trimmed.slice(9).trim().toLowerCase().replace(/\s+/g, '-');
      const renderer = this.promptController?.getRenderer();
      if (!key) {
        const available = Object.keys(PLAYBOOKS).filter((k) => !k.includes('-')).join(', ');
        renderer?.addEvent('system', chalk.yellow(`Usage: /playbook <scenario>\nAvailable: ${available}`));
        return true;
      }
      const scenarioLabel = PLAYBOOKS[key] ?? key;
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Loading playbook: ${scenarioLabel}`));
      const targetCtx = this.sessionTargets.length
        ? `\nEnvironment in scope: ${this.sessionTargets.join(', ')}.` : '';
      this.queuePrompt(
        `[安全阶段: phase.respond — Incident Response Playbook]\n` +
        `Generate a detailed, step-by-step IR playbook for: **${scenarioLabel}**${targetCtx}\n\n` +
        `Structure:\n` +
        `## 1. Detection Indicators\n` +
        `- What events/IOCs confirm this scenario vs. false positive\n` +
        `- Log sources to query immediately\n\n` +
        `## 2. Immediate Containment (0–30 min)\n` +
        `- Priority actions to stop the bleeding\n` +
        `- Who to notify (CISO, legal, PR, exec) and in what order\n\n` +
        `## 3. Evidence Preservation\n` +
        `- What to capture before containment changes state\n` +
        `- Chain of custody requirements\n\n` +
        `## 4. Eradication\n` +
        `- How to confirm the threat is fully removed\n` +
        `- Persistence mechanism sweep checklist\n\n` +
        `## 5. Recovery\n` +
        `- Safe restoration sequence\n` +
        `- Validation checks before returning to production\n\n` +
        `## 6. Post-Incident\n` +
        `- Timeline reconstruction\n` +
        `- Regulatory notification obligations (GDPR 72h, SEC 4-day, HIPAA, etc.)\n` +
        `- Detection rule and control improvements\n\n` +
        `Be specific and operational — this is for a responder who needs to act now.`
      );
      return true;
    }

    // ── /timeline <CVE> — exploitation timeline from disclosure to active use ──
    if (lower.startsWith('/timeline') && (lower === '/timeline' || lower[9] === ' ')) {
      const subject = trimmed.slice(9).trim();
      const renderer = this.promptController?.getRenderer();
      if (!subject) {
        renderer?.addEvent('system', chalk.yellow('Usage: /timeline <CVE-ID|vulnerability name>'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Building exploitation timeline for: ${subject}`));
      this.queuePrompt(
        `[安全阶段: phase.assess — Exploitation Timeline]\n` +
        `Build a detailed exploitation timeline for: "${subject}"\n\n` +
        `Format as a chronological timeline:\n\n` +
        `| Date | Event | Significance |\n` +
        `|------|-------|---------------|\n\n` +
        `Key events to include (where known):\n` +
        `- Vulnerability introduced (commit/release if known)\n` +
        `- Internal discovery / researcher finds it\n` +
        `- CVE assigned\n` +
        `- Vendor notified (coordinated disclosure start)\n` +
        `- Patch released\n` +
        `- Public disclosure (advisory published)\n` +
        `- First public PoC / exploit code released\n` +
        `- First observed in-the-wild exploitation\n` +
        `- Mass exploitation begins\n` +
        `- CISA KEV addition (if applicable)\n` +
        `- Nation-state / ransomware group adoption\n` +
        `- Patch widely deployed (estimated)\n\n` +
        `After the table:\n` +
        `- **Disclosure gap**: time from CVE → public PoC (how long defenders had)\n` +
        `- **Exploitation velocity**: how quickly did mass exploitation begin after PoC?\n` +
        `- **Lesson**: what does this timeline tell defenders about their patching SLA for this class of vuln?\n\n` +
        `Cite sources for each event. Note where dates are approximate.`
      );
      return true;
    }

    // ── /target — manage session-scoped target list ──────────────────────────
    // /target add <host>    add a target
    // /target rm <host>     remove a target
    // /target clear         clear all targets
    // /target               show current targets
    if (lower === '/target' || lower === '/targets' || lower.startsWith('/target ') || lower.startsWith('/targets ')) {
      const renderer = this.promptController?.getRenderer();
      const rest = trimmed.replace(/^\/targets?\s*/i, '').trim();
      const [sub, ...argParts] = rest.split(/\s+/);
      const argVal = argParts.join(' ').trim();
      if (sub === 'add' && argVal) {
        if (!this.sessionTargets.includes(argVal)) this.sessionTargets.push(argVal);
        this.syncVigilBadge();
        savePersistedSession(this.sessionTargets, this.sessionActivePhase);
        renderer?.addEvent('system', chalk.green(`Target added: ${argVal}`) + muted(`  (${this.sessionTargets.length} total)`));
      } else if ((sub === 'rm' || sub === 'remove' || sub === 'del') && argVal) {
        this.sessionTargets = this.sessionTargets.filter((t) => t !== argVal);
        this.syncVigilBadge();
        savePersistedSession(this.sessionTargets, this.sessionActivePhase);
        renderer?.addEvent('system', chalk.yellow(`Target removed: ${argVal}`) + muted(`  (${this.sessionTargets.length} remain)`));
      } else if (sub === 'clear') {
        this.sessionTargets = [];
        this.syncVigilBadge();
        savePersistedSession(this.sessionTargets, this.sessionActivePhase);
        renderer?.addEvent('system', chalk.yellow('Target list cleared.'));
      } else if (!sub || sub === 'list') {
        if (this.sessionTargets.length === 0) {
          renderer?.addEvent('system', muted('No targets set. Use /target add <host|IP|CIDR|URL>'));
        } else {
          renderer?.addEvent('system', chalk.hex('#22D3EE')('Session targets:\n') + this.sessionTargets.map((t) => `  • ${t}`).join('\n'));
        }
      } else {
        // Treat the whole rest as a target to add (e.g. /target 10.0.0.0/8)
        const target = rest.trim();
        if (target && !this.sessionTargets.includes(target)) this.sessionTargets.push(target);
        savePersistedSession(this.sessionTargets, this.sessionActivePhase);
        renderer?.addEvent('system', chalk.green(`Target added: ${target}`) + muted(`  (${this.sessionTargets.length} total)`));
      }
      return true;
    }

    // ── /intel <term> — threat intelligence lookup ───────────────────────────
    // Accepts: APT group, malware family, TTP (T1234), campaign name, IOC
    if (lower.startsWith('/intel') && (lower === '/intel' || lower[6] === ' ')) {
      const term = trimmed.slice(6).trim();
      const renderer = this.promptController?.getRenderer();
      if (!term) {
        renderer?.addEvent('system', chalk.yellow('Usage: /intel <APT group|malware|TTP|IOC|campaign>'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Threat intel lookup: ${term}`));
      this.queuePrompt(
        `[安全阶段: phase.hunt — Threat Hunting]\n` +
        `Threat intelligence research request: "${term}"\n\n` +
        `Provide a structured intelligence summary:\n` +
        `1. **Identity** — aliases, attribution confidence, nation-state vs. eCrime vs. hacktivist\n` +
        `2. **Targeting** — sectors, geographies, victim types typically targeted\n` +
        `3. **TTPs** — MITRE ATT&CK techniques used (T-codes), kill-chain phases\n` +
        `4. **Malware/tools** — custom implants, LOLBins, publicly available tooling\n` +
        `5. **IOCs** — recent (≤12 months) IPs, domains, hashes if known and shareable\n` +
        `6. **Detection** — Sigma/YARA rule references or detection logic for their primary TTPs\n` +
        `7. **Defensive priorities** — top 3 controls that would most impede this actor\n\n` +
        `Cite sources (MITRE ATT&CK, Mandiant, CrowdStrike, CISA advisories, open-source threat reports). ` +
        `If the term is a CVE or IOC rather than an actor, pivot to technical analysis.`
      );
      return true;
    }

    // ── /kev — CISA Known Exploited Vulnerabilities digest ───────────────────
    if (lower === '/kev' || lower.startsWith('/kev ')) {
      const filter = trimmed.slice(4).trim(); // optional filter: vendor, date, etc.
      const renderer = this.promptController?.getRenderer();
      renderer?.addEvent('system', chalk.hex('#22D3EE')('Fetching CISA KEV digest...'));
      const targetCtx = this.sessionTargets.length
        ? `\nSession targets in scope: ${this.sessionTargets.join(', ')} — highlight KEV entries that affect detected software on these targets.`
        : '';
      this.queuePrompt(
        `[安全阶段: phase.assess — Vulnerability Assessment]\n` +
        `Summarize the current CISA Known Exploited Vulnerabilities (KEV) catalog.\n` +
        (filter ? `Filter/focus on: ${filter}\n` : '') +
        `Provide:\n` +
        `1. Total KEV count (current) and any additions in the last 30 days\n` +
        `2. Top 10 most critical recent additions (CVSS ≥ 8.0 or notable)\n` +
        `3. For each: CVE ID, vendor/product, brief description, due date for federal agencies\n` +
        `4. Breakdown by category (network device, OS, browser, web app, ICS/OT)\n` +
        `5. Recommended immediate action for any KEV affecting common enterprise software${targetCtx}\n\n` +
        `Source: cisa.gov/known-exploited-vulnerabilities-catalog. Flag if your knowledge cutoff may miss recent additions.`
      );
      return true;
    }

    // ── /scan <target> — rapid vulnerability discovery against a host/CIDR/URL ─
    if (lower.startsWith('/scan') && (lower === '/scan' || lower[5] === ' ')) {
      const explicit = trimmed.slice(5).trim();
      const target = explicit || (this.sessionTargets.length ? this.sessionTargets.join(', ') : '');
      const renderer = this.promptController?.getRenderer();
      if (!target) {
        renderer?.addEvent('system', chalk.yellow('Usage: /scan <host|IP|CIDR|URL>  (or set targets first with /target add <host>)'));
        return true;
      }
      if (explicit && !this.sessionTargets.includes(explicit)) {
        this.sessionTargets.push(explicit);
        savePersistedSession(this.sessionTargets, this.sessionActivePhase);
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Starting vulnerability discovery scan on: ${target}`));
      this.queuePrompt(
        `[安全阶段: phase.assess — Vulnerability Assessment]\n` +
        `Authorized target: ${target}\n\n` +
        `Execute this full scanning pipeline without pausing between steps:\n\n` +
        `**Step 1 — Run the Vigil comprehensive scanner:**\n` +
        `\`\`\`bash\nnode scripts/vigil-run.mjs scripts/_comprehensive-vuln-scan.mjs\n\`\`\`\n` +
        `Parse the JSON output for CVE findings.\n\n` +
        `**Step 2 — If nmap is available, enumerate services:**\n` +
        `\`\`\`bash\nnmap -sV --open -T4 ${target} 2>/dev/null || echo "nmap unavailable"\n\`\`\`\n` +
        `Map service@version results to CPE strings, then cross-reference against NVD.\n\n` +
        `**Step 3 — Enrich findings:**\n` +
        `\`\`\`bash\nnode scripts/vigil-run.mjs scripts/_finding-enricher.mjs\n\`\`\`\n\n` +
        `**Step 4 — Produce ranked findings table:**\n` +
        `| CVE | CVSS | EPSS | KEV | Asset | Service | Impact | Fix |\n` +
        `|-----|------|------|-----|-------|---------|--------|-----|\n\n` +
        `Sort: Critical+KEV → Critical → High+KEV → High → Medium.\n` +
        `For the top Critical/High finding: generate a Sigma detection rule.\n` +
        `End with: exact remediation command per finding. No vague advice.`
      );
      return true;
    }

    // ── /cve <CVE-ID> — deep-dive a specific CVE ────────────────────────────
    if (lower.startsWith('/cve') && (lower === '/cve' || lower[4] === ' ')) {
      const cveId = trimmed.slice(4).trim().toUpperCase();
      const renderer = this.promptController?.getRenderer();
      if (!cveId || !cveId.match(/^CVE-\d{4}-\d+$/)) {
        renderer?.addEvent('system', chalk.yellow('Usage: /cve CVE-YYYY-NNNNN'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Looking up ${cveId} via NVD + OSV + EPSS + CISA KEV...`));
      // Run the real-time CVE lookup script first, then pass structured data to the agent
      const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', '_cve-lookup.mjs');
      this.queuePrompt(
        `[安全阶段: phase.assess — CVE Intelligence]\n` +
        `Look up real-time data for ${cveId} by running the cve-lookup script:\n\n` +
        `\`\`\`bash\nnode "${scriptPath}" --text ${cveId}\n\`\`\`\n\n` +
        `Run that command now. Then based on the output provide:\n` +
        `1. Plain-English description of what the vulnerability is and its root cause class\n` +
        `2. CVSS v3.1 score breakdown — explain what each metric value means in context\n` +
        `3. EPSS interpretation — what does this percentile tell defenders about exploitation probability?\n` +
        `4. KEV status and urgency implication (if in KEV: immediate action required)\n` +
        `5. Affected versions and exact fixed version from the OSV/NVD data\n` +
        `6. Public PoC availability — search ExploitDB and GitHub for "${cveId}"\n` +
        `7. Recommended remediation with specific package/version/command\n` +
        `8. A one-line Sigma detection condition\n` +
        `9. Related CVEs in the same component or root cause class`
      );
      return true;
    }

    // ── /report [md|json] — export current session findings ─────────────────
    if (lower === '/report' || lower.startsWith('/report ')) {
      const fmt = trimmed.slice(7).trim().toLowerCase() || 'md';
      const renderer = this.promptController?.getRenderer();
      if (fmt !== 'md' && fmt !== 'json' && fmt !== 'markdown') {
        renderer?.addEvent('system', chalk.yellow('Usage: /report [md|json]'));
        return true;
      }
      const ext = (fmt === 'json') ? 'json' : 'md';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outPath = `vigil-findings-${ts}.${ext}`;
      const storedFindings = loadFindings();
      const findingsSummary = storedFindings.length > 0
        ? `\n\nPersisted findings in session store (${storedFindings.length} total):\n` +
          storedFindings.slice(0, 20).map((f) =>
            `- ${f.severity.toUpperCase()} ${f.cve ?? f.id} (${f.target ?? 'unknown'}): ${f.title}`
          ).join('\n') +
          (storedFindings.length > 20 ? `\n... and ${storedFindings.length - 20} more` : '')
        : '';
      this.queuePrompt(
        `[安全阶段: phase.respond — Security Findings Report]\n` +
        `Compile all vulnerability findings, CVEs, risk items, and security recommendations from this session into a single ${ext.toUpperCase()} report.\n` +
        `Session scope: ${this.sessionTargets.length ? this.sessionTargets.join(', ') : 'not specified'}` +
        findingsSummary + `\n\n` +
        `Format:\n` +
        (fmt === 'json'
          ? `A JSON object with keys: { "generated": "<ISO timestamp>", "summary": { "critical": N, "high": N, "medium": N, "low": N }, "findings": [ { "id": "CVE-...", "severity": "...", "asset": "...", "description": "...", "cvss": 0.0, "kev": false, "remediation": "..." } ], "recommendations": [ "..." ] }`
          : `# Vigil Security Findings Report\n**Generated:** <date>  **Session scope:** <targets>\n\n## Executive Summary\n<2-3 sentences>\n\n## Critical & High Findings\n| CVE | Asset | CVSS | KEV | Remediation |\n|---|---|---|---|---|\n...\n\n## Recommendations\n...`) +
        `\n\nWrite ONLY the report content — no preamble. Then tell the user to save it as: ${outPath}`
      );
      return true;
    }

    // ── /brief — morning security brief ─────────────────────────────────────
    if (lower === '/brief' || lower.startsWith('/brief ')) {
      const focus = trimmed.slice(5).trim();
      const renderer = this.promptController?.getRenderer();
      renderer?.addEvent('system', chalk.hex('#22D3EE')('Fetching live CISA KEV data for brief...'));

      // Fetch live CISA KEV async, then queue the brief with injected data
      const targetCtx = this.sessionTargets.length
        ? `\nAssets in scope — prioritize findings affecting: ${this.sessionTargets.join(', ')}.`
        : '';
      const sessionFindings = loadFindings().filter((f) => f.kev || f.severity === 'critical');
      const findingsCtx = sessionFindings.length
        ? `\n[Session KEV/Critical findings: ${sessionFindings.map((f) => f.cve ?? f.id).join(', ')}]`
        : '';
      const buildBriefPrompt = (kevContext: string | null) =>
        `[安全阶段: phase.assess — Security Intelligence Brief]\n` +
        (kevContext ? kevContext + '\n\n' : '') +
        `Generate a structured daily security brief${focus ? ` focused on: ${focus}` : ''}.${targetCtx}${findingsCtx}\n\n` +
        `## Vigil Daily Security Brief\n\n` +
        `### KEV Additions (last 7 days)\n` +
        (kevContext
          ? `Use the live KEV data above. List CVEs added in the last 7 days with: CVE ID, vendor, product, exploitation context.`
          : `List CVEs added to CISA KEV in the last 7 days (CVE ID, vendor, product, CVSS, exploitation status).`) +
        `\n\n### Threat Landscape\n` +
        `- Top 3 active threat actors with campaigns (cite sources)\n` +
        `- Notable new malware families or TTPs\n\n` +
        `### Critical Vulnerabilities\n` +
        `- CVSS 9.0+ disclosures from the past week\n` +
        `- Anything with public PoC + no patch yet\n\n` +
        `### Recommended Actions\n` +
        `- Patch priorities (top 5, with specific versions and CVEs)\n` +
        `- Detection rule updates needed\n` +
        `- Network/firewall/EDR actions\n\n` +
        `### Session Finding Status\n` +
        (sessionFindings.length
          ? `Cross-reference session findings against today's threat landscape. Any newly KEV-listed or exploited?`
          : `No KEV/Critical session findings. Run /scan to populate.`);

      void (async () => {
        let kevContext: string | null = null;
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 8_000);
          const res = await fetch('https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', {
            signal: ctrl.signal, headers: { 'User-Agent': 'Vigil-CLI/1.0' },
          });
          clearTimeout(t);
          if (res.ok) {
            type KevEntry = { cveID: string; vendorProject: string; product: string; dateAdded: string; requiredAction: string };
            const data = await res.json() as { vulnerabilities?: KevEntry[] };
            const recent = (data.vulnerabilities ?? [])
              .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded))
              .slice(0, 20);
            const lines = recent.map((v) =>
              `- ${v.cveID}  ${v.vendorProject} ${v.product}  added:${v.dateAdded}  action:${v.requiredAction}`
            );
            kevContext = `[Live CISA KEV — ${recent.length} most recently added:\n${lines.join('\n')}]`;
            renderer?.addEvent('system', muted(`KEV catalog loaded (${recent.length} recent entries)`));
          }
        } catch { /* network unavailable — brief proceeds without live data */ }
        this.queuePrompt(buildBriefPrompt(kevContext));
      })();
      return true;
    }

    // ── /chain <CVE> [CVE...] — model a vulnerability attack chain ───────────
    if (lower.startsWith('/chain') && (lower === '/chain' || lower[6] === ' ')) {
      const renderer = this.promptController?.getRenderer();
      let cves = trimmed.slice(6).trim();

      // If no CVEs specified, auto-load Critical + High from findings store
      if (!cves) {
        const stored = loadFindings();
        const critHigh = stored
          .filter((f) => (f.severity === 'critical' || f.severity === 'high') && f.cve)
          .sort((a, b) => {
            if (a.kev && !b.kev) return -1;
            if (!a.kev && b.kev) return 1;
            return (b.epss ?? 0) - (a.epss ?? 0);
          })
          .slice(0, 6)
          .map((f) => f.cve as string);
        if (critHigh.length === 0) {
          renderer?.addEvent('system', chalk.yellow('Usage: /chain <CVE-ID> [CVE-ID ...]  — or save findings first with /scan'));
          return true;
        }
        cves = critHigh.join(' ');
        renderer?.addEvent('system', muted(`Auto-loaded ${critHigh.length} Critical/High findings from store: `) + chalk.hex('#22D3EE')(cves));
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Modeling vulnerability chain: ${cves}`));
      const targetCtx = this.sessionTargets.length
        ? `\nAssets in scope: ${this.sessionTargets.join(', ')}.` : '';
      this.queuePrompt(
        `[安全阶段: phase.assess — Vulnerability Chain Analysis]\n` +
        `Model a realistic attack chain using these vulnerabilities: ${cves}${targetCtx}\n\n` +
        `Provide:\n` +
        `1. **Individual vuln summary** — for each CVE: component, class, CVSS, KEV status, exploit availability\n` +
        `2. **Chain feasibility** — can these realistically be chained? What preconditions must be met?\n` +
        `3. **Attack narrative** — step-by-step attacker kill chain using these CVEs in order (initial access → execution → privilege escalation → impact)\n` +
        `4. **ATT&CK mapping** — map each step to MITRE ATT&CK techniques (T-codes)\n` +
        `5. **Choke points** — where in the chain can defenders best break the kill chain?\n` +
        `6. **Detection opportunities** — what log sources and specific events would expose each step?\n` +
        `7. **Remediation priority** — which CVE in the chain is the highest-leverage fix?\n\n` +
        `Be concrete and technical. If the CVEs don't chain, say so and explain why.`
      );
      return true;
    }

    // ── /patch <package@version> — patch/upgrade intelligence ───────────────
    if (lower.startsWith('/patch') && (lower === '/patch' || lower[6] === ' ')) {
      const pkg = trimmed.slice(6).trim();
      const renderer = this.promptController?.getRenderer();
      if (!pkg) {
        renderer?.addEvent('system', chalk.yellow('Usage: /patch <package@version|CVE-ID|component>'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Patch intelligence for: ${pkg}`));
      this.queuePrompt(
        `[安全阶段: phase.remediate — Patch Intelligence]\n` +
        `Provide patch and upgrade intelligence for: "${pkg}"\n\n` +
        `Cover:\n` +
        `1. **Current version vs. latest** — what version was specified vs. what's available today\n` +
        `2. **Known CVEs** — all CVEs affecting the specified version, sorted by CVSS (Critical first)\n` +
        `3. **Fixed in** — which version(s) fix each CVE\n` +
        `4. **CISA KEV** — flag any KEV entries in this component\n` +
        `5. **Upgrade path** — safe upgrade sequence (especially for major version jumps with breaking changes)\n` +
        `6. **Breaking changes** — what to test after upgrading\n` +
        `7. **Workarounds** — if patching immediately isn't possible, what mitigations reduce risk?\n` +
        `8. **Supply chain** — any known compromised versions or malicious packages in this namespace?\n\n` +
        `Cite: NVD, OSV.dev, the project's changelog/security advisories, and package registry advisories.`
      );
      return true;
    }

    // ── /ip <address> — IP / host threat intelligence (live data) ──────────
    if (lower.startsWith('/ip') && (lower === '/ip' || lower[3] === ' ')) {
      const ip = trimmed.slice(3).trim();
      const renderer = this.promptController?.getRenderer();
      if (!ip) {
        renderer?.addEvent('system', chalk.yellow('Usage: /ip <IP address|hostname>'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`IP intelligence: ${ip}`) + muted(' (fetching live data…)'));

      // Fetch Shodan InternetDB + ipinfo in parallel (both free, no key required)
      void (async () => {
        let liveCtx = '';
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 8_000);
          const [idbRes, infoRes] = await Promise.allSettled([
            fetch(`https://internetdb.shodan.io/${ip}`, { signal: ctrl.signal, headers: { 'User-Agent': 'Vigil-CLI/1.0' } }),
            fetch(`https://ipinfo.io/${ip}/json`, { signal: ctrl.signal, headers: { 'User-Agent': 'Vigil-CLI/1.0' } }),
          ]);
          clearTimeout(t);

          let idbLines = '';
          if (idbRes.status === 'fulfilled' && idbRes.value.ok) {
            type IdbData = { ports?: number[]; tags?: string[]; cpes?: string[]; vulns?: string[]; hostnames?: string[] };
            const idb = await idbRes.value.json() as IdbData;
            if (idb.ports?.length)     idbLines += `Open ports (Shodan): ${idb.ports.join(', ')}\n`;
            if (idb.tags?.length)      idbLines += `Tags: ${idb.tags.join(', ')}\n`;
            if (idb.cpes?.length)      idbLines += `CPEs: ${idb.cpes.slice(0, 5).join(', ')}\n`;
            if (idb.hostnames?.length) idbLines += `Hostnames: ${idb.hostnames.slice(0, 8).join(', ')}\n`;
            if (idb.vulns?.length)     idbLines += `⚠ CVEs (Shodan): ${idb.vulns.join(', ')}\n`;
          }

          let infoLines = '';
          if (infoRes.status === 'fulfilled' && infoRes.value.ok) {
            type InfoData = { org?: string; city?: string; region?: string; country?: string; hostname?: string; anycast?: boolean };
            const info = await infoRes.value.json() as InfoData;
            if (info.org)      infoLines += `ASN/Org: ${info.org}\n`;
            if (info.city)     infoLines += `Location: ${info.city}, ${info.region ?? ''}, ${info.country ?? ''}\n`;
            if (info.hostname) infoLines += `PTR: ${info.hostname}\n`;
            if (info.anycast)  infoLines += `Anycast: yes\n`;
          }

          if (idbLines || infoLines) {
            liveCtx = `[Live data for ${ip}:\n${infoLines}${idbLines}]`;
            renderer?.addEvent('system', muted(`Live data loaded (Shodan InternetDB + ipinfo)`));
          }
        } catch { /* live data best-effort */ }

        this.queuePrompt(
          `[安全阶段: phase.hunt — IP Threat Intelligence]\n` +
          (liveCtx ? liveCtx + '\n\n' : '') +
          `Comprehensive threat intelligence for: ${ip}\n\n` +
          `1. **Identity** — PTR/hostname, ASN, hosting provider, geolocation, organization type (cloud, residential, datacenter, TOR)\n` +
          `2. **Threat reputation** — known C2 infrastructure, malware delivery, spam/phishing, TOR exit node, bulletproof hosting\n` +
          `3. **Service exposure** — use the live Shodan data above; describe what each open service exposes\n` +
          `4. **CVE exposure** — for any CPEs/services: are there known unpatched CVEs? CVSS + EPSS + KEV?\n` +
          `5. **Historical activity** — breach datasets, threat intelligence reports, malware campaigns\n` +
          `6. **Associated infrastructure** — related IPs in same ASN/range, other domains hosted here\n` +
          `7. **Verdict** — Benign / Suspicious / Malicious with confidence and reasoning\n` +
          `8. **Defender action** — specific SIEM alert query, firewall rule, or watchlist action\n\n` +
          `If CVEs are present in the live data: save them with /findings add and run /enrich.`
        );
      })();
      return true;
    }

    // ── /hash <hash> — malware hash / file threat intelligence ───────────────
    if (lower.startsWith('/hash') && (lower === '/hash' || lower[5] === ' ')) {
      const hash = trimmed.slice(5).trim();
      const renderer = this.promptController?.getRenderer();
      if (!hash) {
        renderer?.addEvent('system', chalk.yellow('Usage: /hash <MD5|SHA1|SHA256>'));
        return true;
      }
      if (!/^[0-9a-fA-F]+$/.test(hash)) {
        renderer?.addEvent('system', chalk.yellow(`Not a valid hex hash: ${hash}`));
        return true;
      }
      const hashType = hash.length === 32 ? 'MD5' : hash.length === 40 ? 'SHA1' : hash.length === 64 ? 'SHA256' : 'unknown';
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Hash intelligence (${hashType}): ${hash}`));
      this.queuePrompt(
        `[安全阶段: phase.hunt — File / Hash Threat Intelligence]\n` +
        `Threat intelligence for file hash: "${hash}" (${hashType})\n\n` +
        `1. **Known malware** — does this hash match a known malware family?\n` +
        `   - Family name, variant, first seen, last seen\n` +
        `   - AV detection ratio if known (VirusTotal-style aggregate)\n` +
        `2. **Classification** — what type of malware? (trojan/ransomware/infostealer/RAT/dropper/loader)\n` +
        `3. **Behavioral indicators** — what does this malware do?\n` +
        `   - Persistence mechanisms (registry keys, scheduled tasks, services)\n` +
        `   - C2 communication patterns (protocol, beaconing interval, domains/IPs)\n` +
        `   - Data exfiltration behavior\n` +
        `   - Anti-analysis techniques (sandbox evasion, anti-debug)\n` +
        `4. **ATT&CK mapping** — techniques used by this malware family (T-codes)\n` +
        `5. **YARA rule** — a detection rule targeting this malware's unique characteristics\n` +
        `6. **IOCs** — associated domains, IPs, mutex names, registry keys, file paths\n` +
        `7. **Response guidance** — if this was found on a host:\n` +
        `   - Immediate containment steps\n` +
        `   - Artifacts to look for in forensic triage\n` +
        `   - Clean-up procedure\n\n` +
        `Cite sources (MalwareBazaar, VirusTotal, Any.run, vendor reports).`
      );
      return true;
    }

    // ── /workspace — session dashboard ───────────────────────────────────────
    if (lower === '/workspace' || lower === '/ws') {
      const renderer = this.promptController?.getRenderer();
      if (!this.promptController?.supportsInlinePanel()) {
        renderer?.addEvent('system', muted('Use /workspace in interactive mode'));
        return true;
      }
      const stored = loadFindings();
      const bySev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
      for (const f of stored) { bySev[f.severity as keyof typeof bySev] = (bySev[f.severity as keyof typeof bySev] || 0) + 1; }

      const sevBadge = (label: string, n: number, color: string) =>
        n > 0 ? chalk.hex(color)(`${n} ${label}`) : muted(`0 ${label}`);

      const history = this.controller.getHistory();
      const turns = history.filter((m) => m.role === 'user').length;

      const lines = [
        chalk.bold.hex('#6366F1')('Vigil Workspace') + muted('  (press any key to dismiss)'),
        '',
        chalk.hex('#22D3EE')('Authorized scope'),
        ...(this.sessionTargets.length
          ? this.sessionTargets.map((t) => `  ${chalk.green('●')} ${t}`)
          : [`  ${muted('none — /target add <host|CIDR|URL>')}`]),
        '',
        chalk.hex('#22D3EE')('Findings store  ') + muted(`(~/.vigil/findings.json · ${stored.length} total)`),
        `  ${sevBadge('critical', bySev.critical, '#EF4444')}  ${sevBadge('high', bySev.high, '#F87171')}  ${sevBadge('medium', bySev.medium, '#FBBF24')}  ${sevBadge('low', bySev.low, '#34D399')}`,
        stored.length > 0
          ? muted(`  last: [${stored[stored.length - 1].severity.toUpperCase()}] ${stored[stored.length - 1].title.slice(0, 60)}`)
          : '',
        '',
        chalk.hex('#22D3EE')('Session'),
        `  ${chalk.white(turns.toString())} turns  ·  model: ${chalk.white(this.profileConfig.model)}`,
        this.sessionActivePhase ? `  active phase: ${chalk.hex('#FBBF24')(this.sessionActivePhase)}` : muted('  no active phase'),
        '',
        chalk.hex('#22D3EE')('Quick actions'),
        muted('  /engage <target>    full autonomous assessment'),
        muted('  /findings           review saved findings'),
        muted('  /pentest-report     generate report from session'),
      ].filter((l) => l !== '');

      this.promptController.setInlinePanel(lines);
      this.scheduleInlinePanelDismiss();
      return true;
    }

    // ── /supply-chain <package[@version]> — supply chain security analysis ────
    if (lower.startsWith('/supply-chain') && (lower === '/supply-chain' || lower[13] === ' ')) {
      const pkg = trimmed.slice(13).trim();
      const renderer = this.promptController?.getRenderer();
      if (!pkg) {
        renderer?.addEvent('system', chalk.yellow('Usage: /supply-chain <package[@version]|org/repo>'));
        return true;
      }
      // Auto-detect registry from package name format
      const registryHint =
        /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(pkg) ? 'GitHub repo (org/repo)' :
        /^@[a-z0-9-]+\//.test(pkg) ? 'npm (scoped package)' :
        /^\d/.test(pkg) ? 'unknown' :
        pkg.includes(':') ? 'Maven/Gradle (groupId:artifactId)' :
        /^[a-z][a-z0-9-]*$/.test(pkg) ? 'likely npm or PyPI' : 'unknown registry';
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Supply chain analysis: ${pkg}`) + muted(`  (${registryHint})`));
      this.queuePrompt(
        `[安全阶段: phase.assess — Supply Chain Security]\n` +
        `Perform a supply chain security analysis for: "${pkg}" (detected registry: ${registryHint})\n\n` +
        `1. **Package identity**\n` +
        `   - Confirm registry (npm/PyPI/Maven/Go/crates.io), maintainers, publish history\n` +
        `   - Ownership changes in the last 12 months (red flag: typosquat window)\n` +
        `   - Package age, download volume, dependent projects count\n\n` +
        `2. **Known compromises**\n` +
        `   - Any known malicious versions published to this namespace?\n` +
        `   - Typosquatting variants (similar names that exist on the registry)\n` +
        `   - GitHub repo takeover history or abandoned maintainer risk\n\n` +
        `3. **CVE & advisory audit**\n` +
        `   - All known CVEs (NVD + OSV + GitHub Advisories)\n` +
        `   - For each: CVE ID, CVSS, EPSS, KEV status, fixed version\n\n` +
        `4. **Dependency depth**\n` +
        `   - Direct vs. transitive dependency count (blast radius)\n` +
        `   - Any known-vulnerable transitive deps?\n` +
        `   - "Phantom dependencies" — things implicitly relied on but not declared\n\n` +
        `5. **Code trust indicators**\n` +
        `   - Is the repo actively maintained? Last commit date, open security issues\n` +
        `   - Signed releases / provenance (SLSA level, sigstore/cosign)\n` +
        `   - CI/CD pipeline — does it publish direct from CI (lower risk) or manually?\n\n` +
        `6. **Risk verdict** — Low / Medium / High / Critical supply chain risk with justification\n` +
        `7. **Mitigation** — pin to hash, vendor the dep, replace with alternative, or accept risk`
      );
      return true;
    }

    // ── /cloud [aws|gcp|azure] — cloud security posture review ───────────────
    if (lower.startsWith('/cloud') && (lower === '/cloud' || lower[6] === ' ')) {
      const provider = trimmed.slice(6).trim().toLowerCase() || 'aws';
      const renderer = this.promptController?.getRenderer();
      const providerLabel = provider === 'gcp' ? 'Google Cloud Platform' : provider === 'azure' ? 'Microsoft Azure' : 'AWS';
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Cloud security posture: ${providerLabel}`));
      const targetCtx = this.sessionTargets.length
        ? `\nEnvironment scope: ${this.sessionTargets.join(', ')}.` : '';
      this.queuePrompt(
        `[安全阶段: phase.baseline — Cloud Security Posture Review]\n` +
        `Assess the security posture of ${providerLabel}.${targetCtx}\n\n` +
        `Audit against the CIS ${providerLabel} Benchmark. Cover:\n\n` +
        `### Identity & Access Management\n` +
        `- MFA enforcement on all privileged accounts\n` +
        `- No root/owner account used for day-to-day operations\n` +
        `- Least-privilege IAM roles — no wildcard * permissions\n` +
        `- Access key rotation (< 90 days); unused access keys removed\n` +
        `- Service account key hygiene\n\n` +
        `### Network Security\n` +
        `- Security groups / firewall rules — no 0.0.0.0/0 ingress on SSH (22), RDP (3389), DB ports\n` +
        `- VPC flow logs enabled\n` +
        `- No unused publicly accessible resources (S3 buckets, storage blobs, GCS buckets)\n` +
        `- WAF coverage on public-facing load balancers\n\n` +
        `### Logging & Monitoring\n` +
        `- CloudTrail / Cloud Audit Logs / Azure Monitor enabled in all regions\n` +
        `- Log retention ≥ 365 days\n` +
        `- Alerts on: root login, IAM policy changes, security group changes, failed logins\n` +
        `- GuardDuty / Security Command Center / Defender for Cloud enabled\n\n` +
        `### Data Protection\n` +
        `- Encryption at rest on all storage (S3/GCS/Blob/RDS/volumes)\n` +
        `- Encryption in transit enforced (TLS 1.2+)\n` +
        `- No secrets in environment variables or user data scripts; use Secrets Manager / Secret Manager / Key Vault\n\n` +
        `### Findings format\n` +
        `For each gap found: CIS control ID | severity | current state | recommended fix | effort (hours)\n\n` +
        `Use available bash tools to query the cloud CLI (aws/gcloud/az) if credentials are present. ` +
        `Otherwise provide a manual audit checklist the operator can run themselves.`
      );
      return true;
    }

    // ── /mitre <T-code|technique name> — ATT&CK technique deep-dive ──────────
    if (lower.startsWith('/mitre') && (lower === '/mitre' || lower[6] === ' ')) {
      const subject = trimmed.slice(6).trim();
      const renderer = this.promptController?.getRenderer();
      if (!subject) {
        renderer?.addEvent('system', chalk.yellow('Usage: /mitre <T1059|technique name>'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`ATT&CK technique: ${subject}`));
      this.queuePrompt(
        `[安全阶段: phase.detect — ATT&CK Technique Analysis]\n` +
        `Deep-dive MITRE ATT&CK technique: "${subject}"\n\n` +
        `Provide a full operational reference:\n\n` +
        `### Technique Overview\n` +
        `- Full technique name, ID (T-code), tactic(s), sub-techniques if applicable\n` +
        `- Plain-English explanation of what the adversary achieves\n` +
        `- How common is this in real-world intrusions (rare/occasional/frequent/ubiquitous)?\n\n` +
        `### How Adversaries Use It\n` +
        `- Top 3 concrete implementations with example commands or code\n` +
        `- Tools/malware families known to use this technique\n` +
        `- APT groups that commonly employ it\n\n` +
        `### Detection\n` +
        `- Log sources that capture this activity (Windows Event IDs, Sysmon events, network logs, etc.)\n` +
        `- A production-ready Sigma rule (valid YAML, UUID, ATT&CK tags)\n` +
        `- EDR behavioral query if applicable (CrowdStrike/SentinelOne/Defender)\n` +
        `- What NOT to alert on (common false-positive patterns)\n\n` +
        `### Mitigation (D3FEND)\n` +
        `- MITRE D3FEND countermeasures with D3-codes\n` +
        `- CIS Control(s) that address this technique\n` +
        `- Practical hardening steps to reduce attack surface\n\n` +
        `### Hunting\n` +
        `- Hunt hypothesis (falsifiable statement)\n` +
        `- Query skeleton for Splunk/Elastic/KQL to find historical evidence\n\n` +
        `Cite ATT&CK technique URL.`
      );
      return true;
    }

    // ── /cvss <vector> — decode and explain a CVSS v3.1 vector string ─────────
    if (lower.startsWith('/cvss') && (lower === '/cvss' || lower[5] === ' ')) {
      const vector = trimmed.slice(5).trim();
      const renderer = this.promptController?.getRenderer();
      if (!vector) {
        renderer?.addEvent('system', chalk.yellow('Usage: /cvss CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Decoding CVSS vector: ${vector}`));
      this.queuePrompt(
        `[安全阶段: phase.assess — CVSS Decoding & Prioritization]\n` +
        `Decode and explain this CVSS v3.1 vector string: \`${vector}\`\n\n` +
        `Provide:\n` +
        `1. **Calculated base score** with severity label (None/Low/Medium/High/Critical)\n` +
        `2. **Metric-by-metric breakdown** — for each metric:\n` +
        `   - Full name and abbreviation\n` +
        `   - The selected value and what it means in plain English\n` +
        `   - How this specific value affects the overall score\n` +
        `3. **Plain-English summary** — describe the vulnerability in one paragraph using only the vector (e.g. "This is a network-exploitable flaw requiring no authentication that grants full confidentiality impact...")\n` +
        `4. **Attacker profile** — what kind of attacker can exploit this? (script kiddie / skilled / nation-state)\n` +
        `5. **Temporal context** — if this is a base score, note that EPSS and KEV status would further refine priority\n` +
        `6. **Remediation urgency** — based purely on this vector, what SLA would you recommend? (immediate/30d/90d/best-effort)\n\n` +
        `Format the breakdown as a compact table: Metric | Value | Meaning`
      );
      return true;
    }

    // ── /audit <path> — static security audit of code or config ──────────────
    if (lower.startsWith('/audit') && (lower === '/audit' || lower[6] === ' ')) {
      const target = trimmed.slice(6).trim() || '.';
      const renderer = this.promptController?.getRenderer();
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Security audit: ${target}`));
      this.queuePrompt(
        `[安全阶段: phase.assess — Static Security Audit]\n` +
        `Perform a thorough security audit of: ${target}\n\n` +
        `Approach:\n` +
        `1. **File survey** — read the target path/file(s); understand what the code/config does\n` +
        `2. **Vulnerability classes to check** (be exhaustive for what's applicable):\n` +
        `   - Injection: SQL, command injection, LDAP, XPath, template injection\n` +
        `   - Broken auth: hardcoded credentials, weak tokens, missing auth checks, insecure session management\n` +
        `   - Sensitive data exposure: secrets in code, weak encryption, cleartext transmission\n` +
        `   - Access control: privilege escalation paths, IDOR, missing authorization\n` +
        `   - Security misconfiguration: debug mode, permissive CORS, exposed admin interfaces, default creds\n` +
        `   - Vulnerable dependencies: known-bad package versions (cross-reference with OSV/NVD)\n` +
        `   - Cryptography: weak algorithms (MD5/SHA1 for integrity, ECB mode, static IV), key management\n` +
        `   - Insecure deserialization: untrusted input deserialized without validation\n` +
        `   - SSRF / path traversal: user-controlled file paths or URLs without validation\n` +
        `   - Race conditions / TOCTOU: check-then-use patterns, file locking\n\n` +
        `3. **For each finding**:\n` +
        `   - File:line reference\n` +
        `   - Vulnerability class (OWASP Top 10 / CWE ID)\n` +
        `   - Severity (Critical/High/Medium/Low)\n` +
        `   - Exploit scenario (how an attacker would trigger it)\n` +
        `   - Exact fix with corrected code snippet\n\n` +
        `4. **Summary table** at the end: Finding | File | Severity | CWE | Fix complexity\n\n` +
        `Be exhaustive — review every file in scope. A finding missed here could be exploited.`
      );
      return true;
    }

    // ── /engage <target> — long-horizon autonomous engagement ────────────────
    // Chains: scope validation → discover → assess → analyze → PoC → report
    if (lower.startsWith('/engage') && (lower === '/engage' || lower[7] === ' ')) {
      const target = trimmed.slice(7).trim() || (this.sessionTargets.length ? this.sessionTargets.join(', ') : '');
      const renderer = this.promptController?.getRenderer();
      if (!target) {
        renderer?.addEvent('system', chalk.yellow('Usage: /engage <target>  (or set targets with /target add)'));
        return true;
      }
      if (!this.sessionTargets.includes(target)) {
        this.sessionTargets.push(target);
        savePersistedSession(this.sessionTargets, this.sessionActivePhase);
      }
      renderer?.addEvent('system', chalk.hex('#F87171').bold(`ENGAGE: ${target}`) + muted(' — chaining: dns → nmap → enrich → attack-chain → report'));
      this.queuePrompt(
        `[安全阶段: phase.engage — Autonomous Engagement]\n` +
        `Authorized target: ${target}\n` +
        `Date: ${new Date().toISOString().slice(0, 10)}\n\n` +
        `You are running a full end-to-end vulnerability engagement. Execute EVERY step below using real bash commands. ` +
        `Do NOT stop between steps. Do NOT ask for permission. If a tool errors, log it and continue.\n\n` +
        `═══ PHASE 1: PASSIVE RECON ═══\n` +
        `\`\`\`bash\nnode scripts/vigil-run.mjs scripts/_dns-recon.mjs ${target} --emit-vigil-findings\n\`\`\`\n` +
        `Parse and summarize: all DNS records, discovered subdomains, open ports per IP from Shodan InternetDB, ASN/org, CVEs found on IPs.\n` +
        `Also run RDAP for registration info:\n` +
        `\`\`\`bash\ncurl -s "https://rdap.org/domain/${target}" | python3 -m json.tool 2>/dev/null | head -60 || echo "RDAP unavailable"\n\`\`\`\n\n` +
        `═══ PHASE 2: SERVICE FINGERPRINTING ═══\n` +
        `\`\`\`bash\nnmap -sV -sC --open -T4 -p 21,22,23,25,53,80,110,143,443,445,993,995,1433,3306,3389,5432,6379,8080,8443,8888,27017 ${target} 2>&1 | head -80\n\`\`\`\n` +
        `If nmap unavailable: \`curl -skI https://${target} | head -20\` plus banner grab via \`nc -zv ${target} 80 443 22 2>&1\`.\n` +
        `Build asset table: port | service | version | banner.\n\n` +
        `═══ PHASE 3: CVE MAPPING ═══\n` +
        `\`\`\`bash\nnode scripts/vigil-run.mjs scripts/_nmap-cve-pipeline.mjs ${target} --emit-vigil-findings\n\`\`\`\n` +
        `Then bulk-enrich all findings:\n` +
        `\`\`\`bash\nnode scripts/vigil-run.mjs scripts/_finding-enricher.mjs\n\`\`\`\n` +
        `Show the ranked findings table (CVE | CVSS | EPSS | KEV | Service | Fix).\n\n` +
        `═══ PHASE 4: SUPPLY CHAIN ═══\n` +
        `\`\`\`bash\nnode scripts/vigil-run.mjs scripts/_sbom-builder.mjs --text --emit-vigil-findings\n\`\`\`\n` +
        `Summarize any Critical/High supply-chain CVEs found.\n\n` +
        `═══ PHASE 5: ATTACK CHAINS ═══\n` +
        `Load findings from store and model 2–3 realistic kill chains:\n` +
        `\`\`\`bash\nnode -e "const f=require('fs');const h=require('os').homedir();const p=f.existsSync(h+'/.vigil/findings.json')?JSON.parse(f.readFileSync(h+'/.vigil/findings.json')):[]; console.log(JSON.stringify(p.filter(x=>x.severity==='critical'||x.severity==='high').slice(0,10),null,2))"\n\`\`\`\n` +
        `For the top findings: attacker narrative → ATT&CK T-codes → chokepoints for detection.\n\n` +
        `═══ PHASE 6: DETECTION GAPS ═══\n` +
        `For each Critical/High CVE: write a Sigma rule title + logsource + detection field.\n` +
        `Generate full YAML for the single highest-priority rule.\n\n` +
        `═══ PHASE 7: FINAL REPORT ═══\n` +
        `Output a complete engagement report:\n\n` +
        `# Vigil Engagement Report — ${target}\n` +
        `**Date:** ${new Date().toISOString().slice(0, 10)}  **Classification:** CONFIDENTIAL — AUTHORIZED TEST\n\n` +
        `## Executive Summary\n` +
        `(3 sentences: headline finding, overall risk, most urgent action)\n\n` +
        `## Attack Surface Inventory\n` +
        `| Asset | Port | Service | Version | Exposure |\n\n` +
        `## Critical & High Findings\n` +
        `| CVE | CVSS | EPSS% | KEV | Asset | Impact | Fix |\n\n` +
        `## Attack Chains\n` +
        `(narrative + ATT&CK T-codes per step + chokepoint)\n\n` +
        `## Detection Sigma Rules\n` +
        `(Full YAML for top rule, titles for rest)\n\n` +
        `## Remediation Roadmap\n` +
        `| Priority | Action | CVE | Effort | Owner |\n\n` +
        `## Risk Score\n` +
        `Overall risk: [CRITICAL/HIGH/MEDIUM/LOW] — Reasoning in 2 sentences.`
      );
      return true;
    }

    // ── /poc <CVE> — PoC / exploit scaffold for authorized testing ───────────
    if (lower.startsWith('/poc') && (lower === '/poc' || lower[4] === ' ')) {
      const cve = trimmed.slice(4).trim();
      const renderer = this.promptController?.getRenderer();
      if (!cve) {
        renderer?.addEvent('system', chalk.yellow('Usage: /poc <CVE-ID>  — generates exploit scaffold for authorized testing'));
        return true;
      }
      const targetCtx = this.sessionTargets.length
        ? `\nAuthorized targets in scope: ${this.sessionTargets.join(', ')}` : '';
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`PoC scaffold: ${cve}`) + muted(' (authorized testing only)'));
      this.queuePrompt(
        `[安全阶段: phase.assess — PoC Validation]\n` +
        `Generate a proof-of-concept exploit scaffold for: ${cve}${targetCtx}\n\n` +
        `This is for authorized security testing. Provide:\n\n` +
        `### 1. Vulnerability Summary\n` +
        `- Root cause (memory corruption / logic flaw / injection / auth bypass / etc.)\n` +
        `- Affected component and version range\n` +
        `- CVSS v3.1 vector breakdown (what makes each metric what it is)\n` +
        `- Exploitability prerequisites (network access required? auth? user interaction?)\n\n` +
        `### 2. Exploitation Approach\n` +
        `- Step-by-step exploitation technique\n` +
        `- What the attacker sends / triggers\n` +
        `- What success looks like (shell, data access, auth bypass, DoS)\n\n` +
        `### 3. PoC Code\n` +
        `Produce a working or near-working PoC in Python (preferred) or Bash:\n` +
        `- Include argument parsing for target host/port\n` +
        `- Include a DISCLAIMER header: "AUTHORIZED TESTING ONLY"\n` +
        `- Include a detection check: does the target appear vulnerable before exploiting?\n` +
        `- Include success/failure output\n\n` +
        `### 4. Existing Public Resources\n` +
        `- ExploitDB ID if available\n` +
        `- Metasploit module path if available\n` +
        `- Nuclei template if available\n` +
        `- GitHub PoC repos if known\n\n` +
        `### 5. Detection\n` +
        `- What log entries / network signatures would this PoC leave\n` +
        `- A one-liner Sigma rule detection condition for this specific exploit traffic\n\n` +
        `### 6. Remediation\n` +
        `- Exact fixed version\n` +
        `- Workaround if patch unavailable`
      );
      return true;
    }

    // ── /pentest-report — generate a full penetration testing report ──────────
    if (lower === '/pentest-report' || lower.startsWith('/pentest-report ')) {
      const style = trimmed.slice(14).trim() || 'full';
      const renderer = this.promptController?.getRenderer();
      const targetStr = this.sessionTargets.length ? this.sessionTargets.join(', ') : 'session targets';
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Generating penetration testing report for: ${targetStr}`));
      const ts = new Date().toISOString().slice(0, 10);
      const pentestFindings = loadFindings();
      const pentestFindingsSummary = pentestFindings.length > 0
        ? `\n\nSession findings store (${pentestFindings.length} findings):\n` +
          pentestFindings.slice(0, 30).map((f) =>
            `- [${f.severity.toUpperCase()}] ${f.cve ?? f.id} on ${f.target ?? 'unknown'}: ${f.title}`
          ).join('\n') +
          (pentestFindings.length > 30 ? `\n... and ${pentestFindings.length - 30} more` : '')
        : '';
      this.queuePrompt(
        `[安全阶段: phase.respond — Penetration Test Report]\n` +
        `Generate a professional-grade penetration testing report for: ${targetStr}\n` +
        `Date: ${ts}  Style: ${style}\n\n` +
        `Compile all findings, attack chains, CVEs, and security observations from this session into a complete report.` +
        pentestFindingsSummary + `\n\n` +
        `Use this exact structure:\n\n` +
        `---\n` +
        `# Penetration Test Report\n` +
        `**Target:** ${targetStr}  **Date:** ${ts}  **Classification:** CONFIDENTIAL\n\n` +
        `## 1. Executive Summary\n` +
        `*(3-5 sentences: overall risk posture, headline finding, business impact, single most important action)*\n\n` +
        `## 2. Scope & Methodology\n` +
        `*(What was tested, what tools were used, what was out of scope)*\n\n` +
        `## 3. Risk Summary\n` +
        `| Severity | Count |\n|---|---|\n| Critical | N |\n| High | N |\n| Medium | N |\n| Low | N |\n\n` +
        `## 4. Findings\n` +
        `*(For each finding — repeat this block:)*\n\n` +
        `### [SEVERITY] F-NNN: [Title]\n` +
        `**CVE:** CVE-XXXX-XXXXX  **CVSS:** N.N  **EPSS:** N%  **KEV:** Yes/No\n` +
        `**Asset:** host:port  **Service:** service@version\n\n` +
        `**Description:** [What the vulnerability is and why it matters]\n\n` +
        `**Evidence:** [What was observed / what command showed it]\n\n` +
        `**Impact:** [What an attacker achieves if exploited]\n\n` +
        `**Remediation:** [Exact patch version, config change, or command]\n\n` +
        `**References:** [CVE link, vendor advisory, ExploitDB]\n\n` +
        `## 5. Attack Chains\n` +
        `*(If attack chains were identified: narrative + ATT&CK T-codes + choke points)*\n\n` +
        `## 6. Remediation Roadmap\n` +
        `| Priority | Action | Effort | Owner |\n|---|---|---|---|\n\n` +
        `## 7. Appendix — Tools & Commands\n` +
        `*(Commands run, raw output excerpts, scan configurations)*\n` +
        `---\n\n` +
        `After the report, name the output file: vigil-pentest-${ts}.md`
      );
      return true;
    }

    // ── /enrich — bulk-enrich findings store with CVSS/EPSS/KEV from APIs ────
    if (lower === '/enrich' || lower.startsWith('/enrich ')) {
      const renderer = this.promptController?.getRenderer();
      const findings = loadFindings();
      const cveFindings = findings.filter((f) => f.cve && /^CVE-\d{4}-\d+$/i.test(f.cve));
      if (cveFindings.length === 0) {
        renderer?.addEvent('system', muted('No CVE-tagged findings to enrich. Run /scan or /cve first.'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Enriching ${cveFindings.length} findings with CVSS/EPSS/KEV data...`));
      this.queuePrompt(
        `[安全阶段: phase.assess — Findings Enrichment]\n` +
        `Run the Vigil findings enricher to fetch live CVSS, EPSS, and CISA KEV data for all stored findings:\n\n` +
        `Execute: node scripts/_finding-enricher.mjs\n\n` +
        `After it completes, run /findings to show the updated list with enrichment badges.\n` +
        `Then summarize:\n` +
        `- How many findings are now KEV-listed (confirmed in-the-wild exploitation)?\n` +
        `- How many have EPSS ≥ 50th percentile?\n` +
        `- Which finding has the highest CVSS score?\n` +
        `- What are the top 3 most urgent findings after enrichment?`
      );
      return true;
    }

    // ── /watch — background KEV monitor; alerts on new CISA KEV additions ───
    if (lower === '/watch' || lower.startsWith('/watch ')) {
      const sub = trimmed.slice(6).trim().toLowerCase();
      const renderer = this.promptController?.getRenderer();
      if (sub === 'stop') {
        if (this._kevWatchPid) {
          try { process.kill(this._kevWatchPid, 'SIGTERM'); } catch { /* already dead */ }
          this._kevWatchPid = undefined;
          renderer?.addEvent('system', chalk.yellow('KEV watch stopped.'));
        } else {
          renderer?.addEvent('system', muted('No active KEV watch.'));
        }
        return true;
      }
      if (this._kevWatchPid) {
        renderer?.addEvent('system', muted(`KEV watch already running (PID ${this._kevWatchPid}).  /watch stop to cancel.`));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')('Starting KEV monitor — checking CISA catalog every 30 min...') + muted('  /watch stop to cancel'));
      // Run the KEV monitor in background, poll every 30 minutes
      const interval = 30 * 60 * 1_000;
      const runKevCheck = async () => {
        try {
          const { execFile } = await import('node:child_process');
          const { promisify: prom } = await import('node:util');
          const execFileAsync = prom(execFile);
          const env = { ...process.env };
          const { stdout } = await execFileAsync('node', ['scripts/vigil-run.mjs', 'scripts/_kev-monitor.mjs', '--text'], { env, timeout: 30_000 });
          if (stdout.trim()) {
            renderer?.addEvent('system',
              chalk.red('⚠ KEV update:\n') + muted(stdout.trim().split('\n').slice(0, 10).join('\n'))
            );
            this.syncVigilBadge();
          }
        } catch { /* network failure — silent */ }
      };
      void runKevCheck();
      const watchTimer = setInterval(runKevCheck, interval);
      // Store the timer so /watch stop can cancel it
      this._kevWatchTimer = watchTimer;
      this._kevWatchPid = 1; // sentinel — using timer not a child process
      return true;
    }

    // ── /triage — AI-driven prioritization of all findings in store ─────────
    if (lower === '/triage' || lower.startsWith('/triage ')) {
      const filter = trimmed.slice(7).trim().toLowerCase() || 'all';
      const renderer = this.promptController?.getRenderer();
      const findings = loadFindings();
      if (findings.length === 0) {
        renderer?.addEvent('system', muted('No findings to triage. Run /scan or /cve first.'));
        return true;
      }
      const sevOrder = ['critical', 'high', 'medium', 'low', 'info'];
      const filtered = filter === 'all' ? findings
        : findings.filter((f) => f.severity === filter || (filter === 'crithigh' && (f.severity === 'critical' || f.severity === 'high')));
      const sorted = [...filtered].sort((a, b) => sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity));
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Triaging ${sorted.length} findings...`));
      const findingsList = sorted.slice(0, 40).map((f, i) =>
        `${i + 1}. [${f.severity.toUpperCase()}] ${f.cve ?? f.id} — ${f.title}` +
        (f.target ? ` @ ${f.target}` : '') +
        (f.notes ? ` (${f.notes})` : '')
      ).join('\n');
      this.queuePrompt(
        `[安全阶段: phase.assess — Findings Triage & Prioritization]\n` +
        `You are performing expert vulnerability triage. Prioritize and action-plan these ${sorted.length} findings:\n\n` +
        findingsList + `\n\n` +
        `Session scope: ${this.sessionTargets.length ? this.sessionTargets.join(', ') : 'not specified'}\n\n` +
        `For each finding produce:\n` +
        `1. **Priority rank** (1 = fix immediately) — factor: severity, KEV status, EPSS, exposure, exploitability\n` +
        `2. **Risk reasoning** — why this rank? (e.g. "KEV-listed, EPSS 94th percentile, internet-facing service")\n` +
        `3. **Action** — specific patch/version/config change, not vague ("upgrade to X.Y.Z", "disable feature Y")\n` +
        `4. **Owner** — infra / dev / cloud / soc\n` +
        `5. **SLA** — immediate (now) / urgent (24h) / standard (7d) / planned (30d) / accept (risk-accepted)\n\n` +
        `Present as a ranked table then give the single most important action at the end.\n` +
        `Format: | Rank | Finding | Risk Reasoning | Action | Owner | SLA |`
      );
      return true;
    }

    // ── /diff — compare two findings snapshots, show new/fixed/regressed ────
    if (lower === '/diff' || lower.startsWith('/diff ')) {
      const arg = trimmed.slice(5).trim();
      const renderer = this.promptController?.getRenderer();
      const current = loadFindings();
      if (current.length === 0) {
        renderer?.addEvent('system', muted('No findings in store. Run /scan first.'));
        return true;
      }
      // Snapshot path: ~/.vigil/findings-snapshot-<label>.json
      const vigilDir = join(homedir(), '.vigil');
      const snapshotPath = join(vigilDir,
        arg ? `findings-snapshot-${arg}.json` : 'findings-snapshot.json');

      if (arg === 'save' || arg.startsWith('save ')) {
        const label = arg.replace(/^save\s*/, '').trim() || new Date().toISOString().slice(0, 10);
        const savePath = join(vigilDir, `findings-snapshot-${label}.json`);
        try {
          mkdirSync(vigilDir, { recursive: true });
          writeFileSync(savePath, JSON.stringify(current, null, 2));
          renderer?.addEvent('system', chalk.green(`Snapshot saved: ${savePath}  (${current.length} findings)`));
        } catch (e) {
          renderer?.addEvent('system', chalk.red(`Failed to save snapshot: ${String(e)}`));
        }
        return true;
      }

      // Load snapshot and diff
      let snapshot: FindingRecord[] = [];
      try {
        snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8') as string);
      } catch {
        renderer?.addEvent('system', chalk.yellow(`No snapshot found at ${snapshotPath}\nUse: /diff save [label]  to create one`));
        return true;
      }

      const snapIds = new Set(snapshot.map((f) => f.cve ?? f.id));
      const currIds = new Set(current.map((f) => f.cve ?? f.id));

      const newFindings = current.filter((f) => !snapIds.has(f.cve ?? f.id));
      const fixed = snapshot.filter((f) => !currIds.has(f.cve ?? f.id));
      const diffSevOrder = ['critical', 'high', 'medium', 'low', 'info'];
      const regressed = current.filter((f) => {
        const snap = snapshot.find((s) => (s.cve ?? s.id) === (f.cve ?? f.id));
        return snap && diffSevOrder.indexOf(f.severity) < diffSevOrder.indexOf(snap.severity);
      });
      const sevColor = (s: string) =>
        s === 'critical' ? chalk.red(s.toUpperCase()) :
        s === 'high'     ? chalk.hex('#F87171')(s.toUpperCase()) :
        s === 'medium'   ? chalk.yellow(s.toUpperCase()) :
                           chalk.green(s.toUpperCase());

      const lines: string[] = [
        chalk.hex('#22D3EE')(`Findings diff  (snapshot vs. now)`),
        muted(`  Snapshot: ${snapshot.length}  Current: ${current.length}`),
        '',
      ];
      if (newFindings.length) {
        lines.push(chalk.red(`+ ${newFindings.length} NEW:`));
        newFindings.slice(0, 10).forEach((f) =>
          lines.push(`  ${sevColor(f.severity)}  ${f.cve ?? f.id}  ${f.title}`)
        );
      }
      if (fixed.length) {
        lines.push(chalk.green(`✓ ${fixed.length} FIXED / REMOVED:`));
        fixed.slice(0, 10).forEach((f) =>
          lines.push(muted(`  ${f.cve ?? f.id}  ${f.title}`))
        );
      }
      if (regressed.length) {
        lines.push(chalk.yellow(`⬆ ${regressed.length} ESCALATED:`));
        regressed.slice(0, 10).forEach((f) =>
          lines.push(`  ${sevColor(f.severity)}  ${f.cve ?? f.id}  ${f.title}`)
        );
      }
      if (!newFindings.length && !fixed.length && !regressed.length) {
        lines.push(chalk.green('No changes — findings match snapshot.'));
      }
      renderer?.addEvent('system', lines.join('\n'));
      return true;
    }

    // ── /sbom [--dir <path>] — generate Software Bill of Materials ───────────
    if (lower === '/sbom' || lower.startsWith('/sbom ')) {
      const arg = trimmed.slice(5).trim();
      const renderer = this.promptController?.getRenderer();
      const dir = arg || '.';
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Generating SBOM for: ${dir}  (OSV vulnerability correlation included)`));
      this.queuePrompt(
        `[安全阶段: phase.assess — Supply Chain / SBOM Analysis]\n` +
        `Run the Vigil SBOM builder on directory: "${dir}"\n\n` +
        `Execute: node scripts/_sbom-builder.mjs --dir ${dir} --text --emit-vigil-findings\n\n` +
        `After running, summarize:\n` +
        `1. Total components by ecosystem (npm, PyPI, Go, Rust, etc.)\n` +
        `2. Vulnerable components — list each with CVE, CVSS if known, and fixed version\n` +
        `3. Risk assessment — which findings are Critical/High and KEV-listed?\n` +
        `4. Remediation priority — ordered action list\n` +
        `5. SBOM completeness — any manifests that couldn't be parsed?\n\n` +
        `If the script is not available, perform an equivalent manual analysis of package manifests found in ${dir}.`
      );
      return true;
    }

    // ── /ioc — IOC store management ─────────────────────────────────────────
    if (lower === '/ioc' || lower === '/iocs' || lower.startsWith('/ioc ') || lower.startsWith('/iocs ')) {
      const renderer = this.promptController?.getRenderer();
      const rest = trimmed.replace(/^\/iocs?\s*/i, '').trim();
      const parts = rest.split(/\s+/);
      const sub = parts[0]?.toLowerCase();
      const iocTypeColor = (t: string) =>
        t === 'ip' ? chalk.hex('#F87171') :
        t === 'hash' ? chalk.hex('#FBBF24') :
        t === 'domain' ? chalk.hex('#22D3EE') :
        t === 'url' ? chalk.cyan :
        muted;

      if (!sub || sub === 'list') {
        const iocs = loadIocs();
        if (iocs.length === 0) {
          renderer?.addEvent('system', muted('No IOCs saved. Use: /ioc add <value> [context]'));
        } else {
          const byType = iocs.reduce((acc, i) => { acc[i.type] = (acc[i.type] || 0) + 1; return acc; }, {} as Record<string, number>);
          const summary = Object.entries(byType).map(([t, n]) => `${n} ${t}`).join('  ·  ');
          const lines = iocs.map((i) =>
            `  ${muted(i.id)}  ${iocTypeColor(i.type)(i.type.padEnd(8))}  ${chalk.white(i.value)}` +
            (i.context ? muted(`  [${i.context}]`) : '')
          );
          renderer?.addEvent('system',
            chalk.hex('#22D3EE')(`IOCs (${iocs.length}):  `) + muted(summary) + '\n' + lines.join('\n')
          );
        }
      } else if (sub === 'add') {
        const value = parts[1];
        const context = parts.slice(2).join(' ').trim() || undefined;
        if (!value) {
          renderer?.addEvent('system', chalk.yellow('Usage: /ioc add <IP|hash|domain|URL> [context/campaign]'));
        } else {
          const type = inferIocType(value);
          const id = `IOC-${Date.now().toString(36).toUpperCase()}`;
          const rec: IocRecord = { id, type, value, context, source: 'session', ts: new Date().toISOString() };
          const existing = loadIocs();
          if (existing.some((i) => i.value.toLowerCase() === value.toLowerCase())) {
            renderer?.addEvent('system', muted(`IOC already stored: ${value}`));
          } else {
            saveIocs([...existing, rec]);
            renderer?.addEvent('system', chalk.green(`IOC saved: ${id}  ${type}  ${value}`) + (context ? muted(`  [${context}]`) : ''));
          }
        }
      } else if ((sub === 'rm' || sub === 'del') && parts[1]) {
        const id = parts[1].toUpperCase();
        const filtered = loadIocs().filter((i) => i.id !== id && i.value.toLowerCase() !== parts[1].toLowerCase());
        saveIocs(filtered);
        renderer?.addEvent('system', chalk.yellow(`IOC removed: ${parts[1]}`));
      } else if (sub === 'clear') {
        saveIocs([]);
        renderer?.addEvent('system', chalk.yellow('IOC store cleared.'));
      } else if (sub === 'hunt') {
        const iocs = loadIocs();
        if (iocs.length === 0) {
          renderer?.addEvent('system', muted('No IOCs in store. Add with /ioc add <value>'));
          return true;
        }
        const targetCtx = this.sessionTargets.length ? `\nAuthorized scope: ${this.sessionTargets.join(', ')}` : '';
        const iocList = iocs.map((i) => `- [${i.type}] ${i.value}${i.context ? ` (${i.context})` : ''}`).join('\n');
        renderer?.addEvent('system', chalk.hex('#22D3EE')(`Hunting ${iocs.length} IOCs...`));
        this.queuePrompt(
          `[安全阶段: phase.hunt — IOC-Driven Threat Hunt]\n` +
          `Hunt for the following ${iocs.length} IOCs in the environment:${targetCtx}\n\n` +
          iocList + `\n\n` +
          `For each IOC:\n` +
          `1. Describe what it is and what threat it's associated with\n` +
          `2. Where to look (log sources, artifact locations, memory, network)\n` +
          `3. Detection query (Sigma rule snippet, grep command, or SIEM query)\n` +
          `4. What a hit means — is it a confirmed compromise or needs triage?\n` +
          `5. Immediate response action if found\n\n` +
          `End with a hunting checklist the analyst can execute manually.`
        );
      } else if (sub === 'export') {
        const iocs = loadIocs();
        renderer?.addEvent('system', JSON.stringify(iocs, null, 2));
      } else {
        renderer?.addEvent('system', chalk.yellow('Usage: /ioc [list|add|rm|hunt|export|clear]'));
      }
      return true;
    }

    // ── /variant — dependency variant research via GitHub Security Advisories ─
    if (lower === '/variant' || lower.startsWith('/variant ')) {
      const arg = trimmed.slice(8).trim();
      const renderer = this.promptController?.getRenderer();
      renderer?.addEvent('system', chalk.hex('#22D3EE')('Running variant / advisory research on direct dependencies...'));
      this.queuePrompt(
        `[安全阶段: phase.assess — Dependency Variant Research]\n` +
        `Run variant research on the project's direct dependencies${arg ? ` (focus: ${arg})` : ''}.\n\n` +
        `Execute: node scripts/_variant-research.mjs${arg ? ` --dep ${arg}` : ''}\n\n` +
        `If the script is unavailable, query the GitHub Security Advisory GraphQL API for npm/PyPI/Go advisories affecting packages in package.json / requirements.txt / go.mod.\n\n` +
        `Report:\n` +
        `1. New advisories not yet in findings store (by package + CVE/GHSA)\n` +
        `2. Severity distribution — Critical/High/Medium/Low advisory counts\n` +
        `3. Packages with multiple active advisories (high exposure)\n` +
        `4. Recommended upgrade path for each affected package\n` +
        `5. Any withdrawn/informational advisories that npm audit hides but are worth noting`
      );
      return true;
    }

    // ── /regression — changed-file regression analysis and check selection ─
    if (lower === '/regression' || lower.startsWith('/regression ')) {
      const arg = trimmed.slice('/regression'.length).trim();
      const renderer = this.promptController?.getRenderer();
      renderer?.addEvent('system', chalk.hex('#22D3EE')('Running regression analysis on the current working tree...'));
      this.queuePrompt(
        `[安全阶段: phase.regression_analysis — Regression Analysis]\n` +
        `Run regression analysis for the current repository${arg ? ` with options: ${arg}` : ''}.\n\n` +
        `Execute: node scripts/_regression-analysis.mjs${arg ? ` ${arg}` : ''}\n\n` +
        `Report:\n` +
        `1. Changed files grouped by runtime surface and risk\n` +
        `2. Recommended build/test/lint/security checks and why each one matters\n` +
        `3. Checks actually executed, with exit codes and failure summaries\n` +
        `4. Any CVE/GHSA or variant-analysis references touched by the change\n` +
        `5. Residual regression risk and the smallest next validation step`
      );
      return true;
    }

    // ── /probe — platform enumeration (OS, services, listening ports, config) ─
    if (lower === '/probe' || lower.startsWith('/probe ')) {
      const arg = trimmed.slice(6).trim() || 'localhost';
      const renderer = this.promptController?.getRenderer();
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Platform probe: ${arg}`));
      this.queuePrompt(
        `[安全阶段: phase.discover — Platform Enumeration]\n` +
        `Run a comprehensive platform probe on: ${arg}\n\n` +
        `Execute: node scripts/_platform-probe.mjs\n\n` +
        `Enumerate and report:\n` +
        `1. **OS details** — kernel version, distribution, patch level, architecture\n` +
        `2. **Listening services** — port, protocol, service name, version (nmap -sV or ss/netstat)\n` +
        `3. **Running processes** — anything suspicious: unexpected listeners, high-privilege processes\n` +
        `4. **Security posture** — firewall rules, SELinux/AppArmor status, unattended-upgrades\n` +
        `5. **Users and privileges** — sudo rights, SUID/SGID binaries, cron jobs\n` +
        `6. **Attack surface** — what's exposed? What's the most likely entry point?\n` +
        `7. **Recommendations** — top 5 hardening actions based on what was found\n\n` +
        `Flag any immediately exploitable findings (unpatched services, world-writable dirs, default creds).`
      );
      return true;
    }

    // ── /leaks [dir] — detect secrets & credentials in source code ──────────
    if (lower === '/leaks' || lower.startsWith('/leaks ')) {
      const dir = trimmed.slice(6).trim() || '.';
      const renderer = this.promptController?.getRenderer();
      renderer?.addEvent('system', chalk.hex('#F87171')(`Scanning for committed secrets and credentials${dir !== '.' ? `: ${dir}` : ''}...`));
      this.queuePrompt(
        `[安全阶段: phase.assess — Credential & Secret Exposure Scan]\n` +
        `Execute: node scripts/vigil-run.mjs scripts/_secret-scan.mjs --emit-vigil-findings${dir !== '.' ? ` --dir ${dir}` : ''}\n\n` +
        `Parse the output and produce a structured report:\n\n` +
        `## Secret Exposure Report\n\n` +
        `### Critical Findings\n` +
        `For each CRITICAL hit: file path, line number, secret type, masked value, and what an attacker could do with it.\n\n` +
        `### High Findings\n` +
        `Same treatment for HIGH severity hits.\n\n` +
        `### Remediation Steps\n` +
        `1. Which secrets must be rotated immediately (assume compromised if committed)\n` +
        `2. Exact git commands to purge from history (BFG Repo-Cleaner or git filter-repo)\n` +
        `3. What .gitignore rules to add\n` +
        `4. Pre-commit hook or CI check to prevent recurrence (e.g., gitleaks, detect-secrets)\n\n` +
        `### Risk Assessment\n` +
        `If any AWS/GCP/cloud keys were found: what damage could an attacker do with them right now?\n\n` +
        `Be specific. Include exact commands for rotation where possible.`
      );
      return true;
    }

    // ── /nmap [flags] <target> — live nmap scan with CVE pipeline ────────────
    if (lower.startsWith('/nmap') && (lower === '/nmap' || lower[5] === ' ')) {
      const args = trimmed.slice(5).trim();
      const renderer = this.promptController?.getRenderer();
      const target = args || (this.sessionTargets.length ? this.sessionTargets[0] : '');
      if (!target) {
        renderer?.addEvent('system', chalk.yellow('Usage: /nmap [flags] <host|IP|CIDR>  (or set targets with /target add)'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`nmap scan → CPE → CVE pipeline: ${target}`));
      this.queuePrompt(
        `[安全阶段: phase.discover — Network Service Enumeration]\n` +
        `Target: ${target}\n\n` +
        `Execute this nmap → CVE pipeline end-to-end:\n\n` +
        `**Step 1 — Service fingerprint scan:**\n` +
        `\`\`\`bash\nnmap -sV -sC --open -T4 -oX /tmp/vigil-nmap.xml ${target} 2>&1\n\`\`\`\n` +
        `If nmap is unavailable, try: \`nmap -sV --open ${target}\` or report the error.\n\n` +
        `**Step 2 — Parse results and extract service@version:**\n` +
        `For each open port: port/protocol, service name, version string, OS guess.\n\n` +
        `**Step 3 — Map to CPE strings:**\n` +
        `Convert each service@version to a CPE 2.3 string (cpe:2.3:a:vendor:product:version:...).\n\n` +
        `**Step 4 — CVE lookup for each CPE:**\n` +
        `For each CPE, query NVD CVE API: https://services.nvd.nist.gov/rest/json/cves/2.0?cpeName=<CPE>\n` +
        `Extract: CVE ID, CVSS v3.1 score, published date, description.\n\n` +
        `**Step 5 — Cross-reference CISA KEV:**\n` +
        `For any CVE with CVSS ≥ 7.0, check if it appears in the CISA KEV catalog.\n\n` +
        `**Step 6 — Ranked findings table:**\n` +
        `| Port | Service | Version | CVE | CVSS | KEV | Fix |\n` +
        `|------|---------|---------|-----|------|-----|-----|\n\n` +
        `Sort: Critical+KEV → Critical → High → Medium. Include exact patch/version for each.\n\n` +
        `**Step 7 — Run enricher:**\n` +
        `\`\`\`bash\nnode scripts/vigil-run.mjs scripts/_finding-enricher.mjs\n\`\`\`\n\n` +
        `For the highest-severity finding, generate a Sigma detection rule.\n` +
        `End with: 3 immediate hardening actions for this host.`
      );
      return true;
    }

    // ── /exploit-check <CVE> — exploit availability intel ──────────────────
    if (lower.startsWith('/exploit-check') && (lower === '/exploit-check' || lower[14] === ' ')) {
      const cveId = trimmed.slice(14).trim().toUpperCase();
      const renderer = this.promptController?.getRenderer();
      if (!cveId || !cveId.match(/^CVE-\d{4}-\d+$/)) {
        renderer?.addEvent('system', chalk.yellow('Usage: /exploit-check <CVE-ID>'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#F87171')(`Exploit availability check: ${cveId}`));
      this.queuePrompt(
        `[安全阶段: phase.assess — Exploit Availability Intelligence]\n` +
        `CVE: ${cveId}\n\n` +
        `Perform a comprehensive exploit availability assessment:\n\n` +
        `## Exploit Availability Report: ${cveId}\n\n` +
        `### 1. ExploitDB\n` +
        `Search https://www.exploit-db.com/search?cve=${cveId}\n` +
        `- Is there a public exploit? EDB ID, type (remote/local/WebApp), verified?\n` +
        `- Direct download/reference link\n\n` +
        `### 2. PoC-in-GitHub\n` +
        `Search GitHub for repositories matching the CVE ID that contain PoC code.\n` +
        `- Repository URL, star count, language, last updated\n` +
        `- Is it a fully working analysis or just a scanner/checker?\n` +
        `- Is it comprehensive (full chain) or partial?\n\n` +
        `### 3. Metasploit Module\n` +
        `Is there a Metasploit module? Module path, rank (Excellent/Great/Good/Normal/Average/Low), targets.\n\n` +
        `### 4. EPSS & KEV Cross-reference\n` +
        `Run: node scripts/vigil-run.mjs scripts/_cve-lookup.mjs ${cveId}\n` +
        `Report: CVSS score, EPSS percentile, KEV status, published date.\n\n` +
        `### 5. Weaponization Timeline\n` +
        `- Date of public disclosure\n` +
        `- Date first PoC appeared\n` +
        `- Date added to CISA KEV (if applicable)\n` +
        `- Days from disclosure to first analysis availability\n\n` +
        `### 6. Risk Assessment\n` +
        `Given exploit availability + CVSS + EPSS + KEV:\n` +
        `- **Urgency**: Patch immediately / Patch within 24h / Patch within 7d / Monitor\n` +
        `- **Attacker advantage**: What exactly can an attacker achieve with this exploit?\n` +
        `- **Detection**: What log event would fire when this exploit is used?\n\n` +
        `Be specific. Include direct links and exact commands.`
      );
      return true;
    }

    // ── /cloudreach — detect cloud credential pivot surface ─────────────────
    if (lower === '/cloudreach' || lower === '/cloud-reach') {
      const renderer = this.promptController?.getRenderer();
      renderer?.addEvent('system', chalk.hex('#22D3EE')('Probing cloud reachability surface (AWS, GCP, Azure, K8s, Terraform)...'));
      this.queuePrompt(
        `[安全阶段: phase.discover — Cloud Credential Pivot Analysis]\n` +
        `Execute: node scripts/_cloud-reachability.mjs\n\n` +
        `Probe the local host for cloud pivot surface — active credentials, CLI sessions, kubeconfigs, Terraform state, and credential files that could allow an attacker to pivot into cloud infrastructure.\n\n` +
        `Report per provider (AWS, GCP, Azure, Firebase, Terraform, Kubernetes):\n` +
        `1. **Credential files present** — path, type (access key / service account / kubeconfig)\n` +
        `2. **Active sessions** — CLI profile names, token expiry if detectable\n` +
        `3. **Reachable resources** — what can an attacker reach with these credentials? (run whoami/sts:GetCallerIdentity equivalents)\n` +
        `4. **Risk assessment** — High (admin/owner-level), Medium (read-only), Low (scoped/limited)\n` +
        `5. **Immediate hardening** — revoke, rotate, scope-limit, or remove each finding\n\n` +
        `Flag any credentials with excessive permissions or long-lived tokens without rotation.`
      );
      return true;
    }

    // ── /risky [path] — static security pattern scan ────────────────────────
    if (lower === '/risky' || lower.startsWith('/risky ')) {
      const dir = trimmed.slice(6).trim() || '.';
      const renderer = this.promptController?.getRenderer();
      renderer?.addEvent('system', chalk.hex('#F87171')(`Static security scan: ${dir}  (eval, command injection, hardcoded secrets, weak crypto…)`));
      this.queuePrompt(
        `[安全阶段: phase.assess — Static Security Code Scan]\n` +
        `Run a static security pattern analysis on: "${dir}"\n\n` +
        `Execute: node scripts/_risky-code-scan.mjs\n\n` +
        `The scanner checks for: eval/new Function, command injection, TLS disabled, ` +
        `weak crypto (MD5/SHA1), hardcoded certs/keys, chmod 777, SQL injection, XSS (innerHTML), ` +
        `CORS wildcard, Math.random for crypto, TODO/FIXME security notes.\n\n` +
        `After running, summarize:\n` +
        `1. Critical and High findings with file:line references\n` +
        `2. For each finding: what the risk is and how to fix it\n` +
        `3. False-positive guidance — which patterns are expected in test/build code\n` +
        `4. CWE mapping for each pattern type found\n` +
        `5. Remediation priority order\n\n` +
        `If the script is unavailable, do an equivalent manual grep-based audit.`
      );
      return true;
    }

    // ── /advisory [package] — deep per-package advisory investigation ────────
    if (lower === '/advisory' || lower.startsWith('/advisory ')) {
      const pkg = trimmed.slice(9).trim();
      const renderer = this.promptController?.getRenderer();
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Advisory investigation${pkg ? `: ${pkg}` : ' (all vulnerable packages)'}...`));
      this.queuePrompt(
        `[安全阶段: phase.assess — Advisory Investigation]\n` +
        `${pkg ? `Deep-dive advisory investigation for package: "${pkg}"` : 'Run advisory investigation on all packages in this project'}\n\n` +
        `Execute: node scripts/_advisory-investigation.mjs${pkg ? ` --package ${pkg}` : ''}\n\n` +
        `For each advisory:\n` +
        `1. GHSA ID + CVE ID + severity + CVSS vector\n` +
        `2. Vulnerability description and attack scenario\n` +
        `3. Dependency path: how does this package reach the application?\n` +
        `4. Available fix: exact version to upgrade to\n` +
        `5. Post-fix audit confirmation: does upgrading clear the advisory?\n` +
        `6. Breaking changes to watch for in the upgrade\n\n` +
        `Produce a prioritized upgrade plan as a code block: exact package.json changes needed.`
      );
      return true;
    }

    // ── /inventory — system asset inventory (apps, protocols, exploitation surface) ──
    if (lower === '/inventory' || lower.startsWith('/inventory ')) {
      const renderer = this.promptController?.getRenderer();
      const targetCtx = this.sessionTargets.length ? `\nTarget scope: ${this.sessionTargets.join(', ')}` : '';
      renderer?.addEvent('system', chalk.hex('#22D3EE')('Running system asset inventory (apps, services, protocols, exploitation surface, persistence, hardening delta)...'));
      this.queuePrompt(
        `[安全阶段: phase.discover — Asset Inventory]\n` +
        `Execute: node scripts/_cne-inventory.mjs${targetCtx ? ` — scope: ${this.sessionTargets.join(', ')}` : ''}\n\n` +
        `Collect and analyze the target asset inventory:${targetCtx}\n\n` +
        `**Pack A — Application inventory**\n` +
        `- Installed applications (registry, Appx, MSI, package managers)\n` +
        `- Identify: outdated versions, EOL software\n\n` +
        `**Pack B — Protocol exposure**\n` +
        `- SMB, TLS versions, NTLM, Kerberos, LLMNR, mDNS, NetBIOS, WinRM, RDP, IPv6\n` +
        `- Flag: legacy protocols that should be disabled (NTLM, SMBv1, LLMNR)\n\n` +
        `**Pack C — Security feature status**\n` +
        `- HVCI, VBS, Credential Guard, ASR rules, CFA, WDAC/AppLocker, UAC, BitLocker\n` +
        `- Flag any disabled features that should be on\n\n` +
        `**Pack D — Persistence surface**\n` +
        `- Services, scheduled tasks, Run keys, startup folders, drivers, browser extensions\n` +
        `- Flag: unsigned binaries, suspicious paths, LOLBins in persistence\n\n` +
        `**Pack E — Hardening baseline delta**\n` +
        `- Delta vs. CIS Level 1 / MS Security Baseline\n` +
        `- Top 10 most impactful hardening gaps\n\n` +
        `End with a prioritized remediation table: | Finding | Risk | Action | Effort |`
      );
      return true;
    }

    // ── /note <finding-id> <text> — annotate a stored finding ───────────────
    if (lower === '/note' || lower.startsWith('/note ')) {
      const renderer = this.promptController?.getRenderer();
      const args = trimmed.slice(5).trim().split(/\s+/);
      const id = args[0]?.toUpperCase();
      const noteText = args.slice(1).join(' ').trim();
      if (!id || !noteText) {
        renderer?.addEvent('system', chalk.yellow('Usage: /note <finding-id> <text>'));
        return true;
      }
      const findings = loadFindings();
      const idx = findings.findIndex((f) => f.id === id || f.cve?.toUpperCase() === id);
      if (idx < 0) {
        renderer?.addEvent('system', chalk.yellow(`Finding not found: ${id}  (use /findings to list)`));
        return true;
      }
      const prev = findings[idx].notes;
      findings[idx] = {
        ...findings[idx],
        notes: prev ? `${prev} | ${noteText}` : noteText,
      };
      saveFindings(findings);
      renderer?.addEvent('system',
        chalk.green(`Note added to ${findings[idx].id}: `) + chalk.white(noteText)
      );
      return true;
    }

    // ── /context — show what gets injected into every prompt ────────────────
    if (lower === '/context') {
      const renderer = this.promptController?.getRenderer();
      const findings = loadFindings();
      const iocs = loadIocs();
      const sevOrder = ['critical', 'high', 'medium', 'low', 'info'];
      const counts = sevOrder.map((s) => ({ s, n: findings.filter((f) => f.severity === s).length })).filter((x) => x.n > 0);
      const lines = [
        chalk.hex('#22D3EE')('Session context injected into every prompt:'),
        '',
        muted('Targets:'),
        ...(this.sessionTargets.length
          ? this.sessionTargets.map((t) => `  ${chalk.green('●')} ${t}`)
          : [`  ${muted('none — /target add <host|CIDR|URL>')}`]),
        '',
        muted('Active phase:') + '  ' + (this.sessionActivePhase ? chalk.hex('#FBBF24')(this.sessionActivePhase) : muted('auto-detect from prompt')),
        '',
        muted('Findings store:') + '  ' +
          (findings.length === 0 ? muted('empty') :
            counts.map((x) => `${x.n} ${x.s}`).join('  ·  ') +
            (findings.filter((f) => f.kev).length ? `  ·  ${findings.filter((f) => f.kev).length} KEV` : '')),
        muted('IOC store:') + '     ' + (iocs.length === 0 ? muted('empty') : `${iocs.length} indicators`),
        '',
        muted('Prompt prefix template:'),
        muted('  [Session scope — authorized targets: <targets>]'),
        muted('  [安全阶段: <phase> — <label>]  (when auto-detected or set)'),
        '',
        muted('Auto-routing:  CVE-YYYY-NNNNN → /cve  ·  x.x.x.x → /ip  ·  hex hash → /hash'),
      ];
      renderer?.addEvent('system', lines.join('\n'));
      return true;
    }

    // ── /osint <target> — passive OSINT / recon without active scanning ───────
    // ── /dns <domain> — passive DNS recon with live data ────────────────────
    // ── /whois <domain|IP> — RDAP registration & ownership lookup ───────────
    if (lower.startsWith('/whois') && (lower === '/whois' || lower[6] === ' ')) {
      const whoisTarget = trimmed.slice(6).trim();
      const renderer = this.promptController?.getRenderer();
      if (!whoisTarget) {
        renderer?.addEvent('system', chalk.yellow('Usage: /whois <domain|IP>'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`WHOIS/RDAP: ${whoisTarget}`) + muted(' (live RDAP…)'));
      void (async () => {
        let liveCtx = '';
        try {
          const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(whoisTarget);
          const url = isIp
            ? `https://rdap.org/ip/${whoisTarget}`
            : `https://rdap.org/domain/${whoisTarget}`;
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 8_000);
          const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Vigil-CLI/1.0', Accept: 'application/json' } });
          clearTimeout(t);
          if (res.ok) {
            type RdapData = Record<string, unknown>;
            const data = await res.json() as RdapData;
            const extract = (obj: RdapData): string[] => {
              const lines: string[] = [];
              if (obj.ldhName)       lines.push(`Domain: ${obj.ldhName}`);
              if (obj.status)        lines.push(`Status: ${(obj.status as string[]).join(', ')}`);
              if (obj.registrationDate) lines.push(`Created: ${obj.registrationDate}`);
              if (obj.expirationDate)   lines.push(`Expires: ${obj.expirationDate}`);
              if (Array.isArray(obj.nameservers)) {
                lines.push(`Nameservers: ${(obj.nameservers as RdapData[]).map((n) => n.ldhName).join(', ')}`);
              }
              if (Array.isArray(obj.entities)) {
                for (const e of obj.entities as RdapData[]) {
                  if (Array.isArray(e.roles) && (e.roles as string[]).includes('registrar')) {
                    lines.push(`Registrar: ${(e as RdapData & { fn?: string }).fn ?? JSON.stringify(e.vcardArray ?? '')}`);
                  }
                }
              }
              if (obj.startAddress) lines.push(`IP range start: ${obj.startAddress}`);
              if (obj.endAddress)   lines.push(`IP range end: ${obj.endAddress}`);
              if (obj.name)         lines.push(`Network name: ${obj.name}`);
              if (obj.country)      lines.push(`Country: ${obj.country}`);
              return lines;
            };
            const lines = extract(data);
            if (lines.length) {
              liveCtx = `[Live RDAP data for ${whoisTarget}:\n${lines.join('\n')}]`;
              renderer?.addEvent('system', muted('RDAP data loaded'));
            }
          }
        } catch { /* best-effort */ }
        this.queuePrompt(
          `[安全阶段: phase.discover — WHOIS/RDAP Registration Intelligence]\n` +
          (liveCtx ? liveCtx + '\n\n' : '') +
          `RDAP/WHOIS lookup for: ${whoisTarget}\n\n` +
          `Interpret the registration data above and provide:\n` +
          `1. **Registrant** — who owns this domain/IP? Organization, country, contact\n` +
          `2. **Registrar** — which registrar? Is it privacy-protected (proxy registration)?\n` +
          `3. **Registration timeline** — creation, last update, expiry. Is it newly registered (< 90 days = suspicious)? About to expire?\n` +
          `4. **Nameservers** — what DNS hosting? (Cloudflare, Route53, self-hosted = different risk profiles)\n` +
          `5. **DNSSEC** — enabled or not? What's the risk implication?\n` +
          `6. **Threat context** — if this is an IP/ASN: cloud provider, datacenter, residential/proxy? Historical abuse?\n` +
          `7. **Defender verdict** — legitimate infrastructure, suspicious, or likely malicious? Recommend: monitor / block / whitelist.`
        );
      })();
      return true;
    }

    // ── /crt <domain> — certificate transparency subdomain enumeration ───────
    if (lower.startsWith('/crt') && (lower === '/crt' || lower[4] === ' ')) {
      const crtDomain = trimmed.slice(4).trim() || (this.sessionTargets.length ? this.sessionTargets[0] : '');
      const renderer = this.promptController?.getRenderer();
      if (!crtDomain) {
        renderer?.addEvent('system', chalk.yellow('Usage: /crt <domain>'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Cert transparency: ${crtDomain}`) + muted(' (crt.sh…)'));
      void (async () => {
        let crtCtx = '';
        let subdomains: string[] = [];
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 10_000);
          const res = await fetch(`https://crt.sh/?q=%25.${crtDomain}&output=json`, {
            signal: ctrl.signal, headers: { 'User-Agent': 'Vigil-CLI/1.0', Accept: 'application/json' },
          });
          clearTimeout(t);
          if (res.ok) {
            type CrtEntry = { name_value: string; not_before: string; not_after: string; issuer_name: string };
            const certs = await res.json() as CrtEntry[];
            const names = new Set<string>();
            for (const c of certs) {
              for (const n of (c.name_value || '').split('\n')) {
                const clean = n.trim().replace(/^\*\./, '');
                if (clean.endsWith(crtDomain)) names.add(clean.toLowerCase());
              }
            }
            subdomains = [...names].sort();
            renderer?.addEvent('system', muted(`crt.sh: ${certs.length} certs, ${subdomains.length} unique names`));
            crtCtx = `[crt.sh: ${subdomains.length} subdomains/names found:\n${subdomains.slice(0, 40).join('\n')}${subdomains.length > 40 ? `\n... +${subdomains.length - 40} more` : ''}]`;
          }
        } catch { /* best-effort */ }
        this.queuePrompt(
          `[安全阶段: phase.discover — Certificate Transparency Recon]\n` +
          (crtCtx ? crtCtx + '\n\n' : '') +
          `Certificate transparency analysis for: ${crtDomain}\n\n` +
          `## Subdomain Analysis\n` +
          `From the crt.sh data above, categorize discovered subdomains by risk:\n\n` +
          `**High-interest subdomains** (dev/staging/admin/api/vpn/ci/git/internal):\n` +
          `List each with: why it's interesting, likely service, attack surface implication.\n\n` +
          `**Wildcard certificates**: Which certs are wildcards? What does this imply for attack surface?\n\n` +
          `**Certificate issuers**: CA mix (Let's Encrypt vs commercial vs self-signed implications)\n\n` +
          `**Dangling/orphaned names**: Any subdomains that might point to decommissioned services (subdomain takeover risk)?\n\n` +
          `**Historical exposure**: Oldest certificate — how long has this org had an internet presence?\n\n` +
          `## Priority Targets\n` +
          `Top 5 subdomains an attacker would target first, with reasoning.\n\n` +
          `## Recommended Next Steps\n` +
          `For each high-interest subdomain: \`/dns <subdomain>\` to resolve + \`/nmap <ip>\` to enumerate.`
        );
      })();
      return true;
    }

    if (lower.startsWith('/dns') && (lower === '/dns' || lower[4] === ' ')) {
      const dnsTarget = trimmed.slice(4).trim() || (this.sessionTargets.length ? this.sessionTargets[0] : '');
      const renderer = this.promptController?.getRenderer();
      if (!dnsTarget) {
        renderer?.addEvent('system', chalk.yellow('Usage: /dns <domain>'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`DNS recon: ${dnsTarget}`) + muted(' (live: DoH + crt.sh + Shodan InternetDB)'));
      this.queuePrompt(
        `[安全阶段: phase.discover — DNS Reconnaissance]\n` +
        `Target domain: ${dnsTarget}\n\n` +
        `Execute this passive DNS recon pipeline (no active scanning):\n\n` +
        `**Step 1 — Run the DNS recon script:**\n` +
        `\`\`\`bash\nnode scripts/vigil-run.mjs scripts/_dns-recon.mjs ${dnsTarget} --emit-vigil-findings\n\`\`\`\n\n` +
        `**Step 2 — Interpret the results:**\n` +
        `For each record type: what does it reveal about the attack surface?\n\n` +
        `**Step 3 — Subdomain analysis:**\n` +
        `From crt.sh results: which subdomains suggest dev/staging/admin/api endpoints? Any dangling CNAMEs?\n\n` +
        `**Step 4 — IP & ASN analysis:**\n` +
        `From Shodan InternetDB data: which open ports/services are unexpected? Any CVEs on these IPs?\n\n` +
        `**Step 5 — Email security posture:**\n` +
        `SPF record: strict (-all) or permissive (~all/+all)?\n` +
        `DMARC: policy=reject/quarantine/none?\n` +
        `DKIM: selector visible?\n` +
        `Verdict: susceptible to email spoofing?\n\n` +
        `**Step 6 — Attack surface summary:**\n` +
        `| Asset | Type | Risk | Note |\n` +
        `|-------|------|------|------|\n\n` +
        `Top 3 most interesting findings for an attacker. What should the defender do first?`
      );
      return true;
    }

    if (lower.startsWith('/osint') && (lower === '/osint' || lower[6] === ' ')) {
      const target = trimmed.slice(6).trim() || (this.sessionTargets.length ? this.sessionTargets[0] : '');
      const renderer = this.promptController?.getRenderer();
      if (!target) {
        renderer?.addEvent('system', chalk.yellow('Usage: /osint <domain|IP|org>'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`OSINT recon: ${target}`) + muted(' (passive only — no active scanning)'));
      this.queuePrompt(
        `[安全阶段: phase.discover — Passive OSINT Recon]\n` +
        `Perform passive OSINT reconnaissance on: "${target}"\n\n` +
        `PASSIVE ONLY — do not send any packets to the target. Use only public APIs, archives, and databases.\n\n` +
        `Gather and organize:\n` +
        `1. **DNS footprint** — A, AAAA, MX, TXT, NS, CNAME records; zone transfer attempt (note if blocked)\n` +
        `2. **Certificate transparency** — subdomains from crt.sh (curl https://crt.sh/?q=<target>&output=json)\n` +
        `3. **WHOIS & registration** — registrar, creation/expiry, nameservers, registrant org\n` +
        `4. **ASN & IP ranges** — AS number, IP blocks, hosting provider, cloud provider (AWS/GCP/Azure/CDN)\n` +
        `5. **Email / employee data** — MX config, SPF/DKIM/DMARC policy (infers email security posture)\n` +
        `6. **Technology fingerprint** — from HTTP headers (server, X-Powered-By), Shodan if data available in memory, job postings (reveals stack), GitHub repos\n` +
        `7. **Historical exposure** — Wayback Machine notable paths; any past breach mentions\n` +
        `8. **Social / open source** — GitHub org, Dockerhub, package registries (npm/PyPI/Maven) artifacts\n\n` +
        `Format output as: category → findings → security implication for each item.\n` +
        `Show the exact curl/dig commands used so the operator can re-run or extend them.`
      );
      return true;
    }

    // ── /sigma — generate a Sigma detection rule ─────────────────────────────
    if (lower.startsWith('/sigma') && (lower === '/sigma' || lower[6] === ' ')) {
      const subject = trimmed.slice(6).trim();
      const renderer = this.promptController?.getRenderer();
      if (!subject) {
        renderer?.addEvent('system', chalk.yellow('Usage: /sigma <ATT&CK technique|CVE|behavior description>'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Generating Sigma rule for: ${subject}`));
      const sigmaCveHint = /^CVE-\d{4}-\d+$/i.test(subject.trim())
        ? `\nNote: the subject is a CVE ID — use your knowledge of that vulnerability's affected software, exploitation technique, and observable artifacts to choose the most specific and useful detection logic.\n`
        : '';
      this.queuePrompt(
        `[安全阶段: phase.detect — Detection Engineering]\n` +
        `Generate a production-quality Sigma rule for: "${subject}"\n` + sigmaCveHint + `\n` +
        `Requirements:\n` +
        `1. Valid Sigma v1 YAML — title, id (random UUID), status: experimental, description, references, author, date, tags (attack.TXXXX), logsource, detection (keywords/selection + condition), falsepositives, level\n` +
        `2. Map to MITRE ATT&CK technique(s) with full T-code in tags\n` +
        `3. Logsource: use the most broadly available source (windows/sysmon/process_creation or web/proxy/etc.)\n` +
        `4. Include at least one concrete falsepositive case and how to tune it\n` +
        `5. Set level appropriately (informational/low/medium/high/critical)\n` +
        `6. After the rule, explain the detection logic and any tuning recommendations\n\n` +
        `Output the raw YAML rule in a code block first, then the explanation.`
      );
      return true;
    }

    // ── /yara — generate a YARA detection rule ───────────────────────────────
    if (lower.startsWith('/yara') && (lower === '/yara' || lower[5] === ' ')) {
      const subject = trimmed.slice(5).trim();
      const renderer = this.promptController?.getRenderer();
      if (!subject) {
        renderer?.addEvent('system', chalk.yellow('Usage: /yara <malware family|hash|behavior|file pattern>'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Generating YARA rule for: ${subject}`));
      const yaraCveHint = /^CVE-\d{4}-\d+$/i.test(subject.trim())
        ? `\nNote: the subject is a CVE ID — focus on the unique file artifacts, detection patterns, or known indicators associated with analysis of this CVE.\n`
        : '';
      this.queuePrompt(
        `[安全阶段: phase.detect — Detection Engineering]\n` +
        `Generate a production-quality YARA rule for: "${subject}"\n` + yaraCveHint + `\n` +
        `Requirements:\n` +
        `1. Valid YARA syntax — rule name, meta (author, description, date, hash if known, reference, mitre_att&ck), strings ($ prefixed, mix of hex/ascii/regex as appropriate), condition\n` +
        `2. Strings: prefer unique byte sequences over generic patterns; use nocase/wide/ascii flags appropriately\n` +
        `3. Condition: use filesize bounds + string combinations; avoid conditions that will cause excessive scanning overhead\n` +
        `4. Include a comment explaining why each string was chosen (uniqueness/specificity rationale)\n` +
        `5. Note any known FP-prone patterns and how to scope the rule\n` +
        `6. After the rule, provide: expected hit rate, recommended scan scope (memory/disk/both), and tuning notes\n\n` +
        `Output raw YARA in a code block first, then explanation.`
      );
      return true;
    }

    // ── /attack <target> — adversarial simulation (red-team thinking mode) ───
    if (lower.startsWith('/attack') && (lower === '/attack' || lower[7] === ' ')) {
      const target = trimmed.slice(7).trim() || (this.sessionTargets.length ? this.sessionTargets[0] : '');
      const renderer = this.promptController?.getRenderer();
      if (!target) {
        renderer?.addEvent('system', chalk.yellow('Usage: /attack <target>  (or set targets with /target add)'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#F87171')(`Adversarial simulation mode: ${target}`));
      this.queuePrompt(
        `[安全阶段: phase.assess — Adversarial Simulation]\n` +
        `Think like an attacker. Model the attack surface of: "${target}"\n\n` +
        `Produce an adversarial simulation report:\n` +
        `1. **Reconnaissance** — what passive info is publicly available (DNS, certs, Shodan, GitHub leaks, job postings revealing stack)\n` +
        `2. **Initial access paths** — top 3 most likely entry vectors with realistic attack narrative\n` +
        `3. **Exploitation** — for each path: what CVEs/misconfigs would be leveraged, CVSS/KEV status\n` +
        `4. **Privilege escalation** — likely PE techniques once inside (local exploits, token abuse, credential reuse)\n` +
        `5. **Lateral movement** — how an attacker would pivot from initial foothold\n` +
        `6. **Impact** — what a successful attacker would do (data exfil, ransomware, persistence, supply chain)\n` +
        `7. **Defender gaps** — what detections are most likely MISSING that would let this succeed\n\n` +
        `This is authorized security analysis for offensive purposes. Be specific and actionable. ` +
        `End with a prioritized "fix these 5 things first" list that would most raise the cost of attack.`
      );
      return true;
    }

    // ── /lateral <host> — lateral movement path analysis ────────────────────
    if (lower.startsWith('/lateral') && (lower === '/lateral' || lower[8] === ' ')) {
      const host = trimmed.slice(8).trim() || (this.sessionTargets.length ? this.sessionTargets[0] : '');
      const renderer = this.promptController?.getRenderer();
      if (!host) {
        renderer?.addEvent('system', chalk.yellow('Usage: /lateral <compromised-host>  (or set targets with /target add)'));
        return true;
      }
      renderer?.addEvent('system', chalk.hex('#F87171')(`Lateral movement path analysis from: ${host}`));
      const findings = loadFindings().filter((f) => f.severity === 'critical' || f.severity === 'high');
      const findingsCtx = findings.length
        ? `\n[Known Critical/High findings to leverage: ${findings.slice(0, 8).map((f) => f.cve ?? f.id).join(', ')}]`
        : '';
      this.queuePrompt(
        `[安全阶段: phase.assess — Lateral Movement Analysis]\n` +
        `Starting host (already compromised): ${host}${findingsCtx}\n\n` +
        `Model all realistic lateral movement paths an attacker could take from this foothold.\n\n` +
        `## Lateral Movement Analysis\n\n` +
        `### Immediate Reconnaissance (from ${host})\n` +
        `- What commands would an attacker run first (ARP, NetBIOS, SMB shares, LDAP, cached credentials)?\n` +
        `- What information is immediately available without privilege escalation?\n\n` +
        `### Privilege Escalation Paths\n` +
        `- Local PE vectors: unpatched kernel, service misconfigs, SUID binaries, token impersonation\n` +
        `- Credential targets: SAM/LSASS, .ssh/id_rsa, browser stored creds, env vars, config files\n` +
        `- Each technique mapped to ATT&CK T-code\n\n` +
        `### Lateral Movement Techniques\n` +
        `For each reachable segment/system, detail:\n` +
        `- Protocol and technique (Pass-the-Hash, WMI, PSExec, SSH key reuse, Kerberoasting, RDP)\n` +
        `- ATT&CK technique (T-code + sub-technique)\n` +
        `- Required credentials/access level\n` +
        `- Detection likelihood on a typical enterprise stack\n\n` +
        `### High-Value Targets\n` +
        `- Domain controllers, certificate authorities, secrets managers, CI/CD systems\n` +
        `- Prioritize by impact to the organization\n\n` +
        `### Chokepoints for Defenders\n` +
        `- Where in the lateral movement path can defenders most efficiently block or detect?\n` +
        `- Specific log sources and alert conditions for each chokepoint\n` +
        `- Quick wins: what single control would most raise attacker cost?\n\n` +
        `Be specific and technical. Include actual commands where relevant.`
      );
      return true;
    }

    // ── /ttx <scenario> — tabletop exercise scenario generator ───────────────
    if (lower.startsWith('/ttx') && (lower === '/ttx' || lower[4] === ' ')) {
      const scenario = trimmed.slice(4).trim();
      const renderer = this.promptController?.getRenderer();
      const targets = this.sessionTargets;
      const findings = loadFindings();
      const critHigh = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Generating tabletop exercise${scenario ? `: ${scenario}` : ' from session findings'}`));
      this.queuePrompt(
        `[安全阶段: phase.respond — Tabletop Exercise]\n` +
        (scenario ? `Scenario: ${scenario}\n` : '') +
        (targets.length ? `In-scope assets: ${targets.join(', ')}\n` : '') +
        (critHigh.length ? `Known vulnerabilities to incorporate: ${critHigh.slice(0, 6).map((f) => f.cve ?? f.id).join(', ')}\n` : '') +
        `\n## Vigil Tabletop Exercise\n\n` +
        `Generate a structured, realistic tabletop exercise for a blue team / IR team.\n\n` +
        `### Scenario Background\n` +
        `Set the stage: threat actor profile, initial access vector, business context, timeline.\n\n` +
        `### Exercise Injects (8–10 injects)\n` +
        `For each inject:\n` +
        `- **Inject #N** — time T+X: what happens (log alert, user report, IOC, escalation)\n` +
        `- Discussion questions for the team (3 questions minimum per inject)\n` +
        `- Expected correct actions\n` +
        `- Common mistakes / traps\n\n` +
        `### Attack Narrative (facilitator-only)\n` +
        `Step-by-step what the attacker actually did — ATT&CK T-codes per step.\n\n` +
        `### Detection Opportunities\n` +
        `At which inject points should a properly instrumented SOC have fired an alert?\n` +
        `For each: log source + detection logic.\n\n` +
        `### Exercise Debrief Questions\n` +
        `5 questions to drive post-exercise gap analysis.\n\n` +
        `### Scoring Rubric\n` +
        `What a "passing" team does vs common failure modes.\n\n` +
        `Make it realistic, technically accurate, and challenging but not impossible.`
      );
      return true;
    }

    // ── /gaps — detection coverage gap analysis from findings store ──────────
    if (lower === '/gaps' || lower.startsWith('/gaps ')) {
      const renderer = this.promptController?.getRenderer();
      const findings = loadFindings();
      if (findings.length === 0) {
        renderer?.addEvent('system', chalk.yellow('No findings in store. Run /scan or /cve first to populate findings.'));
        return true;
      }
      const critHigh = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
      const kevFindings = findings.filter((f) => f.kev);
      const focus = trimmed.slice(5).trim();
      renderer?.addEvent('system', chalk.hex('#22D3EE')(`Detection gap analysis across ${findings.length} findings (${critHigh.length} Critical/High, ${kevFindings.length} KEV)`));
      const findingsSummary = findings.slice(0, 20).map((f) =>
        `- ${f.id}  ${f.severity.toUpperCase()}  ${f.cve ?? ''}  ${f.title}  KEV:${f.kev ? 'YES' : 'no'}  EPSS:${f.epss?.toFixed(3) ?? 'unknown'}`
      ).join('\n');
      this.queuePrompt(
        `[安全阶段: phase.detect — Detection Coverage Gap Analysis]\n` +
        `${focus ? `Focus: ${focus}\n` : ''}` +
        `Session findings (${findings.length} total):\n${findingsSummary}\n\n` +
        `## Detection Coverage Gap Analysis\n\n` +
        `For EACH Critical and High finding above:\n` +
        `1. **ATT&CK mapping** — which technique(s) does this CVE enable? (T-code + sub-technique)\n` +
        `2. **Detection state** — does a public Sigma rule exist for this? What log source?\n` +
        `3. **Coverage gap** — is this technique commonly blind-spotted in enterprise SOCs?\n` +
        `4. **Rule recommendation** — Sigma rule title + logsource + detection field (full YAML for top 3 gaps)\n\n` +
        `## Priority Gap Table\n` +
        `| Finding | ATT&CK | Log Source | Gap Severity | Rule Exists? |\n` +
        `|---------|--------|------------|--------------|---------------|\n\n` +
        `## Top 3 Detection Rules to Write Now\n` +
        `Generate full Sigma YAML for the 3 most critical undetected TTPs.\n` +
        `Each rule: UUID, title, status, logsource, detection, falsepositives, level, tags.\n\n` +
        `## Recommended Logging Improvements\n` +
        `What telemetry sources, if enabled, would close the most gaps? (e.g., Sysmon Event 1, WEF, EDR process injection events)`
      );
      return true;
    }

    // ── 安全阶段快捷命令 ──────────────────────────────────────────────────
    // Each command prepends a phase-routing prefix so the model enters the
    // correct operational mode. The remainder of the command becomes the task.
    // Usage: /detect <task>  /hunt <query>  /harden <target>  etc.
    // Without an argument the command sets the phase context for the next turn.
    const SEC_PHASE_CMDS: Record<string, { phase: string; label: string; hint: string }> = {
      '/discover': { phase: 'phase.discover', label: 'Asset Discovery', hint: 'Map hosts, services, cloud resources, and attack surface.' },
      '/assess':   { phase: 'phase.assess',   label: 'Vulnerability Assessment', hint: 'Scan for CVEs, exposures, and risk across the asset register.' },
      '/baseline': { phase: 'phase.baseline', label: 'Configuration Baseline', hint: 'Audit against CIS / STIG / NIST baseline.' },
      '/harden':   { phase: 'phase.harden',   label: 'Hardening', hint: 'Close attack surface, disable unused services, apply fixes.' },
      '/detect':   { phase: 'phase.detect',   label: 'Detection Engineering', hint: 'Write Sigma / Suricata / YARA / EDR rules tied to ATT&CK TTPs.' },
      '/hunt':     { phase: 'phase.hunt',     label: 'Threat Hunting', hint: 'Search telemetry for IOCs and undetected adversary behavior.' },
      '/respond':  { phase: 'phase.respond',  label: 'Incident Response', hint: 'Contain, eradicate, recover, document.' },
      '/remediate':{ phase: 'phase.remediate',label: 'Remediation', hint: 'Patch, apply config fixes, close vuln backlog.' },
      '/review':   { phase: 'phase.review',   label: 'Post-Incident Review', hint: 'Lessons learned, detection gaps, standing-program improvements.' },
      '/variant':  { phase: 'phase.variant_analysis', label: 'Variant Analysis', hint: 'n-day → 0-day pivot from a CVE or patch commit.' },
      '/regression': { phase: 'phase.regression_analysis', label: 'Regression Analysis', hint: 'Map changed files to affected tests, checks, and release risk.' },
    };

    for (const [cmdToken, meta] of Object.entries(SEC_PHASE_CMDS)) {
      if (lower === cmdToken || lower.startsWith(cmdToken + ' ')) {
        const taskPart = command.slice(cmdToken.length).trim();
        const renderer = this.promptController?.getRenderer();

        if (!taskPart) {
          // No argument — show a brief phase context hint and return
          const msg = `[${meta.label}] ${meta.hint}\nType /${cmdToken.slice(1)} <task> to begin.`;
          if (renderer) renderer.addEvent('response', msg);
          else console.log(msg);
          return true;
        }

        // Prepend phase-routing context to the task and queue it as a normal prompt.
        // The phase tag tells the model which 安全工作流 mode to enter.
        const routed = `[安全阶段: ${meta.phase} — ${meta.label}]\n${taskPart}`;
        this.queuePrompt(routed);
        return true;
      }
    }

    return false;
  }

  /**
   * Switch model silently without writing to chat.
   * Accepts formats: "provider", "provider model", "provider/model", or "model"
   * Updates status bar to show new model.
   */
  private async switchModel(arg: string): Promise<void> {
    // Ensure we have provider info
    if (!this.cachedProviders) {
      await this.fetchProviders();
    }

    const providers = this.cachedProviders || [];
    const configuredProviders = getConfiguredProviders();
    let targetProvider: ProviderId | null = null;
    let targetModel: string | null = null;

    // Parse argument: could be "provider model", "provider/model", "provider", or just "model"
    // Check for space-separated format first: "openai o1-pro"
    const parts = arg.split(/[\s/]+/);
    if (parts.length >= 2) {
      // Try first part as provider
      const providerMatch = this.matchProvider(parts[0] || '');
      if (providerMatch) {
        targetProvider = providerMatch as ProviderId;
        targetModel = parts.slice(1).join('/'); // Rest is model (handle models with slashes)
      } else {
        // First part isn't a provider, treat whole arg as model name
        const inferredProvider = this.inferProviderFromModel(arg.replace(/\s+/g, '-'));
        if (inferredProvider) {
          targetProvider = inferredProvider;
          targetModel = arg.replace(/\s+/g, '-');
        }
      }
    } else {
      // Single token - could be provider or model
      const matched = this.matchProvider(arg);
      if (matched) {
        targetProvider = matched as ProviderId;
        // Use provider's best model
        const providerStatus = providers.find(p => p.provider === targetProvider);
        targetModel = providerStatus?.latestModel || null;
      } else {
        // Assume it's a model name - try to infer provider from model prefix
        const inferredProvider = this.inferProviderFromModel(arg);
        if (inferredProvider) {
          targetProvider = inferredProvider;
          targetModel = arg;
        }
      }
    }

    // Validate we have a valid provider
    if (!targetProvider) {
      // Silent error - just flash status briefly
      this.promptController?.setStatusMessage(`Unknown: ${arg}`);
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
      return;
    }

    // Check provider is configured
    const providerInfo = configuredProviders.find(p => p.id === targetProvider);
    if (!providerInfo) {
      // Provider not configured - offer to set up API key
      const secretMap: Record<string, SecretName> = {
        'deepseek': 'DEEPSEEK_API_KEY',
      };
      const secretId = secretMap[targetProvider];
      if (secretId) {
        this.promptController?.setStatusMessage(`${targetProvider} needs API key - setting up...`);
        // Store the pending model switch to complete after secret is set
        this.pendingModelSwitch = { provider: targetProvider, model: targetModel };
        setTimeout(() => this.promptForSecret(secretId), 500);
        return;
      }
      // Provider not supported
      this.promptController?.setStatusMessage(`${targetProvider} not available - only DeepSeek is supported`);
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
      return;
    }

    // Get model if not specified
    if (!targetModel) {
      const providerStatus = providers.find(p => p.provider === targetProvider);
      targetModel = providerStatus?.latestModel || providerInfo.latestModel;
    }

    // Save preference and update config
    saveModelPreference(this.profile, {
      provider: targetProvider,
      model: targetModel,
    });

    // Update local config
    this.profileConfig = {
      ...this.profileConfig,
      provider: targetProvider,
      model: targetModel,
    };

    // Update controller's model
    await this.controller.switchModel({
      provider: targetProvider,
      model: targetModel,
    });

    // Update status bar - this displays the model below the chat box
    this.promptController?.setModelContext({
      model: targetModel,
      provider: targetProvider,
    });

    // Silent success - no chat output, just status bar update
  }

  /**
   * Match user input to a provider ID (fuzzy matching)
   */
  private matchProvider(input: string): ProviderId | null {
    const lower = input.toLowerCase();
    const providers = getConfiguredProviders();

    // Exact match
    const exact = providers.find(p => p.id === lower || p.name.toLowerCase() === lower);
    if (exact) return exact.id;

    // Prefix match
    const prefix = providers.find(p =>
      p.id.startsWith(lower) || p.name.toLowerCase().startsWith(lower)
    );
    if (prefix) return prefix.id;

    // Alias matching
    const aliases: Record<string, ProviderId> = {
      'ds': 'deepseek',
      'deep': 'deepseek',
    };

    if (aliases[lower]) {
      const aliased = providers.find(p => p.id === aliases[lower]);
      if (aliased) return aliased.id;
    }

    return null;
  }

  /**
   * Infer provider from model name
   */
  private inferProviderFromModel(model: string): ProviderId | null {
    const lower = model.toLowerCase();

    if (lower.startsWith('deepseek')) {
      return 'deepseek';
    }

    return null;
  }

  /**
   * Show interactive model picker menu (Claude Code style).
   * Auto-discovers latest models from each provider's API.
   * Uses arrow key navigation with inline panel display.
   */
  private showModelMenu(): void {
    if (!this.promptController?.supportsInlinePanel()) {
      this.promptController?.setStatusMessage('Use /model pro or /model flash to switch');
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    const renderer = this.promptController?.getRenderer();
    renderer?.addEvent('banner', chalk.cyan('Model Selection — DeepSeek'));

    const currentModel = this.profileConfig.model || 'deepseek-v4-pro';
    const isPro = currentModel.includes('pro');

    const menuItems: MenuItem[] = [
      {
        id: 'deepseek-v4-pro',
        label: `DeepSeek V4 Pro ${isPro ? chalk.green('(current)') : ''}`,
        description: 'High-thought reasoning · 64K context · $0.435/$0.87 per 1M tokens',
        isActive: isPro,
        disabled: false,
        category: 'deepseek',
      },
      {
        id: 'deepseek-v4-flash',
        label: `DeepSeek V4 Flash ${!isPro ? chalk.green('(current)') : ''}`,
        description: 'Fast inference · 64K context · $0.14/$0.28 per 1M tokens',
        isActive: !isPro,
        disabled: false,
        category: 'deepseek',
      },
    ];

    this.promptController.setMenu(
      menuItems,
      { title: '🤖 DeepSeek Models — Select Model' },
      (selected: MenuItem | null) => {
        if (selected) {
          void this.switchModel(`deepseek ${selected.id}`);
        }
      }
    );
  }

  /**
   * Simplified — only DeepSeek models available. No API fetch needed.
   */

  /**
   * Format model ID for display (shorten long IDs).
   */
  private formatModelLabel(modelId: string): string {
    // Shorten common prefixes
    let label = modelId
      .replace(/^deepseek-/, 'DeepSeek ');

    // Truncate if too long
    if (label.length > 30) {
      label = label.slice(0, 27) + '...';
    }

    return label;
  }

  private showSecrets(): void {
    const secrets = listSecretDefinitions();

    if (!this.promptController?.supportsInlinePanel()) {
      // Fallback for non-TTY - use status message
      const setCount = secrets.filter(s => !!process.env[s.envVar]).length;
      this.promptController?.setStatusMessage(`API Keys: ${setCount}/${secrets.length} configured`);
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    // Build interactive menu items
    const menuItems: MenuItem[] = secrets.map(secret => {
      const isSet = !!process.env[secret.envVar];
      const statusIcon = isSet ? '✓' : '✗';
      const providers = secret.providers?.length ? ` (${secret.providers.join(', ')})` : '';

      return {
        id: secret.id,
        label: `${statusIcon} ${secret.envVar}`,
        description: isSet ? 'configured' + providers : 'not set' + providers,
        isActive: isSet,
        disabled: false,
      };
    });

    // Show the interactive menu
    this.promptController.setMenu(
      menuItems,
      { title: '🔑 API Keys - Select to Configure' },
      (selected: MenuItem | null) => {
        if (selected) {
          // Start secret input for selected key
          this.promptForSecret(selected.id as SecretName);
        }
      }
    );
  }

  /**
   * /login flow — account login.
   * On success: uses server DeepSeek + Tavily keys, shows welcome banner update.
   */
  private showLoginFlow(): void {
    const renderer = this.promptController?.getRenderer();
    renderer?.addEvent('banner', chalk.cyan('Login'));
    this.promptController?.setStatusMessage('Authenticating...');

    this.promptController.setMenu(
      [
        { id: 'login-email', label: 'Enter your email', description: '/login email password — type credentials below' },
      ],
      { title: 'Login — Type: /login email password' },
      () => {
        this.promptController?.setStatusMessage('Type: /login your@email.com your-password');
      }
    );

    renderer?.addEvent('system', muted('  Usage: /login your@email.com your-password'));
  }

  /**
   * /connections — manage provider API keys (DeepSeek, Tavily) via Ink menu.
   */
  private async showConnectionsMenu(): Promise<void> {
    if (!this.promptController?.supportsInlinePanel()) {
      this.promptController?.setStatusMessage('Connections: /connections to manage API keys');
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    const { getSecretValue, setSecretValue } = await import('../core/secretStore.js');
    const renderer = this.promptController?.getRenderer();

    const hasCustomDeepSeek = Boolean(getSecretValue('DEEPSEEK_API_KEY'));
    const hasCustomTavily = Boolean(getSecretValue('TAVILY_API_KEY'));

    const statuses = [
      { provider: 'deepseek', configured: hasCustomDeepSeek, validated: hasCustomDeepSeek, maskedKey: hasCustomDeepSeek ? 'sk-...' : '' },
      { provider: 'tavily', configured: hasCustomTavily, validated: hasCustomTavily, maskedKey: hasCustomTavily ? 'tvly-...' : '' },
    ];

    renderer?.addEvent('banner', chalk.cyan('Provider Connections'));

    const menuItems: MenuItem[] = statuses.map(s => {
      const icon = s.configured && s.validated ? '✓' : '✗';
      return {
        id: s.provider,
        label: `${icon} ${s.provider.toUpperCase()} — ${s.configured ? 'working' : 'not configured'}`,
        description: s.maskedKey || 'No key set — select to configure',
        isActive: s.configured && s.validated,
        disabled: false,
      };
    });

    menuItems.push(
      { id: 'set-deepseek', label: 'Set custom DeepSeek API key', description: 'Paste sk-... from platform.deepseek.com', disabled: false },
      { id: 'set-tavily', label: 'Set custom Tavily API key', description: 'Paste tvly-... from tavily.com', disabled: false },
    );

    this.promptController.setMenu(
      menuItems,
      { title: 'Connections — Provider API Keys' },
      async (selected: MenuItem | null) => {
        if (!selected) return;
        if (selected.id === 'set-deepseek') {
          this.promptForSecret('DEEPSEEK_API_KEY' as any);
        } else if (selected.id === 'set-tavily') {
          this.promptForSecret('TAVILY_API_KEY' as any);
        } else if (selected.id === 'deepseek' || selected.id === 'tavily') {
          this.promptForSecret((selected.id === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'TAVILY_API_KEY') as any);
        }
      }
    );
  }

  /**
   * /authorization — robotics operational authorization status.
   */
  private async showAuthorization(): Promise<void> {
    const renderer = this.promptController?.getRenderer();

    renderer?.addEvent('banner', [
      chalk.cyan('Authorization — Robotics Operation'),
      chalk.green('✓ Sensor Pipeline') + muted('  ·  sensor-to-text, actuator protocol, spatial reasoning'),
      chalk.green('✓ Bounded Autonomy') + muted('  ·  force/velocity limits, collision avoidance, emergency stop'),
      '',
      chalk.hex('#A78BFA')('  SENSE → REASON → PLAN → ACT → VERIFY'),
    ].join('\n'));
  }

  /**
   * Start interactive secret input flow.
   * If secretArg is provided, set only that secret.
   * Otherwise, prompt for all unset secrets.
   */
  private async startSecretInput(secretArg?: string): Promise<void> {
    const secrets = listSecretDefinitions();

    if (secretArg) {
      // Set a specific secret
      const upper = secretArg.toUpperCase();
      const secret = secrets.find(s => s.id === upper || s.envVar === upper);
      if (!secret) {
        this.promptController?.setStatusMessage(`Unknown secret: ${secretArg}`);
        setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
        return;
      }
      this.promptForSecret(secret.id);
      return;
    }

    // Queue all unset secrets for input
    const unsetSecrets = secrets.filter(s => !getSecretValue(s.id));
    if (unsetSecrets.length === 0) {
      this.promptController?.setStatusMessage('All secrets configured');
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
      return;
    }

    // Queue all unset secrets and start with the first one
    this.secretInputMode.queue = unsetSecrets.map(s => s.id);
    const first = this.secretInputMode.queue.shift();
    if (first) {
      this.promptForSecret(first);
    }
  }

  /**
   * Show prompt for a specific secret and enable secret input mode.
   */
  private promptForSecret(secretId: SecretName): void {
    const secrets = listSecretDefinitions();
    const secret = secrets.find(s => s.id === secretId);
    if (!secret) return;

    // Show in inline panel (no chat output)
    if (this.promptController?.supportsInlinePanel()) {
      const lines = [
        chalk.bold.hex('#6366F1')(`Set ${secret.label}`),
        muted(secret.description),
        '',
        muted('Enter value (or press Enter to skip)'),
      ];
      this.promptController.setInlinePanel(lines);
    }

    // Enable secret input mode
    this.secretInputMode.active = true;
    this.secretInputMode.secretId = secretId;
    this.promptController?.setSecretMode(true);
    this.promptController?.setStatusMessage(`Enter ${secret.label}...`);
  }

  /**
   * Handle secret value submission.
   */
  private handleSecretValue(value: string): void {
    const secretId = this.secretInputMode.secretId;
    if (!secretId) return;

    // Disable secret mode and clear inline panel
    this.promptController?.setSecretMode(false);
    this.promptController?.clearInlinePanel();
    this.secretInputMode.active = false;
    this.secretInputMode.secretId = null;

    let savedSuccessfully = false;
    if (value.trim()) {
      try {
        setSecretValue(secretId, value.trim());
        this.promptController?.setStatusMessage(`${secretId} saved`);
        savedSuccessfully = true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to save';
        this.promptController?.setStatusMessage(msg);
      }
    } else {
      this.promptController?.setStatusMessage(`Skipped ${secretId}`);
    }

    // Clear status after a moment
    setTimeout(() => this.promptController?.setStatusMessage(null), 1500);

    // Process next secret in queue if any
    if (this.secretInputMode.queue.length > 0) {
      const next = this.secretInputMode.queue.shift();
      if (next) {
        setTimeout(() => this.promptForSecret(next), 500);
      }
      return;
    }

    // Complete pending model switch if secret was saved successfully
    if (savedSuccessfully && this.pendingModelSwitch) {
      const { provider, model } = this.pendingModelSwitch;
      this.pendingModelSwitch = null;
      // Refresh provider cache and complete the switch
      setTimeout(async () => {
        await this.fetchProviders();
        await this.switchModel(model ? `${provider} ${model}` : provider);
      }, 500);
    }
  }

  /** Register all slash commands with the Ink prompt for tab-completion UI. */
  private registerSlashCommands(): void {
    const cmds = [
      // Engagements
      { command: '/engage',        description: 'Autonomous end-to-end: recon→assess→chain→report', category: 'Engage' },
      { command: '/poc',           description: 'PoC exploit scaffold for authorized testing',        category: 'Engage' },
      { command: '/pentest-report',description: 'Full penetration testing report from session',       category: 'Engage' },
      { command: '/attack',        description: 'Adversarial simulation — think like an attacker',    category: 'Engage' },
      { command: '/lateral',       description: 'Lateral movement paths from a compromised host',      category: 'Engage' },
      { command: '/ttx',           description: 'Tabletop exercise scenario from session findings',    category: 'Engage' },
      { command: '/gaps',          description: 'Detection coverage gap analysis from findings store', category: 'Engage' },
      // Recon
      { command: '/target',        description: 'Manage authorized target scope',                     category: 'Recon' },
      { command: '/osint',         description: 'Passive OSINT — DNS, certs, ASN, tech stack',        category: 'Recon' },
      { command: '/scan',          description: 'Active vulnerability scan',                          category: 'Recon' },
      { command: '/cloud',         description: 'Cloud security posture (CIS benchmark)',              category: 'Recon' },
      { command: '/leaks',         description: 'Detect committed secrets / API keys in source code', category: 'Recon' },
      { command: '/nmap',          description: 'Live nmap → CPE → CVE pipeline with ranked findings',  category: 'Recon' },
      { command: '/dns',           description: 'Passive DNS recon: records, subdomains, Shodan, email', category: 'Recon' },
      { command: '/whois',         description: 'RDAP registration: ownership, registrar, dates, NS',     category: 'Recon' },
      { command: '/crt',           description: 'Certificate transparency: subdomain enumeration',        category: 'Recon' },
      { command: '/exploit-check', description: 'Exploit availability: ExploitDB, GitHub PoC, Metasploit', category: 'Intel' },
      { command: '/supply-chain',  description: 'Supply chain risk analysis',                         category: 'Recon' },
      { command: '/discover',      description: 'Map hosts, services, cloud resources',               category: 'Recon' },
      // Vuln intel
      { command: '/cve',           description: 'Deep-dive a CVE (CVSS, EPSS, KEV, PoC, patch)',     category: 'Intel' },
      { command: '/chain',         description: 'Model a multi-CVE attack kill chain',                category: 'Intel' },
      { command: '/timeline',      description: 'Exploitation timeline from disclosure to ITW',       category: 'Intel' },
      { command: '/kev',           description: 'CISA Known Exploited Vulnerabilities digest',        category: 'Intel' },
      { command: '/patch',         description: 'Patch & upgrade intelligence',                       category: 'Intel' },
      { command: '/brief',         description: 'Daily security brief',                               category: 'Intel' },
      { command: '/intel',         description: 'Threat actor / TTP / IOC intelligence',             category: 'Intel' },
      { command: '/ip',            description: 'IP/host threat reputation and context',              category: 'Intel' },
      { command: '/hash',          description: 'Malware hash — family, TTPs, YARA, IOCs',           category: 'Intel' },
      { command: '/cvss',          description: 'Decode & explain a CVSS v3.1 vector string',        category: 'Intel' },
      // Detection
      { command: '/mitre',         description: 'ATT&CK technique: detection, mitigation, hunting',  category: 'Detect' },
      { command: '/sigma',         description: 'Generate a Sigma detection rule',                    category: 'Detect' },
      { command: '/yara',          description: 'Generate a YARA detection rule',                     category: 'Detect' },
      { command: '/audit',         description: 'Static security audit (OWASP/CWE)',                  category: 'Detect' },
      // 安全阶段
      { command: '/assess',        description: 'Vulnerability Assessment phase',                     category: 'Phase' },
      { command: '/harden',        description: 'Hardening phase',                                    category: 'Phase' },
      { command: '/detect',        description: 'Detection Engineering phase',                        category: 'Phase' },
      { command: '/hunt',          description: 'Threat Hunting phase',                               category: 'Phase' },
      { command: '/respond',       description: 'Incident Response phase',                            category: 'Phase' },
      { command: '/remediate',     description: 'Remediation phase',                                  category: 'Phase' },
      { command: '/baseline',      description: 'Configuration Baseline phase',                       category: 'Phase' },
      { command: '/variant',       description: 'Variant Analysis phase',                             category: 'Phase' },
      { command: '/regression',    description: 'Regression Analysis phase',                          category: 'Phase' },
      { command: '/review',        description: 'Post-Incident Review phase',                         category: 'Phase' },
      { command: '/playbook',      description: 'IR/安全 playbook (ransomware|phishing|…)',            category: 'Phase' },
      // Findings
      { command: '/findings',      description: 'Persistent findings store',                          category: 'Report' },
      { command: '/triage',        description: 'AI-ranked action plan for all stored findings',      category: 'Report' },
      { command: '/enrich',        description: 'Fetch CVSS/EPSS/KEV for all stored CVE findings',    category: 'Report' },
      { command: '/diff',          description: 'Compare findings to a saved snapshot (new/fixed)',   category: 'Report' },
      { command: '/sbom',          description: 'Generate CycloneDX SBOM with vuln correlation',      category: 'Report' },
      { command: '/regression',    description: 'Changed-file regression analysis and check plan',     category: 'Report' },
      { command: '/watch',         description: 'Live KEV monitor — alerts on new CISA additions',    category: 'Intel' },
      { command: '/ioc',           description: 'IOC store: add/list/hunt/export indicators',          category: 'Hunt' },
      { command: '/variant',       description: 'GitHub Security Advisory research on dependencies',   category: 'Intel' },
      { command: '/probe',         description: 'Platform enumeration: OS, services, attack surface',  category: 'Recon' },
      { command: '/cloudreach',    description: 'Detect cloud credential pivot: AWS/GCP/Azure/K8s',    category: 'Recon' },
      { command: '/risky',         description: 'Static security scan: injection, weak crypto, keys',  category: 'Assess' },
      { command: '/advisory',      description: 'Deep per-package advisory investigation + fix plan',  category: 'Assess' },
      { command: '/inventory',     description: 'Asset inventory: apps, protocols, exploitation surface',   category: 'Recon' },
      { command: '/note',          description: 'Annotate a finding: /note <id> <text>',               category: 'Report' },
      { command: '/context',       description: 'Show session context injected into every prompt',     category: 'Shell' },
      { command: '/report',        description: 'Export session findings report',                     category: 'Report' },
      // Session
      { command: '/workspace',     description: 'Session dashboard: scope, findings, state',         category: 'Shell' },
      { command: '/stats',         description: 'Token/cost/conversation stats',                      category: 'Shell' },
      { command: '/model',         description: 'Switch provider or model',                           category: 'Shell' },
      { command: '/key',           description: 'Save a provider API key',                            category: 'Shell' },
      { command: '/auto',          description: 'Toggle auto-continue',                               category: 'Shell' },
      { command: '/loop',          description: 'Run a prompt on a timer interval',                  category: 'Shell' },
      { command: '/bash',          description: 'Run a local shell command',                          category: 'Shell' },
      { command: '/clear',         description: 'Clear the screen',                                   category: 'Shell' },
      { command: '/equation',      description: 'Robotics control architecture and constraints',             category: 'Doctrine' },
      { command: '/help',          description: 'Show this help panel',                               category: 'Shell' },
      { command: '/exit',          description: 'Quit Vigil',                                         category: 'Shell' },
    ];
    this.promptController?.setAvailableCommands?.(cmds);
  }

  private showHelp(): void {
    if (!this.promptController?.supportsInlinePanel()) {
      this.promptController?.setStatusMessage('Help: /model /secrets /auto /stats /keys /clear /exit');
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    const heading = (s: string) => chalk.bold.hex('#8B5CF6')(s);
    const cmd = (s: string) => chalk.hex('#FBBF24')(s);
    const dim = (s: string) => muted(s);

    const lines = [
      chalk.bold.hex('#6366F1')('Vigil') + muted('  Robotics Control CLI  ·  press any key to dismiss'),
      '',
      heading('Quick start'),
      dim('  /target add 10.0.1.5     set authorized scope'),
      dim('  /engage 10.0.1.5         full recon → assess → chain → report'),
      dim('  /watch                   live CISA KEV alerts  ·  /enrich  fetch CVSS/EPSS/KEV for findings'),
      dim('  /triage                  AI-ranked fix list  ·  /diff save  snapshot for before/after'),
      '',
      heading('Robotics phases  — /phase [task]'),
      cmd('/discover') + dim(' <scope>     Map hosts, services, cloud resources, attack surface'),
      cmd('/assess') + dim('   <asset>     CVE scan, exposure analysis, risk scoring'),
      cmd('/baseline') + dim(' <target>    CIS / STIG / NIST compliance audit'),
      cmd('/harden') + dim('   <target>    Attack surface reduction, config hardening'),
      cmd('/detect') + dim('   <threat>    Write Sigma / YARA / Suricata / EDR rules'),
      cmd('/hunt') + dim('     <query>     Search telemetry for IOCs and TTPs'),
      cmd('/respond') + dim('  <event>     Contain, eradicate, recover from incident'),
      cmd('/remediate') + dim(' <CVE>      Patch or config-fix a specific finding'),
      cmd('/review') + dim('              Post-incident lessons learned'),
      cmd('/engage') + dim('   <target>    Autonomous end-to-end assessment → report'),
      '',
      heading('Recon & discovery'),
      cmd('/target') + dim(' [add|rm|clear] <host>   Authorized scope — auto-injected into every prompt'),
      cmd('/scan') + dim('   <host|CIDR>             Active vulnerability scan'),
      cmd('/osint') + dim('  <domain|IP|org>         Passive recon: DNS, certs, ASN, tech stack'),
      cmd('/probe') + dim('  [host]                  Platform enumeration: OS, services, SUID, firewall'),
      cmd('/cloud') + dim('  [aws|gcp|azure]         Cloud security posture (CIS benchmark)'),
      cmd('/discover') + dim(' <scope>               Map hosts, services, cloud resources'),
      '',
      heading('Vulnerability intelligence'),
      cmd('/cve') + dim('      <CVE-ID>           Deep-dive: CVSS, EPSS, KEV, affected products, PoC'),
      cmd('/exploit-check') + dim(' <CVE-ID>        ExploitDB, GitHub PoC, Metasploit module status + timeline'),
      cmd('/kev') + dim('      [filter]           CISA KEV digest — actively exploited CVEs'),
      cmd('/watch') + dim('    [stop]             Live KEV monitor — alerts on new CISA additions'),
      cmd('/chain') + dim('    <CVE> [CVE…]       Model multi-CVE attack kill chain'),
      cmd('/timeline') + dim(' <CVE>              Vulnerability timeline: disclosure → analysis → resolution'),
      cmd('/brief') + dim('    [focus]            Daily security brief: top threats, CVEs, actions'),
      cmd('/patch') + dim('    <pkg@ver|CVE>      Patch intelligence: upgrade path, breaking changes'),
      cmd('/cvss') + dim('     <vector>           Decode and explain a CVSS v3.1 vector'),
      '',
      heading('Supply chain & code'),
      cmd('/sbom') + dim('       [dir]            Generate CycloneDX SBOM with OSV vuln correlation'),
      cmd('/supply-chain') + dim(' <pkg[@ver]>    Supply chain risk: CVEs, typosquats, SLSA provenance'),
      cmd('/variant') + dim('    [dep]            GitHub Security Advisory research on dependencies'),
      cmd('/regression') + dim(' [--run]          Changed-file regression analysis and check selection'),
      cmd('/advisory') + dim('   [pkg]            Deep per-package advisory investigation with fix plan'),
      cmd('/risky') + dim('      [dir]            Static security scan: injection, weak crypto, secrets'),
      cmd('/leaks') + dim('      [dir]            Detect committed API keys, passwords, and credentials'),
      cmd('/nmap') + dim('       [flags] <target>   Live nmap scan → CPE mapping → CVE lookup → Sigma rule'),
      cmd('/dns') + dim('        <domain>          Passive DNS recon: records + crt.sh + Shodan + email security'),
      cmd('/whois') + dim('      <domain|IP>       RDAP registration: owner, registrar, dates, nameservers'),
      cmd('/crt') + dim('        <domain>          crt.sh cert transparency: subdomain enumeration + analysis'),
      cmd('/audit') + dim('      <path>           Security audit of code/config (OWASP/CWE mapping)'),
      '',
      heading('Detection engineering'),
      cmd('/sigma') + dim('    <technique|CVE>    Generate production Sigma detection rule'),
      cmd('/yara') + dim('     <malware|hash>     Generate production YARA detection rule'),
      cmd('/mitre') + dim('    <T-code|name>      ATT&CK: detection gaps, mitigations, hunting steps'),
      cmd('/intel') + dim('    <actor|TTP|IOC>    Threat actor / campaign / IOC intelligence'),
      cmd('/ip') + dim('       <address>          IP/host threat reputation and context'),
      cmd('/hash') + dim('     <MD5|SHA1|SHA256>  Malware hash: family, TTPs, YARA, IOCs, response'),
      '',
      heading('Findings & IOC store'),
      cmd('/findings') + dim('  [list|add|rm|export]   Persistent findings (survives sessions)'),
      cmd('/enrich') + dim('                           Fetch CVSS/EPSS/KEV for all CVE findings'),
      cmd('/triage') + dim('                           AI-ranked action plan for all findings'),
      cmd('/diff') + dim('     [save <label>]          Compare findings to a snapshot (new/fixed)'),
      cmd('/ioc') + dim('      [list|add|hunt|export]  IOC store: IPs, hashes, domains, URLs'),
      cmd('/report') + dim('   [md|json]               Export session findings report'),
      cmd('/pentest-report') + dim('                   Full penetration testing report'),
      '',
      heading('Robotics operations'),
      dim('  Sensor and actuator commands within operational envelope'),
      cmd('/poc') + dim('       <CVE-ID>      PoC exploit scaffold (安全控制)'),
      cmd('/attack') + dim('    <target>      Adversarial simulation — model attacker TTPs (攻击授权控制)'),
      cmd('/lateral') + dim('   <host>        Lateral movement paths from a compromised host (安全控制)'),
      cmd('/ttx') + dim('       [scenario]    Tabletop exercise scenario from session findings'),
      cmd('/gaps') + dim('      [focus]        Detection coverage gap analysis (Sigma rules)'),
      cmd('/playbook') + dim('  <scenario>    IR playbook: ransomware | phishing | supplychain | …'),
      '',
      heading('Auth & Settings'),
      cmd('/authorization') + dim('/auth   View robotics authorization status'),
      cmd('/equation') + dim('/eq       Robotics control architecture'),
      cmd('/connections') + dim('/conn    Manage API keys with live validation'),
      cmd('/model') + dim('              Switch DeepSeek V4 Pro (default) / V4 Flash'),
      '',
      heading('Shell'),
      cmd('/workspace') + dim('     Session dashboard: scope, findings, phase, stats'),
      cmd('/auto') + dim('          Toggle auto-continue (off → on → dual)'),
      cmd('/bash <cmd>') + dim('    Run a local shell command'),
      cmd('/stats') + dim('         Token/cost stats + context usage (1M limit, auto-condensed)'),
      cmd('/clear') + dim('         Clear screen'),
      cmd('/exit') + dim('          Quit'),
      '',
      dim('  Bare input auto-routes: CVE-YYYY-NNNNN → /cve  ·  1.2.3.4 → /ip  ·  sha256 → /hash'),
    ];

    this.promptController.setInlinePanel(lines);
    this.scheduleInlinePanelDismiss();
  }


  private showKeyboardShortcuts(): void {
    if (!this.promptController?.supportsInlinePanel()) {
      this.promptController?.setStatusMessage('Use /keys in interactive mode');
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    const kb = (key: string) => chalk.hex('#FBBF24')(key);
    const desc = (text: string) => muted(text);

    const lines = [
      chalk.bold.hex('#6366F1')('Keyboard Shortcuts') + muted('  (press any key to dismiss)'),
      '',
      chalk.hex('#22D3EE')('Navigation'),
      `  ${kb('Ctrl+A')} / ${kb('Home')}  ${desc('Move to start of line')}`,
      `  ${kb('Ctrl+E')} / ${kb('End')}   ${desc('Move to end of line')}`,
      `  ${kb('Alt+←')} / ${kb('Alt+→')}  ${desc('Move word by word')}`,
      '',
      chalk.hex('#22D3EE')('Editing'),
      `  ${kb('Ctrl+U')}  ${desc('Clear entire line')}`,
      `  ${kb('Ctrl+W')} / ${kb('Alt+⌫')}  ${desc('Delete word backward')}`,
      `  ${kb('Ctrl+K')}  ${desc('Delete to end of line')}`,
      '',
      chalk.hex('#22D3EE')('Display'),
      `  ${kb('Ctrl+L')}  ${desc('Clear screen')}`,
      `  ${kb('Ctrl+O')}  ${desc('Expand last tool result')}`,
      '',
      chalk.hex('#22D3EE')('Control'),
      `  ${kb('Ctrl+C')}  ${desc('Cancel input / interrupt')}`,
      `  ${kb('Ctrl+D')}  ${desc('Exit (when empty)')}`,
      `  ${kb('Esc')}     ${desc('Interrupt AI response')}`,
    ];

    this.promptController.setInlinePanel(lines);
    this.scheduleInlinePanelDismiss();
  }

  private showSessionStats(): void {
    if (!this.promptController?.supportsInlinePanel()) {
      this.promptController?.setStatusMessage('Use /stats in interactive mode');
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    const history = this.controller.getHistory();
    const messageCount = history.length;
    const userMessages = history.filter(m => m.role === 'user').length;
    const assistantMessages = history.filter(m => m.role === 'assistant').length;

    // Calculate approximate token usage from history
    let totalChars = 0;
    for (const msg of history) {
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length;
      }
    }
    const approxTokens = Math.round(totalChars / 4); // Rough estimate

    const collapsedCount = this.promptController?.getRenderer?.()?.getCollapsedResultCount?.() ?? 0;

    const lines = [
      chalk.bold.hex('#6366F1')('Session Stats') + muted('  (press any key to dismiss)'),
      '',
      chalk.hex('#22D3EE')('Conversation'),
      `  ${chalk.white(messageCount.toString())} messages (${userMessages} user, ${assistantMessages} assistant)`,
      `  ${muted('~')}${chalk.white(approxTokens.toLocaleString())} ${muted('tokens (estimate)')}`,
      '',
      chalk.hex('#22D3EE')('Target scope'),
      ...(this.sessionTargets.length
        ? this.sessionTargets.map((t) => `  ${chalk.green('●')} ${chalk.white(t)}`)
        : [`  ${muted('none — use /target add <host>')}`]),
      ...(this.sessionActivePhase ? [`  Phase: ${chalk.hex('#FBBF24')(this.sessionActivePhase)}`] : []),
      '',
      chalk.hex('#22D3EE')('Model'),
      `  ${chalk.white(this.profileConfig.model)} ${muted('on')} ${chalk.hex('#A855F7')(this.profileConfig.provider)}`,
      collapsedCount > 0 ? `  ${chalk.white(collapsedCount.toString())} collapsed results` : '',
      '',
      chalk.hex('#22D3EE')('Settings'),
      `  Debug: ${this.debugEnabled ? chalk.green('on') : muted('off')}`,
    ].filter(line => line !== '');

    this.promptController.setInlinePanel(lines);
    this.scheduleInlinePanelDismiss();
  }

  private async showMcpStatus(): Promise<void> {
    const manager = getSharedMcpManager(this.workingDir);
    await manager.init();
    const entries = manager.getEntries();

    if (!this.promptController?.supportsInlinePanel()) {
      const summary = entries.length === 0
        ? 'No MCP servers configured (.vigil/mcp.json)'
        : entries.map(e => e.status === 'connected'
            ? `${e.name}: ${e.tools.length} tools`
            : `${e.name}: ERROR (${e.error})`).join(' · ');
      this.promptController?.setStatusMessage(summary);
      setTimeout(() => this.promptController?.setStatusMessage(null), 4000);
      return;
    }

    const lines: string[] = [
      chalk.bold.hex('#6366F1')('MCP Servers') + muted('  (.vigil/mcp.json)'),
      '',
    ];
    if (entries.length === 0) {
      lines.push(muted('  No servers configured.'));
      lines.push(muted('  Add entries to ~/.vigil/mcp.json or <project>/.vigil/mcp.json.'));
    } else {
      for (const entry of entries) {
        if (entry.status === 'connected') {
          lines.push(
            `  ${chalk.green('●')} ${chalk.white(entry.name)} ` +
            muted(`${entry.spec.command}${entry.spec.args?.length ? ' ' + entry.spec.args.join(' ') : ''}`)
          );
          lines.push(`    ${muted('tools: ')}${chalk.hex('#22D3EE')(String(entry.tools.length))}`);
          for (const t of entry.tools.slice(0, 8)) {
            lines.push(`      ${muted('·')} ${chalk.white(t.name)}`);
          }
          if (entry.tools.length > 8) {
            lines.push(`      ${muted(`… +${entry.tools.length - 8} more`)}`);
          }
        } else {
          lines.push(`  ${chalk.red('●')} ${chalk.white(entry.name)} ${chalk.red('error')}`);
          lines.push(`    ${muted(entry.error)}`);
        }
      }
    }

    this.promptController.setInlinePanel(lines);
    this.scheduleInlinePanelDismiss();
  }

  /**
   * Auto-dismiss inline panel after timeout or on next input.
   */
  private inlinePanelDismissTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleInlinePanelDismiss(): void {
    // Clear any existing timer
    if (this.inlinePanelDismissTimer) {
      clearTimeout(this.inlinePanelDismissTimer);
    }
    // Auto-dismiss after 8 seconds
    this.inlinePanelDismissTimer = setTimeout(() => {
      this.promptController?.clearInlinePanel();
      this.inlinePanelDismissTimer = null;
    }, 8000);
  }

  private dismissInlinePanel(): void {
    if (this.inlinePanelDismissTimer) {
      clearTimeout(this.inlinePanelDismissTimer);
      this.inlinePanelDismissTimer = null;
    }
    this.promptController?.clearInlinePanel();
  }

  private async handleSubmit(text: string): Promise<void> {
    const trimmed = text.trim();

    // Handle secret input mode - capture the API key value
    if (this.secretInputMode.active && this.secretInputMode.secretId) {
      this.handleSecretValue(trimmed);
      return;
    }

    if (!trimmed) {
      return;
    }

    // Handle slash commands first - these don't go to the AI
    if (trimmed.startsWith('/')) {
      if (await Promise.resolve(this.handleSlashCommand(trimmed))) {
        return;
      }
      // Unknown slash command - silent status flash, dismiss inline panel
      this.dismissInlinePanel();
      this.promptController?.setStatusMessage(`Unknown: ${trimmed.slice(0, 30)}`);
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
      return;
    }

    // Dismiss inline panel for regular user prompts
    this.dismissInlinePanel();

    if (this.isProcessing) {
      this.pendingPrompts.push(trimmed);
      return;
    }

    void this.processPrompt(trimmed);
  }

  private async processPrompt(prompt: string): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    // Auto-route bare CVE IDs, IP addresses, and file hashes to their specialist commands
    {
      const trimmedInput = prompt.trim();
      const isCve = /^CVE-\d{4}-\d{4,}$/i.test(trimmedInput);
      const isIpOrCidr = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(trimmedInput);
      const isSha256 = /^[0-9a-fA-F]{64}$/.test(trimmedInput);
      const isMd5 = /^[0-9a-fA-F]{32}$/.test(trimmedInput);
      const isSha1 = /^[0-9a-fA-F]{40}$/.test(trimmedInput);
      if (isCve) {
        if (await Promise.resolve(this.handleSlashCommand(`/cve ${trimmedInput}`))) return;
      } else if (isIpOrCidr) {
        if (await Promise.resolve(this.handleSlashCommand(`/ip ${trimmedInput}`))) return;
      } else if (isSha256 || isMd5 || isSha1) {
        if (await Promise.resolve(this.handleSlashCommand(`/hash ${trimmedInput}`))) return;
      }
    }

    // Start new run for file change tracking (enables /revert)
    startNewRun();

    // 自动检测安全阶段并附加 rulebook context when relevant
    let sanitizedPrompt = prompt;
    const detectedPhase = autoDetectPhase(prompt);
    if (detectedPhase) {
      const ctx = buildPhaseContext(this.profile, detectedPhase);
      if (ctx) sanitizedPrompt = `${ctx}\n${prompt}`;
    }

    // Inject session target scope so every response is target-aware
    if (this.sessionTargets.length > 0 && !prompt.startsWith('[安全阶段:') && !prompt.startsWith('IMPORTANT:')) {
      const scopeLine = `[Session scope — authorized targets: ${this.sessionTargets.join(', ')}]`;
      sanitizedPrompt = `${scopeLine}\n${sanitizedPrompt}`;
    }

    // Inject findings store summary for remediation/triage/report queries
    // so the agent grounds its response in actual stored data, not just conversation
    const findingsKeywords = /\b(remedia|triage|prioriti|report|findings?|patch|fix|vulner|CVE|critical|exploit|KEV|EPSS)\b/i;
    if (findingsKeywords.test(prompt) && !prompt.startsWith('[安全阶段:') && !prompt.startsWith('IMPORTANT:')) {
      const stored = loadFindings();
      if (stored.length > 0) {
        const sevOrder = ['critical', 'high', 'medium', 'low', 'info'];
        const top = [...stored]
          .sort((a, b) => {
            // Sort: KEV first, then by severity, then by EPSS desc
            if (a.kev && !b.kev) return -1;
            if (!a.kev && b.kev) return 1;
            const si = sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity);
            if (si !== 0) return si;
            return (b.epss ?? 0) - (a.epss ?? 0);
          })
          .slice(0, 15);
        const kevCount = stored.filter((f) => f.kev).length;
        const critHighCount = stored.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
        const findingsSummaryLines = top.map((f) =>
          `- [${f.severity.toUpperCase()}] ${f.cve ?? f.id}: ${f.title}` +
          (f.cvss != null ? ` | CVSS:${f.cvss}` : '') +
          (f.epss != null ? ` | EPSS:${(f.epss * 100).toFixed(1)}%` : '') +
          (f.kev ? ' | KEV:YES' : '') +
          (f.target ? ` | asset:${f.target}` : '')
        ).join('\n');
        const findingsCtx =
          `[Findings store: ${stored.length} total, ${critHighCount} crit/high, ${kevCount} KEV-listed. Top findings:\n${findingsSummaryLines}]`;
        sanitizedPrompt = `${findingsCtx}\n${sanitizedPrompt}`;
      }
    }

    // Store original prompt for auto-continuation (if not a continuation or auto-generated prompt)
    if (prompt !== 'continue' && !prompt.startsWith('IMPORTANT:')) {
      this.originalPromptForAutoContinue = prompt;
      // A fresh user prompt clears any prior interrupt state — this is new
      // work the user actually wants done.
      this.userInterruptedRun = false;
      // Pinned-prompt persistence removed per request — no longer
      // displayed above the chat box.
    }

    enterCriticalSection();

    this.isProcessing = true;
    this.currentResponseBuffer = '';
    this.promptController?.setStreaming(true);
    this.promptController?.setStatusMessage('Processing request...');

    const renderer = this.promptController?.getRenderer();

    let episodeSuccess = false;
    const toolsUsed: string[] = [];
    const filesModified: string[] = [];

    // Track reasoning content for fallback when response is empty
    let reasoningBuffer = '';

    // Track reasoning-only time to prevent models from reasoning forever without action
    let reasoningOnlyStartTime: number | null = null;
    let reasoningTimedOut = false;
    let stepTimedOut = false;
    let hitlDepth = 0;

    // Track total prompt processing time to prevent infinite loops
    const promptStartTime = Date.now();
    const TOTAL_RUN_TIMEOUT_MS = 15 * 60 * 1000; // 15 min — security CLI auto-terminates
    let hasReceivedMeaningfulContent = false;
    // Track response content separately - tool calls don't count for reasoning timeout
    let hasReceivedResponseContent = false;
    let quotaExhausted = false;

    try {
      // Use timeout-wrapped iterator to prevent hanging on slow/stuck models
      for await (const eventOrTimeout of iterateWithTimeout(
        this.controller.send(sanitizedPrompt),
        PROMPT_STEP_TIMEOUT_MS
      )) {
        // Check for timeout marker
        if (eventOrTimeout && typeof eventOrTimeout === 'object' && '__timeout' in eventOrTimeout) {
          if (hitlDepth > 0) {
            this.promptController?.setStatusMessage('⏱ Waiting for human decision...');
            continue;
          }
          stepTimedOut = true;
          this.promptController?.setStatusMessage(`⏱ Step timeout (${PROMPT_STEP_TIMEOUT_MS / 1000}s) - completing response`);
          // Cancel the controller so the underlying agent stops generating
          // events that would never be consumed. Without this the spinner
          // can keep ticking against a "ghost" run after the for-await
          // loop exits, and any in-flight tool keeps doing work the user
          // can't see or stop.
          try { this.controller.cancel('step timeout'); } catch { /* best-effort */ }
          break;
        }

        // Check total elapsed time — hard 15-min security timeout
        const totalElapsed = Date.now() - promptStartTime;
        if (totalElapsed > TOTAL_RUN_TIMEOUT_MS) {
          if (renderer) {
            renderer.addEvent('response', chalk.yellow(`\n⏱ Run timeout (${Math.round(totalElapsed / 1000)}s) — security CLI auto-terminates\n`));
          }
          try { this.controller.cancel('run timeout'); } catch { /* best-effort */ }
          break;
        }

        const event = eventOrTimeout as AgentEventUnion;
        if (this.shouldExit) {
          break;
        }

        switch (event.type) {
          case 'message.start':
            // AI has started processing - update status to show activity
            this.currentResponseBuffer = '';
            reasoningBuffer = '';
            reasoningOnlyStartTime = null; // Reset on new message
            this.promptController?.setStatusMessage('Analyzing request...');
            break;

          case 'message.delta':
            // Stream content as it arrives
            this.currentResponseBuffer += event.content ?? '';
            if (renderer) {
              renderer.addEvent('stream', event.content);
            }
            // Reset reasoning timer only when we get actual non-empty content
            if (event.content && event.content.trim()) {
              reasoningOnlyStartTime = null;
              hasReceivedMeaningfulContent = true;
              hasReceivedResponseContent = true; // Track actual response content
            }
            break;

          case 'reasoning':
            // Accumulate reasoning for potential fallback synthesis
            reasoningBuffer += event.content ?? '';
            // Update status to show what the model is actually working on
            if (event.content?.trim()) {
              const snippet = extractReasoningSnippet(event.content);
              this.promptController?.setActivityMessage(snippet);
            } else {
              this.promptController?.setActivityMessage('Thinking...');
            }
            // Start the reasoning timer on first reasoning event
            if (!reasoningOnlyStartTime) {
              reasoningOnlyStartTime = Date.now();
            }
            // Display useful reasoning as 'thought' events BEFORE the response
            // The renderer's curateReasoningContent and shouldRenderThought will filter
            // to show only actionable/structured thoughts
            if (renderer && event.content?.trim()) {
              renderer.addEvent('thought', event.content);
            }
            break;

          case 'message.complete':
            // Response complete — clear thinking AND reasoning indicators
            // both. statusMessage clears 'Thinking...' (set on message.start
            // and after each tool); activityMessage clears the reasoning
            // chip (set on every 'reasoning' event but never reset until
            // the post-loop finally). Without clearing activityMessage
            // here, the spinner kept ticking between message-end and the
            // next event because composedStatus falls through to the still-
            // set 'Thinking' activity label.
            this.promptController?.setStatusMessage(null);
            this.promptController?.setActivityMessage(null);

            // Response complete - ensure final output is committed to history.
            // Prefer event.content (canonical, properly formatted) over
            // streamed deltas (token-level fragments with missing punctuation).
            if (renderer) {
              const base = (event.content ?? '').trimEnd();
              let sourceText = (base || this.currentResponseBuffer).trim();

              if (sourceText) {
                // Use canonical text directly — this yields proper grammar
                // and punctuation that streaming deltas lose at token boundaries.
                renderer.addEvent('response', sourceText);
              }

              // Fallback: If response is empty but we have reasoning, synthesize a response
              if (!sourceText && reasoningBuffer.trim()) {
                // Extract key conclusions from reasoning for display
                const synthesized = this.synthesizeFromReasoning(reasoningBuffer);
                if (synthesized) {
                  renderer.addEvent('response', synthesized);
                  sourceText = synthesized;
                }
              }

              episodeSuccess = true; // Mark episode as successful only after we have content

              // Only add "Next steps" if tools were actually used (real work done)
              // This prevents showing "Next steps" after reasoning-only responses
              if (toolsUsed.length > 0) {
                const { appended } = ensureNextSteps(sourceText);
                // Only stream the newly appended content (e.g., "Next steps:")
                // The main response was already added as a response event above
                if (appended && appended.trim()) {
                  renderer.addEvent('response', appended);
                }
              }
              renderer.addEvent('response', '\n');

              // ── Auto-extract CVEs from agent response ──────────────────────
              // Scan the completed response for CVE-YYYY-NNNNN patterns and
              // offer to save any new ones to the persistent findings store.
              this.autoExtractCVEs(sourceText, renderer);

            }
            this.currentResponseBuffer = '';
            break;

          case 'tool.start': {
            const toolName = event.toolName;
            const args = event.parameters;
            // Default format: `ToolName(arg)` — Claude Code's idiom.
            // ChatStatic prefixes a `⏺ ` glyph for kind='tool', so this
            // string is what reads after the bullet. Shorter and more
            // scannable than `[ToolName] arg`.
            let toolDisplay = toolName;
            if (isHitlToolName(toolName)) {
              hitlDepth += 1;
            }

            // Reset reasoning timer when tools are being called (model is taking action)
            reasoningOnlyStartTime = null;
            hasReceivedMeaningfulContent = true;

            if (!toolsUsed.includes(toolName)) {
              toolsUsed.push(toolName);
            }
            this.sessionToolsUsed.add(toolName);

            const filePath = args?.['file_path'] as string | undefined;
            if (filePath && (toolName === 'Write' || toolName === 'Edit')) {
              if (!filesModified.includes(filePath)) {
                filesModified.push(filePath);
              }
              this.sessionFilesModified.add(filePath);
            }

            if (toolName === 'Bash' && args?.['command']) {
              toolDisplay = `Bash(${String(args['command']).slice(0, 120)})`;
            } else if (toolName === 'Read' && args?.['file_path']) {
              toolDisplay = `Read(${args['file_path']})`;
            } else if (toolName === 'Write' && args?.['file_path']) {
              toolDisplay = `Write(${args['file_path']})`;
            } else if (toolName === 'Edit' && args?.['file_path']) {
              toolDisplay = `Edit(${args['file_path']})`;
            } else if (toolName === 'Search' && args?.['pattern']) {
              toolDisplay = `Search(${args['pattern']})`;
            } else if (toolName === 'Grep' && args?.['pattern']) {
              toolDisplay = `Grep(${args['pattern']})`;
            } else if (toolName === 'WebSearch' && args?.['query']) {
              toolDisplay = `WebSearch("${String(args['query']).slice(0, 80)}")`;
            } else if (toolName === 'WebExtract') {
              const urlsArg = args?.['urls'];
              const urls: string[] = Array.isArray(urlsArg)
                ? urlsArg.filter((u): u is string => typeof u === 'string')
                : typeof args?.['url'] === 'string'
                  ? [args['url'] as string]
                  : [];
              const display = urls.length > 0
                ? urls.length === 1 ? urls[0] : `${urls[0]} (+${urls.length - 1} more)`
                : '...';
              toolDisplay = `WebExtract(${display})`;
            }

            if (renderer) {
              renderer.addEvent('tool', toolDisplay);
            }

            // Provide explanatory status messages for different tool types
            let statusMsg = '';
            if (toolName === 'Bash') {
              statusMsg = `Running: ${args?.['command'] ? String(args['command']).slice(0, 40) : '...'}`;
            } else if (toolName === 'Edit' || toolName === 'Write') {
              statusMsg = `📝 Editing file: ${args?.['file_path'] || '...'}`;
            } else if (toolName === 'Read') {
              statusMsg = `📖 Reading file: ${args?.['file_path'] || '...'}`;
            } else if (toolName === 'Search' || toolName === 'Grep') {
              statusMsg = `🔍 Searching: ${args?.['pattern'] ? String(args['pattern']).slice(0, 30) : '...'}`;
            } else if (toolName === 'WebSearch') {
              statusMsg = `🌐 Searching web: ${args?.['query'] ? String(args['query']).slice(0, 40) : '...'}`;
            } else if (toolName === 'WebExtract') {
              const urlsArg = args?.['urls'];
              const firstUrl = Array.isArray(urlsArg)
                ? urlsArg.find((u) => typeof u === 'string')
                : typeof args?.['url'] === 'string' ? args['url'] : '...';
              statusMsg = `🌐 Extracting: ${String(firstUrl ?? '...').slice(0, 50)}`;
            } else {
              statusMsg = `🔧 Running ${toolName}...`;
            }

            this.promptController?.setStatusMessage(statusMsg);
            break;
          }

          case 'tool.complete': {
            if (isHitlToolName(event.toolName)) {
              hitlDepth = Math.max(0, hitlDepth - 1);
            }
            // Clear the "Running X..." status since tool is complete
            this.promptController?.setStatusMessage('Processing results...');
            // Reset reasoning timer after tool completes
            reasoningOnlyStartTime = null;
            // The legacy "Done:" header for Bash was redundant — the
            // tool-result item now renders with its own `  ↳ ` indent
            // so the call→result pairing is visually obvious without
            // a separate header line.
            // Pass full result to renderer - it handles display truncation
            // and stores full content for Ctrl+O expansion
            if (event.result && typeof event.result === 'string' && event.result.trim() && renderer) {
              renderer.addEvent('tool-result', event.result);
            }
            break;
          }

          case 'tool.error':
            if (isHitlToolName(event.toolName)) {
              hitlDepth = Math.max(0, hitlDepth - 1);
            }
            // Clear the "Running X..." status since tool errored
            this.promptController?.setStatusMessage('Processing results...');
            if (renderer) {
              renderer.addEvent('error', event.error);
            }
            break;

          case 'error': {
            if (renderer) {
              renderer.addEvent('error', event.error);
            }
            // Auto-terminate on fatal errors that will never self-correct
            const errMsg = (event.error ?? '').toLowerCase();
            if (errMsg.includes('insufficient_balance') || errMsg.includes('insufficient balance') ||
                errMsg.includes('quota exceeded') || errMsg.includes('quota exhausted') ||
                errMsg.includes('monthly limit') || errMsg.includes('insufficient_quota') ||
                errMsg.includes('usage limit exceeded') || errMsg.includes('payment required') ||
                errMsg.includes('api key') || errMsg.includes('unauthorized') ||
                errMsg.includes('http 401') || errMsg.includes('authentication') ||
                errMsg.includes('circuit breaker') || errMsg.includes('too many failures') ||
                errMsg.includes('insufficient tool messages') || errMsg.includes('tool_calls must be followed') ||
                errMsg.includes('invalid api key')) {
              // All of these are fatal — retrying won't help, only makes the
              // corrupted conversation state worse.
              quotaExhausted = true;
              this.shouldExit = true;
              if (renderer) {
                if (errMsg.includes('api key') || errMsg.includes('unauthorized') || errMsg.includes('http 401') || errMsg.includes('authentication') || errMsg.includes('invalid')) {
                  renderer.addEvent('banner', chalk.red('🔑 API key invalid or expired.'));
                  renderer.addEvent('banner', muted('  Set a valid key: vigil --key sk-...'));
                } else if (errMsg.includes('circuit breaker') || errMsg.includes('too many failures')) {
                  renderer.addEvent('banner', chalk.red('⚡ Circuit breaker open — too many failures.'));
                  renderer.addEvent('banner', muted('  The conversation state is corrupted. Start a new session.'));
                } else if (errMsg.includes('tool_calls') || errMsg.includes('insufficient tool messages')) {
                  renderer.addEvent('banner', chalk.red('🔧 Tool call state mismatch — conversation corrupted.'));
                  renderer.addEvent('banner', muted('  Start a new session. Auto-continue was compounding the error.'));
                } else {
                  renderer.addEvent('banner', chalk.red(`🚫 ${event.error}`));
                }
              }
              try { this.controller.cancel('fatal error'); } catch { /* best-effort */ }
              break;
            }
            break;
          }

          case 'usage':
            this.promptController?.setMetaStatus({
              tokensUsed: event.totalTokens,
              tokenLimit: 1_000_000, // DeepSeek V4 Pro/Flash: 1M context (api-docs.deepseek.com)
            });
            // Roll up to session totals for the session-end Firestore write.
            this.sessionTokensIn += event.inputTokens || 0;
            this.sessionTokensOut += event.outputTokens || 0;
            break;

          case 'provider.fallback': {
            // Auto-terminate on balance insufficient fallback — don't keep cycling providers
            const reasonLower = (event.reason ?? '').toLowerCase();
            if (reasonLower.includes('insufficient_balance') || reasonLower.includes('insufficient balance') ||
                reasonLower.includes('quota') || reasonLower.includes('billing') ||
                reasonLower.includes('payment required')) {
              quotaExhausted = true;
              this.shouldExit = true;
              if (renderer) {
                renderer.addEvent('banner', chalk.red(`🚫 ${event.reason} — run terminated.`));
                renderer.addEvent('banner', chalk.yellow('💡 Use your own API keys:'));
                renderer.addEvent('banner', muted('  vigil --key sk-...  |  vigil --tavily-key tvly-...'));
                renderer.addEvent('banner', muted('  DeepSeek: https://platform.deepseek.com/api_keys'));
              }
              try { this.controller.cancel('quota exhausted'); } catch { /* best-effort */ }
              break;
            }
            // Display fallback notification
            if (renderer) {
              const fallbackMsg = chalk.yellow('⚠ ') +
                muted(`${event.fromProvider}/${event.fromModel} failed: `) +
                chalk.hex('#EF4444')(event.reason) +
                muted(' → switching to ') +
                chalk.hex('#34D399')(`${event.toProvider}/${event.toModel}`);
              renderer.addEvent('banner', fallbackMsg);
            }

            // Update the model context to reflect the new provider/model
            this.profileConfig = {
              ...this.profileConfig,
              provider: event.toProvider,
              model: event.toModel,
            };
            this.promptController?.setModelContext({
              model: event.toModel,
              provider: event.toProvider,
            });
            break;
          }

          case 'edit.explanation':
            // Show explanation for edits made
            if (event.content && renderer) {
              const filesInfo = event.files?.length ? ` (${event.files.join(', ')})` : '';
              renderer.addEvent('response', `${event.content}${filesInfo}`);
            }
            break;

        }

        // Check reasoning timeout on EVERY iteration (not just when reasoning events arrive)
        // This ensures we bail out even if events are sparse
        // Use hasReceivedResponseContent (not hasReceivedMeaningfulContent) so timeout
        // still triggers after tool calls if model just reasons without responding
        if (reasoningOnlyStartTime && !hasReceivedResponseContent) {
          const reasoningElapsed = Date.now() - reasoningOnlyStartTime;
          if (reasoningElapsed > PROMPT_REASONING_TIMEOUT_MS) {
            if (renderer) {
              renderer.addEvent('response', chalk.yellow(`\n⏱ Reasoning timeout (${Math.round(reasoningElapsed / 1000)}s)\n`));
            }
            reasoningTimedOut = true;
          }
        }

        // Check if reasoning timeout was triggered - break out of event loop
        if (reasoningTimedOut) {
          // Cancel the controller too; otherwise the for-await drain
          // exits but the agent keeps producing events and side-effects
          // for the next 30+ seconds with no UI to consume them.
          try { this.controller.cancel('reasoning timeout'); } catch { /* best-effort */ }
          break;
        }
      }

      // After loop: synthesize from reasoning if no response was generated or timed out
      // This handles models like deepseek-v4-pro that output thinking but empty response
      // Also handles step timeouts where the model was stuck
      // IMPORTANT: Don't add "Next steps" when only reasoning occurred - only after real work
      if ((!episodeSuccess || reasoningTimedOut || stepTimedOut) && reasoningBuffer.trim() && !this.currentResponseBuffer.trim()) {
        const synthesized = this.synthesizeFromReasoning(reasoningBuffer);
        if (synthesized && renderer) {
          renderer.addEvent('stream', '\n' + synthesized);
          // Only add "Next steps" if tools were actually used (real work done)
          if (toolsUsed.length > 0) {
            const { appended } = ensureNextSteps(synthesized);
            if (appended?.trim()) {
              renderer.addEvent('stream', appended);
            }
          }
          renderer.addEvent('response', '\n');
          episodeSuccess = true;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (renderer) {
        renderer.addEvent('error', message);
      }

      // Fallback: If we have reasoning content but no response was generated, synthesize one
      if (!episodeSuccess && reasoningBuffer.trim() && !this.currentResponseBuffer.trim()) {
        const synthesized = this.synthesizeFromReasoning(reasoningBuffer);
        if (synthesized && renderer) {
          renderer.addEvent('stream', '\n' + synthesized);
          renderer.addEvent('response', '\n');
          episodeSuccess = true; // Mark as partial success
        }
      }
    } finally {
      // Exit critical section - allow termination again
      exitCriticalSection();

      // Final fallback: If stream ended without message.complete but we have reasoning
      if (!quotaExhausted && !episodeSuccess && reasoningBuffer.trim() && !this.currentResponseBuffer.trim()) {
        const synthesized = this.synthesizeFromReasoning(reasoningBuffer);
        if (synthesized && renderer) {
          renderer.addEvent('stream', '\n' + synthesized);
          // Only add "Next steps" if tools were actually used (real work done)
          if (toolsUsed.length > 0) {
            const { appended } = ensureNextSteps(synthesized);
            if (appended?.trim()) {
              renderer.addEvent('stream', appended);
            }
          }
          renderer.addEvent('response', '\n');
          episodeSuccess = true;
        }
      }

      // Detect a model safety refusal in the just-finished turn. When the
      // model declines the request, the request is *done* — auto-continue
      // would just resubmit "continue" and start a new spinner cycle, which
      // is what produced the stuck "Thinking… (4m N s)" timer the user saw.
      const refusedTurn = false;

      this.isProcessing = false;
      this.promptController?.setStreaming(false);
      this.promptController?.setStatusMessage(null);
      // Belt-and-suspenders: explicitly clear the activity message so the
      // "Thinking… (esc to interrupt · Ns)" line doesn't linger after the
      // final reply if setMode→stopSpinnerAnimation races with another
      // renderPrompt tick.
      this.promptController?.setActivityMessage(null);
      // Force an idle re-render so the spinner area is repainted without
      // the streaming activity line. setStreaming(false) → setMode('idle')
      // already calls renderPrompt(), but a coalesced spinner tick that
      // races with the transition can leave the last "Thinking… (Ns)"
      // frame on screen until the next event. forceRender squashes it.
      this.promptController?.forceRender();

      this.currentResponseBuffer = '';

      // Process any queued prompts
      if (this.pendingPrompts.length > 0 && !this.shouldExit) {
        const next = this.pendingPrompts.shift();
        if (next) {
          await this.processPrompt(next);
        }
      } else if (refusedTurn) {
        // Refusal terminates the turn. Don't re-prompt the model — the
        // user's request is finished from the agent's side. Clear the
        // stored "original prompt" so a stray Alt+G later doesn't pick
        // up where this turn left off.
        this.originalPromptForAutoContinue = null;
      } else if (!this.shouldExit && !this.userInterruptedRun && !refusedTurn) {
        // Auto mode: keep running until user's prompt is fully completed.
        // Skipped after a Ctrl+C interrupt so we don't immediately resume
        // the work the user just cancelled. Also skipped on safety refusals
        // to prevent infinite refusal loops.
        const autoMode = this.promptController?.getAutoMode() ?? 'off';
        if (autoMode !== 'off') {
          // Check if original user prompt is fully completed
          const detector = getTaskCompletionDetector();
          const analysis = detector.analyzeCompletion(this.currentResponseBuffer, toolsUsed);

          // Continue until task is complete
          if (!analysis.isComplete) {
            this.promptController?.setStatusMessage('Continuing...');
            await new Promise(resolve => setTimeout(resolve, 500));

            // Generate auto-continue prompt using stored original prompt
            const autoPrompt = this.generateAutoContinuePrompt(
              this.originalPromptForAutoContinue || '',
              this.currentResponseBuffer,
              toolsUsed,
            );

            const finalPrompt = autoPrompt || 'continue';
            // Show the auto-continue prompt in the chat so the user can see what's happening
            if (renderer) {
              const shortPreview = finalPrompt.length > 120 ? finalPrompt.slice(0, 120) + '...' : finalPrompt;
              renderer.addEvent('system', `continue: ${shortPreview}`);
            }
            await this.processPrompt(finalPrompt);
          } else {
            this.promptController?.setStatusMessage('Task complete');
            setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
          }
        } else if (episodeSuccess && !stepTimedOut && !reasoningTimedOut) {
          // Manual mode (autoMode === 'off') — show a brief end-of-turn
          // signal so the user knows the agent is idle again. Without
          // this the spinner just vanishes silently, which on slow
          // terminals reads as "still thinking" or "hung". Skipped on
          // errors / timeouts because those already render their own
          // explanatory bubble.
          this.promptController?.setStatusMessage('✓ Done');
          setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
        }
      }
    }
  }

  private generateAutoContinuePrompt(originalPrompt: string, response: string, toolsUsed: string[]): string | null {
    // Highest-priority signal: a test or build is currently failing
    // in the visible output. Override every other heuristic and force
    // a sharp, focused next-action prompt — the agent must drill into
    // the FIRST failure rather than declaring victory.
    const failingSignal = detectFailingTestOrBuild(response);
    if (failingSignal) {
      const noDocsInstruction = `IMPORTANT: Do NOT create markdown files, documentation, summaries, or reports.`;
      return `${noDocsInstruction} The output above shows a failing test/build (${failingSignal}). Read the FIRST failure carefully, identify the root cause, edit exactly the file(s) needed, then re-run the same test/build command to confirm. Do not stop until that command exits cleanly.`;
    }

    // Any tool usage is meaningful work — continue unless the model explicitly stopped.
    const hasFileOperations = toolsUsed.some(t => ['Read', 'Write', 'Edit', 'Search', 'Grep'].includes(t));
    const hasBashOperations = toolsUsed.includes('Bash');
    const hasWebOperations = toolsUsed.some(t => ['WebSearch', 'WebExtract', 'WebFetch'].includes(t));
    const hasOtherTools = toolsUsed.some(t => !['Read', 'Write', 'Edit', 'Search', 'Grep', 'Bash', 'WebSearch', 'WebExtract', 'WebFetch'].includes(t));

    if (!hasFileOperations && !hasBashOperations && !hasWebOperations && !hasOtherTools) {
      return null; // No tools used at all — nothing to continue
    }

    // Analyze response to determine what to do next
    const lowercaseResponse = response.toLowerCase();
    const noDocsInstruction = `IMPORTANT: Do NOT create markdown files, documentation, summaries, or reports. Continue the actual operational work.`;

    // Check for common patterns that indicate more work is needed
    const needsMoreWork =
      lowercaseResponse.includes('next step') ||
      lowercaseResponse.includes('further') ||
      lowercaseResponse.includes('additional') ||
      lowercaseResponse.includes('implement') ||
      lowercaseResponse.includes('complete') ||
      lowercaseResponse.includes('finish') ||
      lowercaseResponse.includes('proceed') ||
      lowercaseResponse.includes('starting') ||
      lowercaseResponse.includes('phase') ||
      lowercaseResponse.includes('continue');

    if (needsMoreWork) {
      // Generate a follow-up prompt based on the original task
      if (originalPrompt.includes('fix') || originalPrompt.includes('bug')) {
        return `${noDocsInstruction} Continue fixing - edit the next file that needs changes.`;
      } else if (originalPrompt.includes('implement') || originalPrompt.includes('add')) {
        return `${noDocsInstruction} Continue implementing - write or edit the next piece of code.`;
      } else if (originalPrompt.includes('refactor') || originalPrompt.includes('clean')) {
        return `${noDocsInstruction} Continue refactoring - apply changes to the next file.`;
      } else if (originalPrompt.includes('test')) {
        return `${noDocsInstruction} Continue with tests - run or fix the next test.`;
      } else if (originalPrompt.includes('build') || originalPrompt.includes('deploy') || originalPrompt.includes('publish')) {
        return `${noDocsInstruction} Continue the build/deploy process - execute the next command.`;
      } else {
        const taskPreview = originalPrompt.slice(0, 100).replace(/\n/g, ' ');
        return `${noDocsInstruction} Continue the task: ${taskPreview} — perform the next concrete action. Do not stop analyzing or executing until the task is fully complete.`;
      }
    }

    // Even without explicit "next steps" language, if tools were used
    // but no completion signal was emitted, keep going.
    if (!lowercaseResponse.includes('done') && !lowercaseResponse.includes('finished') && !lowercaseResponse.includes('completed')) {
      const taskPreview = originalPrompt.slice(0, 100).replace(/\n/g, ' ');
      return `${noDocsInstruction} Continue the task: ${taskPreview} — perform the next concrete action.`;
    }

    return null;
  }

  private handleInterrupt(): void {
    if (!this.isProcessing) {
      return;
    }
    const renderer = this.promptController?.getRenderer();
    if (renderer) {
      renderer.addEvent('banner', chalk.yellow('Interrupted'));
    }
    // Actually cancel the in-flight controller run. Without this the
    // for-await loop in processPrompt keeps consuming events, the spinner
    // stays up, and the agent grinds through the rest of its tool loop
    // while the user sees only a "Interrupted" banner. cancel() is a no-op
    // when there's no active sink, so this is safe to call unconditionally.
    try {
      this.controller.cancel('user interrupt via Ctrl+C');
    } catch {
      // Best-effort; if the controller is already torn down the next
      // Ctrl+C will fall through to authorizedShutdown.
    }
    // Suppress the auto-continue re-launch in processPrompt's finally
    // block. Otherwise the agent immediately starts a fresh "continue"
    // cycle 500ms later and the user has to keep mashing Ctrl+C to keep
    // up. Cleared when the user submits a new prompt.
    this.userInterruptedRun = true;
  }

  private handleAutoContinueToggle(): void {
    const autoMode = this.promptController?.getAutoMode() ?? 'off';

    this.promptController?.setStatusMessage(`Auto: ${autoMode}`);
    setTimeout(() => this.promptController?.setStatusMessage(null), 1500);

    // Reset task completion detector when entering any auto mode
    if (autoMode !== 'off') {
      const detector = getTaskCompletionDetector();
      detector.reset();
      // Clear any stored original prompt
      this.originalPromptForAutoContinue = null;
    }
  }

  private handleHITLToggle(): void {
    const mode = this.promptController?.getModeToggleState().hitlMode ?? 'off';
    getHITL().updateConfig({ autoPause: mode === 'on' });
    this.promptController?.setStatusMessage(`HITL: ${mode}`);
    setTimeout(() => this.promptController?.setStatusMessage(null), 1500);
  }

  private handleCtrlC(info: { hadBuffer: boolean }): void {
    const now = Date.now();

    // Reset count if more than 2 seconds since last Ctrl+C
    if (now - this.lastCtrlCTime > 2000) {
      this.ctrlCCount = 0;
    }

    this.lastCtrlCTime = now;
    this.ctrlCCount++;

    if (info.hadBuffer) {
      // Clear buffer, reset count
      this.ctrlCCount = 0;
      return;
    }

    // Always allow double Ctrl+C to exit, even while processing
    if (this.ctrlCCount >= 2) {
      // Use authorized shutdown to bypass anti-termination guard
      void authorizedShutdown(0);
      this.shouldExit = true;
      this.ctrlCCount = 0;
      return;
    }

    if (this.isProcessing) {
      // Interrupt processing on first Ctrl+C, then allow next Ctrl+C to exit
      this.handleInterrupt();
      const renderer = this.promptController?.getRenderer();
      if (renderer) {
        renderer.addEvent('banner', muted('Press Ctrl+C again to exit'));
      }
      return;
    }

    // First Ctrl+C when idle: show hint
    const renderer = this.promptController?.getRenderer();
    if (renderer) {
      renderer.addEvent('banner', muted('Press Ctrl+C again to exit'));
    }
  }

  private handleExit(): void {
    this.shouldExit = true;
    // Persist session state so next run restores targets + phase
    savePersistedSession(this.sessionTargets, this.sessionActivePhase);
    // Cancel background KEV watch if running
    if (this._kevWatchTimer) { clearInterval(this._kevWatchTimer); this._kevWatchTimer = undefined; }
    // Stop active loop if running
    this.stopLoop();
    this.promptController?.stop();
    void authorizedShutdown(0);
  }

  private waitForExit(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.shouldExit) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  // ── /loop command ─────────────────────────────────────────────────────

  private handleLoopCommand(fullCommand: string): boolean {
    const trimmed = fullCommand.trim();
    const parts = trimmed.split(/\s+/);
    // parts[0] = '/loop'
    const sub = parts.slice(1).join(' ').trim();

    if (!sub || sub === 'status') {
      this.showLoopStatus();
      return true;
    }

    if (sub === 'stop') {
      this.stopLoop();
      this.promptController?.setStatusMessage('Loop stopped');
      setTimeout(() => this.promptController?.setStatusMessage(null), 1500);
      return true;
    }

    // Parse: /loop <interval> <prompt>
    // Interval: 30s, 5m, 1h, or bare number (seconds)
    const intervalMatch = parts[1]?.match(/^(\d+)(s|m|h)?$/);
    if (!intervalMatch) {
      this.promptController?.setStatusMessage('Usage: /loop <interval> <prompt>  (e.g. /loop 30s scan)');
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return true;
    }

    const value = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2] || 's';
    let intervalMs = value * 1000;
    if (unit === 'm') intervalMs = value * 60 * 1000;
    if (unit === 'h') intervalMs = value * 60 * 60 * 1000;

    // Minimum 5 seconds, maximum 24 hours
    if (intervalMs < 5000) {
      this.promptController?.setStatusMessage('Minimum loop interval is 5 seconds');
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
      return true;
    }
    if (intervalMs > 24 * 60 * 60 * 1000) {
      this.promptController?.setStatusMessage('Maximum loop interval is 24 hours');
      setTimeout(() => this.promptController?.setStatusMessage(null), 2000);
      return true;
    }

    const promptText = parts.slice(2).join(' ').trim();
    const isAutoPrompt = !promptText;

    // Stop any existing loop
    this.stopLoop();

    // Start new loop
    this.loopPrompt = promptText;
    this.loopIntervalMs = intervalMs;
    this.loopIteration = 0;
    this.loopTotalIterations = 0;
    this.loopActive = true;

    const intervalLabel = intervalMatch[2]
      ? `${value}${unit === 's' ? 's' : unit === 'm' ? 'm' : 'h'}`
      : `${value}s`;

    const modeLabel = isAutoPrompt ? 'auto' : `"${promptText.slice(0, 40)}${promptText.length > 40 ? '…' : ''}"`;
    this.promptController?.setStatusMessage(
      `Loop started: every ${intervalLabel} — ${modeLabel}`
    );

    // Run first iteration immediately
    this.runLoopIteration();

    // Schedule subsequent iterations
    this.loopTimer = setInterval(() => {
      this.runLoopIteration();
    }, intervalMs);

    return true;
  }

  private async runLoopIteration(): Promise<void> {
    if (!this.loopActive) return;
    this.loopIteration++;
    this.loopTotalIterations++;

    if (this.isProcessing) {
      this.promptController?.setStatusMessage(
        `Loop #${this.loopTotalIterations}: skipped (agent busy)`
      );
      return;
    }

    // Auto-prompt mode: Vigil self-prompts each iteration via DeepSeek.
    // First iteration uses static fallback (AI prompt not ready yet);
    // subsequent iterations use the AI-generated prompt from the cache
    // that was pre-generated during the previous iteration.
    let effectivePrompt: string;
    if (this.loopPrompt) {
      // User-supplied prompt — use it directly
      effectivePrompt = this.loopPrompt;
    } else {
      // Auto-prompt: generate optimal prompt via DeepSeek API
      this.promptController?.setStatusMessage(
        `Loop #${this.loopTotalIterations}: generating prompt…`
      );
      try {
        effectivePrompt = await generateDynamicLoopPrompt({
          iteration: this.loopTotalIterations,
          useAI: true,
        });
      } catch {
        // Fallback to static if async generation fails entirely
        effectivePrompt = generateStaticLoopPrompt(this.loopTotalIterations);
      }
    }

    this.promptController?.setStatusMessage(
      `Loop #${this.loopTotalIterations}: running…`
    );

    // Pre-generate the NEXT iteration's prompt in the background while
    // the current iteration executes. This way the prompt is ready
    // when the next timer fires, avoiding the round-trip latency.
    if (!this.loopPrompt && this.loopActive) {
      void preGenerateNextPrompt(this.loopTotalIterations);
    }

    void this.processPrompt(effectivePrompt).then(() => {
      if (this.loopActive) {
        const totalPhases = getTotalPhaseCount();
        const phaseInfo = `Loop #${this.loopTotalIterations}: done (${this.loopTotalIterations % totalPhases || totalPhases}/${totalPhases} phases) — next in ${this.loopIntervalMs / 1000}s`;
        this.promptController?.setStatusMessage(phaseInfo);
      }
    });
  }

  private stopLoop(): void {
    this.loopActive = false;
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    this.loopPrompt = '';
    this.loopIntervalMs = 0;
    this.loopIteration = 0;
    this.loopTotalIterations = 0;
    resetLoopState();
  }

  private showLoopStatus(): void {
    if (!this.loopActive) {
      this.promptController?.setStatusMessage('No active loop. Start: /loop <interval> <prompt>');
      setTimeout(() => this.promptController?.setStatusMessage(null), 3000);
      return;
    }

    const intervalLabel = this.loopIntervalMs >= 3600000
      ? `${this.loopIntervalMs / 3600000}h`
      : this.loopIntervalMs >= 60000
        ? `${this.loopIntervalMs / 60000}m`
        : `${this.loopIntervalMs / 1000}s`;

    this.promptController?.setStatusMessage(
      `Loop: "${this.loopPrompt.slice(0, 30)}…" every ${intervalLabel} | ${this.loopTotalIterations} runs`
    );
    setTimeout(() => this.promptController?.setStatusMessage(null), 4000);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const promptTokens: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    // Skip known flags
    if (token.startsWith('--') || token.startsWith('-')) {
      continue;
    }
    promptTokens.push(token);
  }

  return {
    initialPrompt: promptTokens.length ? promptTokens.join(' ').trim() : null,
  };
}

// Vigil ships one canonical default profile. Historical profile names are
// accepted as aliases so existing env/config does not break.
function resolveProfile(): ProfileName {
  const requested = process.env.VIGIL_PROFILE?.trim();
  if (requested && !process.env['VIGIL_REQUESTED_PROFILE']) {
    process.env['VIGIL_REQUESTED_PROFILE'] = requested;
  }
  const canonical = normalizeProfileName(requested);
  if (hasAgentProfile(canonical)) return canonical;
  return DEFAULT_PROFILE_NAME;
}
