/**
 * Vigil Ink Color System — Centralized Theme Tokens
 *
 * Single source of truth for ALL terminal colors. 10 built-in themes
 * with 16 semantic tokens each. Hot-swappable — applyTheme() mutates
 * the live object; Ink components read from it at render time so the
 * entire UI re-skins without reload. No hardcoded hex values anywhere.
 *
 * Design contract: Unicode box-drawing glyphs only — no emoji in chrome.
 * Glyphs defined in glyphs.ts, imported here for theme-aware rendering.
 *
 * Ported from erosolar-coder's color architecture. Adapted for Vigil.
 */

export interface ThemeColors {
  readonly name: string;
  bgDeep: string;
  bg: string;
  panel: string;
  border: string;
  accent: string;
  accentSoft: string;
  text: string;
  textProse: string;
  textDim: string;
  textBright: string;
  ok: string;
  warn: string;
  err: string;
  info: string;
  infoDim: string;
  accentAlt: string;
}

const THEMES: Record<string, ThemeColors> = {
  'space-black': {
    name: 'Space Black',
    bgDeep: '#0a0d14',
    bg: '#111622',
    panel: '#1a1f2e',
    border: '#2a2f3e',
    accent: '#e07b3c',
    accentSoft: '#cc6a30',
    text: '#c8cdd4',
    textProse: '#b0b8c0',
    textDim: '#8B95A5',
    textBright: '#e8edf2',
    ok: '#3fcf8e',
    warn: '#f0c040',
    err: '#ff5c5c',
    info: '#5ccfe6',
    infoDim: '#3a8fa0',
    accentAlt: '#d4bfff',
  },
  'vigil-gold': {
    name: 'Vigil Gold',
    bgDeep: '#0f0d0a',
    bg: '#1a1510',
    panel: '#241e16',
    border: '#3a3020',
    accent: '#d4a843',
    accentSoft: '#bf9538',
    text: '#c8c0b0',
    textProse: '#b0a898',
    textDim: '#9A9088',
    textBright: '#e8dcc0',
    ok: '#3fcf8e',
    warn: '#f0c040',
    err: '#ff5c5c',
    info: '#5ccfe6',
    infoDim: '#3a8fa0',
    accentAlt: '#d4bfff',
  },
  'dracula': {
    name: 'Dracula',
    bgDeep: '#1e1f29',
    bg: '#282a36',
    panel: '#343746',
    border: '#44475a',
    accent: '#ff79c6',
    accentSoft: '#e06c90',
    text: '#f8f8f2',
    textProse: '#e0e0d8',
    textDim: '#8B95CC',
    textBright: '#ffffff',
    ok: '#50fa7b',
    warn: '#f1fa8c',
    err: '#ff5555',
    info: '#8be9fd',
    infoDim: '#5ab0c8',
    accentAlt: '#bd93f9',
  },
  'nord': {
    name: 'Nord',
    bgDeep: '#242933',
    bg: '#2e3440',
    panel: '#3b4252',
    border: '#434c5e',
    accent: '#88c0d0',
    accentSoft: '#6fa8b8',
    text: '#d8dee9',
    textProse: '#c0c8d4',
    textDim: '#8B95A5',
    textBright: '#eceff4',
    ok: '#a3be8c',
    warn: '#ebcb8b',
    err: '#bf616a',
    info: '#81a1c1',
    infoDim: '#5a7a96',
    accentAlt: '#b48ead',
  },
  'tokyo-night': {
    name: 'Tokyo Night',
    bgDeep: '#1a1b26',
    bg: '#1f2335',
    panel: '#292e42',
    border: '#3b4261',
    accent: '#7aa2f7',
    accentSoft: '#5d8ae0',
    text: '#c0caf5',
    textProse: '#a9b1d6',
    textDim: '#8B95CC',
    textBright: '#e0e5ff',
    ok: '#9ece6a',
    warn: '#e0af68',
    err: '#f7768e',
    info: '#7dcfff',
    infoDim: '#5aa0c8',
    accentAlt: '#bb9af7',
  },
  'catppuccin': {
    name: 'Catppuccin Mocha',
    bgDeep: '#11111b',
    bg: '#1e1e2e',
    panel: '#313244',
    border: '#45475a',
    accent: '#cba6f7',
    accentSoft: '#b395e0',
    text: '#cdd6f4',
    textProse: '#bac2de',
    textDim: '#949AAD',
    textBright: '#e6e9f0',
    ok: '#a6e3a1',
    warn: '#f9e2af',
    err: '#f38ba8',
    info: '#89b4fa',
    infoDim: '#5a80c8',
    accentAlt: '#f5c2e7',
  },
  'gruvbox': {
    name: 'Gruvbox Dark',
    bgDeep: '#1d2021',
    bg: '#282828',
    panel: '#3c3836',
    border: '#504945',
    accent: '#fe8019',
    accentSoft: '#e07010',
    text: '#ebdbb2',
    textProse: '#d5c4a1',
    textDim: '#A09588',
    textBright: '#fbf1c7',
    ok: '#b8bb26',
    warn: '#fabd2f',
    err: '#fb4934',
    info: '#83a598',
    infoDim: '#5a7a70',
    accentAlt: '#d3869b',
  },
  'solarized': {
    name: 'Solarized Dark',
    bgDeep: '#001e26',
    bg: '#002b36',
    panel: '#073642',
    border: '#586e75',
    accent: '#268bd2',
    accentSoft: '#1a70b0',
    text: '#839496',
    textProse: '#708284',
    textDim: '#8A9699',
    textBright: '#93a1a1',
    ok: '#859900',
    warn: '#b58900',
    err: '#dc322f',
    info: '#2aa198',
    infoDim: '#1a7a70',
    accentAlt: '#6c71c4',
  },
  'one-dark': {
    name: 'One Dark',
    bgDeep: '#1e2127',
    bg: '#282c34',
    panel: '#353b45',
    border: '#4b5363',
    accent: '#61afef',
    accentSoft: '#4a90d0',
    text: '#abb2bf',
    textProse: '#98a0ad',
    textDim: '#8B95A5',
    textBright: '#c8ccd4',
    ok: '#98c379',
    warn: '#e5c07b',
    err: '#e06c75',
    info: '#56b6c2',
    infoDim: '#3a8a96',
    accentAlt: '#c678dd',
  },
  'rose-pine': {
    name: 'Rose Pine',
    bgDeep: '#191724',
    bg: '#1f1d2e',
    panel: '#26233a',
    border: '#403d52',
    accent: '#ebbcba',
    accentSoft: '#d4a0a0',
    text: '#e0def4',
    textProse: '#c8c4e0',
    textDim: '#9A95B5',
    textBright: '#f0ecff',
    ok: '#31748f',
    warn: '#f6c177',
    err: '#eb6f92',
    info: '#9ccfd8',
    infoDim: '#6a9aa8',
    accentAlt: '#c4a7e7',
  },
};

const DEFAULT_THEME = 'space-black';

let _current = THEMES[DEFAULT_THEME]!;

export function getColors(): Readonly<ThemeColors> {
  return _current;
}

export function applyTheme(name: string): ThemeColors {
  const theme = THEMES[name];
  if (!theme) return _current;
  Object.assign(_current, theme);
  return _current;
}

export function listThemes(): string[] {
  return Object.keys(THEMES);
}

export function getTheme(name: string): ThemeColors | undefined {
  return THEMES[name];
}

// Re-export for convenience — components import `colors` as the live object
export const colors = _current;

// Initialize
export function resetToDefault(): void {
  const def = THEMES[DEFAULT_THEME]!;
  Object.assign(_current, def);
}
