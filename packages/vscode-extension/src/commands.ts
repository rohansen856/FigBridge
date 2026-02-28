import * as vscode from 'vscode';
import {
  formatDirective,
  generateUniqueRefId,
  isLinkKey,
  isRefId,
  MANIFEST_FILENAME,
  normalizeNodeId,
  parseFigmaUrl,
  type NodeId,
  type ParsedFigmaUrl,
  type RefId,
  type RefKind,
} from '@figbridge/core';
import type { FigBridgeWorkspace, Located } from './workspace';
import type { PreviewPanel } from './preview-panel';
import type { ActivityLog } from './activity';
import type { ReferencesProvider } from './views';
import type { Project } from './project';
import { addFile, addRef, MANIFEST_TEMPLATE, retargetRef, retireRef } from './manifest-edit';
import { describeError, formatDuration } from './format';
import { setupClaude } from './claude-setup';

type RefArg = RefId | string | { refId?: RefId } | undefined;

export interface CommandDeps {
  context: vscode.ExtensionContext;
  ws: FigBridgeWorkspace;
  panel: PreviewPanel;
  activity: ActivityLog;
  references: ReferencesProvider;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { ws, panel, activity, references, context } = deps;
  const reg = (id: string, fn: (...args: never[]) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: never[]) => {
      try {
        return await fn(...args);
      } catch (e) {
        void vscode.window.showErrorMessage(`FigBridge: ${(e as Error).message}`);
      }
    });

  /** Resolves a command argument (ID string, tree node, or the annotation under the cursor). */
  function locate(arg: RefArg): Located | undefined {
    const id = typeof arg === 'string' ? arg : arg?.refId;
    if (id && (isRefId(id) || isLinkKey(id))) return ws.byRefId(id as RefId);
    const editor = vscode.window.activeTextEditor;
    if (editor) return ws.locate(editor.document, editor.selection.active);
    if (panel.currentRef) return ws.byRefId(panel.currentRef);
    return undefined;
  }

  function requireLocated(arg: RefArg): Located {
    const l = locate(arg);
    if (!l) throw new Error('Place the cursor on a @figma reference or pick one in the FigBridge view.');
    return l;
  }

  return [
    reg('figbridge.open', async (arg: RefArg) => {
      const l = requireLocated(arg);
      if (!l.resolved) throw new Error(`${l.refId} is not in the manifest.`);
      if (!l.resolved.openUrl) throw new Error(`The Figma file "${l.resolved.file.alias}" can't be resolved${l.resolved.file.envVar ? ` (set ${l.resolved.file.envVar})` : ''}.`);
      await openDesign(l);
    }),

    reg('figbridge.preview', async (arg: RefArg) => panel.show(requireLocated(arg))),

    reg('figbridge.refresh', async (arg: RefArg) => {
      const l = requireLocated(arg);
      if (!l.resolved) throw new Error(`${l.refId} is not in the manifest.`);
      const req = l.previews.request(l.resolved);
      if (!req) throw new Error('This reference has no resolvable Figma file.');
      if (!(await ws.tokens.has())) return promptForToken();
      if (panel.currentRef === l.refId) return panel.show(l, true);
      const status = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Rendering ${l.resolved.ref.name ?? l.refId}` }, () =>
        l.previews.service.ensure(req, { force: true }),
      );
      if (status.state === 'error') void vscode.window.showWarningMessage(`FigBridge: ${describeError(status.error)}`);
    }),

    reg('figbridge.refreshFile', async (arg?: { fileAlias?: string }) => {
      for (const { project, previews } of ws.active())
        for (const f of project.manifest?.files.values() ?? []) if (f.apiKey && (!arg?.fileAlias || f.alias === arg.fileAlias)) previews.service.invalidateFile(f.apiKey, 'manual');
      void vscode.window.showInformationMessage('FigBridge: previews will re-render the next time you view them.');
    }),

    reg('figbridge.refreshAll', async () => {
      for (const { previews } of ws.active()) previews.cache.markStale(() => true, 'manual');
      void vscode.window.showInformationMessage('FigBridge: all cached previews marked for refresh.');
    }),

    reg('figbridge.validateMappings', () => validateMappings(ws)),
    reg('figbridge.renderAll', (apiKey?: string) => renderAll(ws, typeof apiKey === 'string' ? apiKey : undefined)),

    reg('figbridge.rescan', async () => {
      for (const { project } of ws.projects.values()) await project.reloadManifest(true);
    }),

    reg('figbridge.setToken', promptForToken),

    reg('figbridge.forgetToken', async () => {
      const ok = await vscode.window.showWarningMessage(
        'Remove the Figma access token from VS Code secret storage? Mappings keep working; previews stop until you set a token again. You can also revoke the token in Figma → Settings → Security.',
        { modal: true },
        'Forget Token',
      );
      if (ok) {
        await ws.tokens.clear();
        void vscode.window.showInformationMessage('FigBridge: token removed.');
      }
    }),

    reg('figbridge.insertReference', () => insertReference(ws)),
    reg('figbridge.createMapping', (arg: RefArg) => createMapping(ws, typeof arg === 'string' ? arg : arg?.refId)),
    reg('figbridge.retargetMapping', (arg: RefArg) => retargetMapping(requireLocated(arg))),
    reg('figbridge.retireMapping', (arg: RefArg) => retireMapping(requireLocated(arg))),

    reg('figbridge.copyAnnotation', async (arg: RefArg) => {
      const l = requireLocated(arg);
      await vscode.env.clipboard.writeText(`@figma ${l.refId}`);
      vscode.window.setStatusBarMessage(`Copied @figma ${l.refId}`, 2500);
    }),

    reg('figbridge.copyFigmaUrl', async (arg: RefArg) => {
      const url = requireLocated(arg).resolved?.openUrl;
      if (!url) throw new Error('No Figma URL is available for this reference.');
      await vscode.env.clipboard.writeText(url);
      vscode.window.setStatusBarMessage('Copied Figma URL', 2500);
    }),

    reg('figbridge.revealInManifest', async (arg: RefArg) => {
      const l = requireLocated(arg);
      const r = l.resolved?.ref.range;
      if (!r && !l.project.manifest) throw new Error('This annotation links to Figma directly; it has no manifest entry.');
      await vscode.window.showTextDocument(l.project.manifestUri, r ? { selection: new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character) } : {});
    }),

    reg('figbridge.findReference', () => findReference(ws)),
    reg('figbridge.groupByFile', () => references.setGroupBy('file')),
    reg('figbridge.groupBySource', () => references.setGroupBy('source')),

    reg('figbridge.openManifest', async (folder?: vscode.Uri) => {
      const project = folder ? ws.projects.get(folder.toString())?.project : ws.active().find((p) => p.project.manifest)?.project;
      if (!project) return vscode.commands.executeCommand('figbridge.createManifest');
      await vscode.window.showTextDocument(project.manifestUri);
    }),

    reg('figbridge.createManifest', () => createManifest(ws)),

    reg('figbridge.clearCache', async () => {
      let n = 0;
      for (const { previews } of ws.projects.values()) n += await previews.cache.clear();
      void vscode.window.showInformationMessage(`FigBridge: removed ${n} cached preview${n === 1 ? '' : 's'}.`);
    }),

    reg('figbridge.clearActivity', () => activity.clear()),
    reg('figbridge.setupClaude', () => setupClaude(context)),

    reg('figbridge.cleanAllData', async () => {
      const ok = await vscode.window.showWarningMessage(
        'Delete all FigBridge data on this machine: cached previews, Claude activity history and the stored Figma token? Your manifest and source files are not touched.',
        { modal: true },
        'Delete',
      );
      if (!ok) return;
      for (const { previews } of ws.projects.values()) await previews.cache.destroy();
      await activity.clear();
      await ws.tokens.clear();
      await vscode.workspace.fs.delete(context.globalStorageUri, { recursive: true, useTrash: false }).then(undefined, () => undefined);
      void vscode.window.showInformationMessage('FigBridge: local data deleted.');
    }),
  ];

  async function promptForToken(): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to use the Figma API.');
    const token = await vscode.window.showInputBox({
      title: 'Figma personal access token',
      prompt: 'Create one in Figma → Settings → Security → Personal access tokens with scopes file_content:read and file_metadata:read. It is stored in VS Code secret storage only.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (/^\S{20,}$/.test(v.trim()) ? undefined : 'That does not look like a Figma token.'),
    });
    if (!token) return;
    await ws.tokens.set(token.trim());
    const first = ws.active().flatMap(({ project }) => [...(project.manifest?.files.values() ?? [])].filter((f) => f.apiKey))[0];
    if (!first) return void vscode.window.showInformationMessage('FigBridge: token saved.');
    const r = await ws.client.fileMeta(first.apiKey!);
    if (r.ok) void vscode.window.showInformationMessage(`FigBridge: token works — "${r.value.name}" is accessible.`);
    else void vscode.window.showWarningMessage(`FigBridge: token saved, but ${describeError(r.error)}`);
  }

  async function openDesign(l: Located): Promise<void> {
    const url = l.resolved!.openUrl!;
    const mode = vscode.workspace.getConfiguration('figbridge').get<string>('openWith', 'browser');
    if (mode === 'figmaExtension' && vscode.extensions.getExtension('figma.figma-vscode-extension')) {
      // Undocumented URI handler of the Figma extension; may change without notice.
      const f = l.resolved!.file;
      const target = vscode.Uri.parse(
        `vscode://figma.figma-vscode-extension/open/${encodeURIComponent(f.apiKey!)}/${encodeURIComponent(f.name ?? f.alias)}/${encodeURIComponent(l.resolved!.ref.nodeId)}`,
      );
      if (await vscode.env.openExternal(target)) return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

// ---------------------------------------------------------------- mapping flows

async function askFigmaUrl(title: string): Promise<ParsedFigmaUrl & { nodeId: NodeId }> {
  const clip = (await vscode.env.clipboard.readText()).trim();
  const fromClip = parseFigmaUrl(clip);
  const value = await vscode.window.showInputBox({
    title,
    prompt: 'Paste a Figma link to the frame or layer (right-click it in Figma → Copy link to selection).',
    value: fromClip.ok && fromClip.value.nodeId ? clip : '',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const p = parseFigmaUrl(v);
      if (!p.ok) return `Not a Figma design link (${p.error}).`;
      if (!p.value.nodeId) return 'The link must select a node (it needs ?node-id=…).';
      return undefined;
    },
  });
  if (!value) throw new CancelledError();
  const p = parseFigmaUrl(value);
  if (!p.ok || !p.value.nodeId) throw new Error('Invalid Figma link.');
  return p.value as ParsedFigmaUrl & { nodeId: NodeId };
}

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

async function pickProject(ws: FigBridgeWorkspace, uri?: vscode.Uri): Promise<Project> {
  const fromUri = uri ? ws.forUri(uri)?.project : undefined;
  if (fromUri?.manifest) return fromUri;
  const candidates = ws.active().filter((p) => p.project.manifest);
  if (!candidates.length) throw new Error(`No valid ${MANIFEST_FILENAME} is loaded. Run "FigBridge: Create Manifest" first.`);
  if (candidates.length === 1) return candidates[0]!.project;
  const pick = await vscode.window.showQuickPick(candidates.map((c) => ({ label: c.project.name, project: c.project })), { title: 'Which project?' });
  if (!pick) throw new CancelledError();
  return pick.project;
}

/** Finds or (with consent) adds a file alias for the URL's file. Returns the alias and new manifest text. */
async function ensureFileAlias(project: Project, url: ParsedFigmaUrl, text: string): Promise<{ alias: string; text: string }> {
  const key = url.branchKey ?? url.fileKey;
  for (const f of project.manifest!.files.values()) if (f.apiKey === key) return { alias: f.alias, text };
  const suggested = (url.slug ?? 'design').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'design';
  const alias = await vscode.window.showInputBox({
    title: 'This Figma file is not in the manifest yet',
    prompt: 'Short alias for the file (lower-case), e.g. "app" or "design-system".',
    value: /^[a-z]/.test(suggested) ? suggested : `f-${suggested}`,
    validateInput: (v) => (/^[a-z][a-z0-9_-]{0,39}$/.test(v) ? (project.manifest!.files.has(v) ? 'Alias already used.' : undefined) : 'Lower-case letters, digits, - and _; start with a letter.'),
  });
  if (!alias) throw new CancelledError();
  const base = `https://www.figma.com/design/${url.fileKey}${url.branchKey ? `/branch/${url.branchKey}` : ''}${url.slug ? `/${url.slug}` : ''}`;
  return { alias, text: addFile(text, alias, base) };
}

async function nodeName(ws: FigBridgeWorkspace, apiKey: string, nodeId: NodeId): Promise<{ name?: string; kind?: RefKind }> {
  if (!vscode.workspace.isTrusted || !(await ws.tokens.has())) return {};
  const r = await ws.client.nodes(apiKey, [nodeId]);
  if (!r.ok) return {};
  const n = r.value.get(nodeId);
  if (!n) throw new Error(`Node ${nodeId} was not found in that Figma file.`);
  const kind: RefKind | undefined = n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' || n.type === 'INSTANCE' ? 'component' : n.type === 'SECTION' ? 'section' : n.type === 'FRAME' ? 'screen' : undefined;
  return { name: n.name.slice(0, 200), ...(kind ? { kind } : {}) };
}

async function readManifestText(project: Project): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(project.manifestUri);
  return doc.getText();
}

