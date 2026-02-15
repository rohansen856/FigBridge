import type { ErrorCode } from '../diagnostics.js';
import type { NodeId } from '../figma-url.js';

export const FIGMA_API_ORIGIN = 'https://api.figma.com';

/**
 * Hosts that serve rendered images returned by `GET /v1/images`. Observed:
 * `figma-alpha-api.s3.us-west-2.amazonaws.com`. Downloads never carry the token.
 */
const RENDER_HOST = /^(figma-alpha-api\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com|[a-z0-9-]+\.figma\.com)$/;

export interface FigmaError {
  code: ErrorCode;
  /** User-facing, never contains the token or response bodies. */
  message: string;
  httpStatus?: number;
  retryAfterSec?: number;
  planTier?: string;
  rateLimitType?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: FigmaError };

export interface FileMeta {
  name: string;
  version: string;
  lastTouchedAt: string;
  role?: string;
}

export interface NodeSummary {
  id: NodeId;
  name: string;
  type: string;
  width?: number;
  height?: number;
  visible: boolean;
}

export type FetchLike = (url: string, init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'error' | 'follow' }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface FigmaClientOptions {
  /** Returns the PAT, or undefined when none is configured. Called per request; never cached here. */
  getToken: () => Promise<string | undefined>;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Retries for network errors and 5xx only (never 4xx/429). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const MAX_IDS_PER_CALL = 50;

/** Minimal, defensive client for the endpoints FigBridge needs. */
export class FigmaClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<Result<unknown>>>();
  /** Rate-limit blocks: no requests until this epoch-ms, per API key. */
  private readonly blockedUntil = new Map<string, { until: number; error: FigmaError }>();
  /** Requests actually sent; exposed for tests and the "API calls" status. */
  requestCount = 0;

  constructor(private readonly options: FigmaClientOptions) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
  }

  /** `GET /v1/files/:key/meta` (Tier 3, scope file_metadata:read). */
  async fileMeta(apiKey: string, signal?: AbortSignal): Promise<Result<FileMeta>> {
    const r = await this.getJson<{ file?: { name?: string; version?: string; last_touched_at?: string; role?: string } }>(
      apiKey,
      `/v1/files/${encodeURIComponent(apiKey)}/meta`,
      signal,
    );
    if (!r.ok) return r;
    const f = r.value.file;
    if (!f?.version) return badResponse();
    return { ok: true, value: { name: f.name ?? '', version: String(f.version), lastTouchedAt: f.last_touched_at ?? '', ...(f.role ? { role: f.role } : {}) } };
  }

  /** `GET /v1/files/:key/nodes?ids=…&depth=1` (Tier 1). Missing nodes map to null. */
  async nodes(apiKey: string, ids: readonly NodeId[], signal?: AbortSignal): Promise<Result<Map<NodeId, NodeSummary | null>>> {
    const out = new Map<NodeId, NodeSummary | null>();
    for (const chunk of chunks(ids, MAX_IDS_PER_CALL)) {
      const r = await this.getJson<{ nodes?: Record<string, { document?: RawNode } | null> }>(
        apiKey,
        `/v1/files/${encodeURIComponent(apiKey)}/nodes?ids=${encodeURIComponent(chunk.join(','))}&depth=1`,
        signal,
      );
      if (!r.ok) return r;
      for (const id of chunk) {
        const doc = r.value.nodes?.[id]?.document;
        out.set(
          id,
          doc
            ? {
                id,
                name: String(doc.name ?? ''),
                type: String(doc.type ?? ''),
                visible: doc.visible !== false,
                ...(doc.absoluteBoundingBox ? { width: doc.absoluteBoundingBox.width, height: doc.absoluteBoundingBox.height } : {}),
              }
            : null,
        );
      }
    }
    return { ok: true, value: out };
  }

  /** `GET /v1/images/:key` (Tier 1). A null URL means Figma could not render that node. */
  async renderUrls(
    apiKey: string,
    ids: readonly NodeId[],
    opts: { format: 'png' | 'jpg'; scale: number },
    signal?: AbortSignal,
  ): Promise<Result<Map<NodeId, string | null>>> {
    const out = new Map<NodeId, string | null>();
    const scale = Math.min(4, Math.max(0.01, opts.scale));
    for (const chunk of chunks(ids, MAX_IDS_PER_CALL)) {
      const r = await this.getJson<{ err?: string | null; images?: Record<string, string | null> }>(
        apiKey,
        `/v1/images/${encodeURIComponent(apiKey)}?ids=${encodeURIComponent(chunk.join(','))}&format=${opts.format}&scale=${scale}`,
        signal,
      );
      if (!r.ok) return r.error.httpStatus && r.error.httpStatus >= 500 ? { ok: false, error: { ...r.error, code: 'RENDER_FAILED' } } : r;
      if (r.value.err) return { ok: false, error: { code: 'RENDER_FAILED', message: 'Figma could not render the node.' } };
      for (const id of chunk) out.set(id, r.value.images?.[id] ?? null);
    }
    return { ok: true, value: out };
  }

  /** Downloads a rendered image from Figma's render host. The token is never sent. */
  async download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Result<{ bytes: Uint8Array; contentType: string }>> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return badResponse();
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.port || !RENDER_HOST.test(parsed.hostname)) return badResponse();
    const res = await this.send(url, {}, signal);
    if (!res.ok) return res;
    const { response } = res.value;
    if (response.status !== 200) return { ok: false, error: { code: 'RENDER_FAILED', message: `Image download failed (HTTP ${response.status}).`, httpStatus: response.status } };
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!['image/png', 'image/jpeg'].includes(contentType)) return badResponse();
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) return { ok: false, error: { code: 'RENDER_TOO_LARGE', message: `Rendered image is larger than ${Math.round(maxBytes / 1024)} KB.` } };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) return { ok: false, error: { code: 'RENDER_TOO_LARGE', message: `Rendered image is larger than ${Math.round(maxBytes / 1024)} KB.` } };
    return { ok: true, value: { bytes, contentType } };
  }

  /** Current rate-limit block for an API key, if any. */
  rateLimit(apiKey: string): FigmaError | undefined {
    const b = this.blockedUntil.get(apiKey);
    return b && b.until > this.now() ? b.error : undefined;
  }

  private async getJson<T>(apiKey: string, path: string, signal?: AbortSignal): Promise<Result<T>> {
    const existing = this.inFlight.get(path);
    if (existing) return existing as Promise<Result<T>>;
    const p = this.getJsonUncoalesced<T>(apiKey, path, signal).finally(() => this.inFlight.delete(path));
    this.inFlight.set(path, p as Promise<Result<unknown>>);
    return p;
  }

  private async getJsonUncoalesced<T>(apiKey: string, path: string, signal?: AbortSignal): Promise<Result<T>> {
    const blocked = this.rateLimit(apiKey);
    if (blocked) return { ok: false, error: { ...blocked, retryAfterSec: Math.ceil((this.blockedUntil.get(apiKey)!.until - this.now()) / 1000) } };
    const token = await this.options.getToken();
    if (!token) return { ok: false, error: { code: 'PAT_NOT_CONFIGURED', message: 'No Figma access token is configured.' } };
    const res = await this.send(FIGMA_API_ORIGIN + path, { 'X-Figma-Token': token }, signal);
    if (!res.ok) return res;
    const { response } = res.value;
    if (response.status === 200) {
      try {
        return { ok: true, value: JSON.parse(await response.text()) as T };
      } catch {
        return badResponse();
      }
    }
    const error = await httpError(response);
    if (error.code === 'RATE_LIMITED') this.blockedUntil.set(apiKey, { until: this.now() + (error.retryAfterSec ?? 60) * 1000, error });
    return { ok: false, error };
  }

  /** Sends with timeout and bounded retries for network errors and 5xx. */
  private async send(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Result<{ response: Awaited<ReturnType<FetchLike>> }>> {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) return { ok: false, error: { code: 'NETWORK_UNAVAILABLE', message: 'Request cancelled.' } };
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        this.requestCount++;
        const response = await this.fetchImpl(url, { method: 'GET', headers, signal: combined, redirect: 'error' });
        if (response.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        return { ok: true, value: { response } };
      } catch {
        if (signal?.aborted) return { ok: false, error: { code: 'NETWORK_UNAVAILABLE', message: 'Request cancelled.' } };
        if (attempt < this.maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        return {
          ok: false,
          error: { code: 'NETWORK_UNAVAILABLE', message: timeout.aborted ? 'Figma did not respond in time.' : 'Could not reach Figma (offline?).' },
        };
      }
    }
  }
}

