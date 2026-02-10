# 09 — Implementation Plan and Delivery Roadmap

## 1. Execution strategy

Implement a vertical slice first. Avoid spending weeks on all-language AST support or a polished dashboard before proving that a reference can be resolved and previewed under the user's Figma/VS Code/Claude configuration.

The roadmap is divided into phases with exit criteria. Estimate assumes one experienced developer with TypeScript/VS Code extension skills; team parallelization can shorten calendar time but adds integration overhead. These estimates are planning ranges, not guarantees.

## 2. Phase 0 — research and technical spike (2–4 working days)

### Tasks
1. Review vlint's current source and license; document reusable ideas versus incompatible assumptions.
2. Review Frame2Code's repository/license and identify whether its design fetch, PAT storage or MCP utilities are reusable.
3. Create a minimal VS Code extension command/hover provider.
4. Configure one Figma test file and a granular PAT.
5. Call the Figma node endpoint and render endpoint for a known node.
6. Cache the resulting image in extension global storage and attempt Markdown hover preview.
7. If hover image behavior is poor, prototype the Webview/quick-look fallback.
8. Trigger a real Claude Code Figma MCP read and mutation on a test file, capture sanitized `PostToolUse` payload examples, identify actual tool names and whether file/node ID is visible.
9. Prototype hook event delivery through a local file spool.
10. Confirm one initial language adapter's parser approach.

### Exit criteria
- A written pass/fail matrix for preview, API scopes, hook payload, event delivery and annotation owner resolution.
- A selected preview fallback if hover image is insufficient.
- A fixed annotation grammar and manifest v1 decision.
- A documented license/reuse decision.

Do not proceed into dashboard polish until this gate passes or a fallback is agreed.

## 3. Phase 1 — core model and config (3–5 days)

### Deliverables
- Type definitions and runtime validation for v1 manifest.
- URL parser/builder with unit tests.
- Opaque ID generator/validator with collision check.
- Config loader supporting canonical YAML and explicit `${env:NAME}` interpolation.
- File alias/node ID resolver.
- Manifest diagnostics and non-destructive reload.
- Sample repository and fixture data.

### Acceptance gate
- Valid/invalid manifest test corpus passes.
- IDs normalize and are unique; collision fixtures regenerate.
- Figma URL variants normalize to the same `(fileKey,nodeId)` where appropriate.
- PAT is not present in any config/sample/example.

## 4. Phase 2 — annotation discovery and mapping index (4–7 days)

### Deliverables
- Language adapter interface.
- Comment-token discovery that doesn't match inside strings.
- First confirmed language adapter(s).
- Incremental scanning and workspace excludes.
- Occurrence-to-ref index and hierarchical source symbol association.
- Diagnostics for malformed/unresolved/unused refs and incomplete scans.
- CLI/test harness for manifest+source fixtures.

### Required decision before phase
Owner must choose which concrete languages constitute MVP. “Multi-language” is an architectural requirement; it is not a specific testable initial coverage list. Recommended first set for a developer-oriented UI tool is TypeScript/JavaScript plus Dart, then Python and one systems language (Rust or Go) based on actual target users. This is a recommendation, not silently imposed scope.

### Acceptance gate
- Source strings and comments behave correctly.
- Nested fixtures produce correct parent/owner associations for supported adapters.
- Unsupported language returns a clear limitation, never a falsely precise hierarchy.
- “Unused” is not computed when scan is partial.

## 5. Phase 3 — Figma REST client and preview system (4–6 days)

### Deliverables
- SecretStorage-backed PAT lifecycle commands.
- Figma API client for metadata, targeted node retrieval and rendering.
- Cancellation/timeouts/retry/backoff and request coalescing.
- Preview cache with version/freshness status and bounded LRU.
- Hover content and quick-look fallback.
- Open-in-Figma URL command.
- Error taxonomy and offline behavior.

### Acceptance gate
- Preview maps to exact node, not just file thumbnail.
- No network in synchronous hover provider.
- 401/403, 404/null render, 429, timeout/offline all produce useful states.
- Cache hit and invalidation tests pass.

## 6. Phase 4 — extension dashboard and editor affordances (4–7 days)

### Deliverables
- Activity Bar/TreeView or Explorer view.
- Overview counts and actionable status groups.
- Navigation from list → source line / Figma node.
- Context menus for copy/open/refresh.
- Rescan/config validation/cache clear commands.
- Optional CodeLens and diagnostics.
- Theme/high-contrast/accessibility implementation.

### Acceptance gate
- Counts match reference fixture workspaces.
- Large index does not block editor or flicker on each keystroke.
- Empty/error/incomplete states are understandable.