async function applyManifestText(project: Project, newText: string, extra?: (edit: vscode.WorkspaceEdit) => void): Promise<boolean> {
  const doc = await vscode.workspace.openTextDocument(project.manifestUri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);
  extra?.(edit);
  const ok = await vscode.workspace.applyEdit(edit);
  if (ok) await doc.save();
  return ok;
}

function commentFor(languageId: string, id: RefId): string {
  if (['python', 'ruby', 'shellscript', 'yaml', 'perl', 'r', 'elixir', 'toml'].includes(languageId)) return `# @figma ${id}`;
  if (['sql', 'lua', 'haskell'].includes(languageId)) return `-- @figma ${id}`;
  if (languageId === 'dart') return formatDirective(id, 'doc-line');
  return formatDirective(id, 'line');
}

async function insertReference(ws: FigBridgeWorkspace): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error('Open a source file first.');
  const project = await pickProject(ws, editor.document.uri);
  try {
    const url = await askFigmaUrl('Insert @figma reference');
    let text = await readManifestText(project);
    const file = await ensureFileAlias(project, url, text);
    text = file.text;
    const existing = [...project.manifest!.refs.values()].find((r) => r.file === file.alias && r.nodeId === url.nodeId);
    let id: RefId;
    if (existing) {
      const reuse = await vscode.window.showQuickPick(
        [
          { label: `Reuse ${existing.id}`, description: existing.name ?? '', reuse: true },
          { label: 'Create a new reference anyway', reuse: false },
        ],
        { title: 'This node is already mapped' },
      );
      if (!reuse) return;
      id = reuse.reuse ? existing.id : generateUniqueRefId(project.index.takenIds());
    } else id = generateUniqueRefId(project.index.takenIds());

    const line = editor.document.lineAt(editor.selection.active.line);
    const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
    const comment = `${indent}${commentFor(editor.document.languageId, id)}\n`;
    if (!existing || id !== existing.id) {
      const apiKey = url.branchKey ?? url.fileKey;
      const meta = await nodeName(ws, apiKey, url.nodeId);
      const name = await vscode.window.showInputBox({ title: `Name for ${id}`, prompt: 'Human-readable label shown in hovers and views (optional).', value: meta.name ?? '' });
      if (name === undefined) return;
      text = addRef(text, { id, file: file.alias, nodeId: url.nodeId, ...(name ? { name } : {}), ...(meta.kind ? { kind: meta.kind } : {}) });
    }
    const docUri = editor.document.uri;
    const pos = new vscode.Position(line.lineNumber, 0);
    const ok = await applyManifestText(project, text, (edit) => edit.insert(docUri, pos, comment));
    if (ok) vscode.window.setStatusBarMessage(`Inserted @figma ${id}`, 3000);
  } catch (e) {
    if (!(e instanceof CancelledError)) throw e;
  }
}

