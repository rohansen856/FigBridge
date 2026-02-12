import type { RefId } from '../ids.js';
import type { Diagnostic, Position, Range } from '../diagnostics.js';

export interface SourceDocument {
  /** Workspace-relative POSIX path. */
  relPath: string;
  text: string;
  /** VS Code language ID when known; otherwise the adapter is chosen by extension. */
  languageId?: string;
}

/**
 * Where an annotation attaches:
 * - `declaration`: the comment directly precedes a class/function/method/variable declaration.
 * - `usage`: the comment precedes a non-declaration node, e.g. a JSX element or widget expression.
 * - `file`: no syntax target (detached comment, end of block, or a file-level-only adapter).
 */
export type Attachment = 'declaration' | 'usage' | 'file';
export type Confidence = 'ast' | 'file-level';

export interface SourceOwner {
  name: string;
  /** Syntax node type, e.g. `class_definition`, `function_declaration`, `jsx_self_closing_element`. */
  kind: string;
  range: Range;
}

export interface AnnotationOccurrence {
  /** Stable within a scan: hash of path, offset and raw ID. */
  id: string;
  relPath: string;
  rawId: string;
  /** Canonical (upper-case) ID; set even when the ID is not in the manifest. */
  refId: RefId;
  canonical: boolean;
  /** Range of the whole comment containing the directive. */
  commentRange: Range;
  /** Range of the ID token, used for hover and code actions. */
  idRange: Range;
  languageId: string;
  adapterId: string;
  attachment: Attachment;
  owner?: SourceOwner;
  /** `id` of the nearest enclosing declaration occurrence in the same file. */
  sourceParentId?: string;
  confidence: Confidence;
}

export interface FileScanResult {
  relPath: string;
  adapterId: string;
  languageId: string;
  occurrences: AnnotationOccurrence[];
  /** Malformed directives and other per-file problems. */
  diagnostics: Diagnostic[];
  /** Parser reported syntax errors (results may be partial). */
  hasSyntaxErrors: boolean;
}

export interface LanguageAdapter {
  readonly id: string;
  readonly confidence: Confidence;
  /** Lower-case extensions including the dot, e.g. `.tsx`. */
  readonly extensions: readonly string[];
  readonly languageIds: readonly string[];
  scan(doc: SourceDocument): FileScanResult;
}

/** Maps UTF-16 offsets to zero-based line/character positions. */
export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  position(offset: number): Position {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.starts[lo]! };
  }
  range(start: number, end: number): Range {
    return { start: this.position(start), end: this.position(end) };
  }
}

export function rangeContains(outer: Range, pos: Position): boolean {
  const afterStart = pos.line > outer.start.line || (pos.line === outer.start.line && pos.character >= outer.start.character);
  const beforeEnd = pos.line < outer.end.line || (pos.line === outer.end.line && pos.character <= outer.end.character);
  return afterStart && beforeEnd;
}

export function rangeSize(r: Range): number {
  return (r.end.line - r.start.line) * 1_000_000 + (r.end.character - r.start.character);
}
