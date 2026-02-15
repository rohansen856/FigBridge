import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { FILE_KEY_PATTERN, normalizeNodeId, type NodeId } from '../figma-url.js';

export const EVENT_VERSION = 1;
export const MAX_EVENT_BYTES = 4096;
const MAX_NODE_IDS = 50;

export type OperationKind = 'mutation' | 'metadata' | 'read' | 'unrelated' | 'unknown';
export type TargetConfidence = 'node' | 'file' | 'unknown';

export const ClaudeEventSchema = z
  .object({
    v: z.literal(EVENT_VERSION),
    eventId: z.string().uuid(),
    ts: z.string().datetime(),
    hookEvent: z.enum(['PostToolUse', 'PostToolUseFailure']),
    server: z.string().max(80).regex(/^[\w .:-]+$/),
    tool: z.string().max(80).regex(/^[\w-]+$/),
    kind: z.enum(['mutation', 'metadata', 'read', 'unrelated', 'unknown']),
    result: z.enum(['success', 'failure']),
    fileKey: z.string().regex(FILE_KEY_PATTERN).optional(),
    nodeIds: z.array(z.string().max(100)).max(MAX_NODE_IDS),
    target: z.enum(['node', 'file', 'unknown']),
    dedupeKey: z.string().regex(/^[0-9a-f]{16}$/),
    error: z.string().max(300).optional(),
  })
  .strict();

export type ClaudeEvent = z.infer<typeof ClaudeEventSchema>;

/**
 * Figma MCP tool suffix → operation kind. Server names vary by install method
 * (`plugin_figma_figma`, `claude_ai_Figma`, `figma`, `figma-desktop`, …), so only the part after
 * `__` is classified. Reviewed against developers.figma.com/docs/figma-mcp-server/tools-and-prompts.
 */
const TOOL_KINDS: Record<string, OperationKind> = {
  use_figma: 'mutation',
  upload_assets: 'mutation',
  generate_figma_design: 'mutation',
  add_code_connect_map: 'metadata',
  send_code_connect_mappings: 'metadata',
  create_new_file: 'unrelated',
  generate_diagram: 'unrelated',
  generate_image: 'unrelated',
  create_shader: 'unrelated',
  update_shader: 'unrelated',
  create_generative_plugin: 'unrelated',
  update_generative_plugin: 'unrelated',
  export_video: 'unrelated',
  get_design_context: 'read',
  get_screenshot: 'read',
  get_metadata: 'read',
  get_variable_defs: 'read',
  get_figjam: 'read',
  get_code_connect_map: 'read',
  get_code_connect_suggestions: 'read',
  get_context_for_code_connect: 'read',
  list_file_components_for_code_connect: 'read',
  get_libraries: 'read',
  search_design_system: 'read',
  download_assets: 'read',
  get_motion_context: 'read',
  get_shader: 'read',
  list_shaders: 'read',
  list_file_shaders: 'read',
  get_generative_plugin: 'read',
  list_generative_plugins: 'read',
  whoami: 'read',
};

/** `mcp__<server>__<tool>` where the server name mentions Figma (any case). */
export function parseFigmaToolName(toolName: string): { server: string; tool: string } | undefined {
  const m = /^mcp__(.+?)__([A-Za-z0-9_-]+)$/.exec(toolName);
  if (!m || !/figma/i.test(m[1]!)) return undefined;
  return { server: m[1]!, tool: m[2]! };
}

export function classifyTool(tool: string): OperationKind {
  if (tool in TOOL_KINDS) return TOOL_KINDS[tool]!;
  if (tool.startsWith('weave_')) return 'unrelated';
  return 'unknown';
}

/** Raw hook stdin, as documented for PostToolUse / PostToolUseFailure (fields we read). */
export interface HookInput {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: unknown;
  error?: unknown;
}

/**
 * Converts a hook payload into a sanitised event, or undefined when it isn't a Figma MCP call.
 * Only the tool name, validated file key / node IDs, outcome and a short error survive; tool
 * input code, responses, session IDs and transcript paths are dropped.
 */