async function createMapping(ws: FigBridgeWorkspace, rawId?: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const project = await pickProject(ws, editor?.document.uri);
  try {
    const id = (rawId ?? (await vscode.window.showInputBox({ title: 'Reference ID to map', validateInput: (v) => (isRefId(v.trim().toUpperCase()) ? undefined : 'Expected a 12-character reference ID.') })))?.trim().toUpperCase();
    if (!id || !isRefId(id)) return;
    if (project.manifest!.refs.has(id)) throw new Error(`${id} is already mapped.`);
    if (project.manifest!.retired.has(id)) throw new Error(`${id} was retired and can't be mapped again. Insert a new reference instead.`);
    const url = await askFigmaUrl(`Map ${id} to a Figma node`);
    let text = await readManifestText(project);
    const file = await ensureFileAlias(project, url, text);
    text = file.text;
    const meta = await nodeName(ws, url.branchKey ?? url.fileKey, url.nodeId);
    const name = await vscode.window.showInputBox({ title: `Name for ${id}`, value: meta.name ?? '' });
    if (name === undefined) return;
    await applyManifestText(project, addRef(text, { id, file: file.alias, nodeId: url.nodeId, ...(name ? { name } : {}), ...(meta.kind ? { kind: meta.kind } : {}) }));
  } catch (e) {
    if (!(e instanceof CancelledError)) throw e;
  }
}

