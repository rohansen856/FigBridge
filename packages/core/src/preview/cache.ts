import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ErrorCode } from '../diagnostics.js';
import type { NodeId } from '../figma-url.js';

export const CACHE_INDEX_VERSION = 1;

export type StaleReason = 'ttl' | 'claude-event' | 'version-changed' | 'manual';

export interface PreviewKeyParts {
  apiKey: string;
  nodeId: NodeId;
  format: 'png' | 'jpg';
  scale: number;
}

export interface PreviewEntry extends PreviewKeyParts {
  key: string;
  /** File name inside the cache directory. */
  fileName: string;
  bytes: number;
  width: number;
  height: number;
  fetchedAt: number;
  validatedAt: number;
  lastUsedAt: number;
  /** Figma file `version` observed when the image was rendered. */
  versionFingerprint?: string;
  stale?: StaleReason;
}

export interface FailureEntry extends PreviewKeyParts {
  key: string;
  code: ErrorCode;
  message: string;
  failedAt: number;
  /** Don't retry automatically before this time. */
  retryAfter: number;
}

interface CacheIndexFile {
  v: number;
  entries: PreviewEntry[];
}

export function previewKey(p: PreviewKeyParts): string {
  return createHash('sha256').update(`${p.apiKey}|${p.nodeId}|${p.format}|${p.scale}`).digest('hex').slice(0, 32);
}

/** Reads width/height from PNG IHDR or JPEG SOF headers; undefined for anything else. */
export function imageSize(bytes: Uint8Array): { width: number; height: number; mime: 'image/png' | 'image/jpeg' } | undefined {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && dv.getUint32(0) === 0x89504e47 && dv.getUint32(4) === 0x0d0a1a0a)
    return { width: dv.getUint32(16), height: dv.getUint32(20), mime: 'image/png' };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return undefined;
      const marker = bytes[i + 1]!;
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7), mime: 'image/jpeg' };
      i += 2 + len;
    }
  }
  return undefined;
}

export interface PreviewCacheOptions {
  dir: string;
  maxTotalBytes?: number;
  /** When false, images live in memory only (sensitive workspaces). */
  persist?: boolean;
  now?: () => number;
}

/**
 * Local image cache. Files are written atomically (temp + rename); the JSON index is rebuilt
 * from scratch if missing or corrupt. Nothing here holds a token or a signed URL.
 */
