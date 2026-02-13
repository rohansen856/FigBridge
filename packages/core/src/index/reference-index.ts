import type { RefId } from '../ids.js';
import { buildNodeUrl } from '../figma-url.js';
import type { Diagnostic, ErrorCode, Severity } from '../diagnostics.js';
import type { Manifest, ManifestFile, ManifestRef } from '../manifest/types.js';
import { rangeContains, type AnnotationOccurrence, type FileScanResult } from '../scanner/types.js';

export type ScanState = 'pending' | 'partial' | 'complete' | 'failed';
/** Result of the latest remote check for a reference's node; `unknown` until checked. */
export type NodeState = 'unknown' | 'available' | 'missing' | 'denied';
export type FileAccessState = 'unknown' | 'available' | 'denied' | 'missing';

export interface ResolvedRef {
  ref: ManifestRef;
  file: ManifestFile;
  /** Browser URL selecting the node; absent when the file's URL cannot be resolved. */
  openUrl?: string;
  nodeState: NodeState;
}

export interface HealthSummary {
  scanState: ScanState;
  manifestPresent: boolean;
  occurrences: number;
  uniqueIdsUsed: number;
  resolvedOccurrences: number;
  unresolvedOccurrences: number;
  malformedDirectives: number;
  mappings: number;
  /** Mappings with no source occurrence. Undefined unless the scan is complete. */
  unusedMappings?: number;
  deprecatedInUse: number;
  duplicateMappings: number;
  invalidNodes: number;
  inaccessibleFiles: number;
  unresolvedFiles: number;
  filesScanned: number;
  filesWithSyntaxErrors: number;
  fileLevelOnly: number;
}

export type ProblemKind =
  | 'unresolved'
  | 'malformed'
  | 'noncanonical'
  | 'unused'
  | 'deprecated'
  | 'duplicate-mapping'
  | 'invalid-node'
  | 'inaccessible-file'
  | 'unresolved-file';

export interface Problem {
  kind: ProblemKind;
  code: ErrorCode;
  severity: Severity;
  message: string;
  refId?: RefId;
  fileAlias?: string;
  relPath?: string;
  line?: number;
}

export interface SourceTreeNode {
  occurrence: AnnotationOccurrence;
  children: SourceTreeNode[];
}

/**
 * In-memory join of the manifest and per-file scan results. Pure and synchronous; callers feed
 * it manifest updates, file results and remote validation states, then query it.
 */
export class ReferenceIndex {
  private manifest: Manifest | undefined;
  private readonly files = new Map<string, FileScanResult>();
  private readonly byRef = new Map<RefId, AnnotationOccurrence[]>();
  private readonly nodeStates = new Map<RefId, NodeState>();
  private readonly fileStates = new Map<string, FileAccessState>();
  private manifestDuplicateCount = 0;
  scanState: ScanState = 'pending';
  /** Incremented on every change; cheap change detection for views. */
  version = 0;

  setManifest(manifest: Manifest | undefined, duplicateMappings = 0): void {
    this.manifest = manifest;
    this.manifestDuplicateCount = duplicateMappings;
    this.version++;
  }

  getManifest(): Manifest | undefined {
    return this.manifest;
  }

  setFile(result: FileScanResult): void {
    this.removeFromRefIndex(result.relPath);
    if (result.occurrences.length || result.diagnostics.length || result.hasSyntaxErrors) this.files.set(result.relPath, result);
    else this.files.delete(result.relPath);
    for (const o of result.occurrences) {
      const list = this.byRef.get(o.refId);
      if (list) list.push(o);
      else this.byRef.set(o.refId, [o]);
    }
    this.scannedPaths.add(result.relPath);
    this.version++;
  }

  removeFile(relPath: string): void {
    this.removeFromRefIndex(relPath);
    this.files.delete(relPath);
    this.scannedPaths.delete(relPath);
    this.version++;
  }

  clearFiles(): void {
    this.files.clear();
    this.byRef.clear();
    this.scannedPaths.clear();
    this.version++;
  }

  private readonly scannedPaths = new Set<string>();

  private removeFromRefIndex(relPath: string): void {
    const prev = this.files.get(relPath);
    if (!prev) return;
    for (const o of prev.occurrences) {
      const list = this.byRef.get(o.refId);
      if (!list) continue;
      const next = list.filter((x) => x.relPath !== relPath);
      if (next.length) this.byRef.set(o.refId, next);
      else this.byRef.delete(o.refId);
    }
  }

  setNodeState(refId: RefId, state: NodeState): void {
    this.nodeStates.set(refId, state);
    this.version++;
  }

  setFileAccess(alias: string, state: FileAccessState): void {
    this.fileStates.set(alias, state);
    this.version++;
  }

