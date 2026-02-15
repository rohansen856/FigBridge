import type { ErrorCode } from '../diagnostics.js';
import type { NodeId } from '../figma-url.js';
import type { FigmaClient, FigmaError, FileMeta, Result } from '../figma/client.js';
import { previewKey, type PreviewCache, type PreviewEntry, type PreviewKeyParts, type StaleReason } from './cache.js';

export interface PreviewRequest extends PreviewKeyParts {
  /** File alias, for access-state callbacks. */
  alias: string;
  ttlMinutes: number;
}

export type PreviewStatus =
  | { state: 'fresh'; entry: PreviewEntry }
  | { state: 'stale'; entry: PreviewEntry; reason: StaleReason }
  | { state: 'loading'; entry?: PreviewEntry }
  | { state: 'missing' }
  | { state: 'error'; error: FigmaError; entry?: PreviewEntry };

export interface PreviewServiceOptions {
  client: FigmaClient;
  cache: PreviewCache;
  maxImageBytes?: number;
  now?: () => number;
  onNodeState?: (req: PreviewRequest, state: 'available' | 'missing' | 'denied') => void;
  onFileAccess?: (alias: string, state: 'available' | 'denied' | 'missing') => void;
  /** Called whenever a preview's status may have changed. */
  onChange?: (req: PreviewRequest) => void;
}

const META_TTL_MS = 60_000;
const NEGATIVE_TTL: Partial<Record<ErrorCode, number>> = {
  NODE_NOT_FOUND: 10 * 60_000,
  RENDER_FAILED: 10 * 60_000,
  RENDER_TOO_LARGE: 60 * 60_000,
  FILE_UNAVAILABLE: 10 * 60_000,
  NETWORK_UNAVAILABLE: 30_000,
  BAD_RESPONSE: 60_000,
};

/**
 * Cache-first preview orchestration. Hover code calls `peek` (no I/O) and `ensure` (network as
 * needed, coalesced per preview). Freshness after the TTL is checked with the Tier-3 `/meta`
 * endpoint and only re-rendered (Tier 1) when the file version changed.
 */
export class PreviewService {
  private readonly inFlight = new Map<string, Promise<PreviewStatus>>();
  private readonly meta = new Map<string, { at: number; result: Result<FileMeta> }>();
  private readonly maxImageBytes: number;
  private readonly now: () => number;

  constructor(private readonly options: PreviewServiceOptions) {
    this.maxImageBytes = options.maxImageBytes ?? 5 * 1024 * 1024;
    this.now = options.now ?? Date.now;
  }

  /** Status from local state only. */
  peek(req: PreviewRequest): PreviewStatus {
    const entry = this.options.cache.all().find((e) => e.key === previewKey(req));
    if (this.inFlight.has(previewKey(req))) return { state: 'loading', ...(entry ? { entry } : {}) };
    const failure = this.options.cache.failure(req);
    if (failure) return { state: 'error', error: { code: failure.code, message: failure.message }, ...(entry ? { entry } : {}) };
    if (!entry) return { state: 'missing' };
    if (entry.stale) return { state: 'stale', entry, reason: entry.stale };
    if (this.now() - entry.validatedAt > req.ttlMinutes * 60_000) return { state: 'stale', entry, reason: 'ttl' };
    return { state: 'fresh', entry };
  }

  /** Brings the preview up to date. `force` re-renders regardless of cache state. */
  ensure(req: PreviewRequest, opts: { force?: boolean } = {}): Promise<PreviewStatus> {
    const key = previewKey(req);
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.run(req, opts.force ?? false).finally(() => {
      this.inFlight.delete(key);
      this.options.onChange?.(req);
    });
    this.inFlight.set(key, p);
    this.options.onChange?.(req);
    return p;
  }

  isLoading(req: PreviewKeyParts): boolean {
    return this.inFlight.has(previewKey(req));
  }

  /** Invalidates every preview of a file (e.g. after a Claude mutation or version change). */
  invalidateFile(apiKey: string, reason: StaleReason): number {
    this.meta.delete(apiKey);
    return this.options.cache.markStale((e) => e.apiKey === apiKey, reason);
  }

