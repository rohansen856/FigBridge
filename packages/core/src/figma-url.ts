/** Canonical Figma node ID (API form, colon separated), e.g. `1:2` or `I1:2;3:4`. */
export type NodeId = string & { readonly __brand: 'NodeId' };

/** Plain `1:2`, or an instance/sublayer path prefixed `I` or `T` (as the Figma MCP accepts). */
export const NODE_ID_PATTERN = /^(?:\d+:\d+|[IT]\d+:\d+(?:;\d+:\d+)*)$/;
export const FILE_KEY_PATTERN = /^[0-9A-Za-z]{10,128}$/;
const ALLOWED_HOSTS = new Set(['www.figma.com', 'figma.com']);
const FILE_TYPES = new Set(['design', 'file']);

/** Normalises `1-2`, `1:2`, `1%3A2` and instance forms to the API form; undefined if invalid. */
export function normalizeNodeId(raw: string): NodeId | undefined {
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  if (!value.includes(':')) value = value.replace(/-/g, ':');
  return NODE_ID_PATTERN.test(value) ? (value as NodeId) : undefined;
}

/** URL query form: `1:2` → `1-2`. */
export function nodeIdToUrlParam(nodeId: NodeId): string {
  return nodeId.replace(/:/g, '-');
}

export interface ParsedFigmaUrl {
  fileKey: string;
  branchKey?: string;
  slug?: string;
  nodeId?: NodeId;
}

export type FigmaUrlError =
  | 'not-a-url'
  | 'not-https'
  | 'credentials'
  | 'port'
  | 'host'
  | 'path'
  | 'file-key'
  | 'node-id';

export type ParseResult = { ok: true; value: ParsedFigmaUrl } | { ok: false; error: FigmaUrlError };

/**
 * Parses a Figma design URL copied from the browser or app. Rejects anything that is not
 * plain HTTPS on figma.com. Transient query values (`p`, `t`, `scaling`, …) are ignored.
 */
export function parseFigmaUrl(input: string): ParseResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: 'not-a-url' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'not-https' };
  if (url.username || url.password) return { ok: false, error: 'credentials' };
  if (url.port) return { ok: false, error: 'port' };
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return { ok: false, error: 'host' };

  const segments = url.pathname.split('/').filter(Boolean);
  const [type, fileKey, third, fourth, fifth] = segments;
  if (!type || !FILE_TYPES.has(type) || !fileKey) return { ok: false, error: 'path' };
  if (!FILE_KEY_PATTERN.test(fileKey)) return { ok: false, error: 'file-key' };

  const value: ParsedFigmaUrl = { fileKey };
  if (third === 'branch') {
    if (!fourth || !FILE_KEY_PATTERN.test(fourth)) return { ok: false, error: 'file-key' };
    value.branchKey = fourth;
    if (fifth) value.slug = fifth;
  } else if (third) {
    value.slug = third;
  }

  const nodeParam = url.searchParams.get('node-id');
  if (nodeParam !== null) {
    const nodeId = normalizeNodeId(nodeParam);
    if (!nodeId) return { ok: false, error: 'node-id' };
    value.nodeId = nodeId;
  }
  return { ok: true, value };
}

/** Key used for REST calls: a branch key replaces the main file key. */
export function apiKeyOf(file: { fileKey: string; branchKey?: string }): string {
  return file.branchKey ?? file.fileKey;
}

/** Canonical file URL with no node selection or transient parameters. */
export function buildFileUrl(file: { fileKey: string; branchKey?: string; slug?: string }): string {
  const slug = file.slug ? `/${encodeURIComponent(decodeSafe(file.slug))}` : '';
  const branch = file.branchKey ? `/branch/${file.branchKey}` : '';
  return `https://www.figma.com/design/${file.fileKey}${branch}${slug}`;
}

export function buildNodeUrl(
  file: { fileKey: string; branchKey?: string; slug?: string },
  nodeId: NodeId,
): string {
  return `${buildFileUrl(file)}?node-id=${nodeIdToUrlParam(nodeId)}`;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
