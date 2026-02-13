import { FallbackAdapter } from './fallback.js';
import { createTreeSitterAdapters } from './tree-sitter.js';
import type { FileScanResult, LanguageAdapter, SourceDocument } from './types.js';

export interface ScannerOptions {
  /** Directory containing the grammar WASM files (bundled builds); defaults to node_modules. */
  wasmDir?: string;
}

/** Chooses a language adapter per file and scans it. Create once; adapters are reusable. */
export class Scanner {
  private constructor(
    private readonly adapters: LanguageAdapter[],
    private readonly fallback: LanguageAdapter,
  ) {}

  static async create(options: ScannerOptions = {}): Promise<Scanner> {
    return new Scanner(await createTreeSitterAdapters(options.wasmDir), new FallbackAdapter());
  }

  adapterFor(relPath: string, languageId?: string): LanguageAdapter {
    const ext = relPath.slice(relPath.lastIndexOf('.')).toLowerCase();
    return (
      this.adapters.find((a) => a.extensions.includes(ext)) ??
      (languageId ? this.adapters.find((a) => a.languageIds.includes(languageId)) : undefined) ??
      this.fallback
    );
  }

  /** Cheap pre-check so most files never reach a parser. */
  static mayContainDirective(text: string): boolean {
    return text.includes('@figma');
  }

  scan(doc: SourceDocument): FileScanResult {
    const adapter = this.adapterFor(doc.relPath, doc.languageId);
    if (!Scanner.mayContainDirective(doc.text))
      return { relPath: doc.relPath, adapterId: adapter.id, languageId: doc.languageId ?? '', occurrences: [], diagnostics: [], hasSyntaxErrors: false };
    return adapter.scan(doc);
  }
}
