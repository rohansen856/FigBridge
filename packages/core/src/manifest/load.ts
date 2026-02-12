import Ajv2020Module, { type ErrorObject } from 'ajv/dist/2020.js';
import { isMap, isScalar, LineCounter, parseDocument, type Document, type Node } from 'yaml';
import type { RefId } from '../ids.js';
import { apiKeyOf, buildFileUrl, normalizeNodeId, parseFigmaUrl, type NodeId } from '../figma-url.js';
import { looksLikeSecret, type Diagnostic, type ErrorCode, type Range, type Severity } from '../diagnostics.js';
import { MANIFEST_SCHEMA } from './schema.js';
import {
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  SUPPORTED_SCHEMA_VERSIONS,
  type EnvLookup,
  type Manifest,
  type ManifestFile,
  type ManifestLoadResult,
  type ManifestRef,
  type RefKind,
} from './types.js';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const ENV_PLACEHOLDER = /^\$\{env:(FIGMA_[A-Z0-9_]{1,64})\}$/;

// ajv ships CJS; under NodeNext the default import is the module namespace.
const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module }).default ?? Ajv2020Module;
const ajv = new (Ajv2020 as unknown as new (o: object) => import('ajv').default)({ allErrors: true, strict: false });
const validateSchema = ajv.compile(MANIFEST_SCHEMA);

interface RawFile {
  name?: string;
  url?: string;
  fileKey?: string;
  branchKey?: string;
}
interface RawRef {
  file: string;
  nodeId: string;
  name?: string;
  kind?: RefKind;
  tags?: string[];
  parentRef?: string;
  deprecated?: boolean;
  replacedBy?: string;
}
interface RawManifest {
  schemaVersion: number;
  project?: { name?: string };
  settings?: {
    preview?: { format?: 'png' | 'jpg'; scale?: number; ttlMinutes?: number; hoverWidth?: number };
    scan?: { include?: string[]; exclude?: string[] };
  };
  files: Record<string, RawFile>;
  refs: Record<string, RawRef>;
  retired?: string[];
}

/**
 * Parses and validates a manifest. Never throws for user input: every problem becomes a
 * diagnostic. A result without `manifest` must not replace the last-known-good manifest.
 */
