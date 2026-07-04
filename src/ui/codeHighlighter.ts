import { theme } from './theme.js';

type Formatter = (value: string) => string;

interface Token {
  text: string;
  formatter?: Formatter;
}

type Tokenizer = (line: string) => Token[];

type HighlightLanguage =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'shell'
  | 'go'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'java'
  | 'csharp'
  | 'cpp'
  | 'c'
  | 'swift'
  | 'kotlin'
  | 'sql'
  | 'json';

interface LanguageProfile {
  keywords: ReadonlySet<string>;
  types?: ReadonlySet<string>;
  builtins?: ReadonlySet<string>;
  constants?: ReadonlySet<string>;
  commentIndicators: string[];
  stringDelimiters: string[];
  identifierStart: RegExp;
  identifierPart: RegExp;
  decoratorPrefix?: boolean;
  highlightVariables?: boolean;
}

interface NormalizedLanguage {
  id: HighlightLanguage | null;
  label: string | null;
}

export interface HighlightedCodeBlock {
  lines: string[];
  languageLabel: string | null;
}

const identity: Formatter = (value) => value;

const LANGUAGE_ALIASES: Record<string, HighlightLanguage> = {
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'typescript',
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  py: 'python',
  python: 'python',
  bash: 'shell',
  sh: 'shell',
  shell: 'shell',
  zsh: 'shell',
  powershell: 'shell',
  go: 'go',
  rust: 'rust',
  rs: 'rust',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  java: 'java',
  cs: 'csharp',
  csharp: 'csharp',
  dotnet: 'csharp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  c: 'c',
  swift: 'swift',
  kt: 'kotlin',
  kotlin: 'kotlin',
  sql: 'sql',
  postgres: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  json: 'json',
  jsonc: 'json',
};

const LANGUAGE_LABELS: Record<string, string> = {
  js: 'JS',
  javascript: 'JS',
  mjs: 'JS',
  cjs: 'JS',
  jsx: 'JSX',
  ts: 'TS',
  tsx: 'TSX',
  typescript: 'TS',
  py: 'PY',
  python: 'PY',
  bash: 'BASH',
  sh: 'SH',
  shell: 'BASH',
  zsh: 'ZSH',
  powershell: 'PS',
  go: 'GO',
  rust: 'RUST',
  rs: 'RUST',
  ruby: 'RUBY',
  rb: 'RB',
  php: 'PHP',
  java: 'JAVA',
  cs: 'C#',
  csharp: 'C#',
  dotnet: '.NET',
  cpp: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  cc: 'C++',
  c: 'C',
  swift: 'SWIFT',
  kt: 'KOTLIN',
  kotlin: 'KOTLIN',
  sql: 'SQL',
  postgres: 'SQL',
  mysql: 'SQL',
  sqlite: 'SQL',
  json: 'JSON',
  jsonc: 'JSON',
};

const IDENTIFIER_START_C = /[A-Za-z_$]/;
const IDENTIFIER_PART_C = /[A-Za-z0-9_$]/;
const IDENTIFIER_START_ALPHA = /[A-Za-z_]/;
const IDENTIFIER_PART_ALPHA = /[A-Za-z0-9_]/;
const IDENTIFIER_PART_SHELL = /[A-Za-z0-9_-]/;

const COMMON_C_KEYWORDS = [
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'switch',
  'case',
  'default',
  'for',
  'while',
  'do',
  'break',
  'continue',
  'class',
  'extends',
  'implements',
  'new',
  'this',
  'super',
  'try',
  'catch',
  'finally',
  'throw',
  'import',
  'from',
  'export',
  'await',
  'async',
  'yield',
  'static',
  'public',
  'private',
  'protected',
  'continue',
  'break',
  'typeof',
  'instanceof',
  'delete',
  'in',
  'of',
];