  fileAccess(alias: string): FileAccessState {
    return this.fileStates.get(alias) ?? 'unknown';
  }

  // ---- queries ----

  resolve(refId: RefId): ResolvedRef | undefined {
    const ref = this.manifest?.refs.get(refId);
    if (!ref) return undefined;
    const file = this.manifest!.files.get(ref.file);
    if (!file) return undefined;
    const openUrl =
      file.state === 'ok' && file.fileKey ? buildNodeUrl(file as { fileKey: string; branchKey?: string; slug?: string }, ref.nodeId) : undefined;
    return { ref, file, nodeState: this.nodeStates.get(refId) ?? 'unknown', ...(openUrl ? { openUrl } : {}) };
  }

  occurrencesFor(refId: RefId): readonly AnnotationOccurrence[] {
    return this.byRef.get(refId) ?? [];
  }

  occurrencesIn(relPath: string): readonly AnnotationOccurrence[] {
    return this.files.get(relPath)?.occurrences ?? [];
  }

  allOccurrences(): AnnotationOccurrence[] {
    return [...this.files.values()].flatMap((f) => f.occurrences);
  }

  /** The occurrence whose directive comment contains the position (zero-based). */
  occurrenceAt(relPath: string, line: number, character: number): AnnotationOccurrence | undefined {
    const pos = { line, character };
    const inFile = this.occurrencesIn(relPath);
    return inFile.find((o) => rangeContains(o.idRange, pos)) ?? inFile.find((o) => rangeContains(o.commentRange, pos) && o.commentRange.start.line === line);
  }

  isUsed(refId: RefId): boolean {
    return (this.byRef.get(refId)?.length ?? 0) > 0;
  }

  /** Diagnostics to show in a source file: scan diagnostics plus resolution problems. */
  diagnosticsFor(relPath: string): Diagnostic[] {
    const result = this.files.get(relPath);
    if (!result) return [];
    const out = [...result.diagnostics];
    if (!this.manifest) return out;
    for (const o of result.occurrences) {
      const ref = this.manifest.refs.get(o.refId);
      if (!o.canonical)
        out.push({
          code: 'NONCANONICAL_CASE',
          severity: 'warning',
          message: `Reference IDs are upper-case: use ${o.refId}.`,
          file: relPath,
          range: o.idRange,
          data: { refId: o.refId },
        });
      if (!ref)
        out.push({
          code: 'UNRESOLVED_REF',
          severity: this.manifest.retired.has(o.refId) ? 'error' : 'warning',
          message: this.manifest.retired.has(o.refId)
            ? `${o.refId} is a retired reference and no longer maps to a design.`
            : `${o.refId} is not defined in ${this.manifest.path}.`,
          file: relPath,
          range: o.idRange,
          data: { refId: o.refId },
        });
      else if (ref.deprecated)
        out.push({
          code: 'DEPRECATED_REF',
          severity: 'info',
          message: ref.replacedBy ? `${o.refId} is deprecated; use ${ref.replacedBy}.` : `${o.refId} is deprecated.`,
          file: relPath,
          range: o.idRange,
          data: { refId: o.refId, ...(ref.replacedBy ? { replacedBy: ref.replacedBy } : {}) },
        });
    }
    return out;
  }

  health(): HealthSummary {
    const occurrences = this.allOccurrences();
    const refs = this.manifest?.refs;
    const resolved = refs ? occurrences.filter((o) => refs.has(o.refId)).length : 0;
    const files = [...(this.manifest?.files.values() ?? [])];
    return {
      scanState: this.scanState,
      manifestPresent: !!this.manifest,
      occurrences: occurrences.length,
      uniqueIdsUsed: this.byRef.size,
      resolvedOccurrences: resolved,
      unresolvedOccurrences: occurrences.length - resolved,
      malformedDirectives: [...this.files.values()].reduce((n, f) => n + f.diagnostics.filter((d) => d.code === 'MALFORMED_DIRECTIVE').length, 0),
      mappings: refs?.size ?? 0,
      ...(this.scanState === 'complete' && refs ? { unusedMappings: [...refs.keys()].filter((id) => !this.isUsed(id)).length } : {}),
      deprecatedInUse: refs ? [...refs.values()].filter((r) => r.deprecated && this.isUsed(r.id)).length : 0,
      duplicateMappings: this.manifestDuplicateCount,
      invalidNodes: [...this.nodeStates.entries()].filter(([id, s]) => (s === 'missing' || s === 'denied') && refs?.has(id)).length,
      inaccessibleFiles: files.filter((f) => ['denied', 'missing'].includes(this.fileAccess(f.alias))).length,
      unresolvedFiles: files.filter((f) => f.state !== 'ok').length,
      filesScanned: this.scannedPaths.size,
      filesWithSyntaxErrors: [...this.files.values()].filter((f) => f.hasSyntaxErrors).length,
      fileLevelOnly: occurrences.filter((o) => o.confidence === 'file-level').length,
    };
  }

