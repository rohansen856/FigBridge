import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FigmaClient } from '../figma/client.js';
import type { NodeId } from '../figma-url.js';
import { fakeFetch, fakePng, TOKEN, type FakeResponse } from '../test-utils/fake-figma.js';
import { PreviewCache } from './cache.js';
import { PreviewService, type PreviewRequest } from './service.js';

const KEY = 'aHvbMOTkjQ3dmWBoWbMuv2';
const req = (nodeId: string): PreviewRequest => ({ apiKey: KEY, nodeId: nodeId as NodeId, format: 'png', scale: 1, alias: 'app', ttlMinutes: 60 });
const STARTER_429: FakeResponse = { status: 429, headers: { 'Retry-After': '384136', 'X-Figma-Plan-Tier': 'starter', 'X-Figma-Rate-Limit-Type': 'high' } };

let dir: string;
let now = 1_000_000;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'figbridge-quota-'));
  now = 1_000_000;
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

function setup(images: (url: string) => FakeResponse) {
  const f = fakeFetch([
    [/\/meta$/, () => ({ status: 200, body: { file: { name: 'F', version: '1' } } })],
    [/\/v1\/images\//, images],
    [/\/nodes\?/, () => ({ status: 200, body: { nodes: {} } })],
    [/amazonaws/, () => ({ status: 200, bytes: fakePng(10, 10) })],
  ]);
  const client = new FigmaClient({ getToken: async () => TOKEN, fetch: f.fetch, sleep: async () => {}, now: () => now });
  const cache = new PreviewCache({ dir, now: () => now });
  const service = new PreviewService({ client, cache, now: () => now });
  const count = (re: RegExp) => f.calls.filter((c) => re.test(c.url)).length;
  return { f, client, cache, service, count };
}

const renderAll = (url: string): FakeResponse => {
  const ids = decodeURIComponent(/ids=([^&]+)/.exec(url)![1]!).split(',');
  return { status: 200, body: { err: null, images: Object.fromEntries(ids.map((id, i) => [id, `https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/${i}`])) } };
};

describe('batched rendering', () => {
  it('renders a hovered preview and its siblings with one render request', async () => {
    const s = setup(renderAll);
    const siblings = ['1:2', '1:3', '1:4'].map(req);
    expect(await s.service.ensure(req('1:1'), { batch: siblings })).toMatchObject({ state: 'fresh' });
    expect(s.count(/\/v1\/images\//)).toBe(1);
    expect(s.f.calls.find((c) => c.url.includes('/v1/images/'))!.url).toContain(encodeURIComponent('1:1,1:2,1:3,1:4'));
    for (const r of siblings) expect(s.service.peek(r).state).toBe('fresh');
    // Already-fresh siblings are not re-requested.
    await s.service.ensure(req('1:5'), { batch: siblings });
    expect(decodeURIComponent(s.f.calls.filter((c) => c.url.includes('/v1/images/'))[1]!.url)).toContain('ids=1:5&');
  });

  it('renderMany uses one render request per file per 50 nodes', async () => {
    const s = setup(renderAll);
    const reqs = Array.from({ length: 60 }, (_, i) => req(`2:${i}`));
    const out = await s.service.renderMany(reqs);
    expect([...out.values()].every((v) => v.state === 'fresh')).toBe(true);
    expect(s.count(/\/v1\/images\//)).toBe(2);
    expect(s.count(/\/meta$/)).toBe(1);
    await s.service.renderMany(reqs);
    expect(s.count(/\/v1\/images\//)).toBe(2); // all fresh: no new requests
  });
});

describe('low-quota files', () => {
  it('a Starter 429 marks the file low-quota but keeps the metadata tier usable', async () => {
    const s = setup(() => STARTER_429);
    expect(await s.service.ensure(req('1:1'))).toMatchObject({ state: 'error', error: { code: 'RATE_LIMITED', planTier: 'starter' } });
    expect(s.service.isLowQuota(KEY)).toBe(true);
    expect(s.service.blockedUntil(KEY)).toBe(now + 384136 * 1000);
    expect(s.client.rateLimit(KEY, 1)).toBeDefined();
    expect(s.client.rateLimit(KEY, 3)).toBeUndefined();
    expect((await s.client.fileMeta(KEY)).ok).toBe(true);
  });

  it('render: false never calls the render endpoint', async () => {
    const s = setup(renderAll);
    expect(await s.service.ensure(req('1:1'), { render: false })).toEqual({ state: 'missing' });
    expect(s.count(/\/v1\/images\//)).toBe(0);
  });

  it('skips the node-existence check for null renders on low-quota files', async () => {
    const s = setup(() => STARTER_429);
    await s.service.ensure(req('1:1'));
    now += 400_000 * 1000; // block expired
    const nulls = setup(() => ({ status: 200, body: { err: null, images: { '1:9': null } } }));
    nulls.cache.setQuota(KEY, { low: true, updatedAt: now });
    expect(await nulls.service.ensure(req('1:9'))).toMatchObject({ state: 'error', error: { code: 'RENDER_FAILED' } });
    expect(nulls.count(/\/nodes\?/)).toBe(0);
  });

  it('persists quota and restores the render block after a restart', async () => {
    const s = setup(() => STARTER_429);
    await s.service.ensure(req('1:1'));
    await s.cache.save();
    const again = setup(renderAll);
    await again.cache.load();
    again.service.restoreBlocks();
    expect(again.service.isLowQuota(KEY)).toBe(true);
    expect(await again.service.renderMany([req('1:1')])).toBeDefined();
    expect(again.count(/\/v1\/images\//)).toBe(0); // blocked locally; no request sent
  });
});
