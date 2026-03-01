import * as vscode from 'vscode';
import type { AnnotationOccurrence, ManifestRef, Problem, ProblemKind, RefId, SourceTreeNode } from '@figbridge/core';
import type { FigBridgeWorkspace } from './workspace';
import type { Project } from './project';
import type { ProjectPreviews } from './figma';
import type { ActivityLog, ActivityRecord } from './activity';
import { describeError, formatDuration, relativeTime } from './format';

/** Common base: every node knows how to render itself and its children. */
export abstract class Node {
  abstract toItem(): vscode.TreeItem;
  children(): Node[] {
    return [];
  }
  /** Reference ID for commands invoked on this node. */
  refId?: RefId;
}

class Leaf extends Node {
  constructor(private readonly item: vscode.TreeItem) {
    super();
  }
  toItem() {
    return this.item;
  }
}

class Group extends Node {
  constructor(
    private readonly item: vscode.TreeItem,
    private readonly kids: () => Node[],
  ) {
    super();
  }
  toItem() {
    return this.item;
  }
  children() {
    return this.kids();
  }
}

abstract class BaseProvider implements vscode.TreeDataProvider<Node> {
  protected readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(protected readonly ws: FigBridgeWorkspace) {
    ws.onDidChange(() => this.emitter.fire(undefined));
  }
  getTreeItem(n: Node) {
    return n.toItem();
  }
  getChildren(n?: Node) {
    return n ? n.children() : this.roots();
  }
  protected abstract roots(): Node[];
  refresh() {
    this.emitter.fire(undefined);
  }
}

function item(label: string, opts: Partial<vscode.TreeItem> & { collapsed?: boolean; expanded?: boolean } = {}): vscode.TreeItem {
  const { collapsed, expanded, ...rest } = opts;
  const t = new vscode.TreeItem(
    label,
    expanded ? vscode.TreeItemCollapsibleState.Expanded : collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
  );
  Object.assign(t, rest);
  return t;
}

const icon = (id: string, color?: string) => new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);

function occurrenceNode(project: Project, o: AnnotationOccurrence, label?: string, kids?: () => Node[]): Node {
  const uri = project.uriOf(o.relPath);
  const owner = o.owner ? `${o.owner.name}` : o.attachment === 'file' ? '(file)' : '';
  const t = item(label ?? `${o.relPath}:${o.idRange.start.line + 1}`, {
    description: label ? `${o.relPath}:${o.idRange.start.line + 1}` : owner,
    tooltip: new vscode.MarkdownString(
      `\`${o.refId}\` — ${o.attachment}${o.owner ? ` of **${o.owner.name}** (${o.owner.kind})` : ''}\n\n${o.relPath}:${o.idRange.start.line + 1} · ${o.adapterId}${o.confidence === 'file-level' ? ' · file-level only' : ''}`,
    ),
    resourceUri: uri,
    iconPath: icon(o.attachment === 'declaration' ? 'symbol-class' : o.attachment === 'usage' ? 'symbol-reference' : 'file'),
    command: {
      command: 'vscode.open',
      title: 'Go to source',
      arguments: [uri, { selection: new vscode.Range(o.idRange.start.line, o.idRange.start.character, o.idRange.end.line, o.idRange.end.character) }],
    },
    collapsed: !!kids && kids().length > 0,
  });
  const n = kids ? new Group(t, kids) : new Leaf(t);
  n.refId = o.refId;
  t.contextValue = project.index.resolve(o.refId) ? 'ref mapped occurrence' : 'ref unresolved occurrence';
  return n;
}

// ---------------------------------------------------------------- Overview

export class OverviewProvider extends BaseProvider {
  private hasToken = false;
  constructor(ws: FigBridgeWorkspace) {
    super(ws);
    void ws.tokens.has().then((v) => {
      this.hasToken = v;
      this.refresh();
    });
    ws.tokens.onDidChange((v) => {
      this.hasToken = v;
      this.refresh();
    });
  }

