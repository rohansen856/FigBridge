import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MANIFEST_FILENAME, Scanner } from '@figbridge/core';
import { ProjectRouter } from './router.js';

export const SERVER_INSTRUCTIONS = `FigBridge resolves @figma annotations in source comments: opaque IDs ("// @figma F7KQ9M2X4P6D", mapped in the repository's ${MANIFEST_FILENAME}) and direct Figma links ("// @figma https://www.figma.com/design/…?node-id=1-2").
- Before implementing or changing code that carries an @figma annotation, call figbridge_resolve_ref to get the exact Figma fileKey, nodeId and URL.
- Then use the official Figma MCP tools with that fileKey/nodeId for live design context. Never guess a node from a name.
- If a reference is not found, report the missing mapping instead of inventing one.
- These tools are read-only and never need a Figma token.`;

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }], structuredContent: data as Record<string, unknown> });

export function createServer(tools: ProjectRouter): McpServer {
  const server = new McpServer({ name: 'figbridge', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    'figbridge_resolve_ref',
    {
      title: 'Resolve @figma reference',
      description: 'Resolve what follows "@figma" in a source comment (a 12-character ID or a Figma link) to its Figma file key, node ID, URL, labels and the source locations that use it.',
      inputSchema: { refId: z.string().min(1).max(2048).describe('The ID or Figma URL after "@figma", e.g. F7KQ9M2X4P6D or https://www.figma.com/design/…?node-id=1-2') },
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
  const scanner = await Scanner.create({ wasmDir });
  const router = await ProjectRouter.create(start, scanner);
  const server = createServer(router);
  await server.connect(new StdioServerTransport());
  // Log to stderr only; stdout carries the MCP protocol.
  process.stderr.write(`figbridge MCP: serving ${router.start}\n`);
}