export function loadManifest(text: string, path: string, env: EnvLookup): ManifestLoadResult {
  const diagnostics: Diagnostic[] = [];
  const add = (code: ErrorCode, severity: Severity, message: string, range?: Range, data?: Record<string, string>) =>
    diagnostics.push({ code, severity, message, file: path, ...(range ? { range } : {}), ...(data ? { data } : {}) });

  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    add('CONFIG_INVALID', 'error', `Manifest is larger than ${MAX_MANIFEST_BYTES / 1024 / 1024} MB.`);
    return { state: 'invalid', diagnostics };
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter,
    schema: 'core',
    uniqueKeys: true,
    prettyErrors: false,
    customTags: [],
  });
  const toRange = (offsets: readonly [number, number] | readonly number[] | undefined): Range | undefined => {
    if (!offsets || offsets.length < 2) return undefined;
    const s = lineCounter.linePos(offsets[0]!);
    const e = lineCounter.linePos(offsets[1]!);
    return { start: { line: s.line - 1, character: s.col - 1 }, end: { line: e.line - 1, character: e.col - 1 } };
  };

  for (const err of doc.errors) add('CONFIG_INVALID', 'error', `YAML: ${err.message.split('\n')[0]}`, toRange(err.pos));
  if (doc.errors.length) return { state: 'invalid', diagnostics };
  for (const w of doc.warnings) add('CONFIG_INVALID', 'warning', `YAML: ${w.message.split('\n')[0]}`, toRange(w.pos));

  restoreStringScalars(doc);
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 100 });
  } catch (e) {
    add('CONFIG_INVALID', 'error', `YAML: ${(e as Error).message}`);
    return { state: 'invalid', diagnostics };
  }
  const rangeAt = (pathParts: readonly (string | number)[]) => rangeOfPath(doc, pathParts, toRange);

  scanForSecrets(
    doc,
    (range) =>
      add('SECRET_IN_MANIFEST', 'error', 'This value looks like a Figma access token. Remove it; tokens belong in VS Code secret storage.', range),
    toRange,
  );
  if (diagnostics.some((d) => d.code === 'SECRET_IN_MANIFEST')) return { state: 'invalid', diagnostics };

  const version = (data as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === 'number' && !(SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(version)) {
    add(
      'SCHEMA_UNSUPPORTED',
      'error',
      `schemaVersion ${version} is not supported by this version of FigBridge (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}). The manifest is read-only until FigBridge is updated.`,
      rangeAt(['schemaVersion']),
    );
    return { state: 'unsupported-version', diagnostics };
  }

  if (!validateSchema(data)) {
    for (const err of dedupeAjvErrors(validateSchema.errors ?? [])) {
      const parts = instancePathParts(err);
      add('SCHEMA_VIOLATION', 'error', describeAjvError(err), rangeAt(parts) ?? rangeAt(parts.slice(0, -1)));
    }
    return { state: 'invalid', diagnostics };
  }
  const raw = data as RawManifest;

  // Files
  const files = new Map<string, ManifestFile>();
  const aliasesByKey = new Map<string, string>();
  for (const [alias, f] of Object.entries(raw.files)) {
    const range = rangeAt(['files', alias]);
    const file: ManifestFile = { alias, state: 'ok', ...(f.name ? { name: f.name } : {}), ...(range ? { range } : {}) };
    files.set(alias, file);
    let urlValue = f.url;
    if (urlValue !== undefined) {
      file.rawUrl = urlValue;
      const placeholder = ENV_PLACEHOLDER.exec(urlValue);
      if (placeholder) {
        const name = placeholder[1]!;
        file.envVar = name;
        urlValue = env(name)?.trim();
        if (!urlValue) {
          file.state = 'env-missing';
          add('ENV_VAR_MISSING', 'warning', `Environment variable ${name} is not set, so file "${alias}" cannot be resolved.`, rangeAt(['files', alias, 'url']), { variable: name, alias });
          continue;
        }
      }
      const parsed = parseFigmaUrl(urlValue);
      if (!parsed.ok) {
        file.state = 'invalid';
        const where = file.envVar ? ` (from ${file.envVar})` : '';
        add('INVALID_FIGMA_URL', 'error', `File "${alias}" has an invalid Figma URL${where}: ${parsed.error}.`, rangeAt(['files', alias, 'url']), { alias });
        continue;
      }
      file.fileKey = parsed.value.fileKey;
      const branchKey = f.branchKey ?? parsed.value.branchKey;
      if (branchKey) file.branchKey = branchKey;
      if (parsed.value.slug) file.slug = parsed.value.slug;
    } else {
      file.fileKey = f.fileKey!;
      if (f.branchKey) file.branchKey = f.branchKey;
    }
    file.apiKey = apiKeyOf(file as { fileKey: string; branchKey?: string });
    file.baseUrl = buildFileUrl(file as { fileKey: string; branchKey?: string; slug?: string });
    const prior = aliasesByKey.get(file.apiKey);
    if (prior)
      add('DUPLICATE_FILE_KEY', 'warning', `Files "${prior}" and "${alias}" point to the same Figma file.`, range);
    else aliasesByKey.set(file.apiKey, alias);
  }

  // Refs
  const refs = new Map<RefId, ManifestRef>();
  const retired = new Set((raw.retired ?? []) as RefId[]);
  const byTarget = new Map<string, RefId>();
  for (const [id, r] of Object.entries(raw.refs)) {
    const refId = id as RefId;
    const range = rangeAt(['refs', id]);
    if (!files.has(r.file))
      add('UNKNOWN_FILE_ALIAS', 'error', `Reference ${id} uses unknown file alias "${r.file}".`, rangeAt(['refs', id, 'file']));
    if (retired.has(refId))
      add('RETIRED_ID_IN_USE', 'error', `Reference ${id} is listed in "retired" and must not be mapped again.`, range);
    const ref: ManifestRef = {
      id: refId,
      file: r.file,
      nodeId: normalizeNodeId(r.nodeId) as NodeId,
      tags: r.tags ?? [],
      deprecated: r.deprecated === true,
      ...(r.name ? { name: r.name } : {}),
      ...(r.kind ? { kind: r.kind } : {}),
      ...(r.parentRef ? { parentRef: r.parentRef as RefId } : {}),
      ...(r.replacedBy ? { replacedBy: r.replacedBy as RefId } : {}),
      ...(range ? { range } : {}),
    };
    refs.set(refId, ref);
    const target = `${r.file}\u0000${ref.nodeId}`;
    const other = byTarget.get(target);
    if (other)
      add('DUPLICATE_MAPPING', 'warning', `References ${other} and ${id} map to the same node ${ref.nodeId} in "${r.file}".`, range, { other });
    else byTarget.set(target, refId);
  }
  for (const ref of refs.values()) {
    if (ref.parentRef && !refs.has(ref.parentRef))
      add('UNKNOWN_PARENT_REF', 'error', `parentRef ${ref.parentRef} of ${ref.id} is not a known reference.`, rangeAt(['refs', ref.id, 'parentRef']));
    if (ref.replacedBy && !refs.has(ref.replacedBy))
      add('UNKNOWN_REPLACEMENT_REF', 'error', `replacedBy ${ref.replacedBy} of ${ref.id} is not a known reference.`, rangeAt(['refs', ref.id, 'replacedBy']));
  }
  for (const cycle of findParentCycles(refs))
    add('PARENT_CYCLE', 'error', `parentRef cycle: ${cycle.join(' → ')}.`, rangeAt(['refs', cycle[0]!, 'parentRef']));

  const hasErrors = diagnostics.some((d) => d.severity === 'error');
  if (hasErrors) return { state: 'invalid', diagnostics };

  const manifest: Manifest = {
    schemaVersion: 1,
    path,
    ...(raw.project?.name ? { projectName: raw.project.name } : {}),
    preview: {
      format: raw.settings?.preview?.format ?? 'png',
      scale: raw.settings?.preview?.scale ?? 1,
      ttlMinutes: raw.settings?.preview?.ttlMinutes ?? 1440,
      hoverWidth: raw.settings?.preview?.hoverWidth ?? 360,
    },
    scan: {
      include: raw.settings?.scan?.include ?? DEFAULT_INCLUDE,
      exclude: [...DEFAULT_EXCLUDE, ...(raw.settings?.scan?.exclude ?? [])],
    },
    files,
    refs,
    retired,
  };
  return { state: diagnostics.length ? 'warnings' : 'ok', manifest, diagnostics };
}