async function retargetMapping(l: Located): Promise<void> {
  if (!l.resolved) throw new Error(`${l.refId} is not in the manifest.`);
  try {
    const url = await askFigmaUrl(`Retarget ${l.refId}`);
    let text = await readManifestText(l.project);
    const file = await ensureFileAlias(l.project, url, text);
    text = file.text;
    const from = `${l.resolved.file.alias} · node ${l.resolved.ref.nodeId}`;
    const to = `${file.alias} · node ${url.nodeId}`;
    const uses = l.project.index.occurrencesFor(l.refId).length;
    const ok = await vscode.window.showWarningMessage(
      `Retarget ${l.refId}${l.resolved.ref.name ? ` (${l.resolved.ref.name})` : ''}?\n\nFrom: ${from}\nTo: ${to}\n\nAll ${uses} use${uses === 1 ? '' : 's'} in code will point to the new node. If the design meaning changed, insert a new reference instead.`,
      { modal: true },
      'Retarget',
    );
    if (ok !== 'Retarget') return;
    await applyManifestText(l.project, retargetRef(text, l.refId, file.alias, normalizeNodeId(url.nodeId)!));
    l.previews.service.invalidateNodes(l.resolved.file.apiKey!, [l.resolved.ref.nodeId], 'manual');
  } catch (e) {
    if (!(e instanceof CancelledError)) throw e;
  }
}

