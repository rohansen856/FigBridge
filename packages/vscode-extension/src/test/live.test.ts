import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';

// Live Figma round trip inside VS Code. Runs only with FIGMA_LIVE_ENV pointing at a .env file
// that contains FIGMA_ACCESS_TOKEN; the token goes into this throwaway profile's SecretStorage.
const envFile = process.env.FIGMA_LIVE_ENV;

(envFile ? suite : suite.skip)('FigBridge live (Figma API)', () => {
  suiteTeardown(async () => {
    const api: any = await vscode.extensions.getExtension('rohansen856.figbridge')!.activate();
    await api.workspace.tokens.clear();
  });
  test('hover renders the exact node image from cache after the first fetch', async function () {
    this.timeout(90000);
    const line = readFileSync(envFile!, 'utf8').split(/\r?\n/).find((l) => l.startsWith('FIGMA_ACCESS_TOKEN='))!;
    const token = line.slice('FIGMA_ACCESS_TOKEN='.length).trim().replace(/^(['"])(.*)\1$/, '$2');
    const api: any = await vscode.extensions.getExtension('rohansen856.figbridge')!.activate();
    await api.workspace.tokens.set(token);
    const root = vscode.workspace.workspaceFolders![0]!.uri;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'lib/screens/order_details.dart'));
    const lineNo = doc.getText().split('\n').findIndex((l) => l.includes('@figma F7KQ9M2X4P6D'));
    const pos = new vscode.Position(lineNo, doc.lineAt(lineNo).text.indexOf('F7KQ9M2X4P6D') + 2);
    const text = async () =>
      (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos))
        .flatMap((h) => h.contents.map((c: any) => (typeof c === 'string' ? c : c.value)))
        .join('\n');
    const first = await text();
    assert.match(first, /Order details/);
    let latest = first;
    const end = Date.now() + 60000;
    while (!/!\[.*\]\(file:\/\/.*\.png\|width=\d+\)/.test(latest) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 1000));
      latest = await text();
    }
    assert.match(latest, /!\[Order details\]\(file:\/\/.*\.png\|width=360\)/, latest);
    assert.match(latest, /Rendered just now/);
    assert.ok(!latest.includes(token));
    // Deleted node: W2X4Y6Z8A0B2 maps to 999:999.
    const menu = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'web/src/Menu.tsx'));
    const l2 = menu.getText().split('\n').findIndex((l) => l.includes('@figma W2X4Y6Z8A0B2'));
    const hoverMissing = async () =>
      (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', menu.uri, new vscode.Position(l2, 12)))
        .flatMap((h) => h.contents.map((c: any) => (typeof c === 'string' ? c : c.value)))
        .join('\n');
    let missing = await hoverMissing();
    const end2 = Date.now() + 60000;
    while (!/no longer exists|does not exist/.test(missing) && Date.now() < end2) {
      await new Promise((r) => setTimeout(r, 1000));
      missing = await hoverMissing();
    }
    assert.match(missing, /does not exist in this file any more/);
    await api.workspace.tokens.clear();
  });
});
