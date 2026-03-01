import * as assert from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

let api: any;
const root = () => vscode.workspace.workspaceFolders![0]!.uri;
const project = () => api.workspace.forUri(vscode.Uri.joinPath(root(), 'figma.design.yaml')).project;

async function until<T>(fn: () => T | undefined | false, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

function hoverText(hovers: vscode.Hover[]): string {
  return hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))).join('\n');
}

suite('FigBridge extension', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('figbridge.figbridge')!;
    api = await ext.activate();
    await until(() => project().index.scanState === 'complete');
  });

  test('indexes the demo workspace with exact counts', () => {
    const h = project().index.health();
    assert.strictEqual(h.occurrences, 9);
    assert.strictEqual(h.uniqueIdsUsed, 7);
    assert.strictEqual(h.unresolvedOccurrences, 2);
    assert.strictEqual(h.malformedDirectives, 1);
    assert.strictEqual(h.unusedMappings, 1);
    assert.strictEqual(h.unresolvedFiles, 0, 'FIGMA_FILE_URL from the environment resolves the file');
  });

  test('hover on a resolved ID shows its name and asks for a token (no token in test profile)', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root(), 'lib/screens/order_details.dart'));
    const line = doc.getText().split('\n').findIndex((l) => l.includes('@figma F7KQ9M2X4P6D'));
    const col = doc.lineAt(line).text.indexOf('F7KQ9M2X4P6D') + 3;
    const text = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(line, col)));
    assert.match(text, /Order details/);
    assert.match(text, /Set a Figma access token/);
    assert.match(text, /command:figbridge\.open/);
  });

  test('hover shows a cached image even without a token (offline-first)', async () => {
    const entry = [...api.workspace.projects.values()][0];
    const resolved = entry.project.index.resolve('H2C4N6P8R0T2');
    const req = entry.previews.request(resolved);
    // Minimal PNG header (1x1); enough for the cache and the hover markup.
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
    await entry.previews.cache.put(req, new Uint8Array(png), 'v1');
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root(), 'web/src/Menu.tsx'));
    const text = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 12)));
    assert.match(text, /!\[Detail menu\]\(file:\/\/.*\.png\|width=1\)/);
    assert.match(text, /to refresh the preview/);
  });

  test('a Starter-plan file is not rendered on hover and offers Render all previews', async () => {
    const entry = api.workspace.forUri(vscode.Uri.joinPath(root(), 'figma.design.yaml'));
    const key = 'aHvbMOTkjQ3dmWBoWbMuv2';
    entry.previews.cache.setQuota(key, { low: true, planTier: 'starter', blockedUntil: Date.now() + 3 * 86400_000, updatedAt: Date.now() });
    await api.workspace.tokens.set('figd_fake_token_for_tests_only');
    try {
      const before = api.workspace.client.requestCount;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root(), 'web/src/Menu.tsx'));
      const line = doc.getText().split('\n').findIndex((l) => l.includes('@figma K4M6P8R0T2V4') && !l.includes('{/*'));
      const text = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(line, 14)));
      assert.match(text, /Starter plan/);
      assert.match(text, /command:figbridge\.renderAll/);
      assert.match(text, /renders again in 3 d|renders again in 7\d h/);
      assert.strictEqual(api.workspace.client.requestCount, before, 'no Figma request on hover');
    } finally {
      await api.workspace.tokens.clear();
      entry.previews.cache.setQuota(key, { low: false, updatedAt: Date.now() });
    }
  });

  test('hover on an unresolved ID explains it', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root(), 'lib/widgets/pattern.dart'));
    const line = doc.getText().split('\n').findIndex((l) => l.includes('ZZZZZZZZZZZ9'));
    const text = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(line, 12)));
    assert.match(text, /Unknown Figma reference/);
  });

  test('no hover inside a string literal', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: 'const s = "@figma F7KQ9M2X4P6D";' });
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 22));
    assert.ok(!hoverText(hovers).includes('Order details'));
  });

  test('CodeLens appears above annotated declarations', async () => {
    const uri = vscode.Uri.joinPath(root(), 'web/src/Menu.tsx');
    await vscode.workspace.openTextDocument(uri); // provider commands need a loaded document
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri, 10);
    const titles = lenses.map((l) => l.command?.title ?? '');
    assert.ok(titles.some((t) => t.includes('Detail menu')), titles.join(' | '));
    assert.ok(titles.includes('Open in Figma'));
  });

  test('publishes diagnostics with quick fixes', async () => {
    const uri = vscode.Uri.joinPath(root(), 'web/src/Menu.tsx');
    await vscode.workspace.openTextDocument(uri);
    const diags = await until(() => {
      const d = vscode.languages.getDiagnostics(uri);
      return d.length >= 3 && d;
    });
    const codes = diags.map((d) => String(d.code)).sort();
    assert.deepStrictEqual(codes, ['MALFORMED_DIRECTIVE', 'NONCANONICAL_CASE', 'UNRESOLVED_REF']);
    const lower = diags.find((d) => d.code === 'NONCANONICAL_CASE')!;
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, lower.range);
    assert.ok(actions.some((a) => a.title === 'Change to K4M6P8R0T2V4'));
  });

  test('editing source updates the index', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root(), 'web/src/Menu.tsx'));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// @figma Q1R2S3T4V5W6\nexport const Splash = () => null;\n'));
    await until(() => project().index.health().unusedMappings === 0);
    await vscode.commands.executeCommand('undo');
    await until(() => project().index.health().unusedMappings === 1);
  });

  test('an invalid manifest edit keeps the last valid manifest', async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root(), 'figma.design.yaml'));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), 'refs: [\n'));
    await until(() => project().state === 'invalid');
    assert.ok(project().manifest, 'last-known-good manifest retained');
    assert.ok(project().index.resolve('F7KQ9M2X4P6D'));
    await vscode.commands.executeCommand('undo');
    await until(() => project().state === 'ok');
  });

  test('a @figma link annotation resolves without an ID and reuses the mapped name', async () => {
    const uri = vscode.Uri.joinPath(root(), 'web/src/Linked.tsx');
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('// @figma https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food?node-id=1-666&t=x\nexport const Linked = () => null;\n'));
    await until(() => project().index.occurrencesIn('web/src/Linked.tsx').length === 1);
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = hoverText(await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 40)));
    assert.match(text, /Order details/);
    assert.match(text, /direct link/);
    assert.strictEqual(vscode.languages.getDiagnostics(uri).length, 0);
    await vscode.workspace.fs.delete(uri);
  });

  test('a nested figma.design.yaml becomes its own project', async () => {
    const sub = vscode.Uri.joinPath(root(), 'packages/shop');
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(sub, 'Card.tsx'), new TextEncoder().encode('// @figma 8J3TD9PH6Q2W\nexport const Card = () => null;\n'));
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(sub, 'figma.design.yaml'),
      new TextEncoder().encode('schemaVersion: 1\nfiles:\n  app: { fileKey: aHvbMOTkjQ3dmWBoWbMuv2 }\nrefs:\n  8J3TD9PH6Q2W: { file: app, nodeId: "1:667", name: Shop card }\n'),
    );
    const nested = await until(() => {
      const p = api.workspace.forUri(vscode.Uri.joinPath(sub, 'Card.tsx'))?.project;
      return p && p.root.toString() === sub.toString() && p.index.occurrencesIn('Card.tsx').length === 1 && p;
    });
    assert.strictEqual(nested.index.resolve('8J3TD9PH6Q2W').ref.name, 'Shop card');
    await until(() => project().index.occurrencesIn('packages/shop/Card.tsx').length === 0);
    await vscode.workspace.fs.delete(sub, { recursive: true });
  });

  test('Claude hook events invalidate previews and failures are never shown as updates', async () => {
    const dir = await until(() => api.activity.spoolDirectories()[0] as string | undefined);
    mkdirSync(dir, { recursive: true });
    const event = (over: Record<string, unknown>) => ({
      v: 1,
      eventId: randomUUID(),
      ts: new Date().toISOString(),
      hookEvent: 'PostToolUse',
      server: 'plugin_figma_figma',
      tool: 'use_figma',
      kind: 'mutation',
      result: 'success',
      fileKey: 'aHvbMOTkjQ3dmWBoWbMuv2',
      nodeIds: ['1:666'],
      target: 'node',
      dedupeKey: createHash('sha256').update(randomUUID()).digest('hex').slice(0, 16),
      ...over,
    });
    const write = (e: Record<string, unknown>) => writeFileSync(join(dir, `${Date.now()}-${e.eventId}.json`), JSON.stringify(e));
    write(event({}));
    const ok = await until(() => api.activity.records().find((r: any) => r.status === 'stale'));
    assert.ok(ok.refIds.includes('F7KQ9M2X4P6D'));
    write(event({ hookEvent: 'PostToolUseFailure', result: 'failure', error: 'no edit access' }));
    const failed = await until(() => api.activity.records().find((r: any) => r.result === 'failure'));
    assert.strictEqual(failed.status, 'failed');
    write(event({ fileKey: undefined, target: 'unknown', nodeIds: [] }));
    await until(() => api.activity.records().find((r: any) => r.status === 'target-unknown'));
    writeFileSync(join(dir, `${Date.now()}-${randomUUID()}.json`), '{"v":1,"command":"rm -rf /"}');
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(api.activity.records().length, 3, 'forged event ignored');
  });
});