  protected roots(): Node[] {
    const projects = this.ws.active();
    if (!projects.length) return [];
    const multi = projects.length > 1;
    const nodes = projects.flatMap(({ project, previews }) => {
      const rows = this.projectRows(project, previews);
      return multi ? [new Group(item(project.name, { expanded: true, iconPath: icon('root-folder') }), () => rows)] : rows;
    });
    return nodes;
  }

  private projectRows(project: Project, previews: ProjectPreviews): Node[] {
    const h = project.index.health();
    const m = project.manifest;
    const errors = project.manifestDiagnostics().filter((d) => d.severity === 'error').length;
    const rows: Node[] = [];
    const manifestLabel =
      project.state === 'ok' ? 'Manifest valid' : project.state === 'unsupported-version' ? 'Manifest version not supported' : `Manifest has ${errors} error${errors === 1 ? '' : 's'}`;
    rows.push(
      new Leaf(
        item(manifestLabel, {
          description: project.state === 'invalid' && m ? 'using last valid version' : m?.path,
          iconPath: project.state === 'ok' ? icon('pass', 'testing.iconPassed') : icon('error', 'errorForeground'),
          command: { command: 'figbridge.openManifest', title: 'Open manifest', arguments: [project.root] },
        }),
      ),
    );
    const trusted = vscode.workspace.isTrusted;
    rows.push(
      new Leaf(
        item(!trusted ? 'Figma disabled (untrusted workspace)' : this.hasToken ? 'Figma token set' : 'Figma token not set', {
          iconPath: icon(this.hasToken && trusted ? 'key' : 'warning', this.hasToken && trusted ? undefined : 'list.warningForeground'),
          description: this.hasToken ? 'stored in VS Code secret storage' : 'needed for previews',
          ...(trusted ? { command: { command: 'figbridge.setToken', title: 'Set token' } } : {}),
        }),
      ),
    );
    const scanLabel = { pending: 'Scanning…', partial: 'Scan incomplete', complete: 'Scan complete', failed: 'Scan failed' }[h.scanState];
    rows.push(new Leaf(item(scanLabel, { description: `${h.filesScanned} files`, iconPath: icon(h.scanState === 'pending' ? 'loading~spin' : h.scanState === 'complete' ? 'check' : 'warning') })));
    const count = (label: string, value: number | undefined, desc: string, ico: string, focus?: string) =>
      new Leaf(
        item(`${label}: ${value ?? '—'}`, {
          description: desc,
          iconPath: icon(ico),
          ...(focus ? { command: { command: `${focus}.focus`, title: 'Show' } } : {}),
        }),
      );
    rows.push(count('Annotations', h.occurrences, `${h.uniqueIdsUsed} unique IDs`, 'symbol-key', 'figbridge.references'));
    rows.push(
      count(
        'Mappings',
        h.mappings,
        h.unusedMappings === undefined ? 'unused: after full scan' : `${h.unusedMappings} unused in code`,
        'references',
        'figbridge.references',
      ),
    );
    const problems = project.index.problems().filter((p) => p.severity !== 'info').length + errors;
    rows.push(count('Problems', problems, `${h.unresolvedOccurrences} unresolved · ${h.malformedDirectives} malformed · ${h.invalidNodes} missing nodes`, problems ? 'warning' : 'pass', 'figbridge.problems'));
    if (m) {
      const files = [...m.files.values()];
      rows.push(
        new Group(item('Figma files', { expanded: files.length <= 3, iconPath: icon('file-media'), description: String(files.length) }), () =>
          files.map((f) => {
            const access = project.index.fileAccess(f.alias);
            const quota = f.apiKey && previews.service.isLowQuota(f.apiKey) ? previews.service.quota(f.apiKey) : undefined;
            const until = f.apiKey ? previews.service.blockedUntil(f.apiKey) : undefined;
            const quotaLabel = quota ? ` · ${quota.planTier === 'starter' ? 'Starter plan' : 'low API quota'}${until ? `, renders blocked ${formatDuration((until - Date.now()) / 1000)}` : ''}` : '';
            const n = new Leaf(
              item(f.name ?? f.alias, {
                description: (f.state !== 'ok' ? (f.state === 'env-missing' ? `needs ${f.envVar}` : 'invalid URL') : access === 'unknown' ? f.alias : `${f.alias} · ${access}`) + quotaLabel,
                tooltip: f.baseUrl ?? f.rawUrl ?? '',
                iconPath: icon(f.state === 'ok' && access !== 'denied' && access !== 'missing' ? 'file-media' : 'warning'),
                contextValue: 'figmaFile',
                ...(f.baseUrl ? { command: { command: 'vscode.open', title: 'Open file in Figma', arguments: [vscode.Uri.parse(f.baseUrl)] } } : {}),
              }),
            );
            (n as Node & { fileAlias?: string }).fileAlias = f.alias;
            return n;
          }),
        ),
      );
    }
    return rows;
  }
}

