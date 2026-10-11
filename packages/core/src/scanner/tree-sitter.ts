import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node } from 'web-tree-sitter';
import type { Diagnostic, Range } from '../diagnostics.js';
import { matchDirectives } from './grammar.js';
import {
  LineIndex,
  rangeContains,
  rangeSize,
  type AnnotationOccurrence,
  type Attachment,
  type FileScanResult,
  type LanguageAdapter,
  type SourceDocument,
  type SourceOwner,
} from './types.js';

/** Syntax rules for one tree-sitter grammar. */
interface GrammarRules {
  commentTypes: ReadonlySet<string>;
  /** Nodes skipped when looking for the commented node (comments, decorators, annotations). */
  skipTypes: ReadonlySet<string>;
  /** Leading tokens of a declaration that are separate siblings (Dart `final`, return types). */
  modifierTypes: ReadonlySet<string>;
  declarationTypes: ReadonlySet<string>;
  /** Wrapper nodes whose declaration child is the real target (TS `export_statement`). */
  wrapperTypes: ReadonlySet<string>;
  /** Signature node → following sibling that holds its body (Dart `function_body`). */
  bodySiblingTypes: ReadonlySet<string>;
  /** Containers whose comment child applies to the container's next sibling (a JSX comment expression). */
  transparentContainers: ReadonlySet<string>;
  ignorableTypes: ReadonlySet<string>;
}

const TS_RULES: GrammarRules = {
  commentTypes: new Set(['comment']),
  skipTypes: new Set(['comment', 'decorator']),
  modifierTypes: new Set(),
  declarationTypes: new Set([
    'function_declaration',
    'generator_function_declaration',
    'class_declaration',
    'abstract_class_declaration',
    'lexical_declaration',
    'variable_declaration',
    'method_definition',
    'public_field_definition',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'function_signature',
    'abstract_method_signature',
  ]),
  wrapperTypes: new Set(['export_statement', 'ambient_declaration']),
  bodySiblingTypes: new Set(),
  transparentContainers: new Set(['jsx_expression']),
  ignorableTypes: new Set(['jsx_text']),
};

const DART_RULES: GrammarRules = {
  commentTypes: new Set(['comment', 'documentation_comment']),
  skipTypes: new Set(['comment', 'documentation_comment', 'marker_annotation', 'annotation']),
  modifierTypes: new Set([
    'final_builtin',
    'const_builtin',
    'late',
    'static',
    'external',
    'type_identifier',
    'type_arguments',
    'nullable_type',
    'void_type',
    'function_type',
    'inferred_type',
  ]),
  declarationTypes: new Set([
    'class_definition',
    'mixin_declaration',
    'extension_declaration',
    'extension_type_declaration',
    'enum_declaration',
    'type_alias',
    'function_signature',
    'getter_signature',
    'setter_signature',
    'method_signature',
    'declaration',
    'static_final_declaration_list',
    'initialized_identifier_list',
    'local_variable_declaration',
    'local_function_declaration',
  ]),
  wrapperTypes: new Set(),
  bodySiblingTypes: new Set(['function_body']),
  transparentContainers: new Set(),
  ignorableTypes: new Set(),
};

export interface GrammarSpec {
  adapterId: string;
  languageId: string;
  extensions: readonly string[];
  languageIds: readonly string[];
  wasm: string;
  rules: GrammarRules;
}

const require = createRequire(import.meta.url);

/** Default WASM locations inside node_modules / this package; bundlers override with `wasmDir`. */
function defaultWasmPaths(): Record<string, string> {
  const vscodeWasm = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
  const ownWasm = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'wasm');
  return {
    runtime: join(dirname(require.resolve('web-tree-sitter')), 'web-tree-sitter.wasm'),
    typescript: join(vscodeWasm, 'tree-sitter-typescript.wasm'),
    tsx: join(vscodeWasm, 'tree-sitter-tsx.wasm'),
    javascript: join(vscodeWasm, 'tree-sitter-javascript.wasm'),
    dart: join(ownWasm, 'tree-sitter-dart.wasm'),
  };
}