  invalidateNodes(apiKey: string, nodeIds: readonly NodeId[], reason: StaleReason): number {
    this.meta.delete(apiKey);
    const set = new Set(nodeIds);
    return this.options.cache.markStale((e) => e.apiKey === apiKey && set.has(e.nodeId), reason);
  }

  private async run(req: PreviewRequest, force: boolean): Promise<PreviewStatus> {
    const cache = this.options.cache;
    const entry = cache.get(req);
    if (!force) {
      const failure = cache.failure(req);
      if (failure) return { state: 'error', error: { code: failure.code, message: failure.message }, ...(entry ? { entry } : {}) };
      const status = this.peek(req);
      if (status.state === 'fresh') return status;
      if (entry && status.state === 'stale' && status.reason === 'ttl') {
        // Cheap revalidation: unchanged file version means the old render is still right.
        const meta = await this.fileMeta(req, false);
        if (meta.ok && entry.versionFingerprint && meta.value.version === entry.versionFingerprint) {
          cache.touchValidated(entry);
          return { state: 'fresh', entry };
        }
        if (!meta.ok) return this.fail(req, meta.error, entry);
      }
    } else cache.clearFailure(req);
    return this.render(req, entry);
  }

  private async render(req: PreviewRequest, previous: PreviewEntry | undefined): Promise<PreviewStatus> {
    const client = this.options.client;
    const meta = await this.fileMeta(req, true);
    if (!meta.ok) return this.fail(req, meta.error, previous);

    const urls = await client.renderUrls(req.apiKey, [req.nodeId], { format: req.format, scale: req.scale });
    if (!urls.ok) return this.fail(req, urls.error, previous);
    const url = urls.value.get(req.nodeId);
    if (!url) {
      // Null render: distinguish a deleted node from a node Figma can't render.
      const nodes = await client.nodes(req.apiKey, [req.nodeId]);
      if (nodes.ok && nodes.value.get(req.nodeId) === null) {
        this.options.onNodeState?.(req, 'missing');
        return this.fail(req, { code: 'NODE_NOT_FOUND', message: `Node ${req.nodeId} does not exist in this file any more.` }, previous);
      }
      return this.fail(req, { code: 'RENDER_FAILED', message: 'Figma could not render this node (it may be hidden or empty).' }, previous);
    }
    const download = await client.download(url, this.maxImageBytes);
    if (!download.ok) return this.fail(req, download.error, previous);
    const entry = await this.options.cache.put(req, download.value.bytes, meta.value.version);
    if (!entry) return this.fail(req, { code: 'BAD_RESPONSE', message: 'Figma returned an unreadable image.' }, previous);
    this.options.onNodeState?.(req, 'available');
    return { state: 'fresh', entry };
  }

  private async fileMeta(req: PreviewRequest, allowCached: boolean): Promise<Result<FileMeta>> {
    const cached = this.meta.get(req.apiKey);
    if (allowCached && cached && this.now() - cached.at < META_TTL_MS) return cached.result;
    const result = await this.options.client.fileMeta(req.apiKey);
    this.meta.set(req.apiKey, { at: this.now(), result });
    if (result.ok) {
      this.options.onFileAccess?.(req.alias, 'available');
      // A newer version invalidates every older render of this file.
      this.options.cache.markStale((e) => e.apiKey === req.apiKey && !!e.versionFingerprint && e.versionFingerprint !== result.value.version && !e.stale, 'version-changed');
    } else if (result.error.code === 'FILE_UNAVAILABLE') this.options.onFileAccess?.(req.alias, result.error.httpStatus === 404 ? 'missing' : 'denied');
    return result;
  }

  private fail(req: PreviewRequest, error: FigmaError, entry: PreviewEntry | undefined): PreviewStatus {
    const ttl = error.code === 'RATE_LIMITED' ? (error.retryAfterSec ?? 60) * 1000 : NEGATIVE_TTL[error.code];
    if (ttl) this.options.cache.recordFailure(req, error.code, error.message, ttl);
    return { state: 'error', error, ...(entry ? { entry } : {}) };
  }
}
