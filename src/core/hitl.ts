/**
 * Human-in-the-Loop (HITL) System
 * Pauses AI execution and prompts users for important decision paths
 * This is the ONLY HITL system in the repository
 */

import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline';
import { EventEmitter } from 'node:events';
import chalk from 'chalk';
import { authorizedShutdown, isShutdownInProgress, onShutdown, installSignalHandlers } from './shutdown.js';

/** Result returned by the HitlPresenter when user selects. */
export interface HitlPresenterResult {
  selectedOptionId: string;
  userInput?: string;
}

/**
 * Presenter callback registered by the UI (InkPromptController).
 * When set, HITL renders inline through the main Ink app instead of
 * mounting a separate Ink instance that fights for stdin.
 */
export type HitlPresenter = (request: {
  title: string;
  description?: string;
  context?: string;
  options: Array<{ id: string; label: string; description?: string }>;
  customId: string;
}) => Promise<HitlPresenterResult>;

let hitlPresenter: HitlPresenter | null = null;

export function setHitlPresenter(p: HitlPresenter | null): void {
  hitlPresenter = p;
}

export function getHitlPresenter(): HitlPresenter | null {
  return hitlPresenter;
}

/**
 * Module-level event bus that fires when a HITL prompt opens or closes. Other
 * subsystems subscribe to:
 *   - pause their own run-timeouts so user think-time doesn't abort the agent
 *     (see AgentController),
 *   - hand the terminal off cleanly so the prompt and post-prompt I/O don't
 *     fight (see UnifiedUIRenderer / interactiveShell).
 *
 * Always paired: every `prompt-open` is followed by exactly one `prompt-close`,
 * including on timeout, Ctrl+C, custom-input, and shutdown paths.
 */
export const hitlEvents = new EventEmitter();
hitlEvents.setMaxListeners(50);

let activePromptCount = 0;

export function isHITLPromptActive(): boolean {
  return activePromptCount > 0;
}

export interface DecisionOption {
  id: string;
  label: string;
  description: string;
  shortcut?: string;
}

export interface DecisionRequest {
  id: string;
  title: string;
  description: string;
  context: string;
  options: DecisionOption[];
  defaultOptionId?: string;
  requiresExplicitChoice: boolean;
  metadata?: Record<string, any>;
}

export interface DecisionResponse {
  requestId: string;
  selectedOptionId: string;
  userInput?: string;
  timestamp: Date;
}

export interface HITLConfig {
  /**
   * Whether to automatically pause execution for decisions
   * If false, decisions will be logged but execution continues
   */
  autoPause: boolean;
  
  /**
   * Timeout in milliseconds before auto-proceeding with default
   * 0 means no timeout (wait indefinitely)
   */
  timeoutMs: number;
  
  /**
   * Default option to choose if timeout occurs
   */
  timeoutDefaultOptionId?: string;
  
  /**
   * Log level: 'none' | 'minimal' | 'detailed'
   */
  logLevel: 'none' | 'minimal' | 'detailed';
}

export class HITLSystem {
  private config: HITLConfig;
  private pendingDecisions: Map<string, DecisionRequest> = new Map();
  private decisionHistory: DecisionResponse[] = [];
  private rl?: readline.Interface;

  constructor(config?: Partial<HITLConfig>) {
    this.config = {
      autoPause: true,
      timeoutMs: 0,
      logLevel: 'detailed',
      ...config
    };
  }