const TYPESCRIPT_KEYWORDS = ['namespace', 'abstract', 'readonly', 'declare', 'keyof', 'infer', 'satisfies'];
const JAVA_KEYWORDS = ['package', 'synchronized', 'volatile', 'transient', 'implements', 'extends', 'throws'];
const CSHARP_KEYWORDS = [
  'namespace',
  'async',
  'await',
  'var',
  'dynamic',
  'lock',
  'unsafe',
  'checked',
  'unchecked',
  'partial',
  'record',
  'ref',
  'when',
  'where',
];
const CPP_KEYWORDS = ['constexpr', 'typename', 'template', 'namespace', 'using', 'virtual', 'override', 'mutable', 'explicit', 'friend'];
const GO_KEYWORDS = [
  'package',
  'import',
  'var',
  'const',
  'func',
  'struct',
  'interface',
  'map',
  'chan',
  'go',
  'defer',
  'select',
  'range',
  'fallthrough',
  'type',
];
const RUST_KEYWORDS = [
  'fn',
  'let',
  'mut',
  'impl',
  'trait',
  'struct',
  'enum',
  'pub',
  'crate',
  'super',
  'use',
  'move',
  'match',
  'ref',
  'self',
  'where',
  'dyn',
  'async',
  'await',
  'unsafe',
  'extern',
  'type',
  'const',
  'static',
];
const PYTHON_KEYWORDS = [
  'def',
  'class',
  'return',
  'if',
  'elif',
  'else',
  'for',
  'while',
  'break',
  'continue',
  'pass',
  'import',
  'from',
  'as',
  'try',
  'except',
  'finally',
  'raise',
  'with',
  'lambda',
  'yield',
  'global',
  'nonlocal',
  'assert',
  'del',
  'and',
  'or',
  'not',
  'is',
  'in',
];
const SHELL_KEYWORDS = ['if', 'then', 'fi', 'elif', 'else', 'for', 'while', 'in', 'do', 'done', 'case', 'esac', 'function', 'select', 'until', 'time'];
const RUBY_KEYWORDS = [
  'def',
  'class',
  'module',
  'if',
  'elsif',
  'else',
  'end',
  'do',
  'while',
  'until',
  'begin',
  'rescue',
  'ensure',
  'case',
  'when',
  'yield',
  'return',
  'self',
  'super',
  'alias',
  'undef',
];
const PHP_KEYWORDS = [
  'function',
  'class',
  'interface',
  'trait',
  'if',
  'else',
  'elseif',
  'endif',
  'foreach',
  'endforeach',
  'while',
  'endwhile',
  'do',
  'switch',
  'endswitch',
  'case',
  'break',
  'continue',
  'public',
  'private',
  'protected',
  'static',
  'abstract',
  'final',
  'namespace',
  'use',
  'as',
  'return',
  'throw',
  'try',
  'catch',
  'finally',
  'yield',
];
const SQL_KEYWORDS = [
  'select',
  'from',
  'where',
  'insert',
  'into',
  'values',
  'update',
  'set',
  'delete',
  'create',
  'table',
  'drop',
  'alter',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'group',
  'by',
  'order',
  'limit',
  'offset',
  'having',
  'union',
  'on',
  'as',
  'and',
  'or',
  'not',
  'null',
  'is',
  'like',
  'in',
  'case',
  'when',
  'then',
  'end',
  'distinct',
  'exists',
  'between',
];

const COMMON_C_TYPES = ['string', 'number', 'boolean', 'any', 'never', 'void', 'null', 'undefined', 'Promise', 'Array', 'Record', 'Map', 'Set'];
const GO_TYPES = ['string', 'int', 'int64', 'int32', 'bool', 'error', 'byte', 'rune', 'float64', 'float32', 'map', 'chan', 'interface', 'struct'];
const RUST_TYPES = ['String', 'str', 'Vec', 'u8', 'u16', 'u32', 'u64', 'usize', 'i32', 'i64', 'Result', 'Option', 'Box'];
const PYTHON_TYPES = ['int', 'float', 'str', 'list', 'dict', 'set', 'tuple', 'bool', 'Any'];
const RUBY_TYPES = ['String', 'Array', 'Hash', 'Symbol', 'Integer', 'Float'];
const PHP_TYPES = ['string', 'int', 'float', 'bool', 'array', 'callable', 'iterable', 'object', 'mixed', 'void', 'never'];
const SQL_TYPES = ['int', 'integer', 'text', 'varchar', 'timestamp', 'date', 'json', 'boolean', 'serial', 'uuid'];

