// Bundles the CLI and assembles a local Claude Code plugin marketplace in ./marketplace.
import { writeNotices } from '../../scripts/notices.mjs';
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const out = 'marketplace';
const pluginDir = join(out, 'plugins', 'figbridge');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(pluginDir, 'dist', 'wasm'), { recursive: true });

const result = await build({
  entryPoints: ['src/bin.ts'],
  bundle: true,
  outfile: join(pluginDir, 'dist', 'figbridge-claude.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  minify: true,
  legalComments: 'external',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
  metafile: true,
});

const coreDir = dirname(require.resolve('@figbridge/core/package.json'));
const coreRequire = createRequire(join(coreDir, 'package.json'));
const vscodeWasm = join(dirname(coreRequire.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
cpSync(join(dirname(coreRequire.resolve('web-tree-sitter')), 'web-tree-sitter.wasm'), join(pluginDir, 'dist', 'wasm', 'web-tree-sitter.wasm'));
for (const g of ['typescript', 'tsx', 'javascript']) cpSync(join(vscodeWasm, `tree-sitter-${g}.wasm`), join(pluginDir, 'dist', 'wasm', `tree-sitter-${g}.wasm`));
cpSync(join(coreDir, 'wasm', 'tree-sitter-dart.wasm'), join(pluginDir, 'dist', 'wasm', 'tree-sitter-dart.wasm'));
cpSync('plugin-template', pluginDir, { recursive: true });
cpSync(join('..', '..', 'LICENSE'), join(pluginDir, 'LICENSE'));

// Keep plugin version in step with this package.
const manifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = pkg.version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

mkdirSync(join(out, '.claude-plugin'), { recursive: true });
writeFileSync(
  join(out, '.claude-plugin', 'marketplace.json'),
  JSON.stringify(
    {
      name: 'figbridge-local',
      owner: { name: 'FigBridge' },
      description: 'FigBridge plugin bundled with the FigBridge VS Code extension.',
      plugins: [{ name: 'figbridge', source: './plugins/figbridge', description: manifest.description, version: pkg.version }],
    },
    null,
    2,
  ) + '\n',
);
writeNotices(result.metafile, join(pluginDir, 'THIRD_PARTY_NOTICES.md'), [
  { name: 'tree-sitter-dart (grammar, compiled to WASM)', version: 'be07cf7', license: 'MIT', dir: join(coreDir, 'wasm'), licenseFile: 'tree-sitter-dart.LICENSE' },
  { name: '@vscode/tree-sitter-wasm (TypeScript/TSX/JavaScript grammars)', version: '0.3.1', license: 'MIT', dir: dirname(coreRequire.resolve('@vscode/tree-sitter-wasm/package.json')) },
]);
console.log(`built ${out}/ (plugin ${pkg.version})`);