## 7. Phase 5 — Claude mapping bridge and hook refresh (4–7 days)

### Deliverables
- Read-only MCP server with tools listed in the integration document.
- Setup/test/remove commands or a setup guide for Claude Code.
- Project instruction snippet/rules file offered non-destructively.
- Opt-in hook installer/config generator.
- Sanitized event schema and local event receiver/spool.
- Claude Activity dashboard section and preview invalidation policy.

### Acceptance gate
- Claude correctly resolves known reference and rejects unknown ID.
- PAT is unavailable to MCP process and never returned in tool schema/output.
- Actual read and mutation operations tested with official Figma MCP.
- Failed/unknown tool operation does not cause false “design updated” success claim.
- Hook integration can be cleanly removed.

## 8. Phase 6 — hardening, documentation and release (4–7 days)

### Deliverables
- Unit, integration, extension-host, security, portability and performance tests.
- CI build, lint, typecheck, schema verification and VSIX packaging.
- README, quickstart, architecture guide, troubleshooting, privacy policy and license.
- Release notes, changelog and issue templates.
- Test on macOS, Windows and Linux if these are advertised as supported.
- Marketplace/package preflight and dependency/license review.

### Release gate
All P0 requirements from PRD pass. Known limitations are documented. No unresolved critical/high security defect. Preview fallback is verified on supported VS Code builds.

## 9. Milestone sequence

| Milestone | Output | Estimated elapsed range |
|---|---|---|
| M0 Spike | Feasibility results + architecture decision | 2–4 working days |
| M1 Local reference model | Config, ID generator, URL parser | 3–5 more days |
| M2 Source mapping | Initial adapters, index, audit diagnostics | 4–7 more days |
| M3 Preview navigation | Figma client, hover/quick-look, cache | 4–6 more days |
| M4 Dashboard | Main views, filters and actions | 4–7 more days |
| M5 Claude integration | MCP resolver + event hooks | 4–7 more days |
| M6 Release candidate | Security and QA hardening | 4–7 more days |

Total rough range: ~4–7 weeks for a solo developer with scope held to the defined first adapters and existing Figma viewer. Broad multi-language adapters and future platforms are additional scope.

## 10. Suggested issue/work-package hierarchy

### Epic A — Manifest and identifiers
- A1 define JSON Schema.
- A2 YAML parser and env resolver.
- A3 Figma URL normalizer/builder.
- A4 opaque ID generator/collision check.
- A5 manifest migration/diagnostics.

### Epic B — Source indexing
- B1 adapter interface.
- B2 generic comment discovery/tokenization.
- B3 first language adapter.
- B4 second language adapter.
- B5 incremental workspace scan.
- B6 hierarchy and reference coverage.
- B7 diagnostics and ignores.

### Epic C — Figma API and preview
- C1 PAT SecretStorage commands.
- C2 metadata and node APIs.
- C3 render and cache.
- C4 hover preview.
- C5 quick-look fallback.
- C6 stale/invalidation semantics.
- C7 network/rate-limit handling.

### Epic D — IDE product experience
- D1 Activity Bar/TreeView.
- D2 summary dashboard.
- D3 source/Figma navigation.
- D4 CodeLens/hover interactions.
- D5 accessibility/theme QA.

### Epic E — Claude
- E1 read-only MCP resolver.
- E2 Claude setup diagnostics.
- E3 instructions/rules snippet.
- E4 PostToolUse hook event parser.
- E5 event spool/receiver.
- E6 refresh/invalidation.
- E7 Claude Activity view.

### Epic F — release and safety
- F1 automated tests.
- F2 credential redaction tests.
- F3 dependency/license audit.
- F4 packaging/publishing.
- F5 docs, privacy policy and troubleshooting.

## 11. Working method

- Deliver short pull requests behind feature flags where appropriate.
- Use fixtures for Figma API outputs and Claude hook payloads; refresh fixtures intentionally when official schemas/tool names evolve.
- Keep all API and parser code covered with deterministic tests.
- Don't store live tokens, private design fixtures or real session transcript data in Git.
- Run Figma network integration tests explicitly/manual if API access cannot be present in CI.
- Avoid testing only with the project owner's sample design; include a frame, a nested component, a missing node and a non-renderable node.

## 12. Scope control rules

Do not add a Figma plugin, browser extension, hosted backend, visual diff system, code generator, code auto-fixer, or team analytics before MVP release unless discovery shows a hard blocker. New language adapters are acceptable if they reuse the same manifest and tests, but each adapter must state its nesting-accuracy guarantees.