async function retireMapping(l: Located): Promise<void> {
  if (!l.resolved) throw new Error(`${l.refId} is not in the manifest.`);
  const uses = l.project.index.occurrencesFor(l.refId);
  const detail = uses.length
    ? `${uses.length} annotation${uses.length === 1 ? '' : 's'} still use${uses.length === 1 ? 's' : ''} it and will be reported as retired:\n${uses.slice(0, 5).map((o) => `• ${o.relPath}:${o.idRange.start.line + 1}`).join('\n')}`
    : 'No code uses it.';
  const ok = await vscode.window.showWarningMessage(`Retire ${l.refId}${l.resolved.ref.name ? ` (${l.resolved.ref.name})` : ''}? The mapping is removed and the ID is recorded under "retired" so it is never reused.\n\n${detail}`, { modal: true }, 'Retire');
  if (ok !== 'Retire') return;
  await applyManifestText(l.project, retireRef(await readManifestText(l.project), l.refId));
}

async function createManifest(ws: FigBridgeWorkspace): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) throw new Error('Open a folder first.');
  const folder = folders.length === 1 ? folders[0]! : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Where should figma.design.yaml go?' });
  if (!folder) return;
  const uri = vscode.Uri.joinPath(folder.uri, MANIFEST_FILENAME);
  try {
    await vscode.workspace.fs.stat(uri);
    await vscode.window.showTextDocument(uri);
    return;
  } catch {
    /* does not exist yet */
  }
  try {
    const url = await vscode.window.showInputBox({
      title: 'Create figma.design.yaml',
      prompt: 'Link to the Figma design file (any page or frame link works).',
      ignoreFocusOut: true,
      validateInput: (v) => (parseFigmaUrl(v).ok ? undefined : 'Not a Figma design link.'),
    });
    if (!url) return;
    const p = parseFigmaUrl(url);
    if (!p.ok) return;
    const base = `https://www.figma.com/design/${p.value.fileKey}${p.value.branchKey ? `/branch/${p.value.branchKey}` : ''}${p.value.slug ? `/${p.value.slug}` : ''}`;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(MANIFEST_TEMPLATE('app', base, folder.name)));
    await vscode.window.showTextDocument(uri);
    void ws;
  } catch (e) {
    if (!(e instanceof CancelledError)) throw e;
  }
}

