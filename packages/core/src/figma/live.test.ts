/**
 * Live Figma check. Skipped unless FIGMA_LIVE=1; reads FIGMA_ACCESS_TOKEN from the repo-root
 * .env (git-ignored). Uses ~3 Tier-1 requests. Never prints the token.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FigmaClient } from './client.js';
import { PreviewCache } from '../preview/cache.js';
import { PreviewService } from '../preview/service.js';
import { parseDotenv } from '../manifest/env.js';
import type { NodeId } from '../figma-url.js';

const live = process.env.FIGMA_LIVE === '1';
const KEY = 'aHvbMOTkjQ3dmWBoWbMuv2';

describe.skipIf(!live)('live Figma API', () => {
  it('renders an exact frame and detects a missing node', async () => {
    const env = parseDotenv(readFileSync(join(__dirname, '../../../../.env'), 'utf8'), new Set(['FIGMA_ACCESS_TOKEN']));
    const token = env.get('FIGMA_ACCESS_TOKEN');
    expect(token).toBeTruthy();
    const dir = await mkdtemp(join(tmpdir(), 'figbridge-live-'));
    try {
      const client = new FigmaClient({ getToken: async () => token });
      const service = new PreviewService({ client, cache: new PreviewCache({ dir }) });
      const base = { apiKey: KEY, format: 'png' as const, scale: 1, alias: 'app', ttlMinutes: 60 };
      const t0 = Date.now();
      const ok = await service.ensure({ ...base, nodeId: '1:666' as NodeId });
      const ms = Date.now() - t0;
      expect(ok).toMatchObject({ state: 'fresh', entry: { width: 375, height: 812 } });
      const missing = await service.ensure({ ...base, nodeId: '999:999' as NodeId });
      expect(missing).toMatchObject({ state: 'error', error: { code: 'NODE_NOT_FOUND' } });
      console.log(`live: uncached render ${ms} ms, requests ${client.requestCount}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