export class PreviewCache {
  private readonly entries = new Map<string, PreviewEntry>();
  private readonly memory = new Map<string, Uint8Array>();
  private readonly failures = new Map<string, FailureEntry>();
  private readonly maxTotalBytes: number;
  private readonly persist: boolean;
  private readonly now: () => number;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: PreviewCacheOptions) {
    this.maxTotalBytes = options.maxTotalBytes ?? 250 * 1024 * 1024;
    this.persist = options.persist ?? true;
    this.now = options.now ?? Date.now;
  }

  get dir(): string {
    return this.options.dir;
  }

  async load(): Promise<void> {
    if (!this.persist) return;
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(join(this.options.dir, 'cache-v1.json'), 'utf8')) as CacheIndexFile;
      if (parsed.v !== CACHE_INDEX_VERSION || !Array.isArray(parsed.entries)) return;
      for (const e of parsed.entries)
        if (typeof e.key === 'string' && /^[0-9a-f]{32}\.(png|jpg)$/.test(e.fileName) && existsSync(join(this.options.dir, e.fileName)))
          this.entries.set(e.key, e);
    } catch {
      /* missing or corrupt index: start empty; orphaned files are overwritten or cleared later */
    }
  }

  get(parts: PreviewKeyParts): PreviewEntry | undefined {
    const e = this.entries.get(previewKey(parts));
    if (e) {
      e.lastUsedAt = this.now();
      this.scheduleSave();
    }
    return e;
  }

  failure(parts: PreviewKeyParts): FailureEntry | undefined {
    const f = this.failures.get(previewKey(parts));
    return f && f.retryAfter > this.now() ? f : undefined;
  }

  /** Absolute path of the image file (persisted caches only). */
  pathOf(entry: PreviewEntry): string {
    return join(this.options.dir, entry.fileName);
  }

  async read(entry: PreviewEntry): Promise<Uint8Array | undefined> {
    if (!this.persist) return this.memory.get(entry.key);
    try {
      return new Uint8Array(await readFile(this.pathOf(entry)));
    } catch {
      this.entries.delete(entry.key);
      return undefined;
    }
  }

  async put(parts: PreviewKeyParts, bytes: Uint8Array, versionFingerprint?: string): Promise<PreviewEntry | undefined> {
    const size = imageSize(bytes);
    if (!size) return undefined;
    const key = previewKey(parts);
    const fileName = `${key}.${size.mime === 'image/png' ? 'png' : 'jpg'}`;
    const t = this.now();
    if (this.persist) {
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
      const tmp = join(this.options.dir, `.${randomUUID()}.tmp`);
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, join(this.options.dir, fileName));
    } else this.memory.set(key, bytes);
    const entry: PreviewEntry = {
      ...parts,
      key,
      fileName,
      bytes: bytes.byteLength,
      width: size.width,
      height: size.height,
      fetchedAt: t,
      validatedAt: t,
      lastUsedAt: t,
      ...(versionFingerprint ? { versionFingerprint } : {}),
    };
    this.entries.set(key, entry);
    this.failures.delete(key);
    await this.evict();
    this.scheduleSave();
    return entry;
  }

  recordFailure(parts: PreviewKeyParts, code: ErrorCode, message: string, retryAfterMs: number): void {
    const key = previewKey(parts);
    this.failures.set(key, { ...parts, key, code, message, failedAt: this.now(), retryAfter: this.now() + retryAfterMs });
  }

  clearFailure(parts: PreviewKeyParts): void {
    this.failures.delete(previewKey(parts));
  }

  touchValidated(entry: PreviewEntry, versionFingerprint?: string): void {
    entry.validatedAt = this.now();
    delete entry.stale;
    if (versionFingerprint) entry.versionFingerprint = versionFingerprint;
    this.scheduleSave();
  }

  /** Marks matching entries stale; returns how many changed. */
  markStale(predicate: (e: PreviewEntry) => boolean, reason: StaleReason): number {
    let n = 0;
    for (const e of this.entries.values())
      if (predicate(e) && e.stale !== reason) {
        e.stale = reason;
        n++;
      }
    for (const f of this.failures.values()) if (predicate(f as unknown as PreviewEntry)) this.failures.delete(f.key);
    if (n) this.scheduleSave();
    return n;
  }

  all(): PreviewEntry[] {
    return [...this.entries.values()];
  }

  totalBytes(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.bytes;
    return n;
  }

  async clear(predicate: (e: PreviewEntry) => boolean = () => true): Promise<number> {
    const victims = [...this.entries.values()].filter(predicate);
    for (const e of victims) await this.remove(e);
    for (const f of [...this.failures.values()]) if (predicate(f as unknown as PreviewEntry)) this.failures.delete(f.key);
    await this.save();
    return victims.length;
  }

  /** Deletes the whole cache directory, including files not in the index. */
  async destroy(): Promise<void> {
    this.entries.clear();
    this.memory.clear();
    this.failures.clear();
    if (this.persist) await rm(this.options.dir, { recursive: true, force: true });
  }

  private async remove(e: PreviewEntry): Promise<void> {
    this.entries.delete(e.key);
    this.memory.delete(e.key);
    if (this.persist) await rm(this.pathOf(e), { force: true });
  }

  private async evict(): Promise<void> {
    let total = this.totalBytes();
    if (total <= this.maxTotalBytes) return;
    for (const e of [...this.entries.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)) {
      if (total <= this.maxTotalBytes) break;
      total -= e.bytes;
      await this.remove(e);
    }
  }

  private scheduleSave(): void {
    if (!this.persist || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, 1000);
    this.saveTimer.unref?.();
  }

  async save(): Promise<void> {
    if (!this.persist) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    const data: CacheIndexFile = { v: CACHE_INDEX_VERSION, entries: [...this.entries.values()] };
    const tmp = join(this.options.dir, `.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await rename(tmp, join(this.options.dir, 'cache-v1.json'));
  }
}
