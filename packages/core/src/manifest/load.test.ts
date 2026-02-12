import { describe, expect, it } from 'vitest';
import { loadManifest } from './load.js';
import type { EnvLookup } from './types.js';

const URL = 'https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers?node-id=1-9400&p=f&t=x';
const noEnv: EnvLookup = () => undefined;
const load = (text: string, env: EnvLookup = noEnv) => loadManifest(text, 'figma.design.yaml', env);
const codes = (text: string, env?: EnvLookup) => load(text, env).diagnostics.map((d) => d.code);

const valid = `
schemaVersion: 1
project: { name: demo }
files:
  app:
    name: Main
    url: "${URL}"
refs:
  F7KQ9M2X4P6D:
    file: app
    nodeId: "1:666"
    name: Order details
    kind: screen
    tags: [checkout]
  8J3TD9PH6Q2W:
    file: app
    nodeId: "1:667"
    parentRef: F7KQ9M2X4P6D
`;

describe('loadManifest', () => {
  it('loads a valid manifest and normalises the file URL', () => {
    const r = load(valid);
    expect(r.state).toBe('ok');
    const file = r.manifest!.files.get('app')!;
    expect(file).toMatchObject({ fileKey: 'aHvbMOTkjQ3dmWBoWbMuv2', apiKey: 'aHvbMOTkjQ3dmWBoWbMuv2', state: 'ok' });
    expect(file.baseUrl).toBe('https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers');
    expect(r.manifest!.refs.get('8J3TD9PH6Q2W' as never)).toMatchObject({ parentRef: 'F7KQ9M2X4P6D', tags: [] });
    expect(r.manifest!.preview).toEqual({ format: 'png', scale: 1, ttlMinutes: 1440, hoverWidth: 360 });
    expect(r.manifest!.scan.exclude).toContain('**/node_modules/**');
  });

  it('resolves env placeholders and reports missing ones without failing other files', () => {
    const text = `schemaVersion: 1
files:
  app: { url: "\${env:FIGMA_FILE_URL}" }
  lib: { fileKey: LIBkey1234567 }
refs: {}`;
    const ok = load(text, (n) => (n === 'FIGMA_FILE_URL' ? URL : undefined));
    expect(ok.manifest!.files.get('app')).toMatchObject({ fileKey: 'aHvbMOTkjQ3dmWBoWbMuv2', envVar: 'FIGMA_FILE_URL' });
    const missing = load(text);
    expect(missing.state).toBe('warnings');
    expect(missing.diagnostics[0]).toMatchObject({ code: 'ENV_VAR_MISSING', data: { variable: 'FIGMA_FILE_URL' } });
    expect(missing.manifest!.files.get('app')!.state).toBe('env-missing');
    expect(missing.manifest!.files.get('lib')!.state).toBe('ok');
  });

  it('rejects env placeholders outside the FIGMA_ prefix', () => {
    expect(codes('schemaVersion: 1\nfiles:\n  app: { url: "${env:HOME}" }\nrefs: {}')).toContain('SCHEMA_VIOLATION');
  });

  it('reports YAML syntax errors with a range', () => {
    const r = load('schemaVersion: 1\nfiles: [\n');
    expect(r.state).toBe('invalid');
    expect(r.diagnostics[0]!.code).toBe('CONFIG_INVALID');
    expect(r.diagnostics[0]!.range).toBeDefined();
  });

  it('rejects duplicate YAML keys (duplicate ID definitions)', () => {
    const text = valid + '  F7KQ9M2X4P6D:\n    file: app\n    nodeId: "1:2"\n';
    expect(codes(text)).toContain('CONFIG_INVALID');
  });

  it('marks unknown schema versions read-only', () => {
    expect(load('schemaVersion: 2\nfiles: {}\nrefs: {}').state).toBe('unsupported-version');
  });

  it('points schema violations at the offending key', () => {
    const r = load(valid.replace('kind: screen', 'kind: screen\n    colour: red'));
    const d = r.diagnostics.find((x) => x.code === 'SCHEMA_VIOLATION')!;
    expect(d.message).toContain('colour');
    expect(d.range!.start.line).toBe(13); // zero-based; template starts with a newline
  });

  it.each([
    ['malformed ID key', valid.replace('8J3TD9PH6Q2W:', 'BAD-ID:'), 'SCHEMA_VIOLATION'],
    ['excluded letter in ID', valid.replace('8J3TD9PH6Q2W:', '8J3TD9PH6Q2U:'), 'SCHEMA_VIOLATION'],
    ['hyphenated node id', valid.replace('"1:666"', '"1-666"'), 'SCHEMA_VIOLATION'],
    ['both url and fileKey', valid.replace('name: Main', 'name: Main\n    fileKey: aHvbMOTkjQ3dmWBoWbMuv2'), 'SCHEMA_VIOLATION'],
    ['non-figma host', valid.replace(URL, 'https://evil.example/design/aHvbMOTkjQ3dmWBoWbMuv2/x'), 'SCHEMA_VIOLATION'],
    ['unknown alias', valid.replace('file: app\n    nodeId: "1:667"', 'file: web\n    nodeId: "1:667"'), 'UNKNOWN_FILE_ALIAS'],
    ['unknown parent', valid.replace('parentRef: F7KQ9M2X4P6D', 'parentRef: 000000000000'), 'UNKNOWN_PARENT_REF'],
    ['retired ID mapped', valid + 'retired: [F7KQ9M2X4P6D]\n', 'RETIRED_ID_IN_USE'],
    ['PAT in manifest', valid.replace('name: demo', 'name: figd_abcdefghijklmnop'), 'SECRET_IN_MANIFEST'],
  ])('%s → %s', (_label, text, code) => {
    const r = load(text);
    expect(r.state).toBe('invalid');
    expect(r.diagnostics.map((d) => d.code)).toContain(code);
    expect(r.manifest).toBeUndefined();
  });

  it('detects parent cycles', () => {
    const text = valid.replace('    kind: screen', '    kind: screen\n    parentRef: 8J3TD9PH6Q2W');
    const d = load(text).diagnostics.find((x) => x.code === 'PARENT_CYCLE')!;
    expect(d.message).toContain('8J3TD9PH6Q2W → F7KQ9M2X4P6D → 8J3TD9PH6Q2W');
  });

  it('warns (but loads) on duplicate node mappings and duplicate file keys', () => {
    const text = valid.replace('nodeId: "1:667"', 'nodeId: "1:666"').replace('refs:', '  web: { fileKey: aHvbMOTkjQ3dmWBoWbMuv2 }\nrefs:');
    const r = load(text);
    expect(r.state).toBe('warnings');
    expect(r.diagnostics.map((d) => d.code).sort()).toEqual(['DUPLICATE_FILE_KEY', 'DUPLICATE_MAPPING']);
  });

  it('refuses YAML alias bombs', () => {
    const bomb = 'a: &a ["x","x","x","x","x","x","x","x","x","x"]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\n';
    expect(load(bomb).state).toBe('invalid');
  });

  it('never throws on arbitrary input', () => {
    for (const s of ['', '~', '[]', '42', '!!js/function "x"', 'schemaVersion: 1', '\u0000']) expect(() => load(s)).not.toThrow();
  });
});

describe('numeric-looking IDs in YAML', () => {
  it('keeps 000000000000 and 1234E5678901 as strings', () => {
    const text = `schemaVersion: 1
files:
  app: { fileKey: aHvbMOTkjQ3dmWBoWbMuv2 }
refs:
  000000000000: { file: app, nodeId: "1:2" }
  1234E5678901: { file: app, nodeId: "1:3", parentRef: 000000000000 }
retired: [123456789012]
`;
    const r = loadManifest(text, 'figma.design.yaml', () => undefined);
    expect(r.state).toBe('ok');
    expect([...r.manifest!.refs.keys()]).toEqual(['000000000000', '1234E5678901']);
    expect(r.manifest!.refs.get('1234E5678901' as never)!.parentRef).toBe('000000000000');
    expect([...r.manifest!.retired]).toEqual(['123456789012']);
  });
});
