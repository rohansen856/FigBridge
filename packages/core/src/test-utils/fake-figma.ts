import type { FetchLike } from '../figma/client.js';

/** Minimal PNG: signature + IHDR header (enough for size detection). */
export function fakePng(width: number, height: number, extra = 0): Uint8Array {
  const b = new Uint8Array(33 + extra);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  return b;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

export interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Routes by URL substring; records every call. A handler may throw to simulate network errors. */
export function fakeFetch(routes: Array<[RegExp, (url: string) => FakeResponse]>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: { ...(init.headers ?? {}) } });
    const route = routes.find(([re]) => re.test(url));
    if (!route) return respond({ status: 404, body: { status: 404, err: 'Not found' } });
    return respond(route[1](url));
  };
  return { fetch, calls };
}

function respond(r: FakeResponse) {
  const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (r.bytes && !headers.has('content-type')) headers.set('content-type', 'image/png');
  return {
    status: r.status,
    headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
    text: async () => (r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    arrayBuffer: async () => (r.bytes ?? new Uint8Array()).slice().buffer,
  };
}

export const RENDER_URL = 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc';
export const TOKEN = 'figd_TESTSEEDTOKEN_do_not_leak_0123456789';
