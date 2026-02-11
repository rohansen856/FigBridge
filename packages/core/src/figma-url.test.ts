import { describe, expect, it } from 'vitest';
import { buildNodeUrl, normalizeNodeId, parseFigmaUrl, type NodeId } from './figma-url.js';

const BASE = 'https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers---Food-Delivery-App';

describe('normalizeNodeId', () => {
  it.each([
    ['0-1', '0:1'],
    ['0:1', '0:1'],
    ['0%3A1', '0:1'],
    ['1-9400', '1:9400'],
    ['I1:2;3:4', 'I1:2;3:4'],
    ['I1-2;3-4', 'I1:2;3:4'],
  ])('%s → %s', (raw, expected) => expect(normalizeNodeId(raw)).toBe(expected));
  it.each(['', 'abc', '1', '1:2:3', '1:x', '%E0%A4%A'])('rejects %j', (raw) => expect(normalizeNodeId(raw)).toBeUndefined());
});

describe('parseFigmaUrl', () => {
  it('parses a browser URL and drops transient params', () => {
    const r = parseFigmaUrl(`${BASE}?node-id=1-9400&p=f&t=DhiclSm228nAQARN-0`);
    expect(r).toEqual({
      ok: true,
      value: { fileKey: 'aHvbMOTkjQ3dmWBoWbMuv2', slug: 'Food-Couriers---Food-Delivery-App', nodeId: '1:9400' },
    });
  });
  it('accepts /file/, bare figma.com, no slug, no node', () => {
    expect(parseFigmaUrl('https://figma.com/file/aHvbMOTkjQ3dmWBoWbMuv2')).toEqual({ ok: true, value: { fileKey: 'aHvbMOTkjQ3dmWBoWbMuv2' } });
  });
  it('parses branch URLs', () => {
    const r = parseFigmaUrl('https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/branch/BRANCHkey12345/Name?node-id=0-1');
    expect(r).toMatchObject({ ok: true, value: { branchKey: 'BRANCHkey12345', slug: 'Name', nodeId: '0:1' } });
  });
  it.each([
    ['http://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/x', 'not-https'],
    ['javascript:alert(1)', 'not-https'],
    ['file:///etc/passwd', 'not-https'],
    ['https://evil.example/design/aHvbMOTkjQ3dmWBoWbMuv2/x', 'host'],
    ['https://www.figma.com.evil.example/design/aHvbMOTkjQ3dmWBoWbMuv2', 'host'],
    ['https://user:pw@www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2', 'credentials'],
    ['https://www.figma.com:8443/design/aHvbMOTkjQ3dmWBoWbMuv2', 'port'],
    ['https://www.figma.com/board/aHvbMOTkjQ3dmWBoWbMuv2', 'path'],
    ['https://www.figma.com/design/short', 'file-key'],
    ['https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/x?node-id=abc', 'node-id'],
    ['not a url', 'not-a-url'],
  ])('rejects %s (%s)', (url, error) => expect(parseFigmaUrl(url)).toEqual({ ok: false, error }));
});

describe('buildNodeUrl', () => {
  it('round-trips through the parser', () => {
    const url = buildNodeUrl({ fileKey: 'aHvbMOTkjQ3dmWBoWbMuv2', slug: 'Food-Couriers' }, '12:34' as NodeId);
    expect(url).toBe('https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers?node-id=12-34');
    expect(parseFigmaUrl(url)).toMatchObject({ ok: true, value: { nodeId: '12:34' } });
  });
  it('builds branch URLs', () => {
    expect(buildNodeUrl({ fileKey: 'aHvbMOTkjQ3dmWBoWbMuv2', branchKey: 'BRANCHkey12345' }, '0:1' as NodeId)).toBe(
      'https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/branch/BRANCHkey12345?node-id=0-1',
    );
  });
});
