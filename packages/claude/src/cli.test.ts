import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BIN = join(__dirname, '../marketplace/plugins/figbridge/dist/figbridge-claude.mjs');
const FIXTURES = join(__dirname, '../../../fixtures');
const SEED = 'figd_TESTSEEDTOKEN_must_never_appear_0123456789';
const URL = 'https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers?node-id=1-9400&p=f';

let work: string;
let demo: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'figbridge-cli-'));
  demo = join(work, 'demo');
  cpSync(join(FIXTURES, 'workspaces/demo'), demo, { recursive: true });
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('MCP server (bundled)', () => {
  let client: Client;
  let stderr = '';
  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, 'mcp'],
      cwd: join(demo, 'lib'),
      env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: join(demo, 'lib'), FIGMA_FILE_URL: URL, FIGMA_ACCESS_TOKEN: SEED, HOME: work },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d) => (stderr += String(d)));
    client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
  }, 20000);
  afterAll(async () => client?.close());

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).not.toContain(SEED);
    expect(text).not.toContain('figd_');
    return JSON.parse(text);
  };

  it('lists four read-only tools and instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['figbridge_health', 'figbridge_refs_for_source', 'figbridge_resolve_ref', 'figbridge_search_refs']);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    expect(client.getInstructions()).toContain('figbridge_resolve_ref');
  });

  it('resolves a known reference with node, URL and source locations', async () => {
    const r = await call('figbridge_resolve_ref', { refId: 'f7kq9m2x4p6d' });
    expect(r).toMatchObject({
      found: true,
      refId: 'F7KQ9M2X4P6D',
      name: 'Order details',
      nodeId: '1:666',
      figmaUrl: 'https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers?node-id=1-666',
      file: { alias: 'app', fileKey: 'aHvbMOTkjQ3dmWBoWbMuv2', resolved: true },
      childRefs: ['8J3TD9PH6Q2W'],
      scanState: 'complete',
    });
    expect(r.occurrences).toEqual([{ path: 'lib/screens/order_details.dart', line: 5, attachment: 'declaration', owner: 'OrderDetailsScreen', ownerKind: 'class_definition' }]);
  });

  it('returns an explicit not-found for unknown and retired IDs (never a guess)', async () => {
    expect(await call('figbridge_resolve_ref', { refId: 'ZZZZZZZZZZZ9' })).toMatchObject({ found: false, reason: 'not-in-manifest', occurrences: [{ path: 'lib/widgets/pattern.dart' }] });
    expect(await call('figbridge_resolve_ref', { refId: 'RETRD0000001' })).toMatchObject({ found: false, reason: 'retired' });
    expect(await call('figbridge_resolve_ref', { refId: 'not an id' })).toMatchObject({ found: false, reason: 'invalid-id' });
  });

  it('resolves a Figma link to its manifest mapping and code locations', async () => {
    const r = await call('figbridge_resolve_ref', { refId: 'https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food?node-id=1-666&t=x' });
    expect(r).toMatchObject({ found: true, refId: 'F7KQ9M2X4P6D', name: 'Order details', nodeId: '1:666' });
    expect(r.occurrences[0]).toMatchObject({ path: 'lib/screens/order_details.dart' });
    expect(await call('figbridge_resolve_ref', { refId: 'https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food' })).toMatchObject({ found: false, reason: 'invalid-link' });
  });

  it('searches and pages', async () => {
    expect((await call('figbridge_search_refs', { status: 'unused' })).results.map((r: { refId: string }) => r.refId)).toEqual(['Q1R2S3T4V5W6']);
    expect((await call('figbridge_search_refs', { status: 'unresolved' })).results.map((r: { refId: string }) => r.refId)).toEqual(['RETRD0000001', 'ZZZZZZZZZZZ9']);
    expect((await call('figbridge_search_refs', { query: 'BackgroundPattern' })).results.map((r: { refId: string }) => r.refId)).toEqual(['8J3TD9PH6Q2W']);
    const page = await call('figbridge_search_refs', { limit: 2 });
    expect(page).toMatchObject({ total: 6, nextCursor: 2 });
    expect(page.results).toHaveLength(2);
  });

  it('finds references for a source line and rejects path traversal', async () => {
    const r = await call('figbridge_refs_for_source', { path: 'lib/screens/order_details.dart', line: 14 });
    expect(r.results.map((x: { refId: string; attachment: string }) => `${x.refId}:${x.attachment}`)).toEqual(['F7KQ9M2X4P6D:declaration', '8J3TD9PH6Q2W:usage']);
    for (const path of ['../../etc/passwd', '/etc/passwd', 'lib/../../x', 'C:\\Windows\\win.ini']) expect(await call('figbridge_refs_for_source', { path })).toMatchObject({ error: 'invalid-path' });
    expect((await call('figbridge_refs_for_source', { path: 'node_modules/pkg/index.js' })).results).toEqual([]);
  });

  it('reports health without leaking environment values', async () => {
    const h = await call('figbridge_health');
    expect(h.totals).toMatchObject({ occurrences: 9, unresolvedOccurrences: 2, unusedMappings: 1 });
    expect(h.projects).toHaveLength(1);
    expect(JSON.stringify(h)).not.toContain(work);
    expect(stderr).not.toContain(SEED);
  });
});