// ---------------------------------------------------------------- batched rendering

/**
 * Renders every preview (optionally of one Figma file) with one render request per file per 50
 * nodes. This is the way to use Starter-plan files, which allow only a few requests a month.
 */
async function renderAll(ws: FigBridgeWorkspace, onlyApiKey?: string): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to use the Figma API.');
  if (!(await ws.tokens.has())) throw new Error('Set a Figma access token first.');
  const jobs = ws
    .active()
    .map(({ previews }) => ({ previews, reqs: previews.allRequests().filter((r) => !onlyApiKey || r.apiKey === onlyApiKey) }))
    .filter((j) => j.reqs.length);
  const byFile = new Map<string, { count: number; blocked?: number }>();
  for (const { previews, reqs } of jobs)
    for (const r of reqs) {
      const f = byFile.get(r.apiKey) ?? { count: 0, ...(previews.service.blockedUntil(r.apiKey) ? { blocked: previews.service.blockedUntil(r.apiKey)! } : {}) };
      f.count++;
      byFile.set(r.apiKey, f);
    }
  if (!byFile.size) return void vscode.window.showInformationMessage('FigBridge: no references to render.');
  const blocked = [...byFile.values()].filter((f) => f.blocked);
  const ready = [...byFile.entries()].filter(([, f]) => !f.blocked);
  if (!ready.length) {
    const until = Math.min(...blocked.map((f) => f.blocked!));
    return void vscode.window.showWarningMessage(`FigBridge: Figma is rate-limiting renders for ${blocked.length === 1 ? 'this file' : 'these files'}. Try again in ${formatDuration((until - Date.now()) / 1000)}.`);
  }
  const nodes = ready.reduce((n, [, f]) => n + f.count, 0);
  // Each project renders its own batch per file: count requests per project and file.
  let requests = 0;
  for (const { previews, reqs } of jobs) {
    const perFile = new Map<string, number>();
    for (const r of reqs) if (!previews.service.blockedUntil(r.apiKey)) perFile.set(r.apiKey, (perFile.get(r.apiKey) ?? 0) + 1);
    for (const n of perFile.values()) requests += Math.ceil(n / 50);
  }
  const ok = await vscode.window.showInformationMessage(
    `Render ${nodes} preview${nodes === 1 ? '' : 's'} from ${ready.length} Figma file${ready.length === 1 ? '' : 's'}?`,
    {
      modal: true,
      detail: `This uses ${requests} render request${requests === 1 ? '' : 's'} (Figma's render endpoint takes up to 50 nodes per request). Files on a Starter plan allow only a few requests per month; up-to-date previews are skipped.${blocked.length ? `\n\n${blocked.length} file${blocked.length === 1 ? ' is' : 's are'} still rate-limited and will be skipped.` : ''}`,
    },
    'Render',
  );
  if (ok !== 'Render') return;
  let fresh = 0;
  const failures = new Map<string, number>();
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'FigBridge: rendering previews' }, async (progress) => {
    for (const { previews, reqs } of jobs) {
      const todo = reqs.filter((r) => !previews.service.blockedUntil(r.apiKey));
      if (!todo.length) continue;
      progress.report({ message: previews.project.name });
      for (const status of (await previews.service.renderMany(todo)).values()) {
        if (status.state === 'fresh') fresh++;
        else if (status.state === 'error') failures.set(describeError(status.error), (failures.get(describeError(status.error)) ?? 0) + 1);
      }
    }
  });
  const problems = [...failures.entries()].map(([msg, n]) => `${n}× ${msg}`).join(' · ');
  if (problems) void vscode.window.showWarningMessage(`FigBridge: ${fresh} preview${fresh === 1 ? '' : 's'} ready. ${problems}`);
  else void vscode.window.showInformationMessage(`FigBridge: ${fresh} preview${fresh === 1 ? '' : 's'} ready.`);
}

