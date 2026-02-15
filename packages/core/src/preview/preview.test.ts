import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FigmaClient } from '../figma/client.js';
import type { NodeId } from '../figma-url.js';
import { fakeFetch, fakePng, RENDER_URL, TOKEN, type FakeResponse } from '../test-utils/fake-figma.js';
import { imageSize, PreviewCache } from './cache.js';
import { PreviewService, type PreviewRequest } from './service.js';

const KEY = 'aHvbMOTkjQ3dmWBoWbMuv2';
const req = (nodeId = '1:666'): PreviewRequest => ({ apiKey: KEY, nodeId: nodeId as NodeId, format: 'png', scale: 1, alias: 'app', ttlMinutes: 60 });

let dir: string;
let now = 1_000_000;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'figbridge-cache-'));
  now = 1_000_000;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(overrides: { meta?: () => FakeResponse; images?: () => FakeResponse; nodes?: () => FakeResponse } = {}) {
  let version = '100';
  const f = fakeFetch([
    [/\/meta$/, overrides.meta ?? (() => ({ status: 200, body: { file: { name: 'F', version } } }))],
    [/\/v1\/images\//, overrides.images ?? (() => ({ status: 200, body: { err: null, images: { '1:666': RENDER_URL } } }))],
    [/\/nodes\?/, overrides.nodes ?? (() => ({ status: 200, body: { nodes: { '1:666': null } } }))],
    [/amazonaws/, () => ({ status: 200, bytes: fakePng(375, 812) })],
  ]);
  const client = new FigmaClient({ getToken: async () => TOKEN, fetch: f.fetch, sleep: async () => {}, now: () => now });
  const cache = new PreviewCache({ dir, now: () => now });
  const events: string[] = [];
  const service = new PreviewService({
    client,
    cache,
    now: () => now,
    onNodeState: (r, s) => events.push(`node:${r.nodeId}:${s}`),
    onFileAccess: (a, s) => events.push(`file:${a}:${s}`),
  });
  const kinds = () => f.calls.map((c) => (c.url.includes('amazonaws') ? 'download' : c.url.includes('/meta') ? 'meta' : c.url.includes('/images/') ? 'images' : c.url.includes('/nodes') ? 'nodes' : 'download'));
  return { f, cache, service, events, kinds, setVersion: (v: string) => (version = v) };
}

describe('imageSize', () => {
  it('reads PNG dimensions', () => expect(imageSize(fakePng(375, 812))).toEqual({ width: 375, height: 812, mime: 'image/png' }));
  it('rejects other content', () => expect(imageSize(new TextEncoder().encode('<svg/>'))).toBeUndefined());
});

describe('PreviewService', () => {
  it('miss → meta + render + download, then hits cost zero requests', async () => {
    const s = setup();
    expect(s.service.peek(req()).state).toBe('missing');
    const r = await s.service.ensure(req());
    expect(r).toMatchObject({ state: 'fresh', entry: { width: 375, height: 812, versionFingerprint: '100' } });
    expect(s.kinds()).toEqual(['meta', 'images', 'download']);
    expect(s.events).toEqual(['file:app:available', 'node:1:666:available']);
    await s.service.ensure(req());
    expect(s.service.peek(req()).state).toBe('fresh');
    expect(s.f.calls).toHaveLength(3);
    expect((await readdir(dir)).some((n) => n.endsWith('.png'))).toBe(true);
  });

  it('coalesces concurrent hovers into one render', async () => {
    const s = setup();
    await Promise.all(Array.from({ length: 10 }, () => s.service.ensure(req())));
    expect(s.kinds()).toEqual(['meta', 'images', 'download']);
  });

  it('after TTL revalidates with /meta only when the version is unchanged', async () => {
    const s = setup();
    await s.service.ensure(req());
    now += 61 * 60_000;
    expect(s.service.peek(req())).toMatchObject({ state: 'stale', reason: 'ttl' });
    expect(await s.service.ensure(req())).toMatchObject({ state: 'fresh' });
    expect(s.kinds()).toEqual(['meta', 'images', 'download', 'meta']);
  });

  it('re-renders when the file version changed', async () => {
    const s = setup();
    await s.service.ensure(req());
    now += 61 * 60_000;
    s.setVersion('101');
    expect(await s.service.ensure(req())).toMatchObject({ state: 'fresh', entry: { versionFingerprint: '101' } });
    expect(s.kinds().slice(3)).toEqual(['meta', 'images', 'download']); // the revalidation /meta result is reused for the render
  });

  it('Claude invalidation marks stale and the next ensure re-renders', async () => {
    const s = setup();
    await s.service.ensure(req());
    expect(s.service.invalidateNodes(KEY, ['1:666' as NodeId], 'claude-event')).toBe(1);
    expect(s.service.peek(req())).toMatchObject({ state: 'stale', reason: 'claude-event' });
    await s.service.ensure(req());
    expect(s.kinds().slice(3)).toEqual(['meta', 'images', 'download']);
  });

  it('null render + missing node → NODE_NOT_FOUND, negatively cached', async () => {
    const s = setup({ images: () => ({ status: 200, body: { err: null, images: { '1:666': null } } }) });
    expect(await s.service.ensure(req())).toMatchObject({ state: 'error', error: { code: 'NODE_NOT_FOUND' } });
    expect(s.events).toContain('node:1:666:missing');
    await s.service.ensure(req());
    expect(s.kinds()).toEqual(['meta', 'images', 'nodes']);
    expect(s.service.peek(req()).state).toBe('error');
  });

  it('null render of an existing node → RENDER_FAILED', async () => {
    const s = setup({
      images: () => ({ status: 200, body: { err: null, images: { '1:666': null } } }),
      nodes: () => ({ status: 200, body: { nodes: { '1:666': { document: { name: 'Hidden', type: 'RECTANGLE', visible: false } } } } }),
    });
    expect(await s.service.ensure(req())).toMatchObject({ state: 'error', error: { code: 'RENDER_FAILED' } });
  });

  it('keeps serving the last image when offline', async () => {
    let offline = false;
    const s = setup({ meta: () => { if (offline) throw new Error('offline'); return { status: 200, body: { file: { version: '100' } } }; } });
    await s.service.ensure(req());
    offline = true;
    now += 61 * 60_000;
    const r = await s.service.ensure(req());
    expect(r).toMatchObject({ state: 'error', error: { code: 'NETWORK_UNAVAILABLE' }, entry: { width: 375 } });
  });

  it('records denied file access', async () => {
    const s = setup({ meta: () => ({ status: 403, body: { err: 'Forbidden' } }) });
    expect(await s.service.ensure(req())).toMatchObject({ state: 'error', error: { code: 'FILE_UNAVAILABLE' } });
    expect(s.events).toEqual(['file:app:denied']);
  });
});

describe('PreviewCache', () => {
  it('persists and reloads its index', async () => {
    const s = setup();
    await s.service.ensure(req());
    await s.cache.save();
    const reloaded = new PreviewCache({ dir });
    await reloaded.load();
    expect(reloaded.all()).toHaveLength(1);
    expect(await reloaded.read(reloaded.all()[0]!)).toBeDefined();
  });

  it('evicts least-recently-used entries over the size cap', async () => {
    const cache = new PreviewCache({ dir, maxTotalBytes: 100, now: () => now });
    for (const id of ['1:1', '1:2', '1:3']) {
      now += 1000;
      await cache.put({ apiKey: KEY, nodeId: id as NodeId, format: 'png', scale: 1 }, fakePng(1, 1, 7)); // 40 bytes each
    }
    expect(cache.all().map((e) => e.nodeId)).toEqual(['1:2', '1:3']);
  });

  it('never writes the token anywhere in the cache directory', async () => {
    const s = setup();
    await s.service.ensure(req());
    await s.cache.save();
    const { readFile } = await import('node:fs/promises');
    for (const name of await readdir(dir)) expect((await readFile(join(dir, name))).toString('latin1')).not.toContain(TOKEN);
  });
});
