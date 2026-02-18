import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHook } from './hook/main.js';
import { runMcpServer } from './mcp/server.js';

const [major] = process.versions.node.split('.').map(Number);
if ((major ?? 0) < 20) {
  process.stderr.write(`FigBridge needs Node.js 20 or newer (found ${process.versions.node}).\n`);
  process.exit(process.argv[2] === 'hook' ? 0 : 1);
}

const wasmDir = join(dirname(fileURLToPath(import.meta.url)), 'wasm');
switch (process.argv[2]) {
  case 'mcp':
    await runMcpServer(wasmDir);
    break;
  case 'hook':
    await runHook();
    break;
  default:
    process.stderr.write('usage: figbridge-claude <mcp|hook>\n');
    process.exit(2);
}
