# 02 — Technical Requirements Document (TRD)

## 1. Technical summary

FigBridge should be implemented as a VS Code extension written in TypeScript. The extension host is responsible for local source indexing, Figma REST calls, SecretStorage, preview caching, and UI commands. A small local MCP server/process can reuse the same core package so Claude Code can resolve references without needing a VS Code command at each tool call. The extension must not require a cloud backend.

### Proposed repository layout

```text
figbridge/
├── packages/
│   ├── core/                   # Manifest, IDs, normalization, diagnostics, types
│   ├── parser-core/            # Comment scanner and adapter interfaces
│   ├── adapters/               # Language-specific association adapters
│   ├── figma-client/           # REST calls, retries, render URLs, normalization
│   ├── indexer/                # Workspace scan and source-reference graph
│   ├── cache/                  # Preview/metadata cache interfaces + local impl
│   ├── mcp-server/             # Read-only Claude mapping tools/resources
│   ├── hook-receiver/          # Sanitize and record Claude tool events
│   └── vscode-extension/       # Activation, hover, TreeView, commands, Webview
├── schemas/
│   └── figma.design.schema.json
├── docs/
├── examples/
├── test-fixtures/
└── package.json / pnpm-workspace.yaml / tsconfig.base.json
```

A monorepo is proposed to share types and behavior without coupling the core package to VS Code. A simpler single-package project is acceptable for an individual prototype, provided the modules retain boundaries and the MCP code can be run separately. Package manager and monorepo tooling are implementation choices to confirm; pnpm is a reasonable default.

## 2. Logical architecture

### 2.1 Extension host

Responsibilities:
- Discover workspace and config path.
- Read/write nonsecret user-facing config and local generated indexes.
- Obtain and use PAT only through VS Code `SecretStorage`.
- Register hover, CodeLens, commands, TreeView and optional Webview.
- Coordinate debounced scanning, preview fetches, cache invalidation and cancellation.
- Receive sanitized Claude bridge events and update the dashboard.

It MUST NOT:
- Send all source files to Figma or a FigBridge service.
- expose tokens to a Webview or MCP tool.
- block the UI thread with file parsing, YAML processing, HTTP requests, or image processing.
- assume the existing Figma extension's private command IDs, storage, internal APIs or session.

### 2.2 Core package

Pure logic with no VS Code imports:
- Opaque ID validation/generation.
- Manifest model, parser and validation.
- Figma URL parser/builder.
- Annotation tokenization and normalized occurrence records.
- Mapping registry, coverage/status calculators, source hierarchy and diagnostics.
- Claude MCP DTOs and event schema.

This boundary permits CLI checks/tests and future Figma/browser clients without inheriting VS Code runtime dependencies.

### 2.3 Figma REST client

Use the documented Figma REST API for metadata, node JSON and rendering. Relevant endpoints include:
- `GET /v1/files/:key/meta` for lightweight file metadata (scope `file_metadata:read`).
- `GET /v1/files/:key/nodes?ids=...` for the requested node/subtree (scope `file_content:read`).
- `GET /v1/images/:key?ids=...&format=png&scale=...` to obtain rendered image URLs (scope `file_content:read`).

The API document says rendered-image URLs expire after 30 days. Do not treat them as permanent identifiers. Use node IDs normalized to API format (`1:2`) in requests and hyphenated IDs in the Figma web URL query (`node-id=1-2`). See [Figma file endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/).

Implementation requirements:
- Use HTTPS only and fixed `https://api.figma.com` origin.
- Set `X-Figma-Token` only on API requests; never log headers.
- Use explicit timeouts, cancellation and bounded retry with jitter for transient network errors and 429/5xx responses.
- Do not retry 401/403/404 indefinitely.
- Coalesce concurrent requests for same `(fileKey,nodeId,format,scale)`.
- Limit images and node JSON to configured IDs and reasonable response sizes.
- Avoid requesting full file JSON unless required; default to targeted nodes.
- Preserve API response `lastModified`/`version` if supplied for cache invalidation.
- Treat `null` render result as a distinct “not renderable/not found” condition.
- Show API quota/rate-limit status when supplied, but don't invent exact reset times.

### 2.4 Source scanner and adapters

The annotation grammar is comment-based and language-neutral. However, nesting semantics are language-specific. Use a two-stage pipeline:

1. **Lexical candidate scan:** discover comment tokens and look for annotation directives only inside actual comments, never matching string literals.
2. **Language adapter:** resolve the comment to a source range and, where supported, the nearest declaration/AST node and enclosing annotated parent. Each adapter returns normalized ranges and hierarchical ownership.

The extension MUST NOT implement universal nested-component semantics through one regex. It may fall back to “file-level / symbol unknown” with a warning when the language adapter is missing. A third-party parser such as Tree-sitter could broaden support, but licensing, native/WASM build size, grammar maintenance and error recovery must be evaluated before adoption.

Adapter interface (illustrative):