  /**
   * Request a human decision
   * @returns Promise that resolves with the selected option ID
   */
  async requestDecision(request: DecisionRequest): Promise<string> {
    // If request already has an ID, use it, otherwise generate one
    const requestId = request.id || `DECISION-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const fullRequest: DecisionRequest = {
      ...request,
      id: requestId
    };

    this.pendingDecisions.set(requestId, fullRequest);
    
    if (this.config.logLevel !== 'none') {
      this.logDecisionRequest(fullRequest);
    }

    // If auto-pause is disabled, return default or first option
    if (!this.config.autoPause) {
      const selectedOptionId = request.defaultOptionId || request.options[0]?.id;
      if (selectedOptionId) {
        const response: DecisionResponse = {
          requestId,
          selectedOptionId,
          timestamp: new Date()
        };
        this.recordDecision(response);
        
        if (this.config.logLevel === 'detailed') {
          console.log(chalk.yellow(`⚠️  Auto-proceeding with option: ${this.getOptionLabel(request, selectedOptionId)}`));
        }
        return selectedOptionId;
      }
    }

    // Show decision prompt to user
    return this.promptUserForDecision(fullRequest);
  }

  /**
   * Present the decision via the Ink-rendered HitlDecisionMenu.
   * Replaces the prior chalk + raw-mode arrow-key implementation;
   * Ink owns the alternate-screen frame, the keypress loop, and the
   * custom-input flow.
   */
  private async promptUserForDecision(request: DecisionRequest): Promise<string> {
    installSignalHandlers();

    if (isShutdownInProgress()) {
      const defaultOption = request.defaultOptionId || request.options[0]?.id;
      if (defaultOption) return defaultOption;
      throw new Error('Shutdown in progress');
    }

    activePromptCount += 1;
    hitlEvents.emit('prompt-open', { id: request.id });

    const customId = `custom-${Date.now()}`;
    let timer: NodeJS.Timeout | undefined;
    let resolved = false;

    return new Promise<string>((resolve) => {
      const finish = (id: string, userInput?: string) => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        unregisterCleanup();
        const response: DecisionResponse = {
          requestId: request.id,
          selectedOptionId: id,
          ...(userInput ? { userInput } : {}),
          timestamp: new Date(),
        };
        this.recordDecision(response);
        activePromptCount = Math.max(0, activePromptCount - 1);
        hitlEvents.emit('prompt-close', { id: request.id });
        resolve(id);
      };

      const unregisterCleanup = onShutdown(() => {
        if (resolved) return;
        // Shutdown in flight — pick the default and let the caller drain.
        const fallback = this.config.timeoutDefaultOptionId
          || request.defaultOptionId
          || request.options[0]?.id
          || customId;
        finish(fallback);
      });

      if (this.config.timeoutMs > 0 && this.config.timeoutDefaultOptionId) {
        timer = setTimeout(() => {
          if (!resolved) finish(this.config.timeoutDefaultOptionId!);
        }, this.config.timeoutMs);
      }

      void (async () => {
        // Prefer the inline presenter (main Ink app renders the menu).
        // Falls back to showHitlDecision (separate Ink mount) only if no
        // presenter is registered.
        const presenter = getHitlPresenter();
        if (presenter) {
          const result = await presenter({
            title: request.title,
            description: request.description,
            context: request.context,
            options: request.options.map((o) => ({
              id: o.id, label: o.label, description: o.description,
            })),
            customId,
          });
          if (result.userInput) {
            finish(result.selectedOptionId, result.userInput);
          } else {
            finish(result.selectedOptionId);
          }
        } else {
          const { showHitlDecision } = await import('../ui/ink/HitlDecisionMenu.js');
          const result = await showHitlDecision({
            title: request.title,
            description: request.description,
            context: request.context,
            options: request.options.map((o) => ({
              id: o.id, label: o.label, description: o.description,
            })),
            customId,
          });
          if (result.userInput) {
            finish(result.selectedOptionId, result.userInput);
          } else {
            finish(result.selectedOptionId);
          }
        }
      })().catch(() => {
        // Ink failed to mount (no TTY etc.) — fall back to default.
        const fallback = request.defaultOptionId || request.options[0]?.id || customId;
        finish(fallback);
      });
    });
  }

  private cleanupReadline(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = undefined;
    }
  }

  private getOptionLabel(request: DecisionRequest, optionId: string): string {
    const option = request.options.find(opt => opt.id === optionId);
    return option ? option.label : optionId;
  }

  private logDecisionRequest(request: DecisionRequest): void {
    if (this.config.logLevel === 'minimal') {
      console.log(chalk.yellow(`⚠️  Decision required: ${request.title}`));
      return;
    }
    
    console.log(chalk.yellow(`\n⚠️  Decision Point: ${request.title}`));
    console.log(chalk.hex('#9CA4B0')(`   ${request.description}`));
    console.log(chalk.hex('#9CA4B0')(`   Options: ${request.options.map(o => o.label).join(', ')}`));
  }

  private recordDecision(response: DecisionResponse): void {
    this.decisionHistory.push(response);
    this.pendingDecisions.delete(response.requestId);
    
    // Log the decision
    if (this.config.logLevel === 'detailed') {
      const request = this.pendingDecisions.get(response.requestId);
      const optionLabel = request ? this.getOptionLabel(request, response.selectedOptionId) : response.selectedOptionId;
      
      console.log(chalk.green(`📝 Decision recorded: ${optionLabel}`));
      if (response.userInput) {
        console.log(chalk.hex('#9CA4B0')(`   Custom input: ${response.userInput}`));
      }
    }
  }

  /**
   * Get decision history
   */
  getHistory(): DecisionResponse[] {
    return [...this.decisionHistory];
  }

  /**
   * Clear decision history
   */
  clearHistory(): void {
    this.decisionHistory = [];
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<HITLConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// Singleton instance
let hitlInstance: HITLSystem | null = null;

/**
 * Get the global HITL instance
 */
export function getHITL(config?: Partial<HITLConfig>): HITLSystem {
  if (!hitlInstance) {
    hitlInstance = new HITLSystem(config);
  }
  
  if (config) {
    hitlInstance.updateConfig(config);
  }
  
  return hitlInstance;
}

/**
 * Helper function for common decision patterns
 */
export const hitl = {
  /**
   * Request a yes/no decision
   */
  async askYesNo(title: string, description: string, context: string = '', defaultYes: boolean = true): Promise<boolean> {
    const hitl = getHITL();
    
    const decision = await hitl.requestDecision({
      id: `yesno-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      title,
      description,
      context,
      options: [
        {
          id: 'yes',
          label: 'Yes',
          description: 'Proceed with the suggested plan',
          shortcut: 'y'
        },
        {
          id: 'no',
          label: 'No',
          description: 'Do not proceed',
          shortcut: 'n'
        }
      ],
      defaultOptionId: defaultYes ? 'yes' : 'no',
      requiresExplicitChoice: true
    });
    
    return decision === 'yes';
  },

  /**
   * Request selection from multiple options
   */
  async selectOption(title: string, description: string, options: Array<{id: string, label: string, description: string}>, context: string = '', defaultOptionId?: string): Promise<string> {
    const hitl = getHITL();
    
    const decision = await hitl.requestDecision({
      id: `select-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      title,
      description,
      context,
      options: options.map((opt, index) => ({
        ...opt,
        shortcut: String(index + 1)
      })),
      defaultOptionId,
      requiresExplicitChoice: true
    });
    
    return decision;
  },

  /**
   * Request approval for a risky operation
   */
  async requestApproval(title: string, riskDescription: string, operationDetails: string): Promise<boolean> {
    return hitl.askYesNo(
      `APPROVAL REQUIRED: ${title}`,
      riskDescription,
      operationDetails,
      false // Default to "no" for safety
    );
  }
};