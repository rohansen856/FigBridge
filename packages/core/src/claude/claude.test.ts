import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyTool, eventFromHook, nodeIdsFromUseFigmaResponse, parseEvent, parseFigmaToolName, type HookInput } from './events.js';
import { drainSpool, prune, spoolDirFor, SPOOL_MAX_FILES, writeEvent } from './spool.js';

const FIXTURES = join(__dirname, '../../../../fixtures/claude-hooks');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as HookInput;

describe('tool names', () => {
  it.each([
    ['mcp__plugin_figma_figma__use_figma', 'plugin_figma_figma', 'use_figma'],
    ['mcp__claude_ai_Figma__get_metadata', 'claude_ai_Figma', 'get_metadata'],
    ['mcp__figma-desktop__get_screenshot', 'figma-desktop', 'get_screenshot'],
    ['mcp__figma__upload_assets', 'figma', 'upload_assets'],
  ])('%s', (name, server, tool) => expect(parseFigmaToolName(name)).toEqual({ server, tool }));
  it.each(['mcp__github__create_issue', 'Bash', 'mcp__figbridge__resolve', 'mcp__memory__use_figma'])('ignores %s', (name) => {
    expect(parseFigmaToolName(name)).toBeUndefined();
  });
  it('classifies', () => {
    expect(['use_figma', 'get_screenshot', 'add_code_connect_map', 'create_new_file', 'weave_run_tool', 'brand_new_tool'].map(classifyTool)).toEqual([
      'mutation',
      'read',
      'metadata',
      'unrelated',
      'unrelated',
      'unknown',
    ]);
  });
});

describe('eventFromHook', () => {
  it('real failure payload → failure event, no secrets or payload text', () => {
    const e = eventFromHook(fixture('failure.claude-ai.use_figma.json'))!;
    expect(e).toMatchObject({ hookEvent: 'PostToolUseFailure', server: 'claude_ai_Figma', tool: 'use_figma', kind: 'mutation', result: 'failure', fileKey: 'aHvbMOTkjQ3dmWBoWbMuv2', target: 'file', nodeIds: [] });
    expect(e.error).toContain("don't have edit access");
    expect(e.error).not.toContain('https://');
    const s = JSON.stringify(e);
    for (const leaked of ['session_id', 'transcript', '00000000-0000-4000-8000-000000000001', 'script body', '/home/user']) expect(s).not.toContain(leaked);
    expect(parseEvent(s)).toEqual(e);
  });

  it('read failure is a read', () => {
    expect(eventFromHook(fixture('failure.claude-ai.get_metadata.json'))).toMatchObject({ kind: 'read', result: 'failure', nodeIds: ['1:666'], target: 'node' });
  });

  it('success with returned node IDs → node target', () => {
    expect(eventFromHook(fixture('success.plugin.use_figma.json'))).toMatchObject({ kind: 'mutation', result: 'success', nodeIds: ['1:666'], target: 'node' });
  });

  it('upload_assets nodeIds and hyphenated IDs are normalised', () => {
    const e = eventFromHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__figma__upload_assets', tool_input: { fileKey: 'aHvbMOTkjQ3dmWBoWbMuv2', nodeIds: ['1-2', 'bogus', 'I3:4;5:6'] }, tool_use_id: 'x' })!;
    expect(e.nodeIds).toEqual(['1:2', 'I3:4;5:6']);
  });

  it('rejects malformed file keys and non-Figma tools', () => {
    const e = eventFromHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__figma__use_figma', tool_input: { fileKey: '../../etc' } })!;
    expect(e.fileKey).toBeUndefined();
    expect(e.target).toBe('unknown');
    expect(eventFromHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} })).toBeUndefined();
    expect(eventFromHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__figma__use_figma' })).toBeUndefined();
  });

  it('same tool_use_id → same dedupe key', () => {
    const p = fixture('success.plugin.use_figma.json');
    expect(eventFromHook(p)!.dedupeKey).toBe(eventFromHook(p)!.dedupeKey);
    expect(eventFromHook(p)!.eventId).not.toBe(eventFromHook(p)!.eventId);
  });

  it('parses node IDs from use_figma responses in several shapes', () => {
    expect(nodeIdsFromUseFigmaResponse([{ type: 'text', text: '{"createdNodeIds":["5:1","5:2"],"mutatedNodeIds":["1-666"]}' }])).toEqual(['5:1', '5:2', '1-666']);
    expect(nodeIdsFromUseFigmaResponse({ content: [{ type: 'text', text: 'done' }] })).toEqual([]);
    expect(nodeIdsFromUseFigmaResponse({ mutatedNodeIds: ['7:8'] })).toEqual(['7:8']);
    expect(nodeIdsFromUseFigmaResponse(null)).toEqual([]);
  });
});