export function eventFromHook(input: HookInput, now: Date = new Date()): ClaudeEvent | undefined {
  const hookEvent = input.hook_event_name;
  if (hookEvent !== 'PostToolUse' && hookEvent !== 'PostToolUseFailure') return undefined;
  if (typeof input.tool_name !== 'string') return undefined;
  const parsed = parseFigmaToolName(input.tool_name);
  if (!parsed) return undefined;
  const kind = classifyTool(parsed.tool);
  const toolInput = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>;

  const fileKey = typeof toolInput.fileKey === 'string' && FILE_KEY_PATTERN.test(toolInput.fileKey) ? toolInput.fileKey : undefined;
  const nodeIds = new Set<NodeId>();
  const addNode = (v: unknown) => {
    if (typeof v !== 'string') return;
    const id = normalizeNodeId(v);
    if (id && nodeIds.size < MAX_NODE_IDS) nodeIds.add(id);
  };
  addNode(toolInput.nodeId);
  if (Array.isArray(toolInput.nodeIds)) toolInput.nodeIds.forEach(addNode);
  if (hookEvent === 'PostToolUse' && parsed.tool === 'use_figma') for (const id of nodeIdsFromUseFigmaResponse(input.tool_response)) addNode(id);

  const result = hookEvent === 'PostToolUse' ? 'success' : 'failure';
  const target: TargetConfidence = nodeIds.size ? 'node' : fileKey ? 'file' : 'unknown';
  const toolUseId = typeof input.tool_use_id === 'string' ? input.tool_use_id : randomUUID();
  const error = result === 'failure' && typeof input.error === 'string' ? sanitizeError(input.error) : undefined;
  return {
    v: EVENT_VERSION,
    eventId: randomUUID(),
    ts: now.toISOString(),
    hookEvent,
    server: parsed.server.slice(0, 80).replace(/[^\w .:-]/g, '_'),
    tool: parsed.tool,
    kind,
    result,
    ...(fileKey ? { fileKey } : {}),
    nodeIds: [...nodeIds],
    target,
    dedupeKey: createHash('sha256').update(`${hookEvent}|${toolUseId}`).digest('hex').slice(0, 16),
    ...(error ? { error } : {}),
  };
}

/**
 * `use_figma` returns whatever the script returns; the figma-use skill asks scripts to return
 * `{createdNodeIds, mutatedNodeIds}`. Best effort: look for those arrays in JSON text content.
 */
export function nodeIdsFromUseFigmaResponse(response: unknown): string[] {
  const texts: string[] = [];
  const collect = (v: unknown, depth: number) => {
    if (depth > 4 || texts.length > 20) return;
    if (typeof v === 'string') texts.push(v);
    else if (Array.isArray(v)) v.forEach((x) => collect(x, depth + 1));
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const key of ['mutatedNodeIds', 'createdNodeIds'])
        if (Array.isArray(o[key])) texts.push(JSON.stringify({ [key]: o[key] }));
      if (typeof o.text === 'string') texts.push(o.text);
      if (o.content) collect(o.content, depth + 1);
      if (o.result) collect(o.result, depth + 1);
    }
  };
  collect(response, 0);
  const out: string[] = [];
  for (const t of texts) {
    if (t.length > 200_000) continue;
    for (const m of t.matchAll(/"(?:mutatedNodeIds|createdNodeIds)"\s*:\s*\[([^\]]{0,20000})\]/g))
      for (const id of m[1]!.matchAll(/"([IT]?\d+[:-]\d+(?:;\d+[:-]\d+)*)"/g)) out.push(id[1]!);
  }
  return out;
}

function sanitizeError(e: string): string {
  return e
    .replace(/figd_[A-Za-z0-9_-]+/g, 'figd_<redacted>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function parseEvent(text: string): ClaudeEvent | undefined {
  if (text.length > MAX_EVENT_BYTES) return undefined;
  try {
    const r = ClaudeEventSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}