// ---------------------------------------------------------------- References

export class ReferencesProvider extends BaseProvider {
  groupBy: 'file' | 'source' = 'file';

  setGroupBy(mode: 'file' | 'source') {
    this.groupBy = mode;
    void vscode.commands.executeCommand('setContext', 'figbridge.groupBy', mode);
    this.refresh();
  }

  protected roots(): Node[] {
    const projects = this.ws.active();
    const multi = projects.length > 1;
    return projects.flatMap(({ project }) => {
      const rows = this.groupBy === 'file' ? this.byFile(project) : this.bySource(project);
      return multi ? [new Group(item(project.name, { expanded: true, iconPath: icon('root-folder') }), () => rows)] : rows;
    });
  }

  private refNode(project: Project, ref: ManifestRef): Node {
    const occs = project.index.occurrencesFor(ref.id);
    const resolved = project.index.resolve(ref.id)!;
    const bad = resolved.nodeState === 'missing' || resolved.nodeState === 'denied';
    const children = project.index.logicalChildren(ref.id);
    const t = item(ref.name ?? ref.nodeId, {
      description: `${ref.id} · ${occs.length ? `${occs.length} use${occs.length === 1 ? '' : 's'}` : 'unused'}${ref.deprecated ? ' · deprecated' : ''}`,
      tooltip: new vscode.MarkdownString(`**${ref.name ?? ref.nodeId}**\n\n\`${ref.id}\` → node \`${ref.nodeId}\` in ${ref.file}${ref.kind ? ` (${ref.kind})` : ''}${ref.tags.length ? `\n\nTags: ${ref.tags.join(', ')}` : ''}`),
      iconPath: bad ? icon('error', 'errorForeground') : occs.length ? icon(ref.kind === 'screen' ? 'device-mobile' : 'symbol-misc') : icon('circle-outline'),
      collapsed: occs.length + children.length > 0,
      contextValue: 'ref mapped',
      command: { command: 'figbridge.preview', title: 'Preview', arguments: [ref.id] },
    });
    const n = new Group(t, () => [
      ...occs.map((o) => occurrenceNode(project, o)),
      ...children.map((c) => this.refNode(project, c)),
    ]);
    n.refId = ref.id;
    return n;
  }