describe('parseEvent', () => {
  it.each([
    ['not json', 'nope'],
    ['extra field', JSON.stringify({ ...eventFromHook(fixture('success.plugin.use_figma.json')), command: 'rm -rf /' })],
    ['bad version', JSON.stringify({ ...eventFromHook(fixture('success.plugin.use_figma.json')), v: 2 })],
    ['oversize', 'x'.repeat(5000)],
  ])('rejects %s', (_l, text) => expect(parseEvent(text)).toBeUndefined());
});

describe('spool', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'figbridge-spool-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes atomically and drains in order', async () => {
    const spool = join(dir, 'spool');
    const a = eventFromHook(fixture('success.plugin.use_figma.json'))!;
    const b = eventFromHook(fixture('failure.claude-ai.use_figma.json'))!;
    await writeEvent(spool, a);
    await writeEvent(spool, b);
    expect((await readdir(spool)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    const r = await drainSpool(spool);
    expect(r.events.map((e) => e.event.eventId)).toEqual([a.eventId, b.eventId]);
    expect(await readdir(spool)).toEqual([]);
  });

  it('rejects forged or corrupt files and deletes them', async () => {
    const spool = join(dir, 'spool');
    await writeEvent(spool, eventFromHook(fixture('success.plugin.use_figma.json'))!);
    await writeFile(join(spool, `${Date.now()}-00000000-0000-4000-8000-000000000000.json`), '{"v":1,"command":"open https://evil"}');
    const r = await drainSpool(spool);
    expect(r.events).toHaveLength(1);
    expect(r.rejected).toBe(1);
  });

  it('refuses a symlinked spool directory', async () => {
    const real = join(dir, 'real');
    const link = join(dir, 'link');
    await writeEvent(real, eventFromHook(fixture('success.plugin.use_figma.json'))!);
    await symlink(real, link);
    await expect(writeEvent(link, eventFromHook(fixture('success.plugin.use_figma.json'))!)).rejects.toThrow(/plain directory/);
    expect((await drainSpool(link)).events).toEqual([]);
  });

  it('prunes to the file cap and max age', async () => {
    const spool = join(dir, 'spool');
    await writeEvent(spool, eventFromHook(fixture('success.plugin.use_figma.json'))!);
    for (let i = 0; i < SPOOL_MAX_FILES + 5; i++)
      await writeFile(join(spool, `${String(1_700_000_000_000 + i)}-00000000-0000-4000-8000-${String(i).padStart(12, '0')}.json`), '{}');
    await prune(spool, 1_700_000_000_000 + 1000);
    expect((await readdir(spool)).length).toBe(SPOOL_MAX_FILES);
    await prune(spool, Date.now() + 8 * 24 * 3600 * 1000);
    expect(await readdir(spool)).toEqual([]);
  });

  it('derives the same spool dir for the same manifest directory', async () => {
    expect(await spoolDirFor(dir, { XDG_STATE_HOME: '/x' })).toBe(await spoolDirFor(join(dir, '.'), { XDG_STATE_HOME: '/x' }));
    const spool = await spoolDirFor(dir, { XDG_STATE_HOME: '/x', LOCALAPPDATA: 'C:\\x' });
    expect(spool).toMatch(/figbridge[\\/]spool[\\/][0-9a-f]{16}$/);
    if (process.platform === 'linux') expect(spool.startsWith('/x/')).toBe(true);
  });
});
