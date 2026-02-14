import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Scanner } from './scanner/scanner.js';
import { findManifestRoot, isInside, scanWorkspace } from './workspace.js';
import type { RefId } from './ids.js';

const DEMO = join(__dirname, '../../../fixtures/workspaces/demo');
const URL = 'https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers?node-id=1-9400&p=f';
let scanner: Scanner;
beforeAll(async () => {
  scanner = await Scanner.create();
});

describe('scanWorkspace(demo)', () => {
  it('computes exact health counts and skips excluded directories', async () => {
    const { index, manifest } = await scanWorkspace(DEMO, scanner, { env: { FIGMA_FILE_URL: URL } });
    expect(manifest.state).toBe('ok');
    expect(index.health()).toEqual({
      scanState: 'complete',
      manifestPresent: true,
      occurrences: 9,
      uniqueIdsUsed: 7,
      resolvedOccurrences: 7,
      unresolvedOccurrences: 2,
      malformedDirectives: 1,
      mappings: 6,
      unusedMappings: 1,
      deprecatedInUse: 0,
      duplicateMappings: 0,
      invalidNodes: 0,
      inaccessibleFiles: 0,
      unresolvedFiles: 0,
      filesScanned: 3,
      filesWithSyntaxErrors: 0,
      fileLevelOnly: 0,
    });
    expect(index.allOccurrences().some((o) => o.relPath.startsWith('node_modules') || o.relPath.startsWith('build'))).toBe(false);
  });

  it('resolves references to open URLs and lists occurrences', async () => {
    const { index } = await scanWorkspace(DEMO, scanner, { env: { FIGMA_FILE_URL: URL } });
    const r = index.resolve('F7KQ9M2X4P6D' as RefId)!;
    expect(r.openUrl).toBe('https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers?node-id=1-666');
    expect(index.occurrencesFor('8J3TD9PH6Q2W' as RefId).map((o) => `${o.relPath}:${o.attachment}`).sort()).toEqual([
      'lib/screens/order_details.dart:usage',
      'lib/widgets/pattern.dart:declaration',
    ]);
    expect(index.logicalChildren('F7KQ9M2X4P6D' as RefId).map((r) => r.id)).toEqual(['8J3TD9PH6Q2W']);
  });

  it('reports per-file diagnostics including retired and non-canonical IDs', async () => {
    const { index } = await scanWorkspace(DEMO, scanner, { env: { FIGMA_FILE_URL: URL } });
    const diags = index.diagnosticsFor('web/src/Menu.tsx').map((d) => `${d.code}@${d.range!.start.line + 1}`);
    expect(diags).toEqual(['MALFORMED_DIRECTIVE@15', 'NONCANONICAL_CASE@3', 'UNRESOLVED_REF@12']);
    expect(index.diagnosticsFor('web/src/Menu.tsx').find((d) => d.code === 'UNRESOLVED_REF')!.severity).toBe('error');
  });

  it('withholds "unused" while the scan is partial and reports invalid nodes from remote checks', async () => {
    const { index } = await scanWorkspace(DEMO, scanner, { env: { FIGMA_FILE_URL: URL } });
    index.scanState = 'partial';
    expect(index.health().unusedMappings).toBeUndefined();
    expect(index.problems().some((p) => p.kind === 'unused')).toBe(false);
    index.setNodeState('W2X4Y6Z8A0B2' as RefId, 'missing');
    expect(index.health().invalidNodes).toBe(1);
    expect(index.problems().find((p) => p.kind === 'invalid-node')).toMatchObject({ code: 'NODE_NOT_FOUND', refId: 'W2X4Y6Z8A0B2' });
  });

  it('builds the source tree with usage nested under its screen', async () => {
    const { index } = await scanWorkspace(DEMO, scanner, { env: { FIGMA_FILE_URL: URL } });
    const order = index.sourceTree().find((n) => n.occurrence.relPath === 'lib/screens/order_details.dart')!;
    expect(order.occurrence.refId).toBe('F7KQ9M2X4P6D');
    expect(order.children.map((c) => [c.occurrence.refId, c.occurrence.attachment])).toEqual([['8J3TD9PH6Q2W', 'usage']]);
  });

  it('treats an unset env placeholder as an unresolved file, not a crash', async () => {
    const { index } = await scanWorkspace(DEMO, scanner, { env: {} });
    expect(index.health().unresolvedFiles).toBe(1);
    expect(index.resolve('F7KQ9M2X4P6D' as RefId)!.openUrl).toBeUndefined();
  });

  it('takenIds covers manifest, retired and source IDs', async () => {
    const { index } = await scanWorkspace(DEMO, scanner, { env: { FIGMA_FILE_URL: URL } });
    const taken = index.takenIds();
    for (const id of ['F7KQ9M2X4P6D', 'RETRD0000001', 'ZZZZZZZZZZZ9', 'Q1R2S3T4V5W6']) expect(taken.has(id)).toBe(true);
  });
});

describe('paths', () => {
  it('finds the manifest root from a nested directory', () => {
    expect(findManifestRoot(join(DEMO, 'lib/screens'))).toBe(DEMO);
  });
  it('isInside rejects escapes', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
  });
});
