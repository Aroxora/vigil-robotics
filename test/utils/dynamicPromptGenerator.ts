// Stub for dynamic prompt generator utilities used by long-horizon tests.
export function uniqueId(): string {
  return `stub-${Math.random().toString(36).slice(2, 10)}`;
}
export function uniqueCveTarget(): string {
  const year = 2020 + Math.floor(Math.random() * 7);
  return `CVE-${year}-${String(10000 + Math.floor(Math.random() * 90000)).slice(0, 5)}`;
}
export function uniqueService(): string {
  const svc = ['nginx', 'apache', 'redis', 'postgres', 'mysql', 'ssh', 'http', 'dns'];
  return svc[Math.floor(Math.random() * svc.length)];
}
export function uniquePort(): number {
  return 1024 + Math.floor(Math.random() * 60000);
}
export function uniqueTool(): string {
  const t = ['crucible', 'forge', 'chimera', 'aegis', 'oculus', 'lattice', 'glasshouse'];
  return t[Math.floor(Math.random() * t.length)];
}
export function generateCnePrompt(): string {
  return `stub-cne-prompt-${uniqueId()}-${uniqueId()}-${uniqueId()}-with-extra-padding-to-exceed-fifty-chars`;
}
export function generateCodingPrompt(): string {
  return `stub-coding-prompt-${uniqueId()}-${uniqueId()}-${uniqueId()}-with-extra-padding-to-exceed-fifty-chars`;
}
export function generateUniquePrompts(count: number): string[] {
  return Array.from({ length: count }, () => `stub-prompt-${uniqueId()}`);
}
export function generateUniqueIds(count: number): string[] {
  return Array.from({ length: count }, () => uniqueId());
}
export function resolveApiKey(): string | null {
  return null;
}
export async function deepseekChat(prompt: string): Promise<string> {
  return `stub: ${prompt.slice(0, 20)}`;
}
export async function runParallelPrompts(prompts: string[]): Promise<string[]> {
  return prompts.map(p => `stub: ${p.slice(0, 20)}`);
}