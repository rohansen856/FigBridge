import { describe, expect, it } from 'vitest';
import { FigmaClient } from './client.js';
import { fakeFetch, fakePng, RENDER_URL, TOKEN } from '../test-utils/fake-figma.js';
import type { NodeId } from '../figma-url.js';

const KEY = 'aHvbMOTkjQ3dmWBoWbMuv2';
const n = (s: string) => s as NodeId;
const client = (fetch: ReturnType<typeof fakeFetch>['fetch'], token: string | undefined = TOKEN) =>
  new FigmaClient({ getToken: async () => token, fetch, sleep: async () => {}, timeoutMs: 1000 });

describe('FigmaClient', () => {
  it('sends the token only to api.figma.com and parses meta', async () => {
    const f = fakeFetch([
      [/\/meta$/, () => ({ status: 200, body: { file: { name: 'Food', version: '42', last_touched_at: 't' } } })],
      [/amazonaws/, () => ({ status: 200, bytes: fakePng(10, 10) })],
    ]);
    const c = client(f.fetch);
    expect(await c.fileMeta(KEY)).toEqual({ ok: true, value: { name: 'Food', version: '42', lastTouchedAt: 't' } });
    await c.download(RENDER_URL, 1000);
    expect(f.calls[0]!.url).toBe(`https://api.figma.com/v1/files/${KEY}/meta`);
    expect(f.calls[0]!.headers['X-Figma-Token']).toBe(TOKEN);
    expect(f.calls[1]!.headers['X-Figma-Token']).toBeUndefined();
  });

  it('maps render results including null', async () => {
    const f = fakeFetch([[/\/v1\/images\//, () => ({ status: 200, body: { err: null, images: { '1:666': RENDER_URL, '999:999': null } } })]]);
    const r = await client(f.fetch).renderUrls(KEY, [n('1:666'), n('999:999')], { format: 'png', scale: 1 });
    expect(r.ok && [...r.value]).toEqual([['1:666', RENDER_URL], ['999:999', null]]);
    expect(f.calls[0]!.url).toContain('ids=1%3A666%2C999%3A999&format=png&scale=1');
  });

  it('maps node summaries and missing nodes', async () => {
    const f = fakeFetch([[/\/nodes\?/, () => ({ status: 200, body: { nodes: { '1:666': { document: { name: 'Order', type: 'FRAME', absoluteBoundingBox: { width: 375, height: 812 } } }, '999:999': null } } })]]);
    const r = await client(f.fetch).nodes(KEY, [n('1:666'), n('999:999')]);
    expect(r.ok && r.value.get(n('1:666'))).toEqual({ id: '1:666', name: 'Order', type: 'FRAME', visible: true, width: 375, height: 812 });
    expect(r.ok && r.value.get(n('999:999'))).toBeNull();
  });

  it.each([
    [401, { status: 401, err: 'Invalid token' }, 'PAT_INVALID_OR_EXPIRED'],
    [403, { status: 403, err: 'Token expired' }, 'PAT_INVALID_OR_EXPIRED'],
    [403, { status: 403, err: 'Forbidden' }, 'FILE_UNAVAILABLE'],
    [404, { status: 404, err: 'Not found' }, 'FILE_UNAVAILABLE'],
    [400, { status: 400, err: 'Invalid parameter' }, 'NODE_NOT_FOUND'],
    [418, 'not json', 'BAD_RESPONSE'],
  ])('HTTP %i → %s', async (status, body, code) => {
    const f = fakeFetch([[/meta/, () => ({ status, body })]]);
    const r = await client(f.fetch).fileMeta(KEY);
    expect(r).toMatchObject({ ok: false, error: { code } });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(f.calls).toHaveLength(1); // 4xx is never retried
  });

  it('retries 5xx then succeeds', async () => {
    let i = 0;
    const f = fakeFetch([[/meta/, () => (i++ < 2 ? { status: 502 } : { status: 200, body: { file: { version: '1' } } })]]);
    expect((await client(f.fetch).fileMeta(KEY)).ok).toBe(true);
    expect(f.calls).toHaveLength(3);
  });

  it('reports offline after bounded retries', async () => {
    const f = fakeFetch([[/meta/, () => { throw new Error('ECONNREFUSED'); }]]);
    expect(await client(f.fetch).fileMeta(KEY)).toMatchObject({ ok: false, error: { code: 'NETWORK_UNAVAILABLE' } });
    expect(f.calls).toHaveLength(3);
  });

  it('blocks further requests after 429 until Retry-After', async () => {
    let t = 0;
    const f = fakeFetch([[/meta/, () => ({ status: 429, headers: { 'Retry-After': '30', 'X-Figma-Plan-Tier': 'starter', 'X-Figma-Rate-Limit-Type': 'low' } })]]);
    const c = new FigmaClient({ getToken: async () => TOKEN, fetch: f.fetch, now: () => t });
    expect(await c.fileMeta(KEY)).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', retryAfterSec: 30, planTier: 'starter', rateLimitType: 'low' } });
    expect(await c.fileMeta(KEY)).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    expect(f.calls).toHaveLength(1);
    t = 31_000;
    await c.fileMeta(KEY);
    expect(f.calls).toHaveLength(2);
  });

  it('coalesces identical concurrent requests', async () => {
    const f = fakeFetch([[/meta/, () => ({ status: 200, body: { file: { version: '1' } } })]]);
    const c = client(f.fetch);
    await Promise.all(Array.from({ length: 10 }, () => c.fileMeta(KEY)));
    expect(f.calls).toHaveLength(1);
  });

  it('does not call the network without a token', async () => {
    const f = fakeFetch([]);
    expect(await client(f.fetch, '').fileMeta(KEY)).toMatchObject({ ok: false, error: { code: 'PAT_NOT_CONFIGURED' } });
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    'http://figma-alpha-api.s3.us-west-2.amazonaws.com/x',
    'https://evil.example/x.png',
    'https://figma-alpha-api.s3.us-west-2.amazonaws.com.evil.example/x',
    'https://user@figma-alpha-api.s3.us-west-2.amazonaws.com/x',
  ])('refuses to download from %s', async (url) => {
    const f = fakeFetch([[/./, () => ({ status: 200, bytes: fakePng(1, 1) })]]);
    expect((await client(f.fetch).download(url, 1000)).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it('enforces the download size limit and content type', async () => {
    const big = fakeFetch([[/./, () => ({ status: 200, bytes: fakePng(1, 1, 5000) })]]);
    expect(await client(big.fetch).download(RENDER_URL, 1000)).toMatchObject({ ok: false, error: { code: 'RENDER_TOO_LARGE' } });
    const html = fakeFetch([[/./, () => ({ status: 200, bytes: fakePng(1, 1), headers: { 'content-type': 'text/html' } })]]);
    expect((await client(html.fetch).download(RENDER_URL, 1000)).ok).toBe(false);
  });
});
