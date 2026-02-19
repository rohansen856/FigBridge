import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  createEnvLookup,
  createPathFilter,
  loadManifest,
  ReferenceIndex,
  referencedEnvNames,
  Scanner,
  type Diagnostic,
  type Manifest,
  type ManifestLoadResult,
} from '@figbridge/core';

const DEBOUNCE_MS = 300;
const MAX_SOURCE_BYTES = 1024 * 1024;

export type ProjectState = 'no-manifest' | 'invalid' | 'unsupported-version' | 'ok';

/**
 * One workspace folder with a manifest. Keeps the reference index current from disk, open
 * editors and the manifest; keeps the last valid manifest when a new edit is invalid.
 */
export class Project implements vscode.Disposable {
  readonly index = new ReferenceIndex();
  manifestResult: ManifestLoadResult | undefined;
  state: ProjectState = 'no-manifest';
  readonly id: string;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private manifestTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly fileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private scanToken: vscode.CancellationTokenSource | undefined;
  private filter: (relPath: string) => boolean = () => false;

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    private readonly scanner: Scanner,
  ) {
    this.id = createHash('sha256').update(folder.uri.toString()).digest('hex').slice(0, 16);
  }

  get manifestUri(): vscode.Uri {
    const rel = vscode.workspace.getConfiguration('figbridge', this.folder.uri).get<string>('manifestPath', 'figma.design.yaml');
    return vscode.Uri.joinPath(this.folder.uri, rel);
  }

  get manifest(): Manifest | undefined {
    return this.index.getManifest();
  }

  relPath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file' && uri.scheme !== 'untitled') return undefined;
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (rel === uri.fsPath || rel.startsWith('..')) return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder?.uri.toString() !== this.folder.uri.toString()) return undefined;
    // asRelativePath prefixes the folder name in multi-root workspaces.
    const prefix = `${this.folder.name}/`;
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 1 && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
  }

  uriOf(relPath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.folder.uri, ...relPath.split('/'));
  }

  async start(): Promise<void> {
    const manifestWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, '{figma.design.yaml,.env}'));
    manifestWatcher.onDidChange(() => this.scheduleManifestReload());
    manifestWatcher.onDidCreate(() => this.scheduleManifestReload());
    manifestWatcher.onDidDelete(() => this.scheduleManifestReload());
    const sourceWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, '**/*'));
    sourceWatcher.onDidChange((u) => this.scheduleFile(u));
    sourceWatcher.onDidCreate((u) => this.scheduleFile(u));
    sourceWatcher.onDidDelete((u) => {
      const rel = this.relPath(u);
      if (!rel) return;
      // A deleted directory: drop every indexed file beneath it.
      for (const o of this.index.allOccurrences()) if (o.relPath === rel || o.relPath.startsWith(`${rel}/`)) this.index.removeFile(o.relPath);
      this.index.removeFile(rel);
      this.changed.fire();
    });
    this.disposables.push(
      manifestWatcher,
      sourceWatcher,
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.manifestUri.toString()) this.scheduleManifestReload();
        else if (e.contentChanges.length) this.scheduleFile(e.document.uri);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.scheduleFile(d.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('figbridge.manifestPath', this.folder.uri)) void this.reloadManifest(true);
      }),
    );
    await this.reloadManifest(true);
  }

  private scheduleManifestReload(): void {
    clearTimeout(this.manifestTimer);
    this.manifestTimer = setTimeout(() => void this.reloadManifest(false), DEBOUNCE_MS);
  }

  /** Loads and validates the manifest; swaps it in only when valid. */
  async reloadManifest(forceRescan: boolean): Promise<void> {
    const text = await this.readText(this.manifestUri);
    if (text === undefined) {
      this.manifestResult = undefined;
      this.state = 'no-manifest';
      this.index.setManifest(undefined);
      this.index.clearFiles();
      this.index.scanState = 'pending';
      this.changed.fire();
      return;
    }
    const names = referencedEnvNames(text);
    // .env is only read in trusted workspaces and only for variables the manifest references.
    const dotenv = names.size && vscode.workspace.isTrusted ? await this.readText(vscode.Uri.joinPath(this.folder.uri, '.env')) : undefined;
    const result = loadManifest(text, vscode.workspace.asRelativePath(this.manifestUri, false), createEnvLookup(names, process.env, dotenv));
    this.manifestResult = result;
    if (result.manifest) {
      const previousScan = JSON.stringify(this.manifest?.scan);
      const duplicates = result.diagnostics.filter((d) => d.code === 'DUPLICATE_MAPPING').length;
      this.index.setManifest(result.manifest, duplicates);
      this.state = 'ok';
      this.filter = createPathFilter(result.manifest.scan);
      if (forceRescan || previousScan !== JSON.stringify(result.manifest.scan)) await this.rescan();
    } else {
      // Keep the last-known-good manifest and index; only the state and diagnostics change.
      this.state = result.state === 'unsupported-version' ? 'unsupported-version' : 'invalid';
      if (!this.manifest) {
        this.index.scanState = 'failed';
      }
    }
    this.changed.fire();
  }

  manifestDiagnostics(): Diagnostic[] {
    return this.manifestResult?.diagnostics ?? [];
  }

  /** Full rescan; cancels any scan in progress. */
  async rescan(): Promise<void> {
    const manifest = this.manifest;
    if (!manifest) return;
    this.scanToken?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.scanToken = cts;
    this.index.scanState = 'pending';
    this.index.clearFiles();
    this.changed.fire();
    await vscode.window.withProgress({ location: { viewId: 'figbridge.overview' }, title: 'Scanning for @figma references' }, async () => {
      // VS Code globs don't nest braces: search per include pattern, let VS Code prune the
      // brace-free excludes (node_modules etc.), and apply the exact filter afterwards.
      const simpleExcludes = manifest.scan.exclude.filter((p) => !/[{}]/.test(p));
      const exclude = simpleExcludes.length ? new vscode.RelativePattern(this.folder, `{${simpleExcludes.join(',')}}`) : undefined;
      const seen = new Map<string, vscode.Uri>();
      for (const pattern of manifest.scan.include) {
        const found = await vscode.workspace.findFiles(new vscode.RelativePattern(this.folder, pattern), exclude, undefined, cts.token);
        for (const u of found) seen.set(u.toString(), u);
      }
      const uris = [...seen.values()];
      let failed = false;
      for (const uri of uris) {
        if (cts.token.isCancellationRequested) return;
        if (!(await this.scanUri(uri))) failed = true;
      }
      if (cts.token.isCancellationRequested) return;
      this.index.scanState = failed ? 'partial' : 'complete';
      this.changed.fire();
    });
  }

  private scheduleFile(uri: vscode.Uri): void {
    const key = uri.toString();
    clearTimeout(this.fileTimers.get(key));
    this.fileTimers.set(
      key,
      setTimeout(() => {
        this.fileTimers.delete(key);
        void this.scanUri(uri).then(() => this.changed.fire());
      }, DEBOUNCE_MS),
    );
  }

  /** Scans one file, preferring an open editor buffer over disk. Returns false on read failure. */
  private async scanUri(uri: vscode.Uri): Promise<boolean> {
    const rel = this.relPath(uri);
    if (!rel || !this.manifest || !this.filter(rel)) return true;
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    let text: string | undefined;
    if (open) text = open.getText();
    else {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.SymbolicLink || stat.size > MAX_SOURCE_BYTES) {
          this.index.removeFile(rel);
          return true;
        }
      } catch {
        this.index.removeFile(rel);
        return true;
      }
      text = await this.readText(uri);
    }
    if (text === undefined) return false;
    const languageId = open?.languageId;
    this.index.setFile(this.scanner.scan({ relPath: rel, text, ...(languageId ? { languageId } : {}) }));
    return true;
  }

  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }

  cacheDir(globalStorage: vscode.Uri): string {
    return join(globalStorage.fsPath, 'workspaces', this.id, 'previews');
  }

  dispose(): void {
    this.scanToken?.cancel();
    clearTimeout(this.manifestTimer);
    for (const t of this.fileTimers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
  }
}
