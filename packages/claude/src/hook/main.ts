import { eventFromHook, findManifestRoot, spoolDirFor, writeEvent, type HookInput } from '@figbridge/core';

const MAX_STDIN = 16 * 1024 * 1024;

/**
 * PostToolUse / PostToolUseFailure hook. Turns a Figma MCP tool call into a sanitised event in
 * the per-user spool. Always exits 0 and prints nothing to stdout, so it can never block,
 * alter or add context to Claude's work.
 */
export async function runHook(stdin: NodeJS.ReadableStream = process.stdin): Promise<void> {
  try {
    const raw = await readCapped(stdin, MAX_STDIN);
    if (raw === undefined) return;
    const input = JSON.parse(raw) as HookInput & { cwd?: unknown };
    const event = eventFromHook(input);
    if (!event) return;
    const start = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === 'string' ? input.cwd : process.cwd());
    const root = findManifestRoot(start);
    if (!root) return;
    await writeEvent(await spoolDirFor(root), event);
  } catch (e) {
    if (process.env.FIGBRIDGE_DEBUG) process.stderr.write(`figbridge hook: ${(e as Error).message}\n`);
  }
}

function readCapped(stream: NodeJS.ReadableStream, max: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    stream.on('end', () => resolve(over ? undefined : Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => resolve(undefined));
  });
}
