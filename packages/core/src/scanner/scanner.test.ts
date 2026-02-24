import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Scanner } from './scanner.js';
import type { AnnotationOccurrence, FileScanResult } from './types.js';

const FIXTURES = join(__dirname, '../../../../fixtures/scanner');
let scanner: Scanner;
beforeAll(async () => {
  scanner = await Scanner.create();
});

const scanFixture = (name: string) =>
  scanner.scan({ relPath: `src/${name}`, text: readFileSync(join(FIXTURES, name), 'utf8') });

/** Compact view: id@line attachment owner(kind) ^parentId@line */
function summarize(r: FileScanResult): string[] {
  const byId = new Map(r.occurrences.map((o) => [o.id, o]));
  const fmt = (o: AnnotationOccurrence) => `${o.rawId}@${o.idRange.start.line + 1}`;
  return r.occurrences.map((o) => {
    const parent = o.sourceParentId ? ` ^${fmt(byId.get(o.sourceParentId)!)}` : '';
    const owner = o.owner ? ` ${o.owner.name}(${o.owner.kind})` : '';
    return `${fmt(o)} ${o.attachment}${owner}${parent}`;
  });
}

describe('Dart adapter', () => {
  it('associates annotations with declarations, usages and parents', () => {
    const r = scanFixture('widgets.dart');
    expect(r.adapterId).toBe('dart');
    expect(r.hasSyntaxErrors).toBe(false);
    expect(summarize(r)).toEqual([
      'F7KQ9M2X4P6D@4 declaration CheckoutScreen(class_definition)',
      'H2C4N6P8R0T2@10 declaration header(method_signature) ^F7KQ9M2X4P6D@4',
      '8J3TD9PH6Q2W@21 usage CheckoutSummaryCard(const_object_expression) ^F7KQ9M2X4P6D@4',
      '8J3TD9PH6Q2W@29 declaration CheckoutSummaryCard(class_definition)',
      'K4M6P8R0T2V4@38 declaration priceTag(function_signature)',
      'W2X4Y6Z8A0B2@43 declaration theme(static_final_declaration_list)',
      'f7kq9m2x4p6d@48 file',
    ]);
  });

  it('handles Dart 3 records/patterns and names call-expression usages', () => {
    const text = [
      'class A extends StatelessWidget {',
      '  static const _items = [(\'x\', 1.0), (\'y\', 2.0)];',
      '  Widget build(BuildContext c) => Column(children: [',
      '    for (final (label, size) in _items) Text(label),',
      '    // @figma 8J3TD9PH6Q2W',
      '    QuantityStepper(value: 1),',
      '    ErrorBuilder((_, _, _) => const SizedBox()),',
      '  ]);',
      '}',
    ].join('\n');
    const r = scanner.scan({ relPath: 'lib/a.dart', text: `/// @figma F7KQ9M2X4P6D\n${text}` });
    expect(r.hasSyntaxErrors).toBe(false);
    expect(r.occurrences.map((o) => `${o.refId}:${o.attachment}:${o.owner?.name}`)).toEqual(['F7KQ9M2X4P6D:declaration:A', '8J3TD9PH6Q2W:usage:QuantityStepper']);
  });

  it('includes the function body in a signature owner range', () => {
    const priceTag = scanFixture('widgets.dart').occurrences.find((o) => o.rawId === 'K4M6P8R0T2V4')!;
    expect(priceTag.owner!.range.start.line).toBe(38); // zero-based: `Widget priceTag(...)` is line 39
    expect(priceTag.owner!.range.end.line).toBe(40);
  });

  it('flags non-canonical case and malformed IDs, ignores strings and look-alikes', () => {
    const r = scanFixture('widgets.dart');
    expect(r.occurrences.find((o) => o.rawId === 'f7kq9m2x4p6d')).toMatchObject({ canonical: false, refId: 'F7KQ9M2X4P6D' });
    expect(r.diagnostics.map((d) => [d.code, d.range!.start.line + 1])).toEqual([['MALFORMED_DIRECTIVE', 49]]);
    expect(r.occurrences.some((o) => o.rawId === 'ABCDEFGHJKMN')).toBe(false);
  });
});

