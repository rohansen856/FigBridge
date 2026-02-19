import { describe, expect, it } from 'vitest';
import { loadManifest, type NodeId, type RefId } from '@figbridge/core';
import { addFile, addRef, MANIFEST_TEMPLATE, retargetRef, retireRef } from './manifest-edit';

const base = `# team manifest — keep this comment
schemaVersion: 1
files:
  app:
    url: "https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food"
refs:
  # screens
  F7KQ9M2X4P6D:
    file: app
    nodeId: "1:666"
    name: Order details
  8J3TD9PH6Q2W: { file: app, nodeId: "1:667", parentRef: F7KQ9M2X4P6D }
`;
const valid = (text: string) => loadManifest(text, 'figma.design.yaml', () => undefined);

describe('manifest edits', () => {
  it('adds a ref and keeps comments and validity', () => {
    const out = addRef(base, { id: 'H2C4N6P8R0T2' as RefId, file: 'app', nodeId: '1:625' as NodeId, name: 'Detail menu', kind: 'screen' });
    expect(out).toContain('# team manifest — keep this comment');
    expect(out).toContain('# screens');
    expect(out).toMatch(/H2C4N6P8R0T2:\n {4}file: app\n {4}nodeId: "1:625"\n {4}name: Detail menu\n {4}kind: screen/);
    expect(valid(out).state).toBe('ok');
  });

  it('refuses duplicate IDs', () => {
    expect(() => addRef(base, { id: 'F7KQ9M2X4P6D' as RefId, file: 'app', nodeId: '1:1' as NodeId })).toThrow(/already exists/);
  });

  it('adds refs to an empty flow map from the template', () => {
    const t = MANIFEST_TEMPLATE('app', 'https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food', 'demo');
    expect(valid(t).state).toBe('ok');
    const out = addRef(t, { id: 'H2C4N6P8R0T2' as RefId, file: 'app', nodeId: '1:625' as NodeId });
    expect(valid(out).manifest!.refs.size).toBe(1);
  });

  it('retargets a ref', () => {
    const out = retargetRef(base, 'F7KQ9M2X4P6D' as RefId, 'app', '1:9400' as NodeId);
    expect(valid(out).manifest!.refs.get('F7KQ9M2X4P6D' as RefId)!.nodeId).toBe('1:9400');
    expect(out).toContain('name: Order details');
  });

  it('retires a ref, clears dangling parentRef and records the ID', () => {
    const out = retireRef(base, 'F7KQ9M2X4P6D' as RefId);
    const m = valid(out);
    expect(m.state).toBe('ok');
    expect(m.manifest!.refs.has('F7KQ9M2X4P6D' as RefId)).toBe(false);
    expect([...m.manifest!.retired]).toEqual(['F7KQ9M2X4P6D']);
    expect(m.manifest!.refs.get('8J3TD9PH6Q2W' as RefId)!.parentRef).toBeUndefined();
  });

  it('adds a file alias', () => {
    const out = addFile(base, 'lib', 'https://www.figma.com/design/LIBkey1234567/Lib');
    expect(valid(out).manifest!.files.get('lib')!.fileKey).toBe('LIBkey1234567');
  });

  it('rejects edits to a manifest with YAML errors', () => {
    expect(() => addRef('refs: [', { id: 'H2C4N6P8R0T2' as RefId, file: 'app', nodeId: '1:1' as NodeId })).toThrow(/YAML errors/);
  });
});
