import * as vscode from 'vscode';
import { FigmaClient, Scanner, type AnnotationOccurrence, type RefId, type ResolvedRef } from '@figbridge/core';
import { ProjectPreviews, TokenStore } from './figma';
import { Project } from './project';

export interface Located {
  project: Project;
  previews: ProjectPreviews;
  occurrence?: AnnotationOccurrence;
  refId: RefId;
  resolved?: ResolvedRef;
}

/** Owns every Project (one per workspace folder) and the shared Figma client. */
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
    this.updateContext();
  }

  private async add(folder: vscode.WorkspaceFolder): Promise<void> {
    if (folder.uri.scheme !== 'file' || this.projects.has(folder.uri.toString())) return;
    const project = new Project(folder, this.scanner);
    const previews = new ProjectPreviews(project, this.client, this.context.globalStorageUri);
    this.projects.set(folder.uri.toString(), { project, previews });
    project.onDidChange(() => {
      this.updateContext();
      this.changed.fire();
    });
    previews.onDidChange(() => this.changed.fire());
    await project.start();
  }

  private remove(folder: vscode.WorkspaceFolder): void {
    const entry = this.projects.get(folder.uri.toString());
    if (!entry) return;
    entry.previews.dispose();
    entry.project.dispose();
    this.projects.delete(folder.uri.toString());
    this.changed.fire();
  }

  /** Projects that have a usable (or last-known-good) manifest. */
  active(): Array<{ project: Project; previews: ProjectPreviews }> {
    return [...this.projects.values()].filter((p) => p.project.manifest || p.project.state !== 'no-manifest');
  }

  forUri(uri: vscode.Uri): { project: Project; previews: ProjectPreviews } | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? this.projects.get(folder.uri.toString()) : undefined;
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
