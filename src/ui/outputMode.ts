/**
 * Output mode configuration for terminal UI
 *
 * Controls whether to use decorative box-drawing characters or plain text.
 * Plain mode outputs clipboard-friendly text without Unicode borders.
 * Automatically enabled in CI or non-interactive shells; override with VIGIL_PLAIN_OUTPUT=true.
 *
 * Environment Variables:
 * - VIGIL_PLAIN_OUTPUT: Set to 'true', '1', 'yes', or 'on' to force plain mode
 * - CI: Automatically enables plain mode when set
 * - TERM: Checked for 'dumb' terminals which get plain mode
 * - NO_COLOR: If set, enables plain mode (respects https://no-color.org/)
 */

let _plainMode: boolean | null = null;
let _colorEnabled: boolean | null = null;

/**
 * Check if plain output mode is enabled.
 * Plain mode outputs text without box-drawing characters for clean clipboard copying.
 */
export function isPlainOutputMode(): boolean {
  if (_plainMode !== null) {
    return _plainMode;
  }

  try {
    // Check explicit environment override first
    const envValue = process.env['VIGIL_PLAIN_OUTPUT'];
    if (envValue !== undefined) {
      const envEnabled = ['true', '1', 'yes', 'on'].includes(envValue.toLowerCase());
      if (envEnabled) {
        _plainMode = true;
        return _plainMode;
      }
      // Also check for explicit disable
      const envDisabled = ['false', '0', 'no', 'off'].includes(envValue.toLowerCase());
      if (envDisabled) {
        _plainMode = false;
        return _plainMode;
      }
    }

    // NO_COLOR (https://no-color.org) — vision-sensitivity users, log
    // scrapers, accessibility tools all rely on this signal. Per the spec
    // it disables not just colours but also decorative output, so it
    // forces plain mode here in addition to gating chalk in isColorEnabled.
    if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') {
      _plainMode = true;
      return _plainMode;
    }

    // Check for dumb terminal
    const term = process.env['TERM'];
    if (term === 'dumb') {
      _plainMode = true;
      return _plainMode;
    }

    // PowerShell ISE reports isTTY=true but implements a tiny subset of
    // ANSI; overlay output appears as literal `[?25l[2J` text. Fall back
    // to plain mode so output is at least readable there.
    if (isPowerShellIse()) {
      _plainMode = true;
      return _plainMode;
    }

    // Check for CI environments
    const isCi = Boolean(
      process.env['CI'] ||
      process.env['GITHUB_ACTIONS'] ||
      process.env['GITLAB_CI'] ||
      process.env['CIRCLECI'] ||
      process.env['TRAVIS'] ||
      process.env['JENKINS_URL']
    );

    // Check TTY status safely
    const isTty = Boolean(
      process.stdout?.isTTY &&
      process.stdin?.isTTY
    );

    // FORCE_COLOR overrides CI detection — some CIs (Buildkite, modern
    // GitHub Actions log groups) handle ANSI fine and operators set this
    // explicitly to keep colour in captured logs.
    const forceColor = process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '0';

    // Default to plain logging in non-interactive/CI environments; rich UI only in TTY sessions.
    _plainMode = !isTty || (isCi && !forceColor);
  } catch {
    // If anything fails, default to plain mode for safety
    _plainMode = true;
  }

  return _plainMode;
}

/**
 * Check if color output is enabled.
 * Respects NO_COLOR environment variable (https://no-color.org/)
 */
export function isColorEnabled(): boolean {
  if (_colorEnabled !== null) {
    return _colorEnabled;
  }

  try {
    // NO_COLOR takes precedence (https://no-color.org/)
    if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') {
      _colorEnabled = false;
      return _colorEnabled;
    }

    // FORCE_COLOR enables colors (overrides every disable below).
    if (process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '0') {
      _colorEnabled = true;
      return _colorEnabled;
    }

    // If plain mode is on (dumb terminal, ISE, CI without FORCE_COLOR,
    // non-TTY), don't emit colour either — keeps captured logs clean.
    if (isPlainOutputMode()) {
      _colorEnabled = false;
      return _colorEnabled;
    }

    // Color enabled in TTY by default
    _colorEnabled = Boolean(process.stdout?.isTTY);
  } catch {
    _colorEnabled = false;
  }

  return _colorEnabled;
}

/**
 * Override the plain output mode setting (useful for testing)
 */
export function setPlainOutputMode(enabled: boolean): void {
  _plainMode = enabled;
}

/**
 * Override the color output mode setting (useful for testing)
 */
export function setColorEnabled(enabled: boolean): void {
  _colorEnabled = enabled;
}

/**
 * Reset plain output mode to check environment variable again
 */
export function resetPlainOutputMode(): void {
  _plainMode = null;
}

/**
 * Reset color mode to check environment variable again
 */
export function resetColorEnabled(): void {
  _colorEnabled = null;
}

/**
 * Reset all output mode settings
 */
export function resetOutputModes(): void {
  _plainMode = null;
  _colorEnabled = null;
}

/**
 * Detect Windows PowerShell ISE. ISE reports `isTTY=true` but implements
 * almost no ANSI; rich UI output appears as literal escape text. Three
 * signals cover the deployed install base:
 *
 *   - `PSModulePath` contains "ISE"
 *   - `VIGIL_FORCE_PSISE` (test/manual override)
 *   - the resize event never fires; we can't detect that synchronously
 *     here, so we lean on the env signals
 *
 * Returns true ONLY when running in ISE — Windows Terminal,
 * PowerShell.exe, and pwsh are all unaffected.
 */
export function isPowerShellIse(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    if (process.env['VIGIL_FORCE_PSISE'] === '1') return true;
    const psModulePath = process.env['PSModulePath'] || '';
    if (/\bISE\b/i.test(psModulePath)) return true;
    // Some ISE installs set this; harmless to check elsewhere.
    if ((process.env['PROCESSOR_HOST'] || '').includes('ISE')) return true;
    return false;
  } catch {
    return false;
  }
}
