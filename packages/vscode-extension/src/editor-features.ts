import * as vscode from 'vscode';
import type { Diagnostic as CoreDiagnostic } from '@figbridge/core';
import type { FigBridgeWorkspace } from './workspace';

const SELECTOR: vscode.DocumentSelector = [{ scheme: 'file' }, { scheme: 'untitled' }];

function toRange(d: CoreDiagnostic): vscode.Range {
  const r = d.range;
  return r ? new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character) : new vscode.Range(0, 0, 0, 0);
}

function toVsDiagnostic(d: CoreDiagnostic): vscode.Diagnostic {
  const sev = d.severity === 'error' ? vscode.DiagnosticSeverity.Error : d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
  const v = new vscode.Diagnostic(toRange(d), d.message, sev);
  v.source = 'FigBridge';
  v.code = d.code;
  if (d.code === 'UNRESOLVED_REF' && d.severity !== 'error') v.tags = [];
  (v as vscode.Diagnostic & { data?: Record<string, string> }).data = d.data;
  return v;
}

/** Publishes manifest and per-file diagnostics to the Problems panel. */
export class DiagnosticsPublisher implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('figbridge');
  private readonly dataByUri = new Map<string, CoreDiagnostic[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ws: FigBridgeWorkspace) {
    ws.onDidChange(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.publish(), 150);
    });
  }

  publish(): void {
    this.collection.clear();
    this.dataByUri.clear();
    for (const { project } of this.ws.active()) {
      const md = project.manifestDiagnostics();
      if (md.length) this.set(project.manifestUri, md);
      for (const relPath of new Set(project.index.allOccurrences().map((o) => o.relPath))) this.set(project.uriOf(relPath), project.index.diagnosticsFor(relPath));
      // Files with only malformed directives have no occurrences; include them too.
      for (const p of project.index.problems()) if (p.kind === 'malformed' && p.relPath) this.set(project.uriOf(p.relPath), project.index.diagnosticsFor(p.relPath));
    }
  }

  private set(uri: vscode.Uri, diags: CoreDiagnostic[]): void {
    this.dataByUri.set(uri.toString(), diags);
    this.collection.set(uri, diags.map(toVsDiagnostic));
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.collection.dispose();
  }
}

/** Quick fixes: upper-case IDs, apply suggested IDs, create mappings, replace deprecated IDs. */
export class FigmaCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    const out: vscode.CodeAction[] = [];
    for (const d of context.diagnostics) {
      if (d.source !== 'FigBridge') continue;
      const data = (d as vscode.Diagnostic & { data?: Record<string, string> }).data ?? {};
      const replace = (title: string, text: string) => {
        const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit();
        a.edit.replace(document.uri, d.range, text);
        a.diagnostics = [d];
        a.isPreferred = true;
        out.push(a);
      };
      switch (d.code) {
        case 'NONCANONICAL_CASE':
          if (data.refId) replace(`Change to ${data.refId}`, data.refId);
          break;
        case 'MALFORMED_DIRECTIVE':
          if (data.suggestion) {
            const text = document.getText(d.range);
            replace(`Use ${data.suggestion}`, text.replace(/(@figma[ \t]+)\S+/, `$1${data.suggestion}`));
          }
          break;
        case 'DEPRECATED_REF':
          if (data.replacedBy) replace(`Replace with ${data.replacedBy}`, data.replacedBy);
          break;
        case 'UNRESOLVED_REF': {
          if (!data.refId || d.severity === vscode.DiagnosticSeverity.Error) break;
          const a = new vscode.CodeAction(`Create mapping for ${data.refId}…`, vscode.CodeActionKind.QuickFix);
          a.command = { command: 'figbridge.createMapping', title: 'Create mapping', arguments: [data.refId] };
          a.diagnostics = [d];
          out.push(a);
          break;
        }
      }
    }
    return out;
  }
}

/** `Checkout screen · Open in Figma · Preview` above annotated declarations. */
export class FigmaCodeLens implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly ws: FigBridgeWorkspace) {
    ws.onDidChange(() => this.emitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('figbridge').get<boolean>('codeLens.enabled', true)) return [];
    const entry = this.ws.forUri(document.uri);
    const rel = entry?.project.relPath(document.uri);
    if (!entry || !rel) return [];
    const lenses: vscode.CodeLens[] = [];
    for (const o of entry.project.index.occurrencesIn(rel)) {
      if (o.attachment !== 'declaration') continue;
      const range = new vscode.Range(o.idRange.start.line, 0, o.idRange.start.line, 0);
      const resolved = entry.project.index.resolve(o.refId);
      if (!resolved) {
        lenses.push(new vscode.CodeLens(range, { title: `$(warning) ${o.refId} not in manifest`, command: 'figbridge.createMapping', arguments: [o.refId] }));
        continue;
      }
      lenses.push(new vscode.CodeLens(range, { title: `$(symbol-misc) ${resolved.ref.name ?? resolved.ref.nodeId}`, command: 'figbridge.preview', arguments: [o.refId] }));
      if (resolved.openUrl) lenses.push(new vscode.CodeLens(range, { title: 'Open in Figma', command: 'figbridge.open', arguments: [o.refId] }));
    }
    return lenses;
  }
}

export const DOCUMENT_SELECTOR = SELECTOR;