interface RawNode {
  name?: unknown;
  type?: unknown;
  visible?: boolean;
  absoluteBoundingBox?: { width: number; height: number };
}

async function httpError(response: Awaited<ReturnType<FetchLike>>): Promise<FigmaError> {
  const status = response.status;
  let err = '';
  try {
    const body = JSON.parse(await response.text()) as { err?: unknown; message?: unknown };
    err = String(body.err ?? body.message ?? '').toLowerCase();
  } catch {
    /* body is not JSON */
  }
  switch (true) {
    case status === 401:
      return { code: 'PAT_INVALID_OR_EXPIRED', message: 'Figma rejected the access token (invalid or expired).', httpStatus: status };
    case status === 403 && /token|expired|scope/.test(err):
      return { code: 'PAT_INVALID_OR_EXPIRED', message: 'The access token is expired or lacks the required scope (file_content:read, file_metadata:read).', httpStatus: status };
    case status === 403:
      return { code: 'FILE_UNAVAILABLE', message: 'Your Figma account cannot access this file.', httpStatus: status };
    case status === 404:
      return { code: 'FILE_UNAVAILABLE', message: 'Figma file not found.', httpStatus: status };
    case status === 429: {
      const retry = Number(response.headers.get('retry-after'));
      const planTier = response.headers.get('x-figma-plan-tier') ?? undefined;
      const rateLimitType = response.headers.get('x-figma-rate-limit-type') ?? undefined;
      return {
        code: 'RATE_LIMITED',
        message: 'Figma API rate limit reached; previews will refresh later.',
        httpStatus: status,
        retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : 60,
        ...(planTier ? { planTier } : {}),
        ...(rateLimitType ? { rateLimitType } : {}),
      };
    }
    case status === 400:
      return { code: 'NODE_NOT_FOUND', message: 'Figma rejected the node ID.', httpStatus: status };
    default:
      return { code: 'BAD_RESPONSE', message: `Unexpected Figma response (HTTP ${status}).`, httpStatus: status };
  }
}

function badResponse(): { ok: false; error: FigmaError } {
  return { ok: false, error: { code: 'BAD_RESPONSE', message: 'Unexpected response from Figma.' } };
}

function backoff(attempt: number): number {
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
