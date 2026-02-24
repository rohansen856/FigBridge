import { matchDirectives } from './grammar.js';
import { linkSourceParents, malformedDiagnostic, occurrenceId } from './tree-sitter.js';
import { LineIndex, type FileScanResult, type LanguageAdapter, type SourceDocument } from './types.js';

interface CommentSyntax {
  line: readonly string[];
  block: ReadonlyArray<readonly [string, string]>;
  /** String delimiters skipped by the lexer; triple quotes must come before single ones. */
  strings: readonly string[];
}

const C_LIKE: CommentSyntax = { line: ['//'], block: [['/*', '*/']], strings: ['"""', '"', "'", '`'] };
const HASH: CommentSyntax = { line: ['#'], block: [], strings: ['"""', "'''", '"', "'"] };
const DASH: CommentSyntax = { line: ['--'], block: [['/*', '*/']], strings: ['"', "'"] };

const FAMILIES: Array<[CommentSyntax, string[]]> = [
  [C_LIKE, ['.java', '.kt', '.kts', '.swift', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.scala', '.vue', '.svelte', '.css', '.scss', '.less', '.php']],
  [HASH, ['.py', '.rb', '.sh', '.bash', '.zsh', '.yaml', '.yml', '.toml', '.r', '.ex', '.exs', '.pl']],
  [DASH, ['.sql', '.lua', '.hs']],
];

/**
 * Lexer-level adapter for languages without a grammar. It finds directives only in comments
 * (skipping string literals) but cannot tell what a comment annotates, so every occurrence is
 * `file`-attached with `file-level` confidence.
 */
export class FallbackAdapter implements LanguageAdapter {
  readonly id = 'fallback';
  readonly confidence = 'file-level' as const;
  readonly extensions = FAMILIES.flatMap(([, exts]) => exts);
  readonly languageIds: readonly string[] = [];

  scan(doc: SourceDocument): FileScanResult {
    const ext = doc.relPath.slice(doc.relPath.lastIndexOf('.')).toLowerCase();
    const syntax = FAMILIES.find(([, exts]) => exts.includes(ext))?.[0] ?? C_LIKE;
    const lines = new LineIndex(doc.text);
    const result: FileScanResult = {
      relPath: doc.relPath,
      adapterId: this.id,
      languageId: doc.languageId ?? ext.slice(1),
      occurrences: [],
      diagnostics: [],
      hasSyntaxErrors: false,
    };
    for (const [start, end] of lexComments(doc.text, syntax)) {
      const text = doc.text.slice(start, end);
      if (!text.includes('@figma')) continue;
      for (const m of matchDirectives(text)) {
        if (m.kind === 'malformed') {
          result.diagnostics.push(malformedDiagnostic(doc.relPath, lines, start, m));
          continue;
        }
        result.occurrences.push({
          id: occurrenceId(doc.relPath, start + m.idStart, m.rawId),
          relPath: doc.relPath,
          rawId: m.rawId,
          refId: m.refId,
          canonical: m.canonical,
          ...(m.link ? { link: m.link } : {}),
          commentRange: lines.range(start, end),
          idRange: lines.range(start + m.idStart, start + m.idEnd),
          languageId: result.languageId,
          adapterId: this.id,
          attachment: 'file',
          confidence: 'file-level',
        });
      }
    }
    linkSourceParents(result.occurrences);
    return result;
  }
}

/** Returns [start, end) offsets of comments, skipping over string literals. */
export function lexComments(text: string, syntax: CommentSyntax): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  outer: while (i < text.length) {
    for (const q of syntax.strings) {
      if (text.startsWith(q, i)) {
        i += q.length;
        while (i < text.length && !text.startsWith(q, i)) {
          if (text[i] === '\\') i++;
          else if (q.length === 1 && q !== '`' && text[i] === '\n') break; // unterminated single-line string
          i++;
        }
        i += q.length;
        continue outer;
      }
    }
    for (const l of syntax.line) {
      if (text.startsWith(l, i)) {
        const nl = text.indexOf('\n', i);
        const end = nl === -1 ? text.length : nl;
        out.push([i, end]);
        i = end;
        continue outer;
      }
    }
    for (const [open, close] of syntax.block) {
      if (text.startsWith(open, i)) {
        const c = text.indexOf(close, i + open.length);
        const end = c === -1 ? text.length : c + close.length;
        out.push([i, end]);
        i = end;
        continue outer;
      }
    }
    i++;
  }
  return out;
}
