import * as vscode from 'vscode';
import { Scanner } from '@figbridge/core';
import { ActivityLog } from './activity';
import { refreshInstalledPlugin } from './claude-setup';
import { registerCommands } from './commands';
import { DiagnosticsPublisher, DOCUMENT_SELECTOR, FigmaCodeActions, FigmaCodeLens } from './editor-features';
import { TokenStore } from './figma';
import { FigmaHoverProvider } from './hover';
import { PreviewPanel } from './preview-panel';
import { ActivityProvider, OverviewProvider, ProblemsProvider, ReferencesProvider, type Node } from './views';
import { FigBridgeWorkspace } from './workspace';

export interface FigBridgeApi {
  /** Exposed for integration tests only. */
  workspace: FigBridgeWorkspace;
  activity: ActivityLog;
}

export async function activate(context: vscode.ExtensionContext): Promise<FigBridgeApi> {
  const scanner = await Scanner.create({ wasmDir: vscode.Uri.joinPath(context.extensionUri, 'dist', 'wasm').fsPath });
  const tokens = new TokenStore(context.secrets);
  const ws = new FigBridgeWorkspace(context, scanner, tokens);
  const panel = new PreviewPanel(ws);
  const activity = new ActivityLog(ws, context.workspaceState);
  const references = new ReferencesProvider(ws);
  // The provider sets the view badge, so it reads the view lazily.
  const problems: ProblemsProvider = new ProblemsProvider(ws, () => problemsView);
  const problemsView: vscode.TreeView<Node> = vscode.window.createTreeView('figbridge.problems', { treeDataProvider: problems });
  void vscode.commands.executeCommand('setContext', 'figbridge.groupBy', 'file');

  context.subscriptions.push(
    ws,
    panel,
    activity,
    problemsView,
    new DiagnosticsPublisher(ws),
    vscode.window.createTreeView('figbridge.overview', { treeDataProvider: new OverviewProvider(ws) }),
    vscode.window.createTreeView('figbridge.references', { treeDataProvider: references, showCollapseAll: true }),
    vscode.window.createTreeView('figbridge.activity', { treeDataProvider: new ActivityProvider(ws, activity) }),
    vscode.languages.registerHoverProvider(DOCUMENT_SELECTOR, new FigmaHoverProvider(ws)),
    vscode.languages.registerCodeLensProvider(DOCUMENT_SELECTOR, new FigmaCodeLens(ws)),
    vscode.languages.registerCodeActionsProvider(DOCUMENT_SELECTOR, new FigmaCodeActions(), { providedCodeActionKinds: FigmaCodeActions.kinds }),
    ...registerCommands({ context, ws, panel, activity, references }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      for (const { project } of ws.projects.values()) void project.reloadManifest(false);
      void activity.start();
    }),
  );

  await ws.start();
  void activity.start();
  void refreshInstalledPlugin(context);
  return { workspace: ws, activity };
}

export function deactivate(): void {
  /* disposables handle cleanup */
}