```ts
interface LanguageAdapter {
  readonly id: string;
  readonly languageIds: readonly string[];
  scan(document: SourceDocument, cancellation: CancellationToken): Promise<AnnotationOccurrence[]>;
  resolveOwner?(document: SourceDocument, commentRange: Range): Promise<SymbolOwner | undefined>;
  resolveParent?(document: SourceDocument, owner: SymbolOwner): Promise<SymbolOwner | undefined>;
}
```

Normalized occurrence records should contain URI/path, start/end position, raw ID, directive type, enclosing symbol (if any), parent symbol/ref (if resolved), adapter name, and scan confidence/status.

### 2.5 Indexing lifecycle

- On activation, load configuration; show dashboard immediately with local data and “sync pending” state.
- Scan open workspace files in the background using include/exclude globs and VS Code's workspace file APIs.
- Prefer open editor buffers over disk content to avoid stale indexing.
- Debounce file changes; cancel superseded work.
- Incrementally rescan changed files, but use full scan after manifest format/version change, adapter change, or command.
- Never scan `node_modules`, `.dart_tool`, `build`, `dist`, `.git`, generated outputs, package/vendor caches unless explicitly included.
- Keep partial scan state when a language adapter fails; dashboard must say scan is incomplete rather than report a falsely complete “unused” result.

### 2.6 Dashboard presentation

Use a native TreeView for efficient navigable groups and may use a Webview for a richer dashboard/thumbnail list. If Webview is used:
- Restrict `localResourceRoots`.
- Use a strict CSP; no inline script/eval.
- Sanitize all data rendered in HTML.
- use message allowlists and validate payloads from `postMessage`.
- Do not pass PATs or unneeded raw source snippets into the Webview.

