import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tests run against a throwaway copy of the demo fixture and a throwaway state directory.
const work = mkdtempSync(join(tmpdir(), 'figbridge-e2e-'));
// The profile may hold a token from live tests; always delete it.
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
cpSync(fileURLToPath(new URL('../../fixtures/workspaces/demo', import.meta.url)), join(work, 'demo'), { recursive: true });

export default defineConfig({
  files: 'out/test/**/*.test.js',
  workspaceFolder: join(work, 'demo'),
  useInstallation: process.env.VSCODE_PATH ? { fromPath: process.env.VSCODE_PATH } : undefined,
  launchArgs: ['--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${join(work, 'user-data')}`],
  env: {
    FIGMA_FILE_URL: 'https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers?node-id=1-9400&p=f',
    XDG_STATE_HOME: join(work, 'state'),
  },
  mocha: { timeout: 30000, ui: 'tdd' },
});