export const GRAMMAR_FILES = {
  runtime: 'web-tree-sitter.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  dart: 'tree-sitter-dart.wasm',
} as const;

function grammarSpecs(paths: Record<string, string>): GrammarSpec[] {
  return [
    { adapterId: 'typescript', languageId: 'typescript', extensions: ['.ts', '.mts', '.cts'], languageIds: ['typescript'], wasm: paths.typescript!, rules: TS_RULES },
    { adapterId: 'tsx', languageId: 'typescriptreact', extensions: ['.tsx'], languageIds: ['typescriptreact'], wasm: paths.tsx!, rules: TS_RULES },
    { adapterId: 'javascript', languageId: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs'], languageIds: ['javascript', 'javascriptreact'], wasm: paths.javascript!, rules: TS_RULES },
    { adapterId: 'dart', languageId: 'dart', extensions: ['.dart'], languageIds: ['dart'], wasm: paths.dart!, rules: DART_RULES },
  ];
}

let parserInit: Promise<void> | undefined;

/**
 * Loads the tree-sitter runtime and grammars. `wasmDir`, when given, must contain the files in
 * GRAMMAR_FILES (bundled builds copy them next to the bundle).
 */
export async function createTreeSitterAdapters(wasmDir?: string): Promise<LanguageAdapter[]> {
  const paths = wasmDir
    ? Object.fromEntries(Object.entries(GRAMMAR_FILES).map(([k, f]) => [k, join(wasmDir, f)]))
    : defaultWasmPaths();
  parserInit ??= Parser.init({ locateFile: () => paths.runtime! });
  await parserInit;
  const specs = grammarSpecs(paths);
  return Promise.all(specs.map(async (spec) => new TreeSitterAdapter(spec, await Language.load(spec.wasm))));
}

class TreeSitterAdapter implements LanguageAdapter {
  readonly confidence = 'ast' as const;
  readonly id: string;
  readonly extensions: readonly string[];
  readonly languageIds: readonly string[];
  private readonly parser: Parser;

  constructor(
    private readonly spec: GrammarSpec,
    language: Language,
  ) {
    this.id = spec.adapterId;
    this.extensions = spec.extensions;
    this.languageIds = spec.languageIds;
    this.parser = new Parser();
    this.parser.setLanguage(language);
  }

  scan(doc: SourceDocument): FileScanResult {
    const tree = this.parser.parse(doc.text);
    const result: FileScanResult = {
      relPath: doc.relPath,
      adapterId: this.id,
      languageId: doc.languageId ?? this.spec.languageId,
      occurrences: [],
      diagnostics: [],
      hasSyntaxErrors: false,
    };
    if (!tree) return result;
    try {
      result.hasSyntaxErrors = tree.rootNode.hasError;
      const lines = new LineIndex(doc.text);
      const rules = this.spec.rules;
      const comments: Node[] = [];
      collectComments(tree.rootNode, rules, comments);
      for (const comment of comments) {
        const text = comment.text;
        if (!text.includes('@figma')) continue;
        const matches = matchDirectives(text);
        if (!matches.length) continue;
        const commentRange = lines.range(comment.startIndex, comment.endIndex);
        let target: { attachment: Attachment; owner?: SourceOwner } | undefined;
        for (const m of matches) {
          if (m.kind === 'malformed') {
            result.diagnostics.push(malformedDiagnostic(doc.relPath, lines, comment.startIndex, m));
            continue;
          }
          target ??= resolveTarget(comment, rules, lines);
          const idStart = comment.startIndex + m.idStart;
          result.occurrences.push({
            id: occurrenceId(doc.relPath, idStart, m.rawId),
            relPath: doc.relPath,
            rawId: m.rawId,
            refId: m.refId,
            canonical: m.canonical,
            ...(m.link ? { link: m.link } : {}),
            commentRange,
            idRange: lines.range(idStart, comment.startIndex + m.idEnd),
            languageId: result.languageId,
            adapterId: this.id,
            attachment: target.attachment,
            ...(target.owner ? { owner: target.owner } : {}),
            confidence: 'ast',
          });
        }
      }
      linkSourceParents(result.occurrences);
      return result;
    } finally {
      tree.delete();
    }
  }
}

function collectComments(node: Node, rules: GrammarRules, out: Node[]): void {
  // Iterative walk; comments are "extras" and may appear at any depth.
  const cursor = node.walk();
  try {
    let descend = true;
    for (;;) {
      if (descend && rules.commentTypes.has(cursor.nodeType)) {
        const n = cursor.currentNode;
        if (n) out.push(n);
      }
      if (descend && cursor.gotoFirstChild()) continue;
      if (cursor.gotoNextSibling()) {
        descend = true;
        continue;
      }
      if (!cursor.gotoParent()) break;
      descend = false;
    }
  } finally {
    cursor.delete();
  }
}

/** Determines what a comment annotates. */
function resolveTarget(comment: Node, rules: GrammarRules, lines: LineIndex): { attachment: Attachment; owner?: SourceOwner } {
  let anchor: Node = comment;
  const parent = comment.parent;
  if (parent && rules.transparentContainers.has(parent.type) && parent.namedChildCount === 1) anchor = parent;

  // Trailing comment on the same line as the previous statement annotates that statement.
  // With CRLF line endings, the indentation before a JSX comment is a whitespace-only text node.
  let prev = anchor.previousNamedSibling;
  while (prev && isBlank(prev, rules)) prev = prev.previousNamedSibling;
  if (prev && !rules.skipTypes.has(prev.type) && prev.endPosition.row === comment.startPosition.row) {
    return classify(prev, rules, lines);
  }

  let next = anchor.nextNamedSibling;
  while (next && (rules.skipTypes.has(next.type) || isBlank(next, rules))) next = next.nextNamedSibling;
  if (!next) return { attachment: 'file' };
  // Allow at most one blank line between the comment (or skipped decorators) and the target.
  if (next.startPosition.row - comment.endPosition.row > 2 && !hasOnlySkippedBetween(comment, next, rules)) return { attachment: 'file' };
  return classify(next, rules, lines);
}

function isBlank(node: Node, rules: GrammarRules): boolean {
  return rules.ignorableTypes.has(node.type) && node.text.trim() === '';
}

function hasOnlySkippedBetween(from: Node, to: Node, rules: GrammarRules): boolean {
  let n = from.nextNamedSibling;
  let lastRow = from.endPosition.row;
  while (n && n.id !== to.id) {
    if (!rules.skipTypes.has(n.type) || n.startPosition.row - lastRow > 2) return false;
    lastRow = n.endPosition.row;
    n = n.nextNamedSibling;
  }
  return to.startPosition.row - lastRow <= 2;
}

function classify(node: Node, rules: GrammarRules, lines: LineIndex): { attachment: Attachment; owner?: SourceOwner } {
  let target = node;
  if (rules.wrapperTypes.has(target.type)) {
    const inner = target.namedChildren.find((c) => c && rules.declarationTypes.has(c.type));
    if (inner) target = inner;
    else {
      // `export default <expression>` — treat as a declaration named "default".
      const value = target.childForFieldName('value') ?? target.childForFieldName('declaration');
      return {
        attachment: 'declaration',
        owner: { name: value ? nameOf(value) ?? 'default' : 'default', kind: target.type, range: lines.range(target.startIndex, target.endIndex) },
      };
    }
  }

  const start = target;
  if (rules.modifierTypes.has(target.type)) {
    let n: Node | null = target;
    while (n && rules.modifierTypes.has(n.type) && n.endPosition.row <= target.startPosition.row + 1) n = n.nextNamedSibling;
    if (n && rules.declarationTypes.has(n.type)) target = n;
  }

  if (rules.declarationTypes.has(target.type)) {
    let end = target;
    const body = target.nextNamedSibling;
    if (body && rules.bodySiblingTypes.has(body.type)) end = body;
    return {
      attachment: 'declaration',
      owner: {
        name: nameOf(target) ?? '(anonymous)',
        kind: target.type,
        range: lines.range(start.startIndex, end.endIndex),
      },
    };
  }
  return {
    attachment: 'usage',
    owner: { name: nameOf(target) ?? target.type, kind: target.type, range: lines.range(target.startIndex, target.endIndex) },
  };
}

const NAME_TYPES = new Set(['identifier', 'type_identifier', 'property_identifier', 'private_property_identifier']);

/**
 * Best-effort declared or referenced name: the nearest `name` field (breadth-first, so a Dart
 * method's name wins over its return type), else the first identifier within 3 levels.
 */
function nameOf(node: Node): string | undefined {
  // A bare identifier (e.g. a Dart call `QuantityStepper(...)`, where the arguments are a sibling).
  if (NAME_TYPES.has(node.type)) return node.text;
  let firstIdentifier: string | undefined;
  const queue: Array<[Node, number]> = [[node, 0]];
  while (queue.length) {
    const [n, depth] = queue.shift()!;
    const field = n.childForFieldName('name');
    if (field) return field.text;
    if (!firstIdentifier && n.id !== node.id && NAME_TYPES.has(n.type)) firstIdentifier = n.text;
    if (depth >= 3) continue;
    for (const c of n.namedChildren) if (c) queue.push([c, depth + 1]);
  }
  return firstIdentifier;
}

/** Sets `sourceParentId` to the smallest enclosing annotated declaration in the same file. */
export function linkSourceParents(occurrences: AnnotationOccurrence[]): void {
  const decls = occurrences.filter((o) => o.attachment === 'declaration' && o.owner);
  for (const occ of occurrences) {
    let best: AnnotationOccurrence | undefined;
    for (const d of decls) {
      if (d === occ || d.owner === occ.owner) continue;
      // Two comments on the same declaration are siblings, not parent and child.
      if (occ.owner && sameRange(d.owner!.range, occ.owner.range)) continue;
      if (!rangeContains(d.owner!.range, occ.commentRange.start)) continue;
      if (!best || rangeSize(d.owner!.range) < rangeSize(best.owner!.range)) best = d;
    }
    if (best) occ.sourceParentId = best.id;
  }
}

function sameRange(a: Range, b: Range): boolean {
  return (
    a.start.line === b.start.line &&
    a.start.character === b.start.character &&
    a.end.line === b.end.line &&
    a.end.character === b.end.character
  );
}

export function occurrenceId(relPath: string, offset: number, rawId: string): string {
  return createHash('sha256').update(`${relPath}\u0000${offset}\u0000${rawId}`).digest('hex').slice(0, 16);
}

export function malformedDiagnostic(
  relPath: string,
  lines: LineIndex,
  base: number,
  m: { directiveStart: number; end: number; token: string; suggestion?: string; reason?: string },
): Diagnostic {
  const message = m.reason
    ? m.reason
    : m.token
    ? `"${m.token}" is not a valid FigBridge reference ID (12 characters from 0-9 and A-Z except I, L, O, U).` +
      (m.suggestion ? ` Did you mean ${m.suggestion}?` : '')
    : '@figma must be followed by a reference ID.';
  return {
    code: 'MALFORMED_DIRECTIVE',
    severity: 'warning',
    message,
    file: relPath,
    range: lines.range(base + m.directiveStart, base + m.end),
    ...(m.suggestion ? { data: { suggestion: m.suggestion } } : {}),
  };
}
