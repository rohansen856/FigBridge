import { checkRefId, type RefId } from '../ids.js';

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
    }
  | { kind: 'malformed'; directiveStart: number; end: number; token: string; suggestion?: string };

/**
 * `@figma` must stand alone: not preceded by a word character, `@`, `.`, `-` or a backtick (so
 * emails such as `x@figma.com` and quoted mentions don't match) and followed by a space, tab or
 * the end of the comment (so `@figma-ref`, `@figmaX` and `` `@figma` `` in prose don't match).
 */
const DIRECTIVE_PATTERN = /(?<![\w@.\-`])@figma(?=[ \t]|\s*(?:\*\/)?$)/gm;
const ID_TOKEN = /^[ \t]+([^\s*/,;:)}\]]+)/;

/** Finds `@figma <ID>` directives in the text of a single comment. */
export function matchDirectives(commentText: string): DirectiveMatch[] {
  const out: DirectiveMatch[] = [];
  for (const m of commentText.matchAll(DIRECTIVE_PATTERN)) {
    const directiveStart = m.index;
    const afterDirective = directiveStart + DIRECTIVE.length;
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
