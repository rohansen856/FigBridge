import * as vscode from 'vscode';

export const MARKETPLACE_NAME = 'figbridge-local';
export const PLUGIN_NAME = 'figbridge';

/**
 * Installs the bundled Claude Code plugin (read-only MCP server + PostToolUse hooks + skill)
 * through Claude Code's own plugin manager. FigBridge never edits .mcp.json, settings.json or
 * CLAUDE.md; it copies the plugin to a stable folder and runs `claude plugin` commands in a
 * visible terminal only after the user confirms.
 */
export async function setupClaude(context: vscode.ExtensionContext): Promise<void> {
  const bundled = vscode.Uri.joinPath(context.extensionUri, 'claude-marketplace');
  try {
    await vscode.workspace.fs.stat(bundled);
  } catch {
    throw new Error('This build of FigBridge does not include the Claude Code plugin.');
  }
  const target = vscode.Uri.joinPath(context.globalStorageUri, 'claude-marketplace');
  const commands = [`claude plugin marketplace add ${shellQuote(target.fsPath)}`, `claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`];
  const choice = await vscode.window.showInformationMessage(
    'Set up the FigBridge Claude Code plugin?',
    {
      modal: true,
      detail: [
        'It adds to Claude Code:',
        '• a read-only "figbridge" MCP server that resolves @figma IDs from figma.design.yaml (no Figma token, no network);',
        '• PostToolUse/PostToolUseFailure hooks that note Figma MCP edits so FigBridge can mark previews stale;',
        '• a short skill telling Claude how to use @figma references.',
        '',
        `The plugin is copied to:\n${target.fsPath}`,
        '',
        'Then these commands run in a terminal (Claude Code asks before enabling anything):',
        ...commands.map((c) => `  ${c}`),
        '',
        `Remove it any time with: claude plugin uninstall ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
      ].join('\n'),
    },
    'Run in Terminal',
    'Copy Commands',
  );
  if (!choice) return;
  await vscode.workspace.fs.delete(target, { recursive: true, useTrash: false }).then(undefined, () => undefined);
  await vscode.workspace.fs.copy(bundled, target, { overwrite: true });
  await context.globalState.update('figbridge.claudePluginVersion', context.extension.packageJSON.version);
  if (choice === 'Copy Commands') {
    await vscode.env.clipboard.writeText(commands.join('\n'));
    void vscode.window.showInformationMessage('FigBridge: commands copied. Run them in a terminal, then restart Claude Code.');
    return;
  }
  const terminal = vscode.window.createTerminal({ name: 'FigBridge: Claude setup' });
  terminal.show();
  for (const c of commands) terminal.sendText(c);
}

/** After an extension update, refresh the copied plugin so Claude can pick up the new version. */
export async function refreshInstalledPlugin(context: vscode.ExtensionContext): Promise<void> {
  const installed = context.globalState.get<string>('figbridge.claudePluginVersion');
  const current = context.extension.packageJSON.version as string;
  if (!installed || installed === current) return;
  const bundled = vscode.Uri.joinPath(context.extensionUri, 'claude-marketplace');
  const target = vscode.Uri.joinPath(context.globalStorageUri, 'claude-marketplace');
  try {
    await vscode.workspace.fs.copy(bundled, target, { overwrite: true });
    await context.globalState.update('figbridge.claudePluginVersion', current);
    const pick = await vscode.window.showInformationMessage(
      `FigBridge ${current} includes an updated Claude Code plugin.`,
      'Update in Terminal',
    );
    if (pick) {
      const t = vscode.window.createTerminal({ name: 'FigBridge: Claude update' });
      t.show();
      t.sendText(`claude plugin marketplace update ${MARKETPLACE_NAME}`);
      t.sendText(`claude plugin update ${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
    }
  } catch {
    /* plugin not bundled in this build */
  }
}

function shellQuote(p: string): string {
  return process.platform === 'win32' ? `"${p.replace(/"/g, '""')}"` : `'${p.replace(/'/g, `'\\''`)}'`;
}