  private byFile(project: Project): Node[] {
    const m = project.manifest;
    const linked = project.index.allOccurrences().filter((o) => o.link);
    const linkedGroup = linked.length
      ? [
          new Group(item('Linked directly', { expanded: !m, iconPath: icon('link'), description: String(linked.length), tooltip: '@figma annotations that use a Figma link instead of a manifest ID' }), () =>
            linked.map((o) => occurrenceNode(project, o, project.index.resolve(o.refId)?.ref.name ?? `${o.owner?.name ?? 'node'} → ${o.link!.nodeId}`)),
          ),
        ]
      : [];
    if (!m) return linkedGroup;
    const files = [...m.files.values()];
    const groups: Node[] = files.map(
      (f) =>
        new Group(item(f.name ?? f.alias, { expanded: true, iconPath: icon('file-media'), description: `${[...m.refs.values()].filter((r) => r.file === f.alias).length} refs` }), () =>
          [...m.refs.values()]
            // Logical children appear under their parentRef; top level shows refs without one.
            .filter((r) => r.file === f.alias && (!r.parentRef || m.refs.get(r.parentRef)?.file !== f.alias))
            .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
            .map((r) => this.refNode(project, r)),
        ),
    );
    groups.push(...linkedGroup);
    const unresolved = project.index.allOccurrences().filter((o) => !o.link && !m.refs.has(o.refId));
    if (unresolved.length)
      groups.push(
        new Group(item('Not in manifest', { collapsed: true, iconPath: icon('question'), description: String(unresolved.length) }), () =>
          unresolved.map((o) => occurrenceNode(project, o, o.refId)),
        ),
      );
    return groups;
  }

  private bySource(project: Project): Node[] {
    const build = (n: SourceTreeNode): Node => {
      const o = n.occurrence;
      const ref = project.index.resolve(o.refId)?.ref;
      const label = `${o.owner?.name ?? '(file)'} → ${ref?.name ?? (o.link ? `node ${o.link.nodeId}` : o.refId)}`;
      return occurrenceNode(project, o, label, () => n.children.map(build));
    };
    return project.index.sourceTree().map(build);
  }
}

// ---------------------------------------------------------------- Problems

const PROBLEM_GROUPS: Array<[ProblemKind, string, string]> = [
  ['unresolved', 'Unresolved IDs', 'question'],
  ['malformed', 'Malformed annotations', 'error'],
  ['noncanonical', 'Lower-case IDs', 'case-sensitive'],
  ['invalid-node', 'Missing or inaccessible nodes', 'error'],
  ['inaccessible-file', 'Inaccessible Figma files', 'error'],
  ['unresolved-file', 'Unresolved Figma files', 'warning'],
  ['deprecated', 'Deprecated references in use', 'warning'],
  ['unused', 'Unused mappings', 'circle-outline'],
];

export class ProblemsProvider extends BaseProvider {
  constructor(
    ws: FigBridgeWorkspace,
    private readonly view: () => vscode.TreeView<Node> | undefined,
  ) {
    super(ws);
    ws.onDidChange(() => this.updateBadge());
  }

  private updateBadge() {
    const v = this.view();
    if (!v) return;
    const n = this.ws.active().reduce((acc, { project }) => acc + project.index.problems().filter((p) => p.severity !== 'info').length, 0);
    v.badge = n ? { value: n, tooltip: `${n} FigBridge problem${n === 1 ? '' : 's'}` } : undefined;
  }

  protected roots(): Node[] {
    const out: Node[] = [];
    for (const { project } of this.ws.active()) {
      const problems = project.index.problems();
      const manifestDiags = project.manifestDiagnostics().filter((d) => d.severity !== 'info');
      if (manifestDiags.length)
        out.push(
          new Group(item('Manifest', { expanded: true, iconPath: icon('file-code'), description: String(manifestDiags.length) }), () =>
            manifestDiags.map(
              (d) =>
                new Leaf(
                  item(d.message, {
                    iconPath: icon(d.severity === 'error' ? 'error' : 'warning'),
                    description: d.range ? `line ${d.range.start.line + 1}` : '',
                    command: {
                      command: 'vscode.open',
                      title: 'Open',
                      arguments: [project.manifestUri, d.range ? { selection: new vscode.Range(d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character) } : {}],
                    },
                  }),
                ),
            ),
          ),
        );
      for (const [kind, label, ico] of PROBLEM_GROUPS) {
        const list = problems.filter((p) => p.kind === kind);
        if (!list.length) continue;
        out.push(new Group(item(label, { collapsed: list.length > 20, expanded: list.length <= 20, iconPath: icon(ico), description: String(list.length) }), () => list.map((p) => this.problemNode(project, p))));
      }
    }
    return out;
  }