  problems(): Problem[] {
    const out: Problem[] = [];
    const m = this.manifest;
    for (const f of this.files.values()) {
      for (const d of f.diagnostics)
        out.push({ kind: 'malformed', code: d.code, severity: d.severity, message: d.message, relPath: f.relPath, ...(d.range ? { line: d.range.start.line } : {}) });
      for (const o of f.occurrences) {
        const loc = { refId: o.refId, relPath: o.relPath, line: o.idRange.start.line };
        if (!o.canonical) out.push({ kind: 'noncanonical', code: 'NONCANONICAL_CASE', severity: 'warning', message: `${o.rawId} should be written ${o.refId}.`, ...loc });
        if (m && !m.refs.has(o.refId))
          out.push({ kind: 'unresolved', code: 'UNRESOLVED_REF', severity: 'warning', message: `${o.refId} is not in the manifest.`, ...loc });
        else if (m?.refs.get(o.refId)?.deprecated)
          out.push({ kind: 'deprecated', code: 'DEPRECATED_REF', severity: 'info', message: `${o.refId} is deprecated.`, ...loc });
      }
    }
    if (m) {
      if (this.scanState === 'complete')
        for (const id of m.refs.keys())
          if (!this.isUsed(id))
            out.push({ kind: 'unused', code: 'UNRESOLVED_REF', severity: 'info', message: `${id} is not used in any scanned source file.`, refId: id, fileAlias: m.refs.get(id)!.file });
      for (const [id, s] of this.nodeStates)
        if ((s === 'missing' || s === 'denied') && m.refs.has(id))
          out.push({
            kind: 'invalid-node',
            code: s === 'missing' ? 'NODE_NOT_FOUND' : 'FILE_UNAVAILABLE',
            severity: 'error',
            message: s === 'missing' ? `Node ${m.refs.get(id)!.nodeId} of ${id} no longer exists.` : `No access to the node of ${id}.`,
            refId: id,
            fileAlias: m.refs.get(id)!.file,
          });
      for (const f of m.files.values()) {
        if (f.state !== 'ok')
          out.push({ kind: 'unresolved-file', code: f.state === 'env-missing' ? 'ENV_VAR_MISSING' : 'INVALID_FIGMA_URL', severity: 'warning', message: f.state === 'env-missing' ? `File "${f.alias}" needs ${f.envVar}.` : `File "${f.alias}" has an invalid URL.`, fileAlias: f.alias });
        const access = this.fileAccess(f.alias);
        if (access === 'denied' || access === 'missing')
          out.push({ kind: 'inaccessible-file', code: 'FILE_UNAVAILABLE', severity: 'error', message: `Figma file "${f.alias}" is ${access === 'denied' ? 'not accessible with the current token' : 'not found'}.`, fileAlias: f.alias });
      }
    }
    return out;
  }

  /**
   * Source hierarchy: per file, occurrences nested under their nearest enclosing annotated
   * declaration. Roots are occurrences without a source parent. Sorted by path then line.
   */
  sourceTree(): SourceTreeNode[] {
    const roots: SourceTreeNode[] = [];
    const paths = [...this.files.keys()].sort();
    for (const path of paths) {
      const occs = [...this.files.get(path)!.occurrences].sort((a, b) => a.idRange.start.line - b.idRange.start.line);
      const nodes = new Map(occs.map((o) => [o.id, { occurrence: o, children: [] as SourceTreeNode[] }]));
      for (const o of occs) {
        const node = nodes.get(o.id)!;
        const parent = o.sourceParentId ? nodes.get(o.sourceParentId) : undefined;
        if (parent) parent.children.push(node);
        else roots.push(node);
      }
    }
    return roots;
  }

  /** Children through explicit manifest `parentRef` links (logical hierarchy). */
  logicalChildren(refId: RefId): ManifestRef[] {
    return [...(this.manifest?.refs.values() ?? [])].filter((r) => r.parentRef === refId);
  }

  /** IDs that must not be issued for a new mapping. */
  takenIds(): Set<string> {
    const taken = new Set<string>(this.byRef.keys());
    for (const id of this.manifest?.refs.keys() ?? []) taken.add(id);
    for (const id of this.manifest?.retired ?? []) taken.add(id);
    for (const f of this.files.values()) for (const o of f.occurrences) taken.add(o.refId);
    return taken;
  }
}
