import * as vscode from 'vscode';
import {
  FigmaClient,
  PreviewCache,
  PreviewService,
  type NodeId,
  type PreviewRequest,
  type PreviewStatus,
  type RefId,
  type ResolvedRef,
} from '@figbridge/core';
import type { Project } from './project';

const SECRET_KEY = 'figbridge.figmaPat';

/** Holds the user's Figma PAT in SecretStorage. One token per user, not per workspace. */
export class TokenStore {
  private readonly changed = new vscode.EventEmitter<boolean>();
  readonly onDidChange = this.changed.event;
  private present: boolean | undefined;

  constructor(private readonly secrets: vscode.SecretStorage) {
    secrets.onDidChange((e) => {
      if (e.key === SECRET_KEY) {
        this.present = undefined;
        void this.has().then((v) => this.changed.fire(v));
      }
    });
  }

  get(): Thenable<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  async has(): Promise<boolean> {
    this.present ??= !!(await this.secrets.get(SECRET_KEY));
    return this.present;
  }

  async set(token: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, token);
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }
}

/** Per-project preview orchestration plus the request shape for a resolved reference. */
export class ProjectPreviews implements vscode.Disposable {
  readonly cache: PreviewCache;
  readonly service: PreviewService;
  private readonly changed = new vscode.EventEmitter<PreviewRequest>();
  readonly onDidChange = this.changed.event;
  private loaded: Promise<void>;

  constructor(
    readonly project: Project,
    readonly client: FigmaClient,
    globalStorage: vscode.Uri,
  ) {
    const config = vscode.workspace.getConfiguration('figbridge');
    this.cache = new PreviewCache({
      dir: project.cacheDir(globalStorage),
      persist: config.get<boolean>('preview.persist', true),
      maxTotalBytes: config.get<number>('cache.maxMB', 250) * 1024 * 1024,
    });
    this.service = new PreviewService({
      client,
      cache: this.cache,
      onNodeState: (req, state) => {
        for (const ref of project.manifest?.refs.values() ?? [])
          if (ref.nodeId === req.nodeId && project.manifest?.files.get(ref.file)?.apiKey === req.apiKey) project.index.setNodeState(ref.id, state);
      },
      onFileAccess: (alias, state) => project.index.setFileAccess(alias, state),
      onChange: (req) => this.changed.fire(req),
    });
    this.loaded = this.cache.load().then(() => this.service.restoreBlocks());
  }

  /** Every preview this project can request (manifest refs and link annotations), deduplicated. */
  allRequests(): PreviewRequest[] {
    const out = new Map<string, PreviewRequest>();
    const keys: RefId[] = [...(this.project.manifest?.refs.keys() ?? [])];
    for (const o of this.project.index.allOccurrences()) if (o.link) keys.push(o.refId);
    for (const id of keys) {
      const resolved = this.project.index.resolve(id);
      const req = resolved && this.request(resolved);
      if (req) out.set(`${req.apiKey}|${req.nodeId}|${req.format}|${req.scale}`, req);
    }
    return [...out.values()];
  }

  /** Requests for the other previews of the same Figma file, to render in one batch. */
  batchFor(req: PreviewRequest): PreviewRequest[] {
    return this.allRequests().filter((r) => r.apiKey === req.apiKey && r.nodeId !== req.nodeId);
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  request(resolved: ResolvedRef): PreviewRequest | undefined {
    if (resolved.file.state !== 'ok' || !resolved.file.apiKey) return undefined;
    // Link annotations work without a manifest; use the manifest defaults then.
    const preview = this.project.manifest?.preview ?? { format: 'png' as const, scale: 1, ttlMinutes: 1440, hoverWidth: 360 };
    return {
      apiKey: resolved.file.apiKey,
      nodeId: resolved.ref.nodeId,
      format: preview.format,
      scale: preview.scale,
      alias: resolved.file.alias,
      ttlMinutes: preview.ttlMinutes,
    };
  }

  peek(resolved: ResolvedRef): PreviewStatus | undefined {
    const req = this.request(resolved);
    return req ? this.service.peek(req) : undefined;
  }

  imageUri(status: PreviewStatus): vscode.Uri | undefined {
    const entry = 'entry' in status ? status.entry : undefined;
    return entry ? vscode.Uri.file(this.cache.pathOf(entry)) : undefined;
  }

  refsForNode(apiKey: string, nodeId: NodeId): RefId[] {
    const out: RefId[] = [];
    for (const ref of this.project.manifest?.refs.values() ?? [])
      if (ref.nodeId === nodeId && this.project.manifest?.files.get(ref.file)?.apiKey === apiKey) out.push(ref.id);
    return out;
  }

  dispose(): void {
    void this.cache.save();
    this.changed.dispose();
  }
}