  private problemNode(project: Project, p: Problem): Node {
    const target = p.relPath
      ? { command: 'vscode.open', title: 'Go to source', arguments: [project.uriOf(p.relPath), { selection: new vscode.Range(p.line ?? 0, 0, p.line ?? 0, 0) }] }
      : p.refId
        ? { command: 'figbridge.revealInManifest', title: 'Show in manifest', arguments: [p.refId] }
        : { command: 'figbridge.openManifest', title: 'Open manifest', arguments: [project.root] };
    const n = new Leaf(
      item(p.refId ?? p.fileAlias ?? p.message, {
        description: p.relPath ? `${p.relPath}:${(p.line ?? 0) + 1}` : p.message,
        tooltip: p.message,
        contextValue: p.kind === 'unresolved' ? 'ref unresolved' : p.refId && p.kind !== 'unused' ? 'ref mapped' : p.kind === 'unused' ? 'ref mapped unused' : 'problem',
        command: target,
      }),
    );
    if (p.refId) n.refId = p.refId;
    return n;
  }
}

// ---------------------------------------------------------------- Claude activity

export class ActivityProvider extends BaseProvider {
  constructor(
    ws: FigBridgeWorkspace,
    private readonly log: ActivityLog,
  ) {
    super(ws);
    log.onDidChange(() => this.refresh());
  }

  protected roots(): Node[] {
    return this.log.records().map((r) => this.recordNode(r));
  }

  private recordNode(r: ActivityRecord): Node {
    const status: Record<ActivityRecord['status'], [string, string, string?]> = {
      'preview-refreshed': ['Preview refreshed', 'pass', 'testing.iconPassed'],
      stale: ['Stale — refresh pending', 'history', 'list.warningForeground'],
      failed: ['Figma operation failed', 'error', 'errorForeground'],
      'target-unknown': ['Target unknown — refresh manually', 'question', 'list.warningForeground'],
      'not-configured': ['File not in this manifest', 'circle-slash'],
      read: ['Read only', 'eye'],
      'no-preview-change': ['No preview change', 'circle-outline'],
    };
    const [label, ico, color] = status[r.status];
    const target = r.refIds.length ? `${r.refIds.length} ref${r.refIds.length === 1 ? '' : 's'}` : r.fileAlias ?? (r.fileKey ? 'unconfigured file' : 'unknown file');
    const t = item(`${r.tool}`, {
      description: `${label} · ${target} · ${relativeTime(r.ts)}`,
      tooltip: new vscode.MarkdownString(
        `**${r.tool}** (${r.kind}, ${r.result})\n\n${label}\n\n${r.fileAlias ? `File: ${r.fileAlias}` : ''}${r.nodeIds.length ? `  \nNodes: ${r.nodeIds.join(', ')}` : ''}${r.error ? `\n\n${describeError({ code: 'BAD_RESPONSE', message: r.error })}` : ''}\n\n${new Date(r.ts).toLocaleString()}`,
      ),
      iconPath: icon(ico, color),
      collapsed: r.refIds.length > 0,
    });
    return new Group(t, () =>
      r.refIds.map((id) => {
        const located = this.ws.byRefId(id);
        const ref = located?.resolved?.ref;
        const n = new Leaf(
          item(ref?.name ?? id, { description: id, iconPath: icon('symbol-misc'), contextValue: 'ref mapped', command: { command: 'figbridge.preview', title: 'Preview', arguments: [id] } }),
        );
        n.refId = id;
        return n;
      }),
    );
  }
}
