import * as vscode from 'vscode';
import { dirname } from 'node:path';
import { drainSpool, ensureSpoolDir, spoolDirFor, type ClaudeEvent, type NodeId, type RefId } from '@figbridge/core';
import type { FigBridgeWorkspace } from './workspace';

export type ActivityStatus = 'preview-refreshed' | 'stale' | 'failed' | 'target-unknown' | 'not-configured' | 'read' | 'no-preview-change';

export interface ActivityRecord {
  eventId: string;
  ts: number;
  tool: string;
  kind: ClaudeEvent['kind'];
  result: ClaudeEvent['result'];
  status: ActivityStatus;
  fileKey?: string;
  fileAlias?: string;
  nodeIds: string[];
  /** Refs the event is known or presumed to affect. */
  refIds: RefId[];
  error?: string;
}

const MAX_RECORDS = 100;
const STATE_KEY = 'figbridge.activity.v1';
const DEDUPE_KEY = 'figbridge.activity.dedupe.v1';

/**
 * Consumes sanitised Claude Code hook events from the per-user spool, invalidates previews and
 * keeps a bounded activity history. Events only ever mark previews stale; a preview is shown
 * as refreshed only after FigBridge itself re-rendered it.
 */
export class ActivityLog implements vscode.Disposable {
  private list: ActivityRecord[];
  private readonly dedupe: string[];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watched = new Map<string, vscode.Disposable>();
  private draining = false;

  constructor(
    private readonly ws: FigBridgeWorkspace,
    private readonly state: vscode.Memento,
  ) {
    this.list = state.get<ActivityRecord[]>(STATE_KEY, []);
    this.dedupe = state.get<string[]>(DEDUPE_KEY, []);
    this.updateContext();
    this.disposables.push(
      ws.onDidChange(() => {
        void this.syncWatchers();
        this.markRefreshed();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) void this.drainAll();
      }),
    );
  }

  /** Spool directories currently watched (for diagnostics and tests). */
  spoolDirectories(): string[] {
    return [...this.watched.keys()];
  }

  records(): readonly ActivityRecord[] {
    return this.list;
  }

  async start(): Promise<void> {
    await this.syncWatchers();
    await this.drainAll();
  }

  async clear(): Promise<void> {
    this.list = [];
    await this.persist();
  }

  /** Watches the spool directory of every trusted project with a manifest. */
  private async syncWatchers(): Promise<void> {
    if (!vscode.workspace.isTrusted) return;
    for (const { project } of this.ws.active()) {
      const manifestDir = dirname(project.manifestUri.fsPath);
      let dir: string;
      try {
        dir = await spoolDirFor(manifestDir);
      } catch {
        continue;
      }
      if (this.watched.has(dir)) continue;
      try {
        await ensureSpoolDir(dir);
      } catch {
        continue;
      }
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*.json'), false, true, true);
      watcher.onDidCreate(() => void this.drain(dir));
      this.watched.set(dir, watcher);
      void this.drain(dir);
    }
  }

  private async drainAll(): Promise<void> {
    for (const dir of this.watched.keys()) await this.drain(dir);
  }

  private async drain(dir: string): Promise<void> {
    if (this.draining) {
      setTimeout(() => void this.drain(dir), 200);
      return;
    }
    this.draining = true;
    try {
      const { events } = await drainSpool(dir);
      let changed = false;
      for (const { event } of events) changed = this.handle(event) || changed;
      if (changed) await this.persist();
    } finally {
      this.draining = false;
    }
  }

  /** Applies one event. Returns true when the activity list changed. */
  handle(event: ClaudeEvent): boolean {
    if (this.dedupe.includes(event.dedupeKey)) return false;
    this.dedupe.push(event.dedupeKey);
    if (this.dedupe.length > 500) this.dedupe.splice(0, this.dedupe.length - 500);
    const recordReads = vscode.workspace.getConfiguration('figbridge').get<boolean>('claude.recordReads', false);
    if (event.kind === 'read' && !recordReads) return false;

    const matches = event.fileKey ? this.projectsForFile(event.fileKey) : [];
    const record: ActivityRecord = {
      eventId: event.eventId,
      ts: Date.parse(event.ts) || Date.now(),
      tool: event.tool,
      kind: event.kind,
      result: event.result,
      status: 'target-unknown',
      nodeIds: event.nodeIds,
      refIds: [],
      ...(event.fileKey ? { fileKey: event.fileKey } : {}),
      ...(matches[0] ? { fileAlias: matches[0].alias } : {}),
      ...(event.error ? { error: event.error } : {}),
    };

    if (event.result === 'failure') record.status = 'failed';
    else if (event.kind === 'read') record.status = 'read';
    else if (event.kind === 'metadata') record.status = 'no-preview-change';
    else if (!event.fileKey) record.status = 'target-unknown';
    else if (!matches.length) record.status = 'not-configured';
    else if (event.kind === 'unrelated' && !event.nodeIds.length) record.status = 'no-preview-change';
    else {
      // A change to any node can alter the render of its ancestors, whose IDs we don't know,
      // so every preview of the file becomes stale. Node IDs only decide which refs to list first.
      record.status = 'stale';
      for (const { previews, apiKey } of matches) {
        previews.service.invalidateFile(apiKey, 'claude-event');
        const direct = event.nodeIds.flatMap((n) => previews.refsForNode(apiKey, n as NodeId));
        const all = [...(previews.project.manifest?.refs.values() ?? [])]
          .filter((r) => previews.project.manifest?.files.get(r.file)?.apiKey === apiKey)
          .map((r) => r.id);
        record.refIds.push(...new Set([...direct, ...all]));
      }
    }
    this.list.unshift(record);
    if (this.list.length > MAX_RECORDS) this.list.length = MAX_RECORDS;
    this.updateContext();
    this.emitter.fire();
    return true;
  }

  private projectsForFile(fileKey: string) {
    const out: Array<{ previews: ReturnType<FigBridgeWorkspace['active']>[number]['previews']; apiKey: string; alias: string }> = [];
    for (const { project, previews } of this.ws.active())
      for (const f of project.manifest?.files.values() ?? [])
        if (f.apiKey === fileKey || f.fileKey === fileKey) out.push({ previews, apiKey: f.apiKey!, alias: f.alias });
    return out;
  }

  /** Upgrades `stale` records once every affected cached preview was re-rendered after the event. */
  private markRefreshed(): void {
    let changed = false;
    for (const r of this.list) {
      if (r.status !== 'stale' || !r.refIds.length) continue;
      let anyCached = false;
      let allNewer = true;
      for (const id of r.refIds) {
        const located = this.ws.byRefId(id);
        const status = located?.resolved ? located.previews.peek(located.resolved) : undefined;
        const entry = status && 'entry' in status ? status.entry : undefined;
        if (!entry) continue;
        anyCached = true;
        if (entry.fetchedAt < r.ts || entry.stale) allNewer = false;
      }
      if (anyCached && allNewer) {
        r.status = 'preview-refreshed';
        changed = true;
      }
    }
    if (changed) {
      void this.persist();
    }
  }

  private async persist(): Promise<void> {
    await this.state.update(STATE_KEY, this.list);
    await this.state.update(DEDUPE_KEY, this.dedupe);
    this.updateContext();
    this.emitter.fire();
  }

  private updateContext(): void {
    void vscode.commands.executeCommand('setContext', 'figbridge.activityVisible', this.list.length > 0);
  }

  dispose(): void {
    for (const w of this.watched.values()) w.dispose();
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}