const JS_BUILTINS = ['console', 'process', 'Math', 'Date', 'Promise', 'JSON', 'setTimeout', 'setInterval'];
const PY_BUILTINS = ['print', 'len', 'range', 'list', 'dict', 'set', 'tuple', 'enumerate', 'zip', 'map', 'filter', 'sum'];
const SHELL_BUILTINS = ['echo', 'cd', 'alias', 'export', 'local', 'readonly', 'return', 'function', 'trap', 'printf', 'test'];
const GO_BUILTINS = ['make', 'len', 'cap', 'append', 'copy', 'panic', 'recover', 'new', 'print', 'println'];
const RUST_BUILTINS = ['println', 'format', 'vec', 'dbg'];
const RUBY_BUILTINS = ['puts', 'print', 'gets', 'attr_reader', 'attr_accessor', 'attr_writer'];
const PHP_BUILTINS = ['echo', 'print', 'isset', 'empty', 'array_merge', 'count'];

const JS_CONSTANTS = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'];
const PY_CONSTANTS = ['true', 'false', 'none'];
const SHELL_CONSTANTS = ['true', 'false'];
const GO_CONSTANTS = ['true', 'false', 'nil', 'iota'];
const RUST_CONSTANTS = ['true', 'false', 'none', 'some', 'ok', 'err'];
const RUBY_CONSTANTS = ['true', 'false', 'nil'];
const PHP_CONSTANTS = ['true', 'false', 'null'];
const SQL_CONSTANTS = ['true', 'false', 'null'];

