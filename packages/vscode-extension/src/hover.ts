import * as vscode from 'vscode';
import type { PreviewStatus } from '@figbridge/core';
import type { FigBridgeWorkspace, Located } from './workspace';
import { commandLink, describeError, escapeMd, relativeTime } from './format';

/** Hover over a `@figma ID`: rendered node image, labels, status and actions. */
export class FigmaHoverProvider implements vscode.HoverProvider {
  constructor(private readonly ws: FigBridgeWorkspace) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const config = vscode.workspace.getConfiguration('figbridge');
    if (!config.get<boolean>('hover.enabled', true)) return undefined;
    const located = this.ws.locate(document, position);
    if (!located?.occurrence) return undefined;
    const range = new vscode.Range(
      located.occurrence.idRange.start.line,
      located.occurrence.idRange.start.character,
      located.occurrence.idRange.end.line,
      located.occurrence.idRange.end.character,
    );

    if (!located.resolved) return new vscode.Hover(this.unresolved(located), range);

    let status = located.previews.peek(located.resolved);
    const hasToken = vscode.workspace.isTrusted && (await this.ws.tokens.has());
    const autoRender = config.get<boolean>('preview.renderOnHover', true);
    // Fresh: nothing to do. Error: respect the negative cache (e.g. a rate-limit back-off) until
    // the user refreshes. Loading: a fetch is already running.
    if (status && hasToken && (status.state === 'stale' || (status.state === 'missing' && autoRender))) {
      const req = located.previews.request(located.resolved)!;
      const pending = located.previews.service.ensure(req);
      // Wait long enough for a first render to land in this hover, or briefly for a revalidation.
      const waitMs = status.state === 'missing' ? config.get<number>('hover.waitMs', 1500) : 300;
      const winner = await Promise.race([pending, delay(waitMs), cancelled(token)]);
      if (token.isCancellationRequested) return undefined;
      status = winner ?? located.previews.service.peek(req);
    }
    return new vscode.Hover(await this.resolvedMarkdown(located, status, hasToken), range);
  }

  private unresolved(located: Located): vscode.MarkdownString {
    const md = trusted(['figbridge.createMapping', 'figbridge.openManifest']);
    const manifest = located.project.manifest;
    md.appendMarkdown(`**$(warning) Unknown Figma reference \`${escapeMd(located.refId)}\`**\n\n`);
    if (!manifest) md.appendMarkdown('No valid `figma.design.yaml` is loaded.\n\n');
    else if (manifest.retired.has(located.refId)) md.appendMarkdown('This ID was retired and must not be reused.\n\n');
    else md.appendMarkdown(`It is not defined in \`${escapeMd(manifest.path)}\`.\n\n`);
    md.appendMarkdown(`${commandLink('$(add) Create mapping…', 'figbridge.createMapping', [located.refId])} · ${commandLink('Open manifest', 'figbridge.openManifest', [])}`);
    return md;
  }

  private async resolvedMarkdown(located: Located, status: PreviewStatus | undefined, hasToken: boolean): Promise<vscode.MarkdownString> {
    const r = located.resolved!;
    const manifest = located.project.manifest!;
    const md = trusted(['figbridge.open', 'figbridge.preview', 'figbridge.refresh', 'figbridge.setToken', 'figbridge.copyFigmaUrl']);
    const title = r.ref.name ?? r.ref.nodeId;
    md.appendMarkdown(`**${escapeMd(title)}**`);
    if (r.ref.kind) md.appendMarkdown(` · ${escapeMd(r.ref.kind)}`);
    md.appendMarkdown(`  \n${escapeMd(r.file.name ?? r.file.alias)} · node \`${escapeMd(r.ref.nodeId)}\` · \`${escapeMd(r.ref.id)}\``);
    if (r.ref.deprecated) md.appendMarkdown(`  \n$(warning) Deprecated${r.ref.replacedBy ? ` — use \`${escapeMd(r.ref.replacedBy)}\`` : ''}`);
    md.appendMarkdown('\n\n');

    const cached = status && 'entry' in status && status.entry;
    if (r.file.state === 'env-missing') md.appendMarkdown(`$(warning) Set \`${escapeMd(r.file.envVar ?? '')}\` to resolve this file.\n\n`);
    else if (!vscode.workspace.isTrusted) md.appendMarkdown('$(shield) Previews are disabled in untrusted workspaces.\n\n');
    else {
      // A cached image is shown even without a token (offline / token removed).
      if (status && (hasToken || cached)) await this.appendPreview(md, located, status, manifest.preview.hoverWidth);
      if (!hasToken) md.appendMarkdown(`$(key) ${commandLink('Set a Figma access token', 'figbridge.setToken', [])} to ${cached ? 'refresh' : 'see'} the preview.\n\n`);
    }

    const actions = [commandLink('$(link-external) Open in Figma', 'figbridge.open', [r.ref.id])];
    if (hasToken && r.file.state === 'ok') {
      actions.push(commandLink('$(eye) Preview', 'figbridge.preview', [r.ref.id]));
      actions.push(commandLink('$(refresh) Refresh', 'figbridge.refresh', [r.ref.id]));
    }
    if (r.file.state !== 'ok') actions.splice(0, 1);
    md.appendMarkdown(actions.join(' · '));
    const uses = located.project.index.occurrencesFor(r.ref.id).length;
    md.appendMarkdown(`  \n<sub>${uses} use${uses === 1 ? '' : 's'} in code</sub>`);
    return md;
  }

  private async appendPreview(md: vscode.MarkdownString, located: Located, status: PreviewStatus, width: number): Promise<void> {
    const entry = 'entry' in status ? status.entry : undefined;
    if (entry) {
      const src = await this.imageSource(located, entry);
      const alt = escapeMd(located.resolved!.ref.name ?? 'Figma design preview');
      if (src) md.appendMarkdown(`![${alt}](${src}|width=${Math.min(width, entry.width)})\n\n`);
      else md.appendMarkdown(`${commandLink('$(eye) Open preview', 'figbridge.preview', [located.refId])} (image too large to show here)\n\n`);
    }
    switch (status.state) {
      case 'fresh':
        md.appendMarkdown(`<sub>Rendered ${relativeTime(entry!.fetchedAt)}</sub>\n\n`);
        break;
      case 'stale':
        md.appendMarkdown(
          `<sub>$(history) ${status.reason === 'claude-event' ? 'Possibly outdated: changed by Claude' : status.reason === 'version-changed' ? 'Outdated: file changed' : 'Checking for changes…'} · rendered ${relativeTime(status.entry.fetchedAt)}</sub>\n\n`,
        );
        break;
      case 'loading':
        md.appendMarkdown(`$(loading~spin) Rendering in Figma… (usually 5–10 s; hover again or ${commandLink('open preview', 'figbridge.preview', [located.refId])})\n\n`);
        break;
      case 'missing':
        md.appendMarkdown(`${commandLink('$(eye) Load preview', 'figbridge.preview', [located.refId])}\n\n`);
        break;
      case 'error':
        md.appendMarkdown(`$(error) ${escapeMd(describeError(status.error))}${entry ? ' (showing the last image)' : ''}\n\n`);
        break;
    }
  }

  /**
   * `file:` URI for persisted previews on a local extension host. When the host is remote or
   * previews are memory-only, a data URI is used if it fits VS Code's 100k-character markdown
   * limit; otherwise the caller links to the preview panel.
   */
  private async imageSource(located: Located, entry: { fileName: string; bytes: number }): Promise<string | undefined> {
    const persist = vscode.workspace.getConfiguration('figbridge').get<boolean>('preview.persist', true);
    if (persist && !vscode.env.remoteName) return vscode.Uri.file(located.previews.cache.pathOf(entry as never)).toString();
    if (entry.bytes > 70_000) return undefined;
    const bytes = await located.previews.cache.read(entry as never);
    if (!bytes) return undefined;
    const mime = entry.fileName.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  }
}

function trusted(commands: string[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = { enabledCommands: commands };
  md.supportHtml = true;
  return md;
}

function delay(ms: number): Promise<undefined> {
  return new Promise((r) => setTimeout(() => r(undefined), ms));
}

function cancelled(token: vscode.CancellationToken): Promise<undefined> {
  return new Promise((r) => token.onCancellationRequested(() => r(undefined)));
}
