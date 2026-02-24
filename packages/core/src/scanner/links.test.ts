import { beforeAll, describe, expect, it } from 'vitest';
import { Scanner } from './scanner.js';
import { isLinkKey, matchDirectives, parseLinkKey } from './grammar.js';
import { ReferenceIndex } from '../index/reference-index.js';
import { loadManifest } from '../manifest/load.js';
import type { RefId } from '../ids.js';

const URL = 'https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers?node-id=1-520&t=abc-1';
let scanner: Scanner;
beforeAll(async () => {
  scanner = await Scanner.create();
});

describe('link annotations', () => {
  it('parses @figma <url> into a link target', () => {
    const [m] = matchDirectives(`/// @figma ${URL}`);
    expect(m).toMatchObject({ kind: 'ref', rawId: URL, link: { fileKey: 'aHvbMOTkjQ3dmWBoWbMuv2', nodeId: '1:520', apiKey: 'aHvbMOTkjQ3dmWBoWbMuv2', slug: 'Food-Couriers' } });
    expect(isLinkKey(m!.kind === 'ref' ? m!.refId : '')).toBe(true);
    expect(parseLinkKey('link:aHvbMOTkjQ3dmWBoWbMuv2/1:520')).toEqual({ apiKey: 'aHvbMOTkjQ3dmWBoWbMuv2', nodeId: '1:520' });
  });

  it('trims comment terminators and punctuation after the URL', () => {
    expect(matchDirectives(`/* @figma ${URL}*/`)[0]).toMatchObject({ rawId: URL });
    expect(matchDirectives(`{/* @figma ${URL} */}`)[0]).toMatchObject({ rawId: URL });
    expect(matchDirectives(`// see @figma ${URL}.`)[0]).toMatchObject({ rawId: URL });
  });

  it.each([
    ['https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food', /node-id/],
    ['https://evil.example/design/aHvbMOTkjQ3dmWBoWbMuv2/x?node-id=1-2', /figma\.com/],
    ['http://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/x?node-id=1-2', /https/],
  ])('reports a bad link %s', (url, reason) => {
    const [m] = matchDirectives(`// @figma ${url}`);
    expect(m!.kind).toBe('malformed');
    expect(m!.kind === 'malformed' && m!.reason).toMatch(reason);
  });

  it('attaches link annotations like ID annotations', () => {
    const r = scanner.scan({ relPath: 'lib/a.dart', text: `/// @figma ${URL}\nclass FoodCard extends StatelessWidget {}` });
    expect(r.occurrences.map((o) => [o.attachment, o.owner?.name, o.link?.nodeId])).toEqual([['declaration', 'FoodCard', '1:520']]);
  });

  it('resolves without a manifest and marks an equivalent mapping as used', () => {
    const index = new ReferenceIndex();
    index.setFile(scanner.scan({ relPath: 'a.ts', text: `// @figma ${URL}\nexport function Card() {}` }));
    const key = index.allOccurrences()[0]!.refId;
    const bare = index.resolve(key)!;
    expect(bare.openUrl).toBe('https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers?node-id=1-520');
    expect(bare.ref.nodeId).toBe('1:520');
    expect(index.diagnosticsFor('a.ts')).toEqual([]);

    const manifest = loadManifest(
      'schemaVersion: 1\nfiles:\n  app: { fileKey: aHvbMOTkjQ3dmWBoWbMuv2 }\nrefs:\n  CCCXJQAJNVHP: { file: app, nodeId: "1:520", name: Food card }\n',
      'figma.design.yaml',
      () => undefined,
    ).manifest!;
    index.setManifest(manifest);
    index.scanState = 'complete';
    expect(index.resolve(key)!.ref.name).toBe('Food card');
    expect(index.resolve(key)!.file.alias).toBe('app');
    expect(index.isUsed('CCCXJQAJNVHP' as RefId)).toBe(true);
    expect(index.health()).toMatchObject({ unresolvedOccurrences: 0, unusedMappings: 0 });
    expect(index.diagnosticsFor('a.ts')).toEqual([]);
  });
});