const LANGUAGE_PROFILES: Partial<Record<HighlightLanguage, LanguageProfile>> = {
  javascript: createProfile({
    keywords: [...COMMON_C_KEYWORDS],
    types: COMMON_C_TYPES,
    builtins: JS_BUILTINS,
    constants: JS_CONSTANTS,
    commentIndicators: ['//', '/*'],
    stringDelimiters: ['"', "'", '`'],
    identifierStart: IDENTIFIER_START_C,
    identifierPart: IDENTIFIER_PART_C,
  }),
  typescript: createProfile({
    keywords: [...COMMON_C_KEYWORDS, ...TYPESCRIPT_KEYWORDS],
    types: [...COMMON_C_TYPES, 'readonly', 'Pick', 'Partial'],
    builtins: JS_BUILTINS,
    constants: JS_CONSTANTS,
    commentIndicators: ['//', '/*'],
    stringDelimiters: ['"', "'", '`'],
    identifierStart: IDENTIFIER_START_C,
    identifierPart: IDENTIFIER_PART_C,
    decoratorPrefix: true,
  }),
  python: createProfile({
    keywords: PYTHON_KEYWORDS,
    types: PYTHON_TYPES,
    builtins: PY_BUILTINS,
    constants: PY_CONSTANTS,
    commentIndicators: ['#'],
    stringDelimiters: ['"', "'"],
    identifierStart: IDENTIFIER_START_ALPHA,
    identifierPart: IDENTIFIER_PART_ALPHA,
    decoratorPrefix: true,
  }),
  shell: createProfile({
    keywords: SHELL_KEYWORDS,
    builtins: SHELL_BUILTINS,
    constants: SHELL_CONSTANTS,
    commentIndicators: ['#'],
    stringDelimiters: ['"', "'"],
    identifierStart: IDENTIFIER_START_ALPHA,
    identifierPart: IDENTIFIER_PART_SHELL,
    highlightVariables: true,
  }),
  go: createProfile({
    keywords: GO_KEYWORDS,
    types: GO_TYPES,
    builtins: GO_BUILTINS,
    constants: GO_CONSTANTS,
    commentIndicators: ['//', '/*'],
    stringDelimiters: ['"', "'", '`'],
    identifierStart: IDENTIFIER_START_ALPHA,
    identifierPart: IDENTIFIER_PART_ALPHA,
  }),
  rust: createProfile({
    keywords: RUST_KEYWORDS,
    types: RUST_TYPES,
    builtins: RUST_BUILTINS,
    constants: RUST_CONSTANTS,
    commentIndicators: ['//'],
    stringDelimiters: ['"', "'"],
    identifierStart: IDENTIFIER_START_C,
    identifierPart: IDENTIFIER_PART_C,
  }),
  ruby: createProfile({
    keywords: RUBY_KEYWORDS,
    types: RUBY_TYPES,
    builtins: RUBY_BUILTINS,
    constants: RUBY_CONSTANTS,
    commentIndicators: ['#'],
    stringDelimiters: ['"', "'"],
    identifierStart: IDENTIFIER_START_ALPHA,
    identifierPart: IDENTIFIER_PART_ALPHA,
  }),
  php: createProfile({
    keywords: PHP_KEYWORDS,
    types: PHP_TYPES,
    builtins: PHP_BUILTINS,
    constants: PHP_CONSTANTS,
    commentIndicators: ['//', '#'],
    stringDelimiters: ['"', "'"],
    identifierStart: IDENTIFIER_START_ALPHA,
    identifierPart: IDENTIFIER_PART_ALPHA,
    highlightVariables: true,
  }),
  java: createProfile({
    keywords: [...COMMON_C_KEYWORDS, ...JAVA_KEYWORDS],
    types: [...COMMON_C_TYPES, 'int', 'long', 'float', 'double', 'boolean', 'char', 'String'],
    builtins: ['System', 'String', 'List', 'Map', 'Set'],
    constants: JS_CONSTANTS,
    commentIndicators: ['//', '/*'],
    stringDelimiters: ['"', "'"],
    identifierStart: IDENTIFIER_START_C,
    identifierPart: IDENTIFIER_PART_C,
  }),
  csharp: createProfile({
    keywords: [...COMMON_C_KEYWORDS, ...CSHARP_KEYWORDS],
    types: [...COMMON_C_TYPES, 'int', 'long', 'float', 'double', 'bool', 'string', 'Task'],
    builtins: ['Console', 'IEnumerable', 'List', 'Dictionary'],
    constants: JS_CONSTANTS,
    commentIndicators: ['//', '/*'],
    stringDelimiters: ['"', "'"],
    identifierStart: IDENTIFIER_START_C,
    identifierPart: IDENTIFIER_PART_C,
    decoratorPrefix: true,
  }),
  cpp: createProfile({
    keywords: [...COMMON_C_KEYWORDS, ...CPP_KEYWORDS],
    types: [...COMMON_C_TYPES, 'int', 'long', 'float', 'double', 'bool', 'char', 'std'],
    builtins: ['std', 'cout', 'cin'],
    constants: JS_CONSTANTS,
    commentIndicators: ['//', '/*'],
    stringDelimiters: ['"', "'"],
    identifierStart: IDENTIFIER_START_C,
    identifierPart: IDENTIFIER_PART_C,
  }),
  c: createProfile({
    keywords: [...COMMON_C_KEYWORDS],
    types: ['int', 'long', 'float', 'double', 'bool', 'char', 'size_t', 'uint32_t', 'uint64_t'],
    builtins: ['printf', 'scanf'],
    constants: JS_CONSTANTS,
    commentIndicators: ['//', '/*'],
    stringDelimiters: ['"', "'"],
    identifierStart: IDENTIFIER_START_C,
    identifierPart: IDENTIFIER_PART_C,
  }),
  swift: createProfile({
    keywords: [...COMMON_C_KEYWORDS, 'struct', 'protocol', 'extension', 'guard', 'defer'],
    types: [...COMMON_C_TYPES, 'Int', 'Float', 'Double', 'String', 'Bool'],
    builtins: ['print'],
    constants: JS_CONSTANTS,
    commentIndicators: ['//', '/*'],
    stringDelimiters: ['"'],
    identifierStart: IDENTIFIER_START_C,
    identifierPart: IDENTIFIER_PART_C,
  }),
  kotlin: createProfile({
    keywords: [...COMMON_C_KEYWORDS, 'fun', 'val', 'var', 'object', 'sealed', 'data', 'companion'],
    types: [...COMMON_C_TYPES, 'Int', 'Long', 'Float', 'Double', 'String', 'Boolean'],
    builtins: ['println', 'print'],
    constants: JS_CONSTANTS,
    commentIndicators: ['//', '/*'],
    stringDelimiters: ['"'],
    identifierStart: IDENTIFIER_START_C,
    identifierPart: IDENTIFIER_PART_C,
  }),
  sql: createProfile({
    keywords: SQL_KEYWORDS,
    types: SQL_TYPES,
    constants: SQL_CONSTANTS,
    commentIndicators: ['--', '#'],
    stringDelimiters: ['"', "'"],
    identifierStart: IDENTIFIER_START_ALPHA,
    identifierPart: IDENTIFIER_PART_ALPHA,
  }),
};

