# 01 — Product Requirements Document (PRD)

## 1. Document purpose

This PRD defines the user-facing behavior of FigBridge, a working-name local-first Figma-to-code companion for VS Code. It turns the product owner's concept into testable requirements while separating MVP scope from future integrations. Unless otherwise marked, requirements apply to the first public usable release.

## 2. Problem statement

Developers implementing UI often need to move repeatedly between a source file and Figma. Direct URLs in comments are easy to start with but become noisy, are difficult to audit, and do not give a team a unified view of which screens/components have designs, which references are unresolved, or which mappings have become stale. Figma viewing in an editor and Figma MCP provide design access, but neither automatically builds the repository-specific index of opaque code annotations required here.

AI agents introduce a related gap: Claude Code may read or change a Figma frame via MCP, but the developer still needs to identify the corresponding source implementation and refresh any preview or status in the editor. The product should reduce this context switching without making a new viewer or an application-specific runtime dependency.

## 3. Product vision

A developer can inspect a code component, see the precise design reference immediately, open the full Figma node, and understand the state of design-code mappings across the repository. Claude can consult the same mapping registry when it works on a screen, and the IDE can show which designs may have changed after Claude's Figma MCP operations.

## 4. Target users and jobs-to-be-done

### Primary: frontend/mobile developer
- “When I open a component, show me the Figma design associated with it without searching the file manually.”
- “When a design reference breaks, tell me where and why.”
- “When I join an existing project, show me which code components have design mappings and which do not.”

### Secondary: AI-assisted developer using Claude Code
- “Give Claude a deterministic way to resolve an opaque annotation into a Figma URL/node and enough metadata to avoid selecting the wrong frame.”
- “After Claude edits Figma through MCP, show me which design references may need a refresh.”

### Secondary: tech lead/design-system maintainer
- “Audit mapping coverage, find unused registry entries, and identify unresolved or invalid design references.”
- “Keep mappings reviewable and shareable through Git rather than a proprietary cloud service.”

### Non-target for MVP
- Nontechnical designers who need a replacement for Figma's canvas.
- Teams needing centralized cross-repository governance, team analytics or a hosted sync service.
- Automated visual fidelity enforcement across arbitrary UI frameworks.

## 5. Goals

1. Make exact Figma frame/component access a one-action operation from code.
2. Offer a rendered image preview on hover over an annotation/reference.
3. Keep code annotations short, opaque, stable and source-controlled.
4. Support a configuration manifest with one or more Figma files and node mappings.
5. Display actionable dashboard metrics for mapping coverage and health.
6. Make mappings available to Claude Code through an explicit integration.
7. Refresh/invalidate preview state after relevant Claude Figma MCP operations.
8. Protect credentials and keep source/design data local except for direct Figma API calls initiated by the user.
9. Create an adapter boundary so language support can expand without replacing the core registry.

## 6. Non-goals

- Rebuilding the Figma viewer or mirroring the official extension's private session.
- Fully rendering interactive Figma canvas controls in a hover popover.
- Automatically generating application widgets from Figma.
- Making code exactly pixel-identical to Figma or replacing a visual regression system.
- Auto-correcting source code to match design values in MVP.
- Editing Figma directly from FigBridge; Claude uses its separately authorized Figma MCP tools.
- A hosted service, shared team database, telemetry by default, or accounts.
- Guaranteed real-time synchronization of all Figma changes.
- Guaranteed AST-accurate hierarchy for every programming language on day one.

## 7. Product scope by phase

### MVP — VS Code local extension
- Workspace configuration discovery and validation.
- PAT entry, validation, replacement and removal using VS Code SecretStorage.
- `figma.design.yaml` parser and schema validation.
- Opaque ID annotation grammar and source scanner.
- First language adapters (exact list gated by owner decision).
- Hover preview and open-in-Figma command.
- Explorer/TreeView plus details/dashboard Webview or native view.
- Counts for occurrences, unique used IDs, unused registry references, unresolved IDs, invalid nodes/files, duplicate declarations and stale cache.
- Preview cache and refresh controls.
- Optional Claude bridge MCP server for resolving/listing IDs and reading mapping context.
- Optional Claude Code hook integration that records a safe event and invalidates likely affected preview entries.
- Clear, nonfatal errors when API access, network, token, node, or render calls fail.

### Later: Figma Dev Mode plugin
- Add/update development-resource links from a selected Figma node to a code location/reference.
- Show the annotation ID and corresponding path in the repository when an accessible local bridge or declared remote-independent metadata is available.
- Must not be required for VS Code use.

### Later: browser extension
- Context-menu action on Figma design pages to copy a code annotation or reference.
- Display mapping state only when the user explicitly connects the page to a local FigBridge host/native messaging bridge.
- No browser access to VS Code SecretStorage or PAT; no PAT copied into page scripts.