/** Returns each distinct parentRef cycle once, as the list of IDs starting from its smallest ID. */
export function findParentCycles(refs: ReadonlyMap<RefId, { parentRef?: RefId }>): RefId[][] {
  const cycles = new Map<string, RefId[]>();
  for (const start of refs.keys()) {
    const seen: RefId[] = [];
    let cur: RefId | undefined = start;
    while (cur && refs.has(cur)) {
      const idx = seen.indexOf(cur);
      if (idx >= 0) {
        const cycle = seen.slice(idx);
        const min = [...cycle].sort()[0]!;
        const rotated = [...cycle.slice(cycle.indexOf(min)), ...cycle.slice(0, cycle.indexOf(min))];
        cycles.set(rotated.join(','), [...rotated, min]);
        break;
      }
      seen.push(cur);
      cur = refs.get(cur)?.parentRef;
    }
  }
  return [...cycles.values()];
}

function rangeOfPath(
  doc: Document,
  parts: readonly (string | number)[],
  toRange: (o: readonly number[] | undefined) => Range | undefined,
): Range | undefined {
  if (parts.length === 0) return undefined;
  const parent = parts.length > 1 ? doc.getIn(parts.slice(0, -1), true) : doc.contents;
  const key = parts[parts.length - 1];
  if (isMap(parent)) {
    const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === key);
    const node = (pair?.key ?? undefined) as Node | undefined;
    if (node?.range) return toRange(node.range);
  }
  const node = doc.getIn(parts, true) as Node | undefined;
  return node?.range ? toRange(node.range) : undefined;
}

/**
 * Plain YAML scalars such as `000000000000` or `1234E5678901` are valid reference IDs but
 * YAML reads them as numbers. Restore the source text wherever the schema expects a string ID/key.
 */
