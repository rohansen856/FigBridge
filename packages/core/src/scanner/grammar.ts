import { checkRefId, type RefId } from '../ids.js';
import { apiKeyOf, parseFigmaUrl, type NodeId } from '../figma-url.js';

/** Target of a link annotation (`@figma https://www.figma.com/design/…?node-id=…`). */
export interface LinkTarget {
  fileKey: string;
  branchKey?: string;
  slug?: string;
  nodeId: NodeId;
  /** Key used for REST calls (branch key when present). */
  apiKey: string;
}

const LINK_PREFIX = 'link:';

/**
 * Index key for a link annotation. It is never a valid opaque ID, so link and ID annotations
 * can't collide; occurrences of the same node share the key.
 */
export function linkKey(apiKey: string, nodeId: NodeId): RefId {
  return `${LINK_PREFIX}${apiKey}/${nodeId}` as RefId;
}

export function isLinkKey(key: string): boolean {
  return key.startsWith(LINK_PREFIX);
}

export function parseLinkKey(key: string): { apiKey: string; nodeId: NodeId } | undefined {
  if (!isLinkKey(key)) return undefined;
  const rest = key.slice(LINK_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash > 0 ? { apiKey: rest.slice(0, slash), nodeId: rest.slice(slash + 1) as NodeId } : undefined;
}

export const DIRECTIVE = '@figma';

export type DirectiveMatch =
  | {
      kind: 'ref';
      /** Offsets relative to the comment text. */
      directiveStart: number;
      idStart: number;
      idEnd: number;
      rawId: string;
      refId: RefId;
      canonical: boolean;
      /** Present for `@figma <Figma URL>` annotations. */
      link?: LinkTarget;
    }
  | { kind: 'malformed'; directiveStart: number; end: number; token: string; suggestion?: string; reason?: string };

/**
 * `@figma` must stand alone: not preceded by a word character, `@`, `.`, `-` or a backtick (so
 * emails such as `x@figma.com` and quoted mentions don't match) and followed by a space, tab or
 * the end of the comment (so `@figma-ref`, `@figmaX` and `` `@figma` `` in prose don't match).
 */
const DIRECTIVE_PATTERN = /(?<![\w@.\-`])@figma(?=[ \t]|\s*(?:\*\/)?$)/gm;
const ID_TOKEN = /^[ \t]+([^\s*/,;:)}\]]+)/;
const URL_TOKEN = /^[ \t]+(https?:\/\/[^\s<>"'`]+)/;
/** Punctuation that ends a sentence or comment rather than the URL. */
const URL_TRAILER = /(?:\*\/|[)\]}>.,;!?'"])+$/;

const LINK_ERRORS: Record<string, string> = {
  'not-https': 'Figma links must use https.',
  host: 'Only figma.com design links are supported.',
  path: 'Use a Figma design link (figma.com/design/…).',
  'file-key': 'The link has an invalid Figma file key.',
  'node-id': 'The link has an invalid node-id.',
  credentials: 'Links must not contain credentials.',
  port: 'Links must not contain a port.',
  'not-a-url': 'Not a valid URL.',
};

/** Finds `@figma <ID>` and `@figma <Figma URL>` directives in the text of a single comment. */
export function matchDirectives(commentText: string): DirectiveMatch[] {
  const out: DirectiveMatch[] = [];
  for (const m of commentText.matchAll(DIRECTIVE_PATTERN)) {
    const directiveStart = m.index;
    const afterDirective = directiveStart + DIRECTIVE.length;
    const url = URL_TOKEN.exec(commentText.slice(afterDirective));
    if (url) {
      const rawUrl = url[1]!.replace(URL_TRAILER, '');
      const idStart = afterDirective + url[0].length - url[1]!.length;
      const idEnd = idStart + rawUrl.length;
      const parsed = parseFigmaUrl(rawUrl);
      if (!parsed.ok) out.push({ kind: 'malformed', directiveStart, end: idEnd, token: rawUrl, reason: LINK_ERRORS[parsed.error] ?? 'Invalid Figma link.' });
      else if (!parsed.value.nodeId)
        out.push({ kind: 'malformed', directiveStart, end: idEnd, token: rawUrl, reason: 'The link must select a frame or layer (it needs ?node-id=…). In Figma use "Copy link to selection".' });
      else {
        const link: LinkTarget = { ...parsed.value, nodeId: parsed.value.nodeId, apiKey: apiKeyOf(parsed.value) };
        out.push({ kind: 'ref', directiveStart, idStart, idEnd, rawId: rawUrl, refId: linkKey(link.apiKey, link.nodeId), canonical: true, link });
      }
      continue;
    }
    const token = ID_TOKEN.exec(commentText.slice(afterDirective));
    if (!token) {
      out.push({ kind: 'malformed', directiveStart, end: afterDirective, token: '' });
      continue;
    }
    const rawId = token[1]!;
    const idStart = afterDirective + token[0].length - rawId.length;
    const idEnd = idStart + rawId.length;
    const check = checkRefId(rawId);
    if (check.kind === 'invalid')
      out.push({
        kind: 'malformed',
        directiveStart,
        end: idEnd,
        token: rawId,
        ...(check.suggestion ? { suggestion: check.suggestion } : {}),
      });
    else out.push({ kind: 'ref', directiveStart, idStart, idEnd, rawId, refId: check.id, canonical: check.kind === 'valid' });
  }
  return out;
}

/** Comment text to insert for a reference, in the given comment style. */
export function formatDirective(id: RefId, style: 'line' | 'doc-line' | 'block' | 'jsx'): string {
  switch (style) {
    case 'line':
      return `// ${DIRECTIVE} ${id}`;
    case 'doc-line':
      return `/// ${DIRECTIVE} ${id}`;
    case 'block':
      return `/* ${DIRECTIVE} ${id} */`;
    case 'jsx':
      return `{/* ${DIRECTIVE} ${id} */}`;
  }
}
