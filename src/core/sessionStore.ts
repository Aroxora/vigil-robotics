import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ConversationMessage, ProviderId } from './types.js';
import type { ProfileName } from '../config.js';

const dataRoot =
  process.env['VIGIL_DATA_DIR']?.trim() ||
  process.env['VIGIL_DATA_DIR']?.trim() ||
  join(homedir(), '.vigil');
const sessionsDir = join(dataRoot, 'sessions');
const indexPath = join(sessionsDir, 'index.json');

export interface SessionSummary {
  id: string;
  title: string;
  profile: ProfileName;
  provider: ProviderId;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  workspaceRoot?: string;
}

export interface StoredSession extends SessionSummary {
  messages: ConversationMessage[];
  scrollbackBuffer?: string[]; // Optional scrollback history
}

export interface SaveSessionOptions {
  id?: string | null;
  title?: string | null;
  profile: ProfileName;
  provider: ProviderId;
  model: string;
  workspaceRoot?: string | null;
  messages: ConversationMessage[];
  scrollbackBuffer?: string[]; // Optional scrollback history
}

interface SessionIndex {
  entries: Record<string, SessionSummary>;
}

export function listSessions(profile?: ProfileName): SessionSummary[] {
  const index = readIndex();
  const entries = Object.values(index.entries);
  const filtered = profile ? entries.filter((entry) => entry.profile === profile) : entries;
  return filtered.sort((a, b) => {
    const aTime = Date.parse(a.updatedAt ?? '') || 0;
    const bTime = Date.parse(b.updatedAt ?? '') || 0;
    return bTime - aTime;
  });
}

export function saveSessionSnapshot(options: SaveSessionOptions): SessionSummary {
  ensureDirectory();
  if (!Array.isArray(options.messages)) {
    throw new Error('Session snapshots must include the entire message history array.');
  }

  const index = readIndex();
  const now = new Date().toISOString();
  const existingId = options.id ?? null;
  const summaryId =
    existingId && index.entries[existingId] ? existingId : randomUUID();
  const previous = index.entries[summaryId];

  const summary: SessionSummary = {
    id: summaryId,
    title: sanitizeTitle(options.title) ?? previous?.title ?? buildDefaultTitle(options.messages),
    profile: options.profile,
    provider: options.provider,
    model: options.model,
    workspaceRoot: options.workspaceRoot ?? previous?.workspaceRoot ?? undefined,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    messageCount: options.messages.length,
  };

  const payload: StoredSession = {
    ...summary,
    messages: options.messages,
    ...(options.scrollbackBuffer && { scrollbackBuffer: options.scrollbackBuffer }),
  };

  writeFileSync(getSessionPath(summaryId), JSON.stringify(payload, null, 2), 'utf8');
  index.entries[summaryId] = summary;
  writeIndex(index);
  return summary;
}

export function loadSessionById(id: string): StoredSession | null {
  if (!id) {
    return null;
  }
  try {
    const raw = readFileSync(getSessionPath(id), 'utf8');
    const parsed = JSON.parse(raw) as StoredSession;
    return parsed;
  } catch {
    return null;
  }
}

export function deleteSession(id: string): boolean {
  if (!id) {
    return false;
  }
  const index = readIndex();
  if (!index.entries[id]) {
    return false;
  }
  try {
    rmSync(getSessionPath(id), { force: true });
  } catch {
    // ignore
  }
  delete index.entries[id];
  writeIndex(index);
  return true;
}

export function saveAutosaveSnapshot(
  profile: ProfileName,
  options: Omit<SaveSessionOptions, 'profile'>
): void {
  ensureDirectory();
  const payload: StoredSession = {
    id: `autosave-${profile}`,
    profile,
    provider: options.provider,
    model: options.model,
    workspaceRoot: options.workspaceRoot ?? undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: sanitizeTitle(options.title) ?? buildDefaultTitle(options.messages),
    messageCount: options.messages.length,
    messages: options.messages,
  };
  writeFileSync(getAutosavePath(profile), JSON.stringify(payload, null, 2), 'utf8');
}

export function loadAutosaveSnapshot(profile: ProfileName): StoredSession | null {
  try {
    const raw = readFileSync(getAutosavePath(profile), 'utf8');
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export function clearAutosaveSnapshot(profile: ProfileName): void {
  try {
    rmSync(getAutosavePath(profile), { force: true });
  } catch {
    // ignore
  }
}

function readIndex(): SessionIndex {
  ensureDirectory();
  try {
    const raw = readFileSync(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as SessionIndex;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object') {
      return { entries: {} };
    }
    return { entries: { ...parsed.entries } };
  } catch {
    return { entries: {} };
  }
}

function writeIndex(index: SessionIndex): void {
  ensureDirectory();
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
}

function ensureDirectory(): void {
  mkdirSync(sessionsDir, { recursive: true });
}

function getSessionPath(id: string): string {
  return join(sessionsDir, `${id}.json`);
}

function getAutosavePath(profile: ProfileName): string {
  return join(sessionsDir, `${profile}-autosave.json`);
}

function sanitizeTitle(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, 160);
}

function buildDefaultTitle(messages: ConversationMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const condensed = message.content.trim().replace(/\s+/g, ' ');
    if (condensed) {
      return condensed.slice(0, 160);
    }
  }
  return `Session ${new Date().toLocaleString()}`;
}

function pruneOrphans(): void {
  try {
    ensureDirectory();
    const index = readIndex();
    const known = new Set(Object.keys(index.entries));
    for (const file of readdirSync(sessionsDir)) {
      if (!file.endsWith('.json')) {
        continue;
      }
      if (file === 'index.json' || file.includes('-autosave')) {
        continue;
      }
      const id = file.slice(0, -5);
      if (!known.has(id)) {
        const candidate = join(sessionsDir, file);
        const stats = statSync(candidate);
        if (stats.isFile()) {
          rmSync(candidate, { force: true });
        }
      }
    }
  } catch {
    // best-effort cleanup
  }
}

pruneOrphans();