Official [VS Code Webview guidance](https://code.visualstudio.com/api/extension-guides/webview) specifically recommends limiting capabilities, restrictive resource roots, CSP and input sanitization.

## 3. Hover image rendering design

### 3.1 Desired behavior

Hover over the ID token or recognized adjacent annotation. If the mapping resolves, display:
- a rendered thumbnail of the exact mapped node;
- the Figma file and node display names;
- stale/cache status where useful;
- a “Open in Figma” action or a command reference accessible without relying on unsupported hover buttons;
- clear errors for unknown ID, missing PAT, inaccessible file, missing node or render failure.

### 3.2 Implementation strategy

1. On hover, synchronously resolve the annotation ID from the in-memory index; return local cached metadata immediately if possible.
2. If a fresh thumbnail exists in extension global storage, form Markdown content with a supported image URI/path or provide a quick-look command.
3. If uncached, return informative loading content immediately and start an async render request. Refresh hover/provider content when the image arrives, subject to VS Code UX behavior.
4. Use a preview Webview/quick-pick command as the robust fallback if the hover implementation cannot show a useful image consistently across VS Code platforms/builds.
5. Cache binary image content in `globalStorageUri`; do not store authenticated headers or the PAT with it.

A key validation spike is required: a remote Figma render URL and/or locally cached image must actually display in a VS Code Markdown hover at useful dimensions under current VS Code security/resource rules. The hover API's limitations mean the product must not make its entire UX depend on a large interactive embedded canvas.

### 3.3 Cache policy

Cache key: SHA-256 of `fileKey + nodeId + format + scale + fileVersion/lastModified fingerprint`.
Cache record: content path, dimensions (if determined), observed file metadata/version, createdAt, lastValidatedAt, expiresAt, byte size, fetch status.

- Default policy: metadata cache 15 minutes; rendered image cache 24 hours for proactive freshness, with manual override. Returned Figma image URLs can live longer but should not be trusted as permanent references.
- After observed MCP mutation: invalidate previews for identified nodes; otherwise invalidate entries for relevant configured Figma file(s).
- If version/lastModified changed: invalidate affected file's node previews conservatively.
- Cap total storage (initial suggestion 250 MB, configurable) with least-recently-used eviction.
- Use atomic temp-file writes and validate file content before reuse.
- Clear cache command and per-file cache invalidation command required.

## 4. URL normalization

Accepted input should include a Figma design URL with or without `node-id`. Parser responsibilities:
- Validate host is an allowed Figma host and URL scheme is HTTPS.
- Extract file type, file key and optional file slug.
- Parse `node-id=0-1` or `node-id=0%3A1` to canonical node ID `0:1`.
- Ignore nonessential UI/tracking query keys (`p`, `t`, `scaling`, etc.) for reference identity.
- Preserve only allowed canonical link attributes needed to open the right file/node.
- Reject arbitrary hosts, malformed file keys and node IDs before any API call.
- Keep a file's canonical base URL separate from a particular node URL.

The example base file URL in the request includes volatile `p` and `t` parameters. FigBridge should normally store a normalized base such as `https://www.figma.com/design/<fileKey>/<slug>` and build per-node URLs with `?node-id=<hyphenatedNodeId>`. It should not need or preserve a Figma session/tracking parameter to resolve a node.

## 5. Local persistence

- User secret: VS Code SecretStorage, key namespaced by extension and workspace/file identity as appropriate.
- Canonical project config: `figma.design.yaml` committed to Git.
- Optional `.env`: read only explicit allowlisted non-secret configuration variables; document `.gitignore` hygiene. The extension MUST NOT execute shell interpolation or arbitrary dotenv expansion.
- Generated source index: memory + optionally `globalStorageUri` cache; recomputable.
- Preview images and HTTP metadata: extension global storage, not project folder by default.
- Hook event spool: `.figbridge/events/` or extension storage, local and gitignored; schema-validated and size-limited. The exact transport should be selected during implementation spike; the default proposal is local per-workspace event files to avoid exposing a listening network port.

## 6. Claude integration architecture

Two separate integration responsibilities must stay distinct:

**A. Context bridge:** a small read-only MCP server exposes mapping tools/resources. It reads the versioned project manifest and may ask the same core resolver to identify the annotation's source location. Claude can resolve an opaque ID before invoking Figma's official MCP. It must not expose PATs or pretend cached metadata is live design state.

Suggested tools:
- `figbridge_list_refs(query?, fileAlias?, status?, limit?)`
- `figbridge_resolve_ref(refId)`
- `figbridge_find_refs_for_source(path, symbol?)`
- `figbridge_get_file_summary(fileAlias)`
- `figbridge_get_preview_metadata(refId)` (metadata/link/cache state only by default; optionally image URL if safe and useful)

Responses should be compact, versioned and deterministic. Unknown IDs return `found: false` and possible near matches are not auto-applied. Source code snippets are not returned unless explicitly requested, and tokens are never present.

**B. Change-event bridge:** an opt-in Claude Code `PostToolUse` hook observes tool name/input/output, filters likely Figma MCP calls, and writes a sanitized event for the extension. The event triggers status update and cache invalidation. It must not modify, block or replace Figma tool results in the MVP. Claude's hook payload shapes/tool names must be validated on the user's installed Claude Code version.

Official references: [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) and [Figma MCP introduction](https://developers.figma.com/docs/figma-mcp-server/).

## 7. Error taxonomy

| Code | Condition | User-visible behavior |
|---|---|---|
| `CONFIG_NOT_FOUND` | No manifest | Offer initialize command; no remote calls |
| `CONFIG_INVALID` | YAML/schema issue | Explain path/line where available; don't discard the user's file |
| `ENV_VAR_MISSING` | File URL placeholder missing | Show variable name and config location; never print other env values |
| `PAT_NOT_CONFIGURED` | No PAT in SecretStorage | Prompt for secure token entry |
| `PAT_INVALID_OR_EXPIRED` | Figma returns 401/403 | Offer token replacement, explain scope/access may be insufficient |
| `FILE_UNAVAILABLE` | File 404/forbidden | Do not guess a replacement file; show configured alias |
| `NODE_NOT_FOUND` | Node absent/null | Mark mapping invalid; open file link if possible |
| `RENDER_FAILED` | Figma image map null/HTTP failure | Text fallback and open-in-Figma action |
| `NETWORK_UNAVAILABLE` | Timeout/offline | Use cached preview; mark offline/stale |
| `RATE_LIMITED` | HTTP 429 | Backoff, coalesce request, show delayed refresh status |
| `UNRESOLVED_REF` | ID absent from config | Dashboard diagnostic; don't infer based on name |
| `ADAPTER_UNAVAILABLE` | Unknown language/AST issue | Show file-level or unknown owner, not a false hierarchy |
| `HOOK_EVENT_INVALID` | Malformed event | Ignore safely and emit redacted diagnostic |
| `HOOK_NOT_CONFIGURED` | No Claude hooks | Explain integration is not installed; core features still work |

## 8. Performance budgets

The following are target budgets to verify, not claims about measured performance:
- Cached lookup and metadata resolution: p95 below 100 ms.
- Hover provider response: p95 below 100 ms; never wait for Figma network request inside provider.
- Manifest parse for 2,000 refs: below 100 ms on a representative development laptop.
- Incremental scan of one modified source file: below 50 ms for typical files, excluding heavy parser warm-up.
- Full scan of 10,000 occurrences: target under 3 seconds after adapters are initialized; benchmark and optimize if this fails.
- Dashboard status recomputation: p95 below 250 ms after index update for 2,000 unique references.
- No repeated API call per pointer movement: preview requests are deduplicated and cached.

## 9. Dependencies and technology recommendations

- TypeScript and VS Code Extension API.
- YAML parser with safe schema validation (no custom tag execution).
- JSON Schema for `figma.design.yaml`.
- Figma REST client using built-in or maintained HTTP support; avoid leaking default request logs.
- VS Code SecretStorage for credentials.
- Adapter-specific parsers chosen after verifying licenses and support matrices.
- MCP SDK version compatible with current Claude Code; pin/test compatible versions.
- Test frameworks for unit, integration and VS Code extension-host tests.

Exact versions are intentionally not pinned in this requirements document; dependency selection and current compatibility are an implementation-time check.

## 10. Technical acceptance gate

Before feature development begins, prove with a small spike that:
1. One Figma PAT can query a target node and request a render under minimum scopes.
2. The render can be safely cached and displayed via the desired hover UI or fallback.
3. A Claude Code hook receives a real Figma MCP `PostToolUse` payload and the hook matcher/filter can distinguish relevant operations.
4. The actual source annotations can be associated with declaration ranges for at least one language without false matches in string literals.
