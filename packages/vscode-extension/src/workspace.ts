import * as vscode from 'vscode';
import { dirname, relative, sep } from 'node:path';
import { FigmaClient, MANIFEST_FILENAME, Scanner, type AnnotationOccurrence, type RefId, type ResolvedRef } from '@figbridge/core';
import { ProjectPreviews, TokenStore } from './figma';
import { Project } from './project';

export interface Located {
  project: Project;
  previews: ProjectPreviews;
  occurrence?: AnnotationOccurrence;
  refId: RefId;
  resolved?: ResolvedRef;
}

const DISCOVERY_EXCLUDE = '{**/node_modules/**,**/.git/**,**/build/**,**/dist/**,**/out/**,**/.dart_tool/**,**/.next/**,**/Pods/**}';

/**
 * Owns every Project and the shared Figma client. A workspace folder yields one project per
 * `figma.design.yaml` found anywhere inside it, plus a manifest-less project at the folder root
 * (for `@figma <link>` annotations) when the root has no manifest of its own.
 */
export class FigBridgeWorkspace implements vscode.Disposable {
  readonly projects = new Map<string, { project: Project; previews: ProjectPreviews }>();
  readonly client: FigmaClient;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when any project's index, manifest or previews change. */
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly scanner: Scanner,
    readonly tokens: TokenStore,
  ) {
    this.client = new FigmaClient({
      getToken: async () => (vscode.workspace.isTrusted ? await tokens.get() : undefined),
    });
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        for (const f of e.removed) this.remove(f);
        for (const f of e.added) void this.add(f);
      }),
      tokens.onDidChange(() => this.changed.fire()),
    );
  }

  async start(): Promise<void> {
    await Promise.all((vscode.workspace.workspaceFolders ?? []).map((f) => this.add(f)));
    // A manifest appearing or disappearing anywhere changes the project layout.
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${MANIFEST_FILENAME}`, false, true, false);
    const relayout = (uri: vscode.Uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder && !/[\\/](node_modules|\.git|build|dist|\.dart_tool)[\\/]/.test(uri.fsPath)) void this.rediscover(folder);
    };
    watcher.onDidCreate(relayout);
    watcher.onDidDelete(relayout);
    this.disposables.push(
      watcher,
      vscode.workspace.onDidChangeConfiguration((e) => {
        for (const f of vscode.workspace.workspaceFolders ?? []) if (e.affectsConfiguration('figbridge.manifestPath', f.uri)) void this.rediscover(f);
      }),
    );
    this.updateContext();
  }

  private readonly folderProjects = new Map<string, string[]>();

  private async add(folder: vscode.WorkspaceFolder): Promise<void> {
    if (folder.uri.scheme !== 'file' || this.folderProjects.has(folder.uri.toString())) return;
    this.folderProjects.set(folder.uri.toString(), []);
    const configured = vscode.workspace.getConfiguration('figbridge', folder.uri).get<string>('manifestPath', MANIFEST_FILENAME);
    const manifests =
      configured !== MANIFEST_FILENAME
        ? [vscode.Uri.joinPath(folder.uri, configured)]
        : await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/${MANIFEST_FILENAME}`), DISCOVERY_EXCLUDE, 200);
    const roots = new Map<string, { root: vscode.Uri; name: string }>();
    for (const m of manifests) roots.set(vscode.Uri.file(dirname(m.fsPath)).toString(), { root: vscode.Uri.file(dirname(m.fsPath)), name: m.path.split('/').pop()! });
    if (!roots.has(folder.uri.toString())) roots.set(folder.uri.toString(), { root: folder.uri, name: MANIFEST_FILENAME });
    const all = [...roots.values()];
    const keys: string[] = [];
    for (const { root, name } of all) {
      const nested = all
        .filter((o) => o.root.toString() !== root.toString())
        .map((o) => relative(root.fsPath, o.root.fsPath))
        .filter((r) => r && !r.startsWith('..'))
        .map((r) => r.split(sep).join('/'));
      const project = new Project(folder, root, this.scanner, nested, name);
      const previews = new ProjectPreviews(project, this.client, this.context.globalStorageUri);
      this.projects.set(root.toString(), { project, previews });
      keys.push(root.toString());
      project.onDidChange(() => {
        this.updateContext();
        this.changed.fire();
      });
      previews.onDidChange(() => this.changed.fire());
    }
    this.folderProjects.set(folder.uri.toString(), keys);
    await Promise.all(keys.map((k) => this.projects.get(k)!.project.start()));
  }

  /** Re-discovers projects in a folder (a manifest was created or deleted). */
  async rediscover(folder: vscode.WorkspaceFolder): Promise<void> {
    this.remove(folder);
    await this.add(folder);
    this.updateContext();
    this.changed.fire();
  }

  private remove(folder: vscode.WorkspaceFolder): void {
    for (const key of this.folderProjects.get(folder.uri.toString()) ?? []) {
      const entry = this.projects.get(key);
      entry?.previews.dispose();
      entry?.project.dispose();
      this.projects.delete(key);
    }
    this.folderProjects.delete(folder.uri.toString());
    this.changed.fire();
  }

  /** Projects with a (last-known-good or broken) manifest, or with any annotations. */
  active(): Array<{ project: Project; previews: ProjectPreviews }> {
    return [...this.projects.values()].filter((p) => p.project.manifest || p.project.state !== 'no-manifest' || p.project.index.allOccurrences().length > 0);
  }

  /** The project that owns a file: the deepest project root containing it. */
  forUri(uri: vscode.Uri): { project: Project; previews: ProjectPreviews } | undefined {
    return [...this.projects.values()].find((p) => p.project.owns(uri));
  }

  /** Finds the annotation at a position, if any, and resolves it against the manifest. */
  locate(document: vscode.TextDocument, position: vscode.Position): Located | undefined {
    const entry = this.forUri(document.uri);
    if (!entry) return undefined;
    const rel = entry.project.relPath(document.uri);
    if (!rel) return undefined;
    const occurrence = entry.project.index.occurrenceAt(rel, position.line, position.character);
    if (!occurrence) return undefined;
    const resolved = entry.project.index.resolve(occurrence.refId);
    return { ...entry, occurrence, refId: occurrence.refId, ...(resolved ? { resolved } : {}) };
  }

  /** Resolves a ref ID in whichever project defines it (first match). */
  byRefId(refId: RefId): Located | undefined {
    for (const entry of this.projects.values()) {
      const resolved = entry.project.index.resolve(refId);
      if (resolved) return { ...entry, refId, resolved };
    }
    for (const entry of this.projects.values()) if (entry.project.index.occurrencesFor(refId).length) return { ...entry, refId };
    return undefined;
  }

  private updateContext(): void {
    const states = [...this.projects.values()].map((p) => p.project.state);
    const state = states.includes('ok') ? 'ok' : states.includes('invalid') ? 'invalid' : 'no-manifest';
    void vscode.commands.executeCommand('setContext', 'figbridge.state', state);
  }

  dispose(): void {
    for (const { project, previews } of this.projects.values()) {
      previews.dispose();
      project.dispose();
    }
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
  }
}