// ---------------------------------------------------------------- validation & search

async function validateMappings(ws: FigBridgeWorkspace): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to use the Figma API.');
  if (!(await ws.tokens.has())) throw new Error('Set a Figma access token first.');
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'FigBridge: validating mappings', cancellable: true }, async (progress, token) => {
    let missing = 0;
    let checked = 0;
    const problems: string[] = [];
    for (const { project } of ws.active()) {
      const m = project.manifest;
      if (!m) continue;
      for (const f of m.files.values()) {
        if (token.isCancellationRequested) return;
        if (!f.apiKey) continue;
        progress.report({ message: f.name ?? f.alias });
        const refs = [...m.refs.values()].filter((r) => r.file === f.alias);
        if (ws.client.rateLimit(f.apiKey, 1)) {
          problems.push(`${f.alias}: Figma is rate-limiting this file; try again later`);
          continue;
        }
        const meta = await ws.client.fileMeta(f.apiKey);
        if (!meta.ok) {
          problems.push(`${f.alias}: ${describeError(meta.error)}`);
          if (meta.error.code === 'FILE_UNAVAILABLE') project.index.setFileAccess(f.alias, meta.error.httpStatus === 404 ? 'missing' : 'denied');
          continue;
        }
        project.index.setFileAccess(f.alias, 'available');
        if (!refs.length) continue;
        const nodes = await ws.client.nodes(f.apiKey, refs.map((r) => r.nodeId));
        if (!nodes.ok) {
          problems.push(`${f.alias}: ${describeError(nodes.error)}`);
          continue;
        }
        for (const r of refs) {
          checked++;
          const n = nodes.value.get(r.nodeId);
          project.index.setNodeState(r.id, n ? 'available' : 'missing');
          if (!n) missing++;
        }
      }
    }
    const summary = `Checked ${checked} mapping${checked === 1 ? '' : 's'}: ${missing ? `${missing} node${missing === 1 ? '' : 's'} missing` : 'all nodes exist'}.`;
    if (problems.length) void vscode.window.showWarningMessage(`FigBridge: ${summary} ${problems.join(' · ')}`);
    else if (missing) void vscode.window.showWarningMessage(`FigBridge: ${summary} See the Problems view.`);
    else void vscode.window.showInformationMessage(`FigBridge: ${summary}`);
  });
}

interface RefPick extends vscode.QuickPickItem {
  refId: RefId;
  project: Project;
  status: string;
  lang: string[];
  fileAlias?: string;
  tags: string[];
  refKind?: string;
}

