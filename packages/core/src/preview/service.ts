import type { ErrorCode } from '../diagnostics.js';
import type { NodeId } from '../figma-url.js';
import type { FigmaClient, FigmaError, FileMeta, Result } from '../figma/client.js';
import { previewKey, type PreviewCache, type PreviewEntry, type PreviewKeyParts, type QuotaState, type StaleReason } from './cache.js';

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

export interface EnsureOptions {
  /** Re-render even when the cached image is fresh. */
  force?: boolean;
  /**
   * Other previews of the same file to render in the same request. Figma's render endpoint
   * accepts many node IDs per call, so a batch costs one request instead of one per node.
   */
  batch?: readonly PreviewRequest[];
  /**
   * When false, never call the (Tier 1) render endpoint: only revalidate cached images with the
   * cheap metadata endpoint. Used for hovers on low-quota files.
   */
  render?: boolean;
}

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
/** Figma accepts up to this many node IDs per render request in FigBridge's client. */
export const MAX_BATCH = 50;
const DOWNLOAD_CONCURRENCY = 4;
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
 * endpoint and only re-rendered (Tier 1) when the file version changed. Renders are batched
 * per file, and files on low-quota plans are remembered so they aren't rendered implicitly.
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

  /** Re-applies render blocks saved by an earlier session (call after `cache.load()`). */
  restoreBlocks(): void {
    for (const [apiKey, q] of this.options.cache.allQuotas())
      if (q.blockedUntil && q.blockedUntil > this.now())
        this.options.client.restoreBlock(apiKey, 1, q.blockedUntil, {
          code: 'RATE_LIMITED',
          message: 'Figma API rate limit reached; previews will refresh later.',
          ...(q.planTier ? { planTier: q.planTier } : {}),
          ...(q.rateLimitType ? { rateLimitType: q.rateLimitType } : {}),
        });
  }

  /** What Figma told us about this file's render quota, if anything. */
  quota(apiKey: string): QuotaState | undefined {
    return this.options.cache.quota(apiKey);
  }

  /** Starter-plan file or low seat: renders should only happen on explicit request. */
  isLowQuota(apiKey: string): boolean {
    return this.options.cache.quota(apiKey)?.low === true;
  }

  /** When Figma allows renders for this file again (epoch ms), if currently blocked. */
  blockedUntil(apiKey: string): number | undefined {
    const until = this.options.cache.quota(apiKey)?.blockedUntil;
    return until && until > this.now() ? until : undefined;
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

  /** Brings one preview up to date; see EnsureOptions for batching and render control. */
  ensure(req: PreviewRequest, opts: EnsureOptions = {}): Promise<PreviewStatus> {
    const key = previewKey(req);
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.run(req, opts).finally(() => {
      this.inFlight.delete(key);
      this.options.onChange?.(req);
    });
    this.inFlight.set(key, p);
    this.options.onChange?.(req);
    return p;
  }

  /**
   * Renders many previews with as few requests as possible: one metadata call and one render
   * call per file (per 50 nodes). Used by "Render All Previews".
   */
  async renderMany(reqs: readonly PreviewRequest[], opts: { force?: boolean } = {}): Promise<Map<string, PreviewStatus>> {
    const out = new Map<string, PreviewStatus>();
    const todo = reqs.filter((r) => {
      if (opts.force) return true;
      const s = this.peek(r);
      if (s.state === 'fresh' || s.state === 'loading') {
        out.set(previewKey(r), s);
        return false;
      }
      return true;
    });
    const groups = new Map<string, PreviewRequest[]>();
    for (const r of todo) {
      const g = `${r.apiKey}|${r.format}|${r.scale}`;
      const list = groups.get(g);
      if (list) list.push(r);
      else groups.set(g, [r]);
    }
    for (const group of groups.values()) {
      if (opts.force) for (const r of group) this.options.cache.clearFailure(r);
      for (let i = 0; i < group.length; i += MAX_BATCH) {
        const chunk = group.slice(i, i + MAX_BATCH);
        const result = this.track(chunk, this.renderBatch(chunk));
        for (const [k, v] of await result) out.set(k, v);
      }
    }
    return out;
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

  private async run(req: PreviewRequest, opts: EnsureOptions): Promise<PreviewStatus> {
    const cache = this.options.cache;
    const entry = cache.get(req);
    const force = opts.force ?? false;
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
      if (opts.render === false) return this.peek(req);
    } else cache.clearFailure(req);

    // Render this preview together with any siblings that also need it (same request).
    const siblings = (opts.batch ?? []).filter((b) => {
      if (b.apiKey !== req.apiKey || b.format !== req.format || b.scale !== req.scale) return false;
      if (previewKey(b) === previewKey(req) || this.inFlight.has(previewKey(b))) return false;
      const s = this.peek(b);
      return s.state === 'missing' || s.state === 'stale';
    });
    const batch = [req, ...siblings].slice(0, MAX_BATCH);
    const results = await this.track(batch.slice(1), this.renderBatch(batch));
    return results.get(previewKey(req)) ?? { state: 'missing' };
  }

  /** Marks batch members as loading while a shared render is in flight. */
  private track(reqs: readonly PreviewRequest[], p: Promise<Map<string, PreviewStatus>>): Promise<Map<string, PreviewStatus>> {
    for (const r of reqs) {
      const key = previewKey(r);
      if (this.inFlight.has(key)) continue;
      const one = p.then((m) => m.get(key) ?? this.peek(r)).finally(() => {
        this.inFlight.delete(key);
        this.options.onChange?.(r);
      });
      this.inFlight.set(key, one);
      this.options.onChange?.(r);
    }
    return p;
  }

  /** One metadata call + one render call for up to MAX_BATCH nodes of one file. */
  private async renderBatch(reqs: readonly PreviewRequest[]): Promise<Map<string, PreviewStatus>> {
    const out = new Map<string, PreviewStatus>();
    const first = reqs[0]!;
    const client = this.options.client;
    const failAll = (error: FigmaError) => {
      for (const r of reqs) out.set(previewKey(r), this.fail(r, error, this.options.cache.get(r)));
      return out;
    };
    const meta = await this.fileMeta(first, true);
    if (!meta.ok) return failAll(meta.error);
    const urls = await client.renderUrls(
      first.apiKey,
      reqs.map((r) => r.nodeId),
      { format: first.format, scale: first.scale },
    );
    if (!urls.ok) return failAll(urls.error);

    // Null renders: deleted nodes vs nodes Figma can't render. Telling them apart costs another
    // Tier-1 request, so skip that on low-quota files.
    const nulls = reqs.filter((r) => !urls.value.get(r.nodeId));
    let existing: Map<NodeId, unknown> | undefined;
    if (nulls.length && !this.isLowQuota(first.apiKey)) {
      const nodes = await client.nodes(first.apiKey, nulls.map((r) => r.nodeId));
      if (nodes.ok) existing = nodes.value;
    }
    for (const r of nulls) {
      const previous = this.options.cache.get(r);
      if (existing && existing.get(r.nodeId) === null) {
        this.options.onNodeState?.(r, 'missing');
        out.set(previewKey(r), this.fail(r, { code: 'NODE_NOT_FOUND', message: `Node ${r.nodeId} does not exist in this file any more.` }, previous));
      } else
        out.set(
          previewKey(r),
          this.fail(r, { code: 'RENDER_FAILED', message: existing ? 'Figma could not render this node (it may be hidden or empty).' : 'Figma could not render this node (it may be deleted, hidden or empty).' }, previous),
        );
    }

    // Downloads come from Figma's image CDN and don't count against the API quota.
    const queue = reqs.filter((r) => urls.value.get(r.nodeId));
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const previous = this.options.cache.get(r);
        const download = await client.download(urls.value.get(r.nodeId)!, this.maxImageBytes);
        if (!download.ok) {
          out.set(previewKey(r), this.fail(r, download.error, previous));
          continue;
        }
        const entry = await this.options.cache.put(r, download.value.bytes, meta.value.version);
        if (!entry) {
          out.set(previewKey(r), this.fail(r, { code: 'BAD_RESPONSE', message: 'Figma returned an unreadable image.' }, previous));
          continue;
        }
        this.options.onNodeState?.(r, 'available');
        out.set(previewKey(r), { state: 'fresh', entry });
      }
    };
    await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
    return out;
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
    if (error.code === 'RATE_LIMITED') this.noteRateLimit(req.apiKey, error);
    const ttl = error.code === 'RATE_LIMITED' ? (error.retryAfterSec ?? 60) * 1000 : NEGATIVE_TTL[error.code];
    if (ttl) this.options.cache.recordFailure(req, error.code, error.message, ttl);
    return { state: 'error', error, ...(entry ? { entry } : {}) };
  }

  /**
   * Remembers what a 429 said about the file. Starter-plan files and View/Collab seats get only
   * a few render requests per month (developers.figma.com/docs/rest-api/rate-limits), so they
   * switch to explicit, batched rendering.
   */
  private noteRateLimit(apiKey: string, error: FigmaError): void {
    const low = error.planTier === 'starter' || error.rateLimitType === 'low' || (error.retryAfterSec ?? 0) > 3600;
    const previous = this.options.cache.quota(apiKey);
    this.options.cache.setQuota(apiKey, {
      low: low || previous?.low === true,
      ...(error.planTier ? { planTier: error.planTier } : previous?.planTier ? { planTier: previous.planTier } : {}),
      ...(error.rateLimitType ? { rateLimitType: error.rateLimitType } : {}),
      blockedUntil: this.now() + (error.retryAfterSec ?? 60) * 1000,
      updatedAt: this.now(),
    });
  }
}