describe('MCP server started above nested manifests', () => {
  let client: Client;
  beforeAll(async () => {
    // work/ has no manifest; work/demo/ has one; work/loose.ts uses a link annotation.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(work, 'loose.ts'), '// @figma https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food?node-id=1-81\nexport const Splash = () => null;\n');
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: work, env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: work, FIGMA_FILE_URL: URL, HOME: work } });
    client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
  }, 20000);
  afterAll(async () => client?.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as Array<{ text: string }>)[0]!.text);

  it('discovers the nested project and prefixes its paths', async () => {
    const r = await call('figbridge_resolve_ref', { refId: 'F7KQ9M2X4P6D' });
    expect(r).toMatchObject({ found: true, project: 'demo/', nodeId: '1:666' });
    expect(r.occurrences[0].path).toBe('demo/lib/screens/order_details.dart');
    const src = await call('figbridge_refs_for_source', { path: 'demo/lib/screens/order_details.dart' });
    expect(src).toMatchObject({ path: 'demo/lib/screens/order_details.dart', project: 'demo/' });
    expect(src.results).toHaveLength(2);
  });

  it('resolves link annotations outside any manifest and reports per-project health', async () => {
    const src = await call('figbridge_refs_for_source', { path: 'loose.ts' });
    expect(src.results[0]).toMatchObject({ found: true, nodeId: '1:81', attachment: 'declaration', owner: 'Splash' });
    const h = await call('figbridge_health');
    expect(h.projects.map((p: { project: string }) => p.project).sort()).toEqual(['.', 'demo/']);
    expect(h.totals.occurrences).toBe(10);
  });
});

function runHook(payload: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, 'hook'], { env: { PATH: process.env.PATH ?? '', ...env } });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += String(d)));
    p.on('close', (code) => resolve({ code, stdout }));
    p.stdin.end(payload);
  });
}

describe('hook (bundled)', () => {
  it('writes one sanitised event to the per-user spool and prints nothing', async () => {
    const state = join(work, 'state');
    const payload = readFileSync(join(FIXTURES, 'claude-hooks/failure.claude-ai.use_figma.json'), 'utf8');
    const r = await runHook(payload, { CLAUDE_PROJECT_DIR: demo, XDG_STATE_HOME: state, HOME: work });
    expect(r).toEqual({ code: 0, stdout: '' });
    const spoolRoot = join(state, 'figbridge', 'spool');
    const [dir] = readdirSync(spoolRoot);
    const files = readdirSync(join(spoolRoot, dir!));
    expect(files).toHaveLength(1);
    const event = JSON.parse(readFileSync(join(spoolRoot, dir!, files[0]!), 'utf8'));
    expect(event).toMatchObject({ tool: 'use_figma', result: 'failure', fileKey: 'aHvbMOTkjQ3dmWBoWbMuv2' });
    expect(JSON.stringify(event)).not.toContain('session');
  });

  it.each([
    ['garbage stdin', 'not json'],
    ['non-figma tool', JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })],
    ['empty', ''],
  ])('exits 0 silently on %s', async (_l, payload) => {
    expect(await runHook(payload, { CLAUDE_PROJECT_DIR: demo, XDG_STATE_HOME: join(work, 'state2'), HOME: work })).toEqual({ code: 0, stdout: '' });
  });

  it('does nothing outside a FigBridge project', async () => {
    const payload = readFileSync(join(FIXTURES, 'claude-hooks/success.plugin.use_figma.json'), 'utf8');
    const state = join(work, 'state3');
    expect(await runHook(payload, { CLAUDE_PROJECT_DIR: tmpdir(), XDG_STATE_HOME: state, HOME: work })).toEqual({ code: 0, stdout: '' });
    expect(() => readdirSync(join(state, 'figbridge', 'spool'))).toThrow();
  });
});
