# 12 — Architecture Decision Records (ADRs)

Each ADR records the current decision, context, alternatives, consequences and status. These are decisions for the specification baseline; any change during implementation should be recorded with rationale and migration impact.

## ADR-001 — Local-first with no backend for MVP

**Status:** Accepted.

**Context:** Core workflow runs in the developer's workspace. Centralized mapping sync is not a stated first-release requirement. A hosted service would add auth, deployment, tenancy, privacy and operational cost.

**Decision:** Store canonical mappings in `figma.design.yaml` in Git. Keep indexes, preview binaries and event state in VS Code global storage / bounded local spool. No service/database required for MVP.

**Alternatives:** Hosted database; SQLite as primary source; remote team service.

**Consequences:** Works offline for local mapping, naturally reviewable in code review and shares mappings through Git. A team that wants centralized cross-repository inventory will need a future opt-in service or repository aggregation command. Runtime caches are rebuildable.

## ADR-002 — Manifest is the source of truth

**Status:** Accepted.

**Context:** Inferring a mapping from class names or selection URLs leads to ambiguous resolution and breaks when names change. A registry is necessary for dashboard counts and Claude.

**Decision:** `figma.design.yaml` stores file aliases and ID → file/node mappings. The runtime index is generated and never authoritative.

**Consequences:** Developers must add/maintain entries; validation detects drift. Git can review mapping changes. The extension must provide useful create/repair actions to reduce manual YAML maintenance.

## ADR-003 — Twelve-character opaque ID, not encryption

**Status:** Accepted provisionally; confirm in Phase 0.

**Decision:** Generate 12-character uppercase Crockford Base32 references from a secure random source, with manifest collision check.

**Alternatives:** Raw Figma URLs in comments; encrypted node IDs; hash-derived deterministic IDs; incremental IDs.

**Rationale:** Short, stable, human-transcribable and no key management. The manifest handles resolution. Deterministic hash IDs would leak relationship patterns and cause painful rename/migration semantics; encryption gives no secrecy once the manifest is available.

**Consequences:** IDs need an explicit generator and collision validation. They cannot be used as authorization, access tokens or redaction mechanism.

## ADR-004 — Use existing Figma viewer and official MCP

**Status:** Accepted.

**Context:** The project owner already uses Figma for VS Code and official Figma MCP through Claude Code.

**Decision:** FigBridge provides navigation/reference logic and a small image preview, but does not rebuild the whole viewer or try to read private session state. Claude uses official Figma MCP for live design operations.

**Alternatives:** Embedded custom Figma canvas; own MCP that duplicates Figma design extraction; private APIs into official extension.

**Consequences:** Lower engineering burden and fewer terms/security risks. Some navigation into the exact tab/pane of the existing viewer cannot be promised without a documented public API; direct HTTPS open is the fallback.

## ADR-005 — Figma REST API for previews; PAT stored in SecretStorage

**Status:** Accepted for personal/local MVP; revisit for public multi-user distribution.

**Context:** Preview should show a rendered exact node. Figma REST provides targeted node metadata and render endpoints. The owner chose PAT auth.

**Decision:** Use documented REST endpoints with granular scopes, send token through `X-Figma-Token`, and store it via VS Code SecretStorage.

**Consequences:** Per-user PAT expiry and rotation are needed. PAT is user-bound and can be broad; public distribution to many users may eventually justify an OAuth app. FigBridge does not reuse OAuth/session credentials from the official Figma extension.

## ADR-006 — YAML manifest with environment substitution

**Status:** Accepted.

**Decision:** Canonical file is `figma.design.yaml`; direct URL or allowlisted `${env:FIGMA_FILE_URL}` placeholder is supported. The config schema does not permit a PAT.

**Consequences:** Human-readable Git diff and multiple file aliases. Env interpolation needs explicit syntax and allowlist. Do not execute expressions/shell syntax or indiscriminately load all `.env` values into the UI.

## ADR-007 — Multi-language adapters, bounded support declaration

**Status:** Accepted; initial adapter roster remains open.

**Context:** Language-neutral comment grammar is possible, but accurate owner and nesting resolution depends on syntax.

**Decision:** Separate generic annotation grammar from per-language adapters. Scanner can detect refs generically where comments are lexed, but hierarchy confidence is labelled and only asserted when syntax association is supported.

**Alternatives:** Universal regex; implement every language up front; start with a single framework and no extension point.

**Consequences:** More architecture and test maintenance than a one-language tool, but no core manifest migration when adding languages. Release notes must list adapter quality/limitations.

## ADR-008 — Rendered image hover plus quick-look fallback

**Status:** Accepted.

**Context:** User selected image preview. VS Code hover is useful but constrained; asynchronous network calls cannot block hover creation.

**Decision:** Attempt local cached image in hover; always implement a Preview Reference command that can open a larger Webview/quick-look. The Webview is not an interactive Figma viewer.

**Consequences:** A failed hover image path does not make the product unusable. Preview UI has to respect CSP/remote image policy and not leak private content.

## ADR-009 — Claude context bridge and hook events are independent

**Status:** Accepted.

**Decision:** A read-only local FigBridge MCP server resolves local annotations. An opt-in `PostToolUse` hook emits sanitized event records for change observation. The mapping MCP server does not need the PAT; official Figma MCP does not need FigBridge's local state to work.

**Consequences:** More setup than a comments-only extension, but each responsibility is explicit. If one integration is unavailable, the rest of FigBridge still works. Hook payload/tool namespace compatibility needs versioned integration tests.

## ADR-010 — Local event spool before network listener

**Status:** Accepted provisionally; implementation spike can change it.

**Context:** Hook runs as an external process; extension host runs separately. A local HTTP server introduces port, authentication and origin considerations.

**Decision:** Prefer a bounded per-workspace event spool that VS Code watches. Validate path, schema and event sizes; store only sanitized event fields.

**Alternatives:** Unix socket/named pipe; loopback HTTP with random token; custom URI handler.

**Consequences:** Simpler cross-process communication, but event cleanup and file permissions must be handled. If the spool proves unreliable or unsuitable on a supported platform, revise ADR with an IPC option.

## ADR-011 — No browser extension / Figma Dev Mode plugin in MVP

**Status:** Accepted.

**Context:** VS Code is the primary development environment and includes the code index, SecretStorage and commands. Figma/browser plugins cannot access arbitrary local files without a bridge.

**Decision:** Build and validate VS Code first. Maintain shareable manifest/ID rules so future clients can reuse them.

**Consequences:** Fewer platforms to test and secure. Future browser/Dev Mode products will need explicit communication/auth APIs and a separate flow design.

## ADR-012 — Do not include visual fidelity linting in MVP

**Status:** Accepted.

**Context:** vlint already addresses Figma-vs-React styling validation. Cross-framework layout normalization and visual comparison significantly expand scope.

**Decision:** Focus on navigation, preview, mapping health and agent context. Visual mismatch analysis, token validation or code auto-fix is out of scope.

**Consequences:** A future product can integrate with visual lint tools without competing in that category. Users should not expect FigBridge to assert that code matches the design pixel-for-pixel.

## ADR-013 — In-memory index before SQLite

**Status:** Accepted.

**Decision:** Keep source/config index in memory and optionally write a cache file for warm start. Use bounded image/event cache. Add SQLite only if performance testing demonstrates that in-memory/index-file architecture is insufficient.

**Consequences:** Fewer dependencies and migration burden. Index rebuild must be performant and incremental.
