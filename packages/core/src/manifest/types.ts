import type { RefId } from '../ids.js';
import type { NodeId } from '../figma-url.js';
import type { Diagnostic, Range } from '../diagnostics.js';

export const MANIFEST_FILENAME = 'figma.design.yaml';
export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

export const DEFAULT_INCLUDE = ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,dart}'];
export const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/build/**',
  '**/dist/**',
  '**/out/**',
  '**/coverage/**',
  '**/.dart_tool/**',
  '**/.next/**',
  '**/*.g.dart',
  '**/*.freezed.dart',
  '**/*.min.js',
];

export type RefKind = 'screen' | 'component' | 'variant' | 'asset' | 'section' | 'other';

export interface PreviewSettings {
  format: 'png' | 'jpg';
  scale: number;
  ttlMinutes: number;
  hoverWidth: number;
}

export interface ScanSettings {
  include: string[];
  exclude: string[];
}

export type FileState = 'ok' | 'env-missing' | 'invalid';

export interface ManifestFile {
  alias: string;
  name?: string;
  /** Unresolved value as written (may be an env placeholder). */
  rawUrl?: string;
  fileKey?: string;
  branchKey?: string;
  slug?: string;
  /** Key for REST calls (branch key if present). */
  apiKey?: string;
  /** Canonical HTTPS base URL without node selection. */
  baseUrl?: string;
  state: FileState;
  envVar?: string;
  range?: Range;
}

export interface ManifestRef {
  id: RefId;
  file: string;
  nodeId: NodeId;
  name?: string;
  kind?: RefKind;
  tags: string[];
  parentRef?: RefId;
  deprecated: boolean;
  replacedBy?: RefId;
  range?: Range;
}

export interface Manifest {
  schemaVersion: 1;
  projectName?: string;
  /** Workspace-relative path of the manifest file. */
  path: string;
  preview: PreviewSettings;
  scan: ScanSettings;
  files: Map<string, ManifestFile>;
  refs: Map<RefId, ManifestRef>;
  retired: Set<RefId>;
}

export type ManifestState = 'ok' | 'warnings' | 'invalid' | 'unsupported-version';

export interface ManifestLoadResult {
  state: ManifestState;
  /** Present for `ok` and `warnings`; never for `invalid`/`unsupported-version`. */
  manifest?: Manifest;
  diagnostics: Diagnostic[];
}

/** Resolves an allowlisted environment variable; returns undefined when unset. */
export type EnvLookup = (name: string) => string | undefined;
