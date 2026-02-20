import * as vscode from 'vscode';
import type { PreviewStatus, RefId } from '@figbridge/core';
import type { FigBridgeWorkspace, Located } from './workspace';
import { describeError, relativeTime } from './format';

/**
 * Single reusable preview panel. The webview runs no scripts at all: actions live in the editor
 * title bar as ordinary commands, so manifest or Figma text can't become executable.
 */
export class PreviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private current: RefId | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly ws: FigBridgeWorkspace) {
    this.disposables.push(ws.onDidChange(() => void this.render()));
  }

  get currentRef(): RefId | undefined {
    return this.panel?.active || this.panel?.visible ? this.current : undefined;
  }

  async show(located: Located, force = false): Promise<void> {
    this.current = located.refId;
    const roots = [vscode.Uri.file(located.previews.cache.dir)];
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('figbridge.preview', 'Figma Preview', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
        enableScripts: false,
        enableCommandUris: false,
        localResourceRoots: roots,
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.current = undefined;
      });
    } else {
      this.panel.webview.options = { enableScripts: false, enableCommandUris: false, localResourceRoots: roots };
      this.panel.reveal(undefined, true);
    }
    await this.render();
    const req = located.resolved ? located.previews.request(located.resolved) : undefined;
    if (req && vscode.workspace.isTrusted && (await this.ws.tokens.has())) {
      void located.previews.service.ensure(req, { force }).then(() => this.render());
      await this.render();
    }
  }

  private async render(): Promise<void> {
    if (!this.panel || !this.current) return;
    const located = this.ws.byRefId(this.current);
    const webview = this.panel.webview;
    const ref = located?.resolved?.ref;
    this.panel.title = `Figma: ${ref?.name ?? this.current}`;
    const status = located?.resolved ? located.previews.peek(located.resolved) : undefined;
    const hasToken = await this.ws.tokens.has();
    webview.html = html(webview, located, status, hasToken);
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function html(webview: vscode.Webview, located: Located | undefined, status: PreviewStatus | undefined, hasToken: boolean): string {
  const csp = `default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline';`;
  const r = located?.resolved;
  const entry = status && 'entry' in status ? status.entry : undefined;
  let body = '';
  if (!located || !r) body = `<p class="warn">Reference ${esc(located?.refId ?? '')} is not in the manifest.</p>`;
  else {
    body += `<h1>${esc(r.ref.name ?? r.ref.nodeId)}</h1>`;
    body += `<p class="meta">${esc(r.file.name ?? r.file.alias)} · node <code>${esc(r.ref.nodeId)}</code> · <code>${esc(r.ref.id)}</code>${r.ref.kind ? ` · ${esc(r.ref.kind)}` : ''}</p>`;
    const uses = located.project.index.occurrencesFor(r.ref.id);
    if (uses.length) body += `<p class="meta">Used in ${uses.map((o) => `<code>${esc(o.relPath)}:${o.idRange.start.line + 1}</code>`).slice(0, 8).join(', ')}${uses.length > 8 ? ' …' : ''}</p>`;
    if (!vscode.workspace.isTrusted) body += '<p class="warn">Previews are disabled in untrusted workspaces.</p>';
    else if (!hasToken) body += '<p class="warn">Set a Figma access token (command “FigBridge: Set Figma Access Token”) to load previews.</p>';
    else if (r.file.state !== 'ok') body += `<p class="warn">The Figma file “${esc(r.file.alias)}” can’t be resolved${r.file.envVar ? ` — set ${esc(r.file.envVar)}` : ''}.</p>`;
    else if (status) {
      const line =
        status.state === 'fresh'
          ? `Rendered ${relativeTime(status.entry.fetchedAt)}`
          : status.state === 'stale'
            ? status.reason === 'claude-event'
              ? 'Possibly outdated — Claude changed this file. Refreshing…'
              : 'Checking for changes…'
            : status.state === 'loading'
              ? 'Rendering in Figma… (usually 5–10 s)'
              : status.state === 'error'
                ? describeError(status.error)
                : 'Loading…';
      body += `<p class="${status.state === 'error' ? 'warn' : 'meta'}">${esc(line)}</p>`;
    }
    if (entry) {
      const src = webview.asWebviewUri(vscode.Uri.file(located.previews.cache.pathOf(entry)));
      body += `<img src="${esc(src.toString())}" width="${entry.width}" height="${entry.height}" alt="${esc(`Figma design: ${r.ref.name ?? r.ref.nodeId}`)}">`;
    }
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px 16px}
h1{font-size:1.2em;margin:0 0 4px}.meta{color:var(--vscode-descriptionForeground);margin:2px 0}
.warn{color:var(--vscode-errorForeground)}code{font-family:var(--vscode-editor-font-family)}
img{display:block;margin-top:12px;max-width:100%;height:auto;border:1px solid var(--vscode-panel-border);background:repeating-conic-gradient(#8882 0 25%,transparent 0 50%) 50%/16px 16px}
</style></head><body>${body}</body></html>`;
}
