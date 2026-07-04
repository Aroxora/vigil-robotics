import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ArtifactMetadata {
  id: string;
  size: number;
  mimeType?: string;
  source?: string;
  tags?: string[];
  createdAt: string;
  description?: string;
}

export interface ArtifactPutResult {
  id: string;
  size: number;
  summary: string;
}

/**
 * Context bound by the CLI bootstrap so every artifact write carries
 * the active profile + CLI version into the transparency log. Kept
 * module-local so the ArtifactStore class stays decoupled from
 * auth/profile state.
 */
interface ArtifactLogContext {
  profile?: string;
  cliVersion?: string;
  /** Set to false to disable the transparency log (tests, --self-test). */
  enabled: boolean;
}

let logContext: ArtifactLogContext = { enabled: true };

export function setArtifactLogContext(ctx: Partial<Omit<ArtifactLogContext, 'enabled'>> & { enabled?: boolean }): void {
  logContext = { ...logContext, ...ctx };
}

const DEFAULT_ROOT = join(homedir(), '.vigil', 'artifacts');
const INDEX_FILE = 'index.json';

export class ArtifactStore {
  private readonly root: string;
  private indexCache: Record<string, ArtifactMetadata> | null = null;

  constructor(root: string = DEFAULT_ROOT) {
    this.root = root;
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true });
    }
  }

  put(content: string | Buffer, meta: Partial<ArtifactMetadata> = {}): ArtifactPutResult {
    const buf = typeof content === 'string' ? Buffer.from(content) : content;
    const id = createHash('sha256').update(buf).digest('hex');
    const blobPath = this.blobPath(id);
    if (!existsSync(blobPath)) {
      mkdirSync(dirname(blobPath), { recursive: true });
      writeFileSync(blobPath, buf);
    }
    const record: ArtifactMetadata = {
      id,
      size: buf.length,
      createdAt: new Date().toISOString(),
    };
    if (meta.mimeType !== undefined) record.mimeType = meta.mimeType;
    if (meta.source !== undefined) record.source = meta.source;
    if (meta.tags !== undefined) record.tags = meta.tags;
    if (meta.description !== undefined) record.description = meta.description;
    this.writeMeta(record);
    return { id, size: buf.length, summary: this.buildSummary(record, buf) };
  }

  get(id: string): Buffer {
    const blobPath = this.blobPath(id);
    if (!existsSync(blobPath)) throw new Error(`Artifact not found: ${id}`);
    return readFileSync(blobPath);
  }

  getString(id: string): string {
    return this.get(id).toString();
  }

  has(id: string): boolean {
    return existsSync(this.blobPath(id));
  }

  meta(id: string): ArtifactMetadata | null {
    return this.loadIndex()[id] ?? null;
  }

  list(filter?: { source?: string; tag?: string }): ArtifactMetadata[] {
    let out = Object.values(this.loadIndex());
    if (filter?.source) out = out.filter((a) => a.source === filter.source);
    if (filter?.tag) out = out.filter((a) => a.tags?.includes(filter.tag!));
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private blobPath(id: string): string {
    return join(this.root, id.slice(0, 2), id);
  }

  private indexPath(): string {
    return join(this.root, INDEX_FILE);
  }

  private loadIndex(): Record<string, ArtifactMetadata> {
    if (this.indexCache) return this.indexCache;
    const p = this.indexPath();
    if (!existsSync(p)) {
      this.indexCache = {};
      return this.indexCache;
    }
    try {
      this.indexCache = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      this.indexCache = {};
    }
    return this.indexCache!;
  }

  private writeMeta(record: ArtifactMetadata): void {
    const idx = this.loadIndex();
    idx[record.id] = record;
    writeFileSync(this.indexPath(), JSON.stringify(idx, null, 2), 'utf8');
  }

  private buildSummary(record: ArtifactMetadata, buf: Buffer): string {
    const head = buf.length > 200
      ? buf.subarray(0, 200).toString().replace(/\n/g, ' ') + '…'
      : buf.toString();
    const tags = record.tags?.length ? ` tags=${record.tags.join(',')}` : '';
    const source = record.source ? ` source=${record.source}` : '';
    return `artifact id=${record.id.slice(0, 12)}… size=${record.size}B${source}${tags} preview=${head}`;
  }
}

let shared: ArtifactStore | null = null;

export function getSharedArtifactStore(): ArtifactStore {
  if (!shared) shared = new ArtifactStore();
  return shared;
}