export function highlightAndWrapCode(code: string, language: string | undefined, width: number): HighlightedCodeBlock {
  const normalized = normalizeLanguage(language);
  const profile = normalized?.id ? LANGUAGE_PROFILES[normalized.id] ?? null : null;
  const tokenizer = selectTokenizer(normalized?.id ?? null, profile);
  const available = Math.max(1, Number.isFinite(width) ? Math.floor(width) : 80);
  const sanitized = code.replace(/\t/g, '  ');
  const lines: string[] = [];

  for (const raw of sanitized.split('\n')) {
    const tokens = tokenizer(raw);
    const wrapped = wrapTokens(tokens, available);
    if (wrapped.length) {
      lines.push(...wrapped);
    } else {
      lines.push('');
    }
  }

  if (!lines.length) {
    lines.push('');
  }

  return {
    lines,
    languageLabel: normalized?.label ?? null,
  };
}

function normalizeLanguage(value?: string): NormalizedLanguage | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const key = trimmed.toLowerCase();
  const id = LANGUAGE_ALIASES[key] ?? null;
  const label = LANGUAGE_LABELS[key] ?? (id ? LANGUAGE_LABELS[id] : undefined) ?? trimmed.toUpperCase();
  return { id, label };
}

function selectTokenizer(language: HighlightLanguage | null, profile: LanguageProfile | null): Tokenizer {
  if (language === 'json') {
    return tokenizeJsonLine;
  }
  if (profile) {
    return tokenizeGenericLine(profile);
  }
  return (line) => (line.length ? [{ text: line }] : [{ text: '' }]);
}

function createProfile(config: {
  keywords: string[];
  types?: string[];
  builtins?: string[];
  constants?: string[];
  commentIndicators: string[];
  stringDelimiters: string[];
  identifierStart: RegExp;
  identifierPart: RegExp;
  decoratorPrefix?: boolean;
  highlightVariables?: boolean;
}): LanguageProfile {
  const profile: LanguageProfile = {
    keywords: toWordSet(config.keywords),
    commentIndicators: config.commentIndicators,
    stringDelimiters: config.stringDelimiters,
    identifierStart: config.identifierStart,
    identifierPart: config.identifierPart,
  };
  if (config.types) {
    profile.types = toWordSet(config.types);
  }
  if (config.builtins) {
    profile.builtins = toWordSet(config.builtins);
  }
  if (config.constants) {
    profile.constants = toWordSet(config.constants);
  }
  if (typeof config.decoratorPrefix === 'boolean') {
    profile.decoratorPrefix = config.decoratorPrefix;
  }
  if (typeof config.highlightVariables === 'boolean') {
    profile.highlightVariables = config.highlightVariables;
  }
  return profile;
}