function restoreStringScalars(doc: Document): void {
  const fix = (node: unknown) => {
    if (isScalar(node) && typeof node.value !== 'string' && typeof node.source === 'string' && node.type === 'PLAIN')
      node.value = node.source;
  };
  const refs = doc.get('refs', true);
  if (isMap(refs))
    for (const pair of refs.items) {
      fix(pair.key);
      if (isMap(pair.value))
        for (const field of pair.value.items)
          if (isScalar(field.key) && ['parentRef', 'replacedBy', 'nodeId', 'file'].includes(String(field.key.value)))
            fix(field.value);
    }
  const files = doc.get('files', true);
  if (isMap(files))
    for (const pair of files.items) {
      fix(pair.key);
      if (isMap(pair.value))
        for (const field of pair.value.items)
          if (isScalar(field.key) && ['fileKey', 'branchKey'].includes(String(field.key.value))) fix(field.value);
    }
  const retired = doc.get('retired', true);
  if (retired && typeof retired === 'object' && 'items' in retired)
    for (const item of (retired as { items: unknown[] }).items) fix(item);
}

function scanForSecrets(
  doc: Document,
  report: (range: Range | undefined) => void,
  toRange: (o: readonly number[] | undefined) => Range | undefined,
): void {
  const visit = (node: unknown): void => {
    if (isScalar(node)) {
      if (typeof node.value === 'string' && looksLikeSecret(node.value)) report(toRange(node.range ?? undefined));
    } else if (node && typeof node === 'object' && 'items' in node) {
      for (const item of (node as { items: unknown[] }).items) {
        if (item && typeof item === 'object' && 'key' in item) {
          visit((item as { key: unknown }).key);
          visit((item as unknown as { value: unknown }).value);
        } else visit(item);
      }
    }
  };
  visit(doc.contents);
}

function instancePathParts(err: ErrorObject): string[] {
  const parts = err.instancePath.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (err.keyword === 'additionalProperties') parts.push(String(err.params.additionalProperty));
  if (err.keyword === 'propertyNames' && err.params.propertyName) parts.push(String(err.params.propertyName));
  return parts;
}

function dedupeAjvErrors(errors: ErrorObject[]): ErrorObject[] {
  // `oneOf`/`anyOf` produce noisy sub-errors; keep the summary and drop schema-path children.
  const umbrella = errors.filter((e) => e.keyword === 'oneOf' || e.keyword === 'anyOf').map((e) => e.instancePath);
  const seen = new Set<string>();
  return errors.filter((e) => {
    if (e.keyword !== 'oneOf' && e.keyword !== 'anyOf' && umbrella.includes(e.instancePath)) return false;
    if (e.keyword === 'pattern' && e.propertyName === undefined && errors.some((o) => o.keyword === 'propertyNames' && o.instancePath === e.instancePath)) return false;
    const key = `${e.instancePath}|${e.keyword}|${JSON.stringify(e.params)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describeAjvError(err: ErrorObject): string {
  const where = err.instancePath ? err.instancePath.slice(1).replace(/\//g, '.') : 'manifest';
  switch (err.keyword) {
    case 'additionalProperties':
      return `Unknown field "${String(err.params.additionalProperty)}" in ${where}.`;
    case 'required':
      return `Missing required field "${String(err.params.missingProperty)}" in ${where}.`;
    case 'propertyNames':
      return `Invalid key "${String(err.params.propertyName)}" in ${where}: reference IDs are 12 Crockford Base32 characters; file aliases are lower-case.`;
    case 'oneOf':
      return `${where} must have exactly one of "url" or "fileKey".`;
    case 'anyOf':
      return `${where} must be an https://www.figma.com/design/… URL or a \${env:FIGMA_…} placeholder.`;
    case 'const':
      return `${where} must be ${JSON.stringify(err.params.allowedValue)}.`;
    case 'enum':
      return `${where} must be one of ${(err.params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(', ')}.`;
    case 'pattern':
      return where.endsWith('nodeId')
        ? `${where} must be a Figma node ID such as "12:34" (use a colon, not a hyphen).`
        : `${where} has an invalid format.`;
    default:
      return `${where} ${err.message ?? 'is invalid'}.`;
  }
}