### Later: hosted service (only if justified)
- Shared mapping registry, team-level diagnostics, optional authentication and policy controls.
- Requires a new privacy/security review and separate requirements.

## 8. Personas and core user stories

### Story A: annotate a screen
As a developer, I can add `@figma <opaque-id>` in a code comment and map the ID in `figma.design.yaml`, so the link survives refactors and appears in Git review.

Acceptance criteria:
- ID is validated against the configured grammar.
- Missing manifest entries are reported but do not prevent normal coding.
- An existing configured ID maps to one file/node target.
- The annotation does not change runtime behavior or require a language package at runtime.

### Story B: hover and navigate
As a developer, when I hover the annotation or use the Open Design command on the associated component, I see the rendered preview and can open the precise Figma node.

Acceptance criteria:
- Preview displays the mapped node, not merely the whole file thumbnail.
- The preview identifies the node name and file name if known.
- Open action constructs a canonical Figma URL with the right node selected.
- Failed rendering shows a reason and a direct open action.

### Story C: mapping health
As a maintainer, I can open the FigBridge view and see totals and filtered lists of mapped, unresolved, unused, stale and invalid records.

Acceptance criteria:
- Counts distinguish occurrences from unique IDs.
- “Unused” means a registry ID with no current source occurrence in indexed workspace files, not “a Figma component that is unused in every Figma file”.
- Results update after manifest changes, file edits, file create/delete, branch switch and manual rescan.
- Dashboard avoids scanning build output, dependencies and configured excludes.

### Story D: Claude resolves design context
As a developer, I can ask Claude to implement a screen and include `@figma X`, and Claude can resolve X to the correct Figma node, URL, labels, and optional preview metadata through the explicit FigBridge integration.

Acceptance criteria:
- A read-only tool returns normalized metadata and URL, never PAT.
- An unknown ID returns an explicit unresolved result, not guessed mapping.
- Tool docs tell Claude to use Figma MCP for detailed live design context and use the opaque ID only as a deterministic locator.

### Story E: Claude changes a design
As a developer, after Claude invokes a Figma MCP mutation, the extension records an event and marks potentially affected previews stale; it updates displayed preview after a supported refresh.

Acceptance criteria:
- Hook installation is opt-in and documented.
- Event payload is minimized and validated.
- A missed/unknown tool result causes conservative file-level invalidation or an “unable to identify changes” status.
- UI does not claim a change succeeded solely because a hook fired; hook only observes completed tool execution.

## 9. Functional requirements

Priority definition: **P0** release blocker; **P1** important; **P2** later improvement.

### Configuration and manifest
- FR-001 (P0): Discover `figma.design.yaml` at repository root by default; allow an explicit configured path.
- FR-002 (P0): Validate manifest against a versioned schema and report exact file/line when parser supports it.
- FR-003 (P0): Support one or more named Figma files with canonical URL or environment-variable reference.
- FR-004 (P0): Map fixed-length opaque IDs to a file alias, canonical node ID, optional display name/kind and metadata.
- FR-005 (P0): Normalize accepted Figma node URLs, convert hyphenated URL node IDs to colon-delimited API IDs, and preserve a canonical open URL.
- FR-006 (P1): Support `.env` values for allowlisted nonsecret URL variables such as `FIGMA_FILE_URL`; do not use `.env` as the token store.
- FR-007 (P1): Reload configuration when saved and offer a command to validate/regenerate indexes.
- FR-008 (P1): Provide an ID generation command that checks collisions before writing the manifest and annotation.

### Annotation scanning and hierarchy
- FR-009 (P0): Parse supported annotation tags only from comments or recognized annotation locations; ignore matching text in strings.
- FR-010 (P0): Find annotations in supported source files and associate them with a source range and nearest component/declaration when adapter support exists.
- FR-011 (P1): Build a nested source hierarchy for supported AST adapters and report when only a file-level association is possible.
- FR-012 (P1): Permit an explicit parent reference override where automatic containment is unsuitable.
- FR-013 (P0): Report annotations whose IDs are not mapped, mappings with no code usage, duplicate IDs, duplicate declarations and malformed IDs.
- FR-014 (P1): Support workspace include/exclude globs and default exclusions for dependency/build directories.
- FR-015 (P1): Track multiple occurrences of one reference ID distinctly from duplicate ID definitions.

### Preview/navigation
- FR-016 (P0): Provide hover preview for resolved references using Figma's rendered node image.
- FR-017 (P0): Include an Open in Figma action with the selected node.
- FR-018 (P0): Show loading/cached/stale/unavailable status and a useful fallback on API errors.
- FR-019 (P0): Cache previews outside the repository and refresh expired/invalid assets.
- FR-020 (P1): Support manual refresh for one reference, one file or all references.
- FR-021 (P1): Allow hover size/scale and cache TTL configuration within bounded safe values.
- FR-022 (P1): Use a webview/quick-look command for a larger preview, without requiring an interactive canvas.