function toWordSet(values: string[]): ReadonlySet<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

function tokenizeGenericLine(profile: LanguageProfile): Tokenizer {
  const commentIndicators = [...profile.commentIndicators].sort((a, b) => b.length - a.length);
  return (line: string): Token[] => {
    if (!line.length) {
      return [{ text: '' }];
    }

    const tokens: Token[] = [];
    let index = 0;

    const push = (text: string, formatter?: Formatter) => {
      if (!text) {
        return;
      }
      tokens.push(formatter ? { text, formatter } : { text });
    };

    while (index < line.length) {
      const rest = line.slice(index);

      const comment = commentIndicators.find((indicator) => rest.startsWith(indicator));
      if (comment) {
        push(line.slice(index), theme.ui.muted);
        break;
      }

      const char = line.charAt(index);

      if (/\s/.test(char)) {
        const start = index;
        while (index < line.length && /\s/.test(line.charAt(index))) {
          index += 1;
        }
        push(line.slice(start, index));
        continue;
      }

      if (profile.highlightVariables && char === '$') {
        const span = readVariable(line, index, profile);
        push(span.text, theme.accent);
        index = span.next;
        continue;
      }

      if (profile.decoratorPrefix && char === '@') {
        const decorator = readIdentifier(line, index + 1, profile);
        push(`@${decorator.text}`, theme.accent);
        index = decorator.next;
        continue;
      }

      if (profile.stringDelimiters.includes(char)) {
        const literal = readString(line, index, char);
        push(literal.text, theme.secondary);
        index = literal.next;
        continue;
      }

      if (isNumberStart(line, index)) {
        const numberToken = readNumber(line, index);
        push(numberToken.text, theme.accent);
        index = numberToken.next;
        continue;
      }

      if (profile.identifierStart.test(char)) {
        const identifier = readIdentifier(line, index, profile);
        const formatter = pickIdentifierFormatter(identifier.text, profile);
        push(identifier.text, formatter);
        index = identifier.next;
        continue;
      }

      push(char);
      index += 1;
    }

    return tokens.length ? tokens : [{ text: '' }];
  };
}

function tokenizeJsonLine(line: string): Token[] {
  if (!line.length) {
    return [{ text: '' }];
  }

  const tokens: Token[] = [];
  let index = 0;

  const push = (text: string, formatter?: Formatter) => {
    if (!text) {
      return;
    }
    tokens.push(formatter ? { text, formatter } : { text });
  };

  while (index < line.length) {
    const char = line.charAt(index);

    if (/\s/.test(char)) {
      const start = index;
      while (index < line.length && /\s/.test(line.charAt(index))) {
        index += 1;
      }
      push(line.slice(start, index));
      continue;
    }

    if (char === '"') {
      const literal = readString(line, index, '"');
      const isKey = isJsonKey(line, literal.next);
      push(literal.text, isKey ? theme.primary : theme.secondary);
      index = literal.next;
      continue;
    }

    if (char === '-' || /\d/.test(char)) {
      const numberToken = readNumber(line, index);
      push(numberToken.text, theme.accent);
      index = numberToken.next;
      continue;
    }

    const remaining = line.slice(index).toLowerCase();
    if (remaining.startsWith('true') || remaining.startsWith('false')) {
      const literal = remaining.startsWith('true') ? 'true' : 'false';
      push(line.slice(index, index + literal.length), theme.warning);
      index += literal.length;
      continue;
    }
    if (remaining.startsWith('null')) {
      push('null', theme.warning);
      index += 4;
      continue;
    }

    push(char);
    index += 1;
  }

  return tokens.length ? tokens : [{ text: '' }];
}

function isJsonKey(line: string, index: number): boolean {
  for (let cursor = index; cursor < line.length; cursor += 1) {
    const char = line.charAt(cursor);
    if (char === ':') {
      return true;
    }
    if (!/\s/.test(char)) {
      return false;
    }
  }
  return false;
}

