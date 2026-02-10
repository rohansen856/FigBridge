# 06 — Data and Storage Schema

## 1. Storage architecture decision

MVP is **local-first, no backend service and no required database**. The checked-in `figma.design.yaml` is the canonical, human-reviewable registry. The extension creates runtime indexes and preview-cache metadata in its VS Code extension storage. A service/SQL database would add failure modes without improving the local developer workflow, so it is deferred.

“Schema” includes four things:
1. The committed manifest schema.
2. The normalized in-memory source/reference index.
3. The local cache metadata schema and filesystem layout.
4. The sanitized Claude event schema.

If future workloads require cross-workspace history, an optional SQLite index can be added behind the storage interface. It must not become a new source of truth.

## 2. Entities

### Workspace
- `workspaceId`: stable local opaque hash derived from canonical workspace URI; not an account identity.
- `rootUri`: current workspace root (never synced off-machine by default).
- `configUri`: path to `figma.design.yaml`.
- `configHash`: digest of normalized parsed config for change detection.
- `lastFullScanAt`: timestamp.
- `scanState`: `complete | partial | failed | pending`.
- `adapterSet`: language adapters used for the scan.

### FigmaFile
- `alias`: key referenced by mapping records.
- `fileKey`: ID parsed from canonical URL.
- `canonicalUrl`: HTTPS base URL.
- `displayName`: config or API metadata.
- `remoteVersion`/`lastModified`: when available.
- `lastValidatedAt`: remote validation time.
- `accessState`: `unknown | available | denied | missing | offline`.

### DesignReference
- `refId`: 12-character opaque code.
- `fileAlias`: FK-like pointer to configured `FigmaFile`.
- `nodeId`: canonical colon-form node ID.
- `displayName`: human-readable label.
- `kind`: optional `screen | component | variant | asset | section | unknown`.
- `parentRef`: optional explicit logical parent.
- `tags`: optional metadata list.
- `nodeState`: `configured-unverified | available | missing | denied | offline`.

### AnnotationOccurrence
- `occurrenceId`: deterministic hash of `workspaceId + normalizedPath + range + refId` for current scan; changes if code location/range changes.
- `refIdRaw`: text found in source.
- `refIdNormalized`: normalized key candidate.
- `resolvedRefId`: populated only if manifest entry exists.
- `sourceUri`: local source URI.
- `relativePath`: repository-relative path.
- `range`: start/end line+column (zero-based internally; display one-based).
- `languageId`: VS Code language identifier.
- `adapterId`: language adapter that processed file.
- `ownerSymbol`: optional source declaration identity/name.
- `sourceParentOccurrence`: optional relation to parent annotation/symbol.
- `scanConfidence`: `ast | declaration | file-level | unknown`.
- `diagnostics[]`: malformed/unresolved/ambiguous flags.

### PreviewCacheEntry
- `cacheKey`: hash of file key, node ID, format, scale and remote version fingerprint.
- `imagePath`: location under extension global storage.
- `imageMime`: `image/png`, `image/jpeg` or `image/svg+xml` only when verified safe.
- `byteSize`: bounded positive integer.
- `fetchedAt`, `lastUsedAt`, `expiresAt`.
- `remoteVersionFingerprint`: latest known file version/lastModified.
- `status`: `fresh | stale | failed | evicted`.
- `lastErrorCode`: normalized code; no secrets or raw auth error body.

### ClaudeDesignEvent
- `eventId`: random UUID.
- `timestamp`: ISO UTC time from hook.
- `sessionIdHash`: optional hash, not raw transcript content or an account ID.
- `toolName`: allowlisted/masked tool name.
- `operationKind`: `read | mutation | unknown`.
- `fileKey`: optional parsed file key, validated before storage.
- `nodeIds[]`: optional normalized node IDs.
- `targetConfidence`: `node | file | unknown`.
- `resultState`: `success | failure | unknown` based only on hook payload.
- `handledAt`: optional processing timestamp.
- `cacheInvalidation`: `specific-nodes | whole-file | all-configured | none`.
- `safeSummary`: short normalized text, no raw output by default.

## 3. Manifest schema example

The example `examples/figma.design.yaml` is the human-edited data. The corresponding JSON Schema should enforce types, required values, IDs, alias existence (some cross-field validation will require application logic), URI rules and schema version. Use `additionalProperties: false` for core objects unless extension points are specifically reserved.

## 4. Runtime index

The generated index is memory-first. If persisted for quicker activation, it is only a cache and must include:

```json
{
  "indexVersion": 1,
  "schemaVersion": 1,
  "workspaceHash": "sha256:...",
  "configHash": "sha256:...",
  "builtAt": "<ISO 8601 timestamp>",
  "scanState": "complete",
  "sourceFiles": [],
  "occurrences": [],
  "summary": {
    "annotationOccurrences": 0,
    "uniqueResolvedRefs": 0,
    "unusedRefs": 0,
    "unresolvedOccurrences": 0,
    "invalidNodes": 0
  }
}
```

This is a structural example, not a final machine-generated schema. A persisted index must not include source code contents, environment values, PAT, signed render URLs or complete Figma API responses. Paths should be relative or workspace URI references; sensitive absolute paths should not be sent to external services.

## 5. Local filesystem layout

Proposed extension storage:

```text
<VS Code globalStorageUri>/
├── workspaces/<workspaceHash>/
│   ├── index-v1.json              # recomputable, optional
│   ├── cache-manifest-v1.json     # cache entries
│   ├── previews/<cacheKey>.png    # rendered image binary
│   ├── events/                    # processed/queued sanitized event IDs if needed
│   └── logs/                      # opt-in diagnostics, redacted, bounded
└── user-secrets/                  # do not write credentials here manually;
                                    # use VS Code SecretStorage APIs
```

VS Code owns SecretStorage implementation; the extension must not roll its own keychain file. The directory above is illustrative and excludes the actual SecretStorage backend.

Workspace-local hook event spool (if used) should be under a gitignored path such as `.figbridge/events/` and contain no PAT, raw design JSON, arbitrary tool output, source snippet or environment values. Prefer extension storage if the hook transport can reach it cross-platform without opening a network server.

## 6. Logical indexes

These are indexes in memory or the optional SQLite implementation:
- `refsById: Map<RefId, DesignReference>`.
- `filesByAlias: Map<FileAlias, FigmaFile>`.
- `occurrencesByRefId: Map<RefId, AnnotationOccurrence[]>`.
- `occurrencesByUri: Map<Uri, AnnotationOccurrence[]>`.
- `childrenBySourceOwner: Map<SymbolKey, AnnotationOccurrence[]>`.
- `cacheByCacheKey: Map<CacheKey, PreviewCacheEntry>`.
- `eventsByTimestamp: bounded ring buffer`.

Coverage calculations:
- `annotationOccurrences = count(all recognized directives)`.
- `uniqueIdsUsed = count(distinct normalized IDs in source)`.
- `resolvedOccurrences = occurrence with a manifest entry`.
- `unresolvedOccurrences = occurrence without an entry or with invalid syntax, grouped separately`.
- `unusedMappings = manifest refs where occurrencesByRefId[refId] is empty after a complete scan`.
- `invalidNodes = mappings whose remote validation explicitly proves missing/inaccessible; offline is not invalid`.
- `potentiallyStalePreviews = caches invalidated by age, file version or observed MCP mutation`.

## 7. Optional future SQLite logical schema (not MVP)

Do not ship SQLite unless measurement proves in-memory scanning is insufficient. If later needed, tables could be:

```sql
CREATE TABLE workspace_config (
  workspace_hash TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  last_full_scan_at TEXT,
  scan_state TEXT NOT NULL
);

CREATE TABLE design_file (
  workspace_hash TEXT NOT NULL,
  alias TEXT NOT NULL,
  file_key TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  display_name TEXT,
  remote_version TEXT,
  last_modified TEXT,
  last_validated_at TEXT,
  access_state TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, alias)
);

CREATE TABLE design_reference (
  workspace_hash TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  file_alias TEXT NOT NULL,
  node_id TEXT NOT NULL,
  display_name TEXT,
  kind TEXT,
  parent_ref TEXT,
  node_state TEXT NOT NULL,
  PRIMARY KEY (workspace_hash, ref_id),
  FOREIGN KEY (workspace_hash, file_alias) REFERENCES design_file(workspace_hash, alias),
  FOREIGN KEY (workspace_hash, parent_ref) REFERENCES design_reference(workspace_hash, ref_id)
);

CREATE TABLE annotation_occurrence (
  occurrence_id TEXT PRIMARY KEY,
  workspace_hash TEXT NOT NULL,
  ref_id_raw TEXT NOT NULL,
  ref_id_normalized TEXT,
  relative_path TEXT NOT NULL,
  language_id TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  owner_symbol TEXT,
  source_parent_occurrence TEXT,
  scan_confidence TEXT NOT NULL
);

CREATE INDEX occurrence_by_ref ON annotation_occurrence(workspace_hash, ref_id_normalized);
CREATE INDEX occurrence_by_path ON annotation_occurrence(workspace_hash, relative_path);

CREATE TABLE preview_cache (
  cache_key TEXT PRIMARY KEY,
  workspace_hash TEXT NOT NULL,
  file_key TEXT NOT NULL,
  node_id TEXT NOT NULL,
  image_path TEXT NOT NULL,
  image_mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  remote_version_fingerprint TEXT,
  status TEXT NOT NULL
);

CREATE TABLE claude_design_event (
  event_id TEXT PRIMARY KEY,
  workspace_hash TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  file_key TEXT,
  target_confidence TEXT NOT NULL,
  result_state TEXT NOT NULL,
  cache_invalidation TEXT NOT NULL
);
```

Foreign keys and migration implementation must be tested if this optional database is ever adopted. The table design intentionally avoids `token`, raw tool outputs, transcript paths, source contents and signed image URLs.

## 8. Versioning and migration

- Manifest has `schemaVersion`; internal index has `indexVersion`; cache entries have cache schema version.
- On unsupported schema: read-only/diagnostic state, no automatic rewrite.
- On known older schema: produce a migration preview and only write after the user confirms or after an explicitly enabled safe migration policy.
- Cache/index corruption should cause rebuild, not manifest deletion.
- Event spool processing should be idempotent through `eventId` and bounded retention.

## 9. Retention and deletion

- Image cache uses size-bounded LRU plus TTL.
- Hook events retain only the most recent bounded number (initial proposal: 100) or a short configured age (initial proposal: 7 days), whichever is stricter.
- Diagnostic logs are off by default or very short-lived, bounded and redacted.
- Commands required: clear all preview cache, clear a file's cache, clear Claude history/events, forget token, remove hook integration.
- Uninstall cleanup policy must be documented; VS Code may retain global storage after extension uninstall, so provide an explicit cleanup command.
