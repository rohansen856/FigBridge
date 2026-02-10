# 13 — Open Questions, Blocking Decisions and Risks

This document intentionally distinguishes **blocking before implementation** from decisions that can be resolved after the first spike. The owner asked not to silently assume unspecified details; the spec therefore uses safe defaults but flags where confirmation is required.

## 1. Blocking decisions before full MVP implementation

### BQ-1 — Which concrete languages are supported in the first release?

“Multi-language” is confirmed, but not the initial language list. An adapter architecture does not by itself define what can be tested and shipped.

**Recommendation:** TypeScript/JavaScript plus Dart in the first public beta because these cover web and Flutter; add Python and Rust or Go after the adapter interface proves stable. This is only a recommendation and must be confirmed by the product owner.

**Why blocking:** AST/library choices, fixture suite, nesting semantics, source annotations and release claims depend on actual language scope.

### BQ-2 — Is Figma PAT acceptable for a public extension, or only personal/local use?

The owner selected PAT. Figma recommends OAuth for an app acting on behalf of multiple users; PAT suits personal scripts/local tooling and can grant access as the generating user, within scopes and Figma permissions.

**Recommendation:** Keep PAT for personal/local MVP, but do not publish widely until token handling, scope behavior, Figma terms and whether OAuth should be added are reviewed.

**Why blocking for public release:** authentication UX, app distribution, privacy policy and per-user governance differ substantially.

### BQ-3 — Must preview be inside the hover, or is a hover thumbnail plus quick-look fallback acceptable?

The owner chose image preview, not an interactive embed. The extension should try Markdown image hover and provide a dedicated preview view. The exact hover rendering reliability must be validated in current VS Code builds.

**Recommendation:** Accept small image in hover with a clear quick-look fallback. Do not block release on a large image rendered entirely inside the hover if VS Code constrains it.

**Why blocking before implementation:** the spike determines the preview component boundary and cache delivery mechanism.

### BQ-4 — What is the required minimum Claude Code version/platform matrix?

The project needs hooks and an MCP server. Hook fields/matchers and MCP config workflows should be tested against a defined set of Claude Code versions and operating systems.

**Recommendation:** Define minimum version only after a real test on the owner's current install; keep hook support optional so core extension can run without Claude.

**Why blocking before hook implementation:** event schema, config generator, installer and clean-up behavior depend on the supported version.

## 2. Important but non-blocking decisions

### NQ-1 — Exact initial opaque ID length/alphabet

Proposed 12-character Crockford Base32/60-bit ID. Confirm during Phase 0; if accepted and committed, keep stable for schema v1.

### NQ-2 — Dashboard native view vs. Webview

Recommendation: native TreeView for navigation + small Webview for overview/thumbnails if needed. Not blocking because a Webview can be introduced behind the same core model.

### NQ-3 — Event transport

Recommendation: bounded local event spool first, avoid localhost listener. A per-platform IPC option can replace it if testing exposes reliability/permission issues.

### NQ-4 — Does the product need a CLI?

Recommendation: a small CLI is useful for ID generation, manifest validation and CI checks, but not required for the first editor-only vertical slice. A CLI can share the core package.

### NQ-5 — Public open-source license and naming

Working name “FigBridge” is provisional. Confirm extension/project name, publisher identity, license, trademark/branding guidance and public distribution plan before publishing.

### NQ-6 — Maximum workspace/reference scale

Current design targets ~10,000 annotation occurrences and ~2,000 unique mappings. If expected workspace is larger, performance design should be benchmarked earlier. This is a target, not a proven limit.

### NQ-7 — Explicit parent mapping field

The spec allows optional `parentRef`, while source syntax and Figma metadata provide their own hierarchies. Confirm if users need manual logical hierarchy beyond these inferred relationships.

## 3. Risks and mitigations

| Risk | Probability / impact | Mitigation |
|---|---|---|
| Similar product already covers more than research found | Medium / Medium | Recheck Marketplace, GitHub and current product documentation before naming/launch; differentiate on exact defined gap. |
| Hover image preview doesn't render consistently | Medium / High | Phase 0 spike; quick-look Webview fallback; return immediate hover status and async update. |
| Official Figma extension exposes no programmatic exact-node navigation | High / Medium | Use direct canonical HTTPS links and optional Dev resources; don't use private API. |
| Figma PAT access or expiration limits use | Medium / High | Minimal scopes, SecretStorage, expiry UX, OAuth review for public distribution. |
| Figma API rate limit/network instability | Medium / Medium | Cache, request coalescing, backoff, lazy render, offline state. |
| Figma node changed/deleted | Medium / Medium | Exact node validation; stable opaque ID with explicit retarget/migration, no name guessing. |
| Multi-language hierarchy quality is uneven | High / High | Named adapters, confidence labels, per-language tests, no universal-regex promise. |
| Claude tool names/output shapes change | High / Medium | Hook schema fixtures, version test matrix, unknown-operation fallback, configurable namespace filter. |
| Hook event misses node ID | Medium / Medium | File-level invalidation or “possibly stale” fallback; manual refresh. |
| Extension observes but cannot confirm Figma mutation is persisted | Medium / High | Event only invalidates; actual preview refresh/API read confirms current output. |
| Image cache exposes private design content | Low/Medium / High | Local storage only, bounded retention, no telemetry, clear cache, no Git artifact. |
| Scope expands to Figma plugin/browser extension too early | High / High | MVP VS Code only; separate phase gate and ADR. |
| Code/license copied from a precedent incorrectly | Low/High | Review license, attribution, dependency notices and compatibility before reuse. |
| User expects IDs to hide design/file links | Medium / Medium | Documentation states IDs are opaque identifiers, not encryption/access control. |

## 4. Product questions not to confuse with blockers

The following aren't blocking because the spec has a safe default:
- **Do annotations need raw links?** No, canonical form is opaque ID; command can copy a full URL when requested.
- **Can the Figma base URL be hardcoded?** Yes, or a supported environment placeholder can be used.
- **Does every mapped node need to be a component?** No; screens, frames, sections or nested nodes may be referenced.
- **Should a Figma node with no code annotation be called unused?** Not by default; dashboard only calls configured refs without source usages “unused in code”.
- **Should Claude have edit permissions via FigBridge?** No. FigBridge MCP is read-only for MVP; the official Figma MCP handles writes under the user's own auth.
- **Should the browser extension be in MVP?** No, phased plan puts VS Code first.
- **Does mapping need a cloud database?** No.

## 5. Research/technical validation checklist

Before first implementation PR:
- [ ] Inspect current vlint source repository and LICENSE; record reuse/no-reuse decision.
- [ ] Inspect Frame2Code source/license and package architecture.
- [ ] Test current Figma render API with `file_content:read`; verify image hover UX.
- [ ] Test `file_metadata:read` usage only if metadata endpoint is included.
- [ ] Generate an expiring PAT and verify replacement flow (Figma currently documents maximum expiry for new PATs as 90 days; recheck at release).
- [ ] Capture sanitized actual Claude Figma MCP read and mutation hook payloads.
- [ ] Decide supported Claude Code versions and OS hook support.
- [ ] Choose initial source language adapter list.
- [ ] Confirm current Figma plan/seat access for official VS Code extension and any needed API/Code Connect features.
- [ ] Confirm license/name/privacy policy before public extension publishing.

## 6. Final recommendation

Proceed, but start with the technical spike and explicit decisions above. The risk is not the core mapping/preview idea—it is overpromising universal language hierarchy, hover behavior, or real-time Claude/Figma sync before validating the relevant interfaces. Build the stable manifest/reference core first and keep viewer/platform expansions behind separately testable APIs.
