import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { findManifestRoot, MANIFEST_FILENAME, Scanner } from '@figbridge/core';
import { DiskIndexer } from './indexer.js';
import { Tools } from './tools.js';

export const SERVER_INSTRUCTIONS = `FigBridge resolves @figma reference IDs found in source comments (e.g. "// @figma F7KQ9M2X4P6D") using the repository's ${MANIFEST_FILENAME}.
- Before implementing or changing code that carries an @figma annotation, call figbridge_resolve_ref to get the exact Figma fileKey, nodeId and URL.
- Then use the official Figma MCP tools with that fileKey/nodeId for live design context. Never guess a node from a name.
- If a reference is not found, report the missing mapping instead of inventing one.
- These tools are read-only and never need a Figma token.`;

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }], structuredContent: data as Record<string, unknown> });

export function createServer(tools: Tools): McpServer {
  const server = new McpServer({ name: 'figbridge', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    'figbridge_resolve_ref',
    {
      title: 'Resolve @figma reference',
      description: 'Resolve a 12-character @figma reference ID to its Figma file key, node ID, URL, labels and the source locations that use it.',
      inputSchema: { refId: z.string().min(1).max(64).describe('The ID after "@figma", e.g. F7KQ9M2X4P6D') },
      annotations: readOnly,
    },
    async ({ refId }) => json(await tools.resolveRef(refId)),
  );

  server.registerTool(
    'figbridge_search_refs',
    {
      title: 'Search @figma references',
      description: 'List or search design references by name, ID, node, tag, source path or component name. Paginated.',
      inputSchema: {
        query: z.string().max(200).optional(),
        fileAlias: z.string().max(40).optional(),
        tag: z.string().max(80).optional(),
        status: z.enum(['used', 'unused', 'unresolved', 'deprecated']).optional().describe('unresolved = IDs used in code but missing from the manifest'),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.number().int().min(0).optional(),
      },
      annotations: readOnly,
    },
    async (args) => json(await tools.searchRefs(args)),
  );

  server.registerTool(
    'figbridge_refs_for_source',
    {
      title: '@figma references in a source file',
      description: 'Return the @figma references annotated in a workspace-relative source file, optionally only those on or enclosing a 1-based line.',
      inputSchema: { path: z.string().min(1).max(500), line: z.number().int().min(1).optional() },
      annotations: readOnly,
    },
    async (args) => json(await tools.refsForSource(args)),
  );

  server.registerTool(
    'figbridge_health',
    {
      title: 'FigBridge mapping health',
      description: 'Counts of annotations and mappings plus problems: unresolved IDs, malformed annotations, unused mappings and manifest errors.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => json(await tools.health()),
  );
  return server;
}

export async function runMcpServer(wasmDir: string): Promise<void> {
  const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findManifestRoot(start) ?? start;
  const scanner = await Scanner.create({ wasmDir });
  const indexer = new DiskIndexer(root, scanner);
  const server = createServer(new Tools(indexer));
  await server.connect(new StdioServerTransport());
  // Log to stderr only; stdout carries the MCP protocol.
  process.stderr.write(`figbridge MCP: serving ${root}\n`);
}