function wrapTokens(tokens: Token[], width: number): string[] {
  const lines: string[] = [];
  let current = '';
  let used = 0;

  const flush = () => {
    lines.push(current);
    current = '';
    used = 0;
  };

  for (const token of tokens) {
    const formatter = token.formatter ?? identity;
    let remaining = token.text;

    if (!remaining) {
      continue;
    }

    while (remaining.length) {
      const available = Math.max(1, width - used);
      if (available <= 0) {
        flush();
        continue;
      }

      if (remaining.length <= available) {
        current += formatter(remaining);
        used += remaining.length;
        remaining = '';
      } else {
        const slice = remaining.slice(0, available);
        current += formatter(slice);
        used += slice.length;
        remaining = remaining.slice(available);
        flush();
      }
    }
  }

  if (current) {
    flush();
  }

  if (!lines.length) {
    lines.push('');
  }

  return lines;
}

function pickIdentifierFormatter(value: string, profile: LanguageProfile): Formatter | undefined {
  const lower = value.toLowerCase();
  if (profile.keywords.has(lower)) {
    return theme.primary;
  }
  if (profile.constants?.has(lower)) {
    return theme.warning;
  }
  if (profile.types?.has(lower)) {
    return theme.accent;
  }
  if (profile.builtins?.has(lower)) {
    return theme.secondary;
  }
  return undefined;
}

function readString(line: string, start: number, delimiter: string): { text: string; next: number } {
  let index = start + 1;
  while (index < line.length) {
    const char = line.charAt(index);
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === delimiter) {
      index += 1;
      break;
    }
    index += 1;
  }
  return { text: line.slice(start, index), next: index };
}

function readNumber(line: string, start: number): { text: string; next: number } {
  let index = start;

  if (line.charAt(index) === '-' || line.charAt(index) === '+') {
    index += 1;
  }

  if (line.slice(index, index + 2).toLowerCase() === '0x') {
    index += 2;
    while (/[0-9a-fA-F_]/.test(line.charAt(index))) {
      index += 1;
    }
    return { text: line.slice(start, index), next: index };
  }

  while (/[0-9_]/.test(line.charAt(index))) {
    index += 1;
  }

  if (line.charAt(index) === '.' && /[0-9]/.test(line.charAt(index + 1))) {
    index += 1;
    while (/[0-9_]/.test(line.charAt(index))) {
      index += 1;
    }
  }

  if ((line.charAt(index) === 'e' || line.charAt(index) === 'E') && /[+\-0-9]/.test(line.charAt(index + 1))) {
    index += 1;
    if (line.charAt(index) === '+' || line.charAt(index) === '-') {
      index += 1;
    }
    while (/[0-9]/.test(line.charAt(index))) {
      index += 1;
    }
  }

  return { text: line.slice(start, index), next: index };
}

function isNumberStart(line: string, index: number): boolean {
  const char = line.charAt(index);
  if (char === '-' || char === '+') {
    return /[0-9]/.test(line.charAt(index + 1));
  }
  return /[0-9]/.test(char);
}

function readIdentifier(line: string, start: number, profile: LanguageProfile): { text: string; next: number } {
  let index = start;
  if (!profile.identifierStart.test(line.charAt(index))) {
    return { text: line.charAt(start), next: start + 1 };
  }
  index += 1;
  while (index < line.length && profile.identifierPart.test(line.charAt(index))) {
    index += 1;
  }
  return { text: line.slice(start, index), next: index };
}

function readVariable(line: string, start: number, profile: LanguageProfile): { text: string; next: number } {
  if (line.charAt(start + 1) === '{') {
    let index = start + 2;
    while (index < line.length && line.charAt(index) !== '}') {
      index += 1;
    }
    if (line.charAt(index) === '}') {
      index += 1;
    }
    return { text: line.slice(start, index), next: index };
  }

  let index = start + 1;
  while (index < line.length && profile.identifierPart.test(line.charAt(index))) {
    index += 1;
  }
  return { text: line.slice(start, index), next: index };
}
