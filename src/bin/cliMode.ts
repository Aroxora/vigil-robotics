type Mode = 'version' | 'help' | 'self-test' | 'json' | 'eval' | 'shell';

export interface CliModeResult {
  mode: Mode;
  argv: string[];
}

export function detectCliMode(argv: string[]): CliModeResult {
  const args = [...argv];
  if (args.includes('--version') || args.includes('-v')) {
    return { mode: 'version', argv: args };
  }
  if (args.includes('--help') || args.includes('-h')) {
    return { mode: 'help', argv: args };
  }
  if (args.includes('--self-test')) {
    return { mode: 'self-test', argv: args };
  }
  if (args.includes('--json')) {
    return { mode: 'json', argv: args };
  }
  if (args.includes('--eval') || args.includes('-e')) {
    return { mode: 'eval', argv: args };
  }
  return { mode: 'shell', argv: args };
}