/** QuickPick over every reference. Filter tokens: status:, lang:, file:, tag:, kind:. */
async function findReference(ws: FigBridgeWorkspace): Promise<void> {
  const items: RefPick[] = [];
  for (const { project } of ws.active()) {
    const m = project.manifest;
    const seen = new Set<string>();
    for (const r of m?.refs.values() ?? []) {
      const occs = project.index.occurrencesFor(r.id);
      seen.add(r.id);
      items.push({
        label: r.name ?? r.nodeId,
        description: `${r.id} · ${r.file}${r.kind ? ` · ${r.kind}` : ''}`,
        detail: occs.length ? occs.slice(0, 3).map((o) => `${o.relPath}:${o.idRange.start.line + 1}`).join('  ') : 'unused in code',
        refId: r.id,
        project,
        status: r.deprecated ? 'deprecated' : occs.length ? 'used' : 'unused',
        lang: [...new Set(occs.map((o) => o.languageId))],
        fileAlias: r.file,
        tags: r.tags,
        ...(r.kind ? { refKind: r.kind } : {}),
      });
    }
    for (const o of project.index.allOccurrences())
      if (!seen.has(o.refId)) {
        seen.add(o.refId);
        items.push({ label: `$(warning) ${o.refId}`, description: 'not in manifest', detail: `${o.relPath}:${o.idRange.start.line + 1}`, refId: o.refId, project, status: 'unresolved', lang: [o.languageId], tags: [] });
      }
  }
  const qp = vscode.window.createQuickPick<RefPick>();
  qp.title = 'Find Figma reference';
  qp.placeholder = 'Search by name, ID or path · filters: status:unused lang:dart file:app tag:checkout kind:screen';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  const apply = () => {
    const filters = [...qp.value.matchAll(/(\w+):(\S+)/g)].map((m) => [m[1]!.toLowerCase(), m[2]!.toLowerCase()] as const);
    qp.items = items.filter((i) =>
      filters.every(([k, v]) =>
        k === 'status' ? i.status === v : k === 'lang' ? i.lang.some((l) => l.toLowerCase().includes(v)) : k === 'file' ? i.fileAlias === v : k === 'tag' ? i.tags.map((t) => t.toLowerCase()).includes(v) : k === 'kind' ? i.refKind === v : true,
      ),
    );
  };
  qp.onDidChangeValue(apply);
  apply();
  qp.onDidAccept(async () => {
    const pick = qp.selectedItems[0];
    qp.hide();
    if (!pick) return;
    const occ = pick.project.index.occurrencesFor(pick.refId)[0];
    const actions = [
      ...(pick.status !== 'unresolved' ? [{ label: '$(eye) Preview', id: 'preview' }, { label: '$(link-external) Open in Figma', id: 'open' }] : [{ label: '$(add) Create mapping…', id: 'create' }]),
      ...(occ ? [{ label: '$(go-to-file) Go to source', id: 'source' }] : []),
      ...(pick.status !== 'unresolved' ? [{ label: '$(file-code) Show in manifest', id: 'manifest' }] : []),
    ];
    const action = await vscode.window.showQuickPick(actions, { title: `${pick.refId} — ${pick.label}` });
    if (!action) return;
    if (action.id === 'source' && occ)
      await vscode.window.showTextDocument(pick.project.uriOf(occ.relPath), { selection: new vscode.Range(occ.idRange.start.line, occ.idRange.start.character, occ.idRange.end.line, occ.idRange.end.character) });
    else if (action.id === 'preview') await vscode.commands.executeCommand('figbridge.preview', pick.refId);
    else if (action.id === 'open') await vscode.commands.executeCommand('figbridge.open', pick.refId);
    else if (action.id === 'create') await vscode.commands.executeCommand('figbridge.createMapping', pick.refId);
    else if (action.id === 'manifest') await vscode.commands.executeCommand('figbridge.revealInManifest', pick.refId);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}