### Explorer/dashboard
- FR-023 (P0): Provide a dedicated FigBridge view in the Activity Bar or Explorer container, with mappings and status groups.
- FR-024 (P0): Show counts: source annotation occurrences, unique IDs used, registry IDs unused, unresolved IDs, invalid file/node mappings, preview stale/errors.
- FR-025 (P0): Open a selected mapping at source location or open its exact Figma node.
- FR-026 (P1): Filter/sort by status, language, file alias, source file and reference kind.
- FR-027 (P1): Show source usage count and hierarchical source parents.
- FR-028 (P1): Show the direct Figma file URL and update timestamp/last refresh if available.
- FR-029 (P1): Support a rescan command and status for incomplete scans.

### Claude integration
- FR-030 (P0): Provide read-only mapping tools/resources for Claude through an explicit FigBridge MCP server or documented equivalent.
- FR-031 (P0): The mapping tool must return file alias, node ID, canonical link, display name, source location(s), and whether mapping resolution succeeded.
- FR-032 (P0): Provide a way for Claude to list/search mappings without reading the entire source repository.
- FR-033 (P1): Provide optional hook setup instructions/config generator to receive Figma MCP mutation events.
- FR-034 (P1): Persist only sanitized event metadata and refresh/invalidate the affected preview cache when possible.
- FR-035 (P1): Surface last event time, tool category, target file if known, and processing status in the dashboard.
- FR-036 (P0): Never return the Figma PAT through MCP, hooks, logs or extension Webview messages.
- FR-037 (P1): Prompt/instructions must tell Claude that Figma MCP remains authoritative for live design reads/writes and that mappings are locators, not cached design truth.

### Reliability and privacy
- FR-038 (P0): Work offline with cached previews and manifest operations; clearly mark remote validation unavailable.
- FR-039 (P0): Rate-limit and deduplicate concurrent requests for the same file/node.
- FR-040 (P0): Make all network/data work cancellable where feasible and avoid blocking typing.
- FR-041 (P0): Token stored with VS Code SecretStorage and cleared with an explicit command.
- FR-042 (P0): No telemetry by default; no source-code upload to a FigBridge server.
- FR-043 (P0): Figma API error messages are useful but redact token and private URLs where practical.

## 10. Non-functional requirements

- NFR-001 Responsiveness: a cached hover should be available within 100 ms at p95 on a normal development machine; uncached hover shows immediate loading text and should avoid blocking the editor thread.
- NFR-002 Network latency: uncached preview fetch may depend on Figma network/API performance; use async fetching and show a loading or cached result.
- NFR-003 Startup: do not fetch the entire contents of every configured Figma file on each activation.
- NFR-004 Scale: target 10,000 annotation occurrences / 2,000 unique IDs in a medium monorepo without material editor stalls; benchmark and tune during MVP.
- NFR-005 Robustness: malformed comments, unknown languages, invalid manifest fields and unavailable Figma nodes do not crash VS Code.
- NFR-006 Portability: core feature runs on macOS, Windows and Linux supported by VS Code, subject to Claude hook mechanism support.
- NFR-007 Accessibility: dashboard keyboard navigable, status not conveyed by color alone, image alt text available.
- NFR-008 Security: PAT never lands in tracked config/cache/logs/Webview state/MCP output.
- NFR-009 Determinism: same manifest+source tree produces the same mapping report except transient statuses/timestamps.
- NFR-010 Maintainability: parser adapters can be added without modifying the ID registry format.

## 11. Success metrics

Local-only metrics may be displayed to the user; no telemetry is sent by default.

- Time from source annotation to correct design preview: median under 2 seconds when uncached and network is healthy; cached under 100 ms for the hover response.
- Mapping-resolution correctness: 100% for valid fixtures; malformed inputs are classified, not silently guessed.
- Annotation audit correctness: exact count of occurrences and registry-unused IDs for fixture workspaces.
- Figma image cache hit rate: measured during tests; target >80% on repeated browse of the same references in one work session.
- Claude mapping tool correctness: 100% correct mappings for fixture IDs and explicit errors for missing IDs.
- Hook false-positive rate: no unrelated MCP mutation should be labelled a Figma update.
- Security: zero PAT occurrences in test logs, fixtures, manifest, cache metadata or hook event records.

## 12. Release gates

- No critical credential leak or arbitrary-code execution issue.
- Manifest schema and annotation grammar documented and versioned.
- First language adapters explicitly documented, including unsupported syntax cases.
- Figma preview/refresh failure modes tested.
- Claude integration is opt-in and does not alter tool permissions or block Claude operations.
- Existing products and licensing reviewed before using code or dependencies.
