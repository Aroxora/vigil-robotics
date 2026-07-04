/**
 * Local Explore - Minimal stub for backward compatibility
 */

export type AIEnhancer = (prompt: string) => Promise<string>;

let _globalAIEnhancer: AIEnhancer | null = null;

export function setGlobalAIEnhancer(enhancer: AIEnhancer | null): void {
  _globalAIEnhancer = enhancer;
}

export function getGlobalAIEnhancer(): AIEnhancer | null {
  return _globalAIEnhancer;
}

export interface CodebaseIndex {
  version: number;
  createdAt: string;
  rootDir: string;
  hash: string;
  files: IndexedFile[];
  symbols: SymbolIndex;
  imports: ImportGraph;
  patterns: DetectedPatterns;
}

export interface IndexedFile {
  path: string;
  hash: string;
  lastModified: number;
}

export interface SymbolIndex {
  functions: Map<string, string[]>;
  classes: Map<string, string[]>;
  exports: Map<string, string[]>;
}

export interface ImportGraph {
  nodes: string[];
  edges: [string, string][];
}

export interface DetectedPatterns {
  frameworks: string[];
  testFrameworks: string[];
  buildTools: string[];
}

export async function buildCodebaseIndex(_rootDir: string): Promise<CodebaseIndex> {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    rootDir: _rootDir,
    hash: '',
    files: [],
    symbols: {
      functions: new Map(),
      classes: new Map(),
      exports: new Map(),
    },
    imports: { nodes: [], edges: [] },
    patterns: { frameworks: [], testFrameworks: [], buildTools: [] },
  };
}

export async function searchIndex(
  _index: CodebaseIndex,
  _query: string
): Promise<string[]> {
  return [];
}