describe('TSX adapter', () => {
  it('associates annotations with declarations, JSX usages and parents', () => {
    const r = scanFixture('components.tsx');
    expect(r.adapterId).toBe('tsx');
    expect(r.hasSyntaxErrors).toBe(false);
    expect(summarize(r)).toEqual([
      'F7KQ9M2X4P6D@6 declaration CheckoutScreen(function_declaration)',
      '8J3TD9PH6Q2W@10 usage CheckoutSummaryCard(jsx_self_closing_element) ^F7KQ9M2X4P6D@6',
      '8J3TD9PH6Q2W@19 declaration CheckoutSummaryCard(lexical_declaration)',
      'H2C4N6P8R0T2@22 declaration Row(lexical_declaration) ^8J3TD9PH6Q2W@19',
      'K4M6P8R0T2V4@27 declaration PriceTag(class_declaration)',
      'W2X4Y6Z8A0B2@30 declaration render(method_definition) ^K4M6P8R0T2V4@27',
      'Q1R2S3T4V5W6@36 declaration n(lexical_declaration)',
    ]);
    expect(r.diagnostics).toEqual([]);
  });

  it('reports exact ID ranges', () => {
    const r = scanFixture('components.tsx');
    const first = r.occurrences[0]!;
    expect(first.idRange).toEqual({ start: { line: 5, character: 10 }, end: { line: 5, character: 22 } });
  });
});

describe('adversarial inputs', () => {
  const cases: Array<[string, string]> = [
    ['a.ts', 'const s = "// @figma F7KQ9M2X4P6D";'],
    ['a.ts', "const s = '/* @figma F7KQ9M2X4P6D */';"],
    ['a.ts', 'const s = `\n// @figma F7KQ9M2X4P6D\n`;'],
    ['a.ts', 'const r = /\\/\\/ @figma F7KQ9M2X4P6D/;'],
    ['a.tsx', 'const x = <p>// @figma F7KQ9M2X4P6D</p>;'],
    ['a.dart', "final s = r'// @figma F7KQ9M2X4P6D';"],
    ['a.dart', 'final s = """\n/* @figma F7KQ9M2X4P6D */\n""";'],
    ['a.dart', "final s = '\${'// @figma F7KQ9M2X4P6D'}';"],
    ['a.ts', '// @figma-ref F7KQ9M2X4P6D\n// x@figma F7KQ9M2X4P6D\n// @figmaF7KQ9M2X4P6D'],
  ];
  it.each(cases)('%s: %j has no occurrences', (relPath, text) => {
    expect(scanner.scan({ relPath, text }).occurrences).toEqual([]);
  });

  it('ignores @figma mentioned in prose', () => {
    const r = scanner.scan({ relPath: 'a.dart', text: '/// Every screen carries a `@figma` reference (see @figma: docs).\nclass A {}' });
    expect(r.occurrences).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it('still reports a directive with a missing or bad ID', () => {
    const r = scanner.scan({ relPath: 'a.ts', text: '// @figma\n/* @figma */\n// @figma 12345\nconst x = 1;' });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['MALFORMED_DIRECTIVE', 'MALFORMED_DIRECTIVE', 'MALFORMED_DIRECTIVE']);
  });

  it('finds several directives in one comment', () => {
    const r = scanner.scan({ relPath: 'a.ts', text: '/* @figma F7KQ9M2X4P6D and @figma 8J3TD9PH6Q2W */\nfunction f() {}' });
    expect(r.occurrences.map((o) => [o.rawId, o.owner?.name])).toEqual([
      ['F7KQ9M2X4P6D', 'f'],
      ['8J3TD9PH6Q2W', 'f'],
    ]);
  });

  it('handles non-ASCII text before a directive', () => {
    const r = scanner.scan({ relPath: 'a.ts', text: 'const s = "héllo 😀"; // @figma F7KQ9M2X4P6D' });
    expect(r.occurrences[0]!.idRange.start).toEqual({ line: 0, character: 32 });
  });

  it('detaches comments separated by more than one blank line', () => {
    const r = scanner.scan({ relPath: 'a.ts', text: '// @figma F7KQ9M2X4P6D\n\n\n\nfunction f() {}' });
    expect(r.occurrences[0]!.attachment).toBe('file');
  });

  it('survives syntax errors', () => {
    const r = scanner.scan({ relPath: 'a.ts', text: '// @figma F7KQ9M2X4P6D\nfunction f( {' });
    expect(r.hasSyntaxErrors).toBe(true);
    expect(r.occurrences).toHaveLength(1);
  });

  it('uses the fallback lexer for other languages', () => {
    const py = scanner.scan({ relPath: 'app.py', text: 's = "# @figma 8J3TD9PH6Q2W"\n# @figma F7KQ9M2X4P6D\ndef f(): pass' });
    expect(py.adapterId).toBe('fallback');
    expect(py.occurrences.map((o) => [o.rawId, o.attachment, o.confidence])).toEqual([['F7KQ9M2X4P6D', 'file', 'file-level']]);
    const kt = scanner.scan({ relPath: 'A.kt', text: 'val s = "// @figma 8J3TD9PH6Q2W"\n/* @figma F7KQ9M2X4P6D */' });
    expect(kt.occurrences.map((o) => o.rawId)).toEqual(['F7KQ9M2X4P6D']);
  });
});
