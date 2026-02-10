# 00 — Viability and Executive Summary

**Status:** Viable, with a narrow and well-defined MVP.  
**Decision:** Proceed to a validation spike and then MVP implementation; do not begin with three platform extensions or a hosted backend.

## 1. Executive decision

The proposed Figma–code companion is technically viable. Its core value is not “show Figma in VS Code” because Figma already provides that. The product's value is a **stable, source-controlled, multi-language reference layer** that connects exact source-code regions to exact Figma nodes, exposes previews and health metrics in the editor, and makes those mappings available to Claude Code.

The recommended MVP is a local-first VS Code extension with:

1. Opaque fixed-length annotations in source comments.
2. A repository-local `figma.design.yaml` configuration and mapping manifest.
3. Hover image previews of referenced Figma nodes.
4. Open-in-Figma navigation and an extension dashboard.
5. Multi-language scanner architecture with a deliberately bounded set of first-release language adapters.
6. A companion local MCP server or MCP-compatible command surface that lets Claude resolve references and read the manifest.
7. An opt-in Claude Code hook that reports Figma MCP tool operations and signals preview invalidation.
8. Local metadata and thumbnail caches, with all secrets in VS Code SecretStorage.

A Figma Dev Mode plugin and browser extension should be designed as future clients of the same manifest/reference format, but should not block the VS Code MVP. A backend server is unnecessary for the specified local workflow.

## 2. Viability by capability

| Capability | Assessment | Main caveat |
|---|---|---|
| Fixed-length opaque IDs | High | IDs need collision checks, migration support, and a shared manifest; they are not security controls. |
| Base file URL in YAML or environment | High | Parse only documented, allowlisted environment variables. Never place a PAT in the manifest or `.env`. |
| Resolve exact Figma node | High | The node must exist and the authenticated user must be able to access it. URL node IDs use hyphens; REST API node IDs use colons. |
| Render node image | High | Figma's returned image URLs expire; preview caching and refresh are required. Some nodes can fail to render. |
| Image preview on hover | High, validation needed | VS Code hover layout is more constrained than a Webview. Validate image rendering and sizing early; provide a preview command/dashboard fallback. |
| Dashboard counts and mapping status | High | “Unused” must be defined from the local manifest and scanned source; the extension cannot infer all intended designs unless the file is configured and discoverable. |
| Code hierarchy ↔ design hierarchy | High for supported adapters | Reliable nesting requires syntax-aware parsing; simple regexes alone are insufficient for arbitrary languages. |
| Multi-language support | High as an architecture, not all-at-once delivery | Each language has different comment, declaration, and syntax rules. A plugin/adapter interface is required. |
| Claude reads annotations | High | Claude needs an explicitly configured MCP bridge/tool or injected project instruction; Figma MCP does not automatically index local annotations. |
| Detect Claude's Figma MCP mutations | Feasible | Hooks can observe tool events, but tool naming/output shapes vary. Events may not identify every changed node. |
| Refresh preview after mutation | Feasible | Must implement conservative invalidation and refresh-on-next-view; avoid claiming instant synchronization when API output is ambiguous. |
| Reuse official Figma viewer | Partially feasible | Direct Figma URLs and official development-resource links are safe integration points. Controlling the official extension's private embedded viewer is not a supported public contract. |
| Standalone backend/database | Not required | Local manifest + extension storage covers MVP. A service introduces deployment, auth, tenancy, data governance and maintenance without a demonstrated need. |

## 3. Existing products and the actual gap

Research identified important precedents:

- **vlint**: currently the closest architectural precedent. Its Marketplace description documents `@design-frame` and `@design-component` comments, a manifest, Figma REST extraction, token storage in VS Code SecretStorage, and design-reference metadata. Its documented use case is static style validation of React/JSX implementations. It substantially overlaps with the annotation/manifest idea, so its current source and license must be studied before coding a parallel parser or registry. [Marketplace](https://marketplace.visualstudio.com/items?itemName=EdwardNg.vlint).
- **Frame2Code**: a VS Code extension that connects Figma to AI coding agents through MCP and extracts structured design details. Its documented focus includes design-to-code workflows, asset export, design tokens, and agent prompts. It does not, based on the reviewed documentation, deliver the full persistent opaque-reference dashboard and cross-language annotation workflow proposed here. [Repository](https://github.com/JewelArimattom/frame2code).
- **Official Figma for VS Code**: can browse and inspect Figma designs, render frames, surface code suggestions and connect code files to design components through Dev resources. It is the viewer to keep, not recreate. [Official guide](https://help.figma.com/hc/en-us/articles/15023121296151-Figma-for-VS-Code).
- **Figma Code Connect**: maps design-system components to code snippets/implementations and informs Figma MCP. It is a complementary component-level mechanism, not an arbitrary per-source-annotation navigation registry. [Docs](https://developers.figma.com/docs/code-connect/).

The novelty claim must be careful: the complete combination was **not verified as an existing off-the-shelf product**, but this is not proof no similar project exists. The project should differentiate on multi-language stable references, quick hover previews, mapping health dashboard, and Claude-aware local integration—not on the basic idea of Figma annotations.

## 4. Recommended architecture

```text
Repository source files
  └─ @figma ABC... annotations
        │
        ▼
VS Code extension host ─── Figma REST API (PAT in SecretStorage)
  ├─ syntax/language adapters    ├─ file/node metadata
  ├─ reference index             ├─ image rendering URL
  ├─ hover preview               └─ rate-limit/error handling
  ├─ CodeLens / commands
  ├─ TreeView / dashboard Webview
  └─ local cache and event monitor
        ▲
        │ local event files / explicit hooks
Claude Code hook ─── Figma MCP tools (official; separate connection)
        │
        └─ FigBridge MCP: resolve IDs, list mappings, obtain design context
```

The official Figma MCP connection and FigBridge's own MCP bridge serve different roles. Figma MCP gives Claude design data and write operations. FigBridge MCP gives Claude the repository's annotation registry and mapping semantics. Claude Code hooks notify the editor after relevant tool operations; they do not replace either MCP server.

## 5. Cost and schedule — planning estimate, not a commitment

For one experienced developer, a defensible initial planning estimate is approximately **4–7 weeks to a usable MVP** if initial parser adapters are limited and the Figma API/hover assumptions validate early. Add time for broad language coverage, polished packaging, Windows/macOS/Linux verification, a separate Figma plugin, or a browser extension. This is an engineering estimate, not a measured benchmark.

Proposed phase gates:

1. **Spike (2–4 days):** validate Figma node rendering, VS Code hover image preview, and a real Claude `PostToolUse` event from the user's current Figma MCP setup.
2. **Vertical slice:** manifest → annotation scan → preview → open in Figma.
3. **Dashboard and adapter interface:** mapping health and first languages.
4. **Claude context and mutation events:** read-only MCP bridge and opt-in hooks.
5. **Hardening:** security, error handling, tests, accessibility, release packaging.

If the hover preview is unreliable in a target VS Code build, ship a quick-look command/preview Webview as an equivalent fallback while keeping the editor hover informative.

## 6. Critical product principles

- **The manifest is the source of truth.** Do not try to infer mappings from names alone.
- **IDs are identifiers, not secrets.** Access control remains Figma's responsibility.
- **Credentials never enter source control or Claude context.** Store the PAT in SecretStorage and never expose it to MCP tools, hooks, logs, thumbnails, diagnostics, or the Webview.
- **No private extension APIs.** Do not depend on the internals of Figma for VS Code or its stored credentials.
- **Don't claim real-time consistency.** Mark previews stale/refresh-pending after possible mutations; refresh using supported APIs.
- **Multi-language means adapters.** Implement syntax-aware associations for a named initial set; do not overpromise universal AST precision.
- **Local-first by default.** No account, server, telemetry, or upload of project source is required.

## 7. Go/no-go checklist

Proceed to full implementation when all of the following are true:

- [ ] The Figma API can render one frame and one nested component under the intended PAT scope.
- [ ] VS Code hover can show a usable image or a preview fallback meets the interaction intent.
- [ ] The manifest stores opaque IDs and stable mappings, and invalid/duplicate IDs are detected.
- [ ] One initial language adapter can associate an annotation with the correct enclosing component.
- [ ] A Claude Code hook from the actual environment can identify the official Figma MCP tool namespace and persist a sanitized event.
- [ ] The license and implementation of vlint and Frame2Code have been reviewed for reuse constraints.

## 8. References

The research basis and source qualifications are recorded in [11 — Existing Projects and Market Research](11-existing-projects-and-market-research.md). See also official Figma [file/node/render endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/), [PAT authentication](https://developers.figma.com/docs/rest-api/personal-access-tokens/), [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/), and [VS Code Webview security guidance](https://code.visualstudio.com/api/extension-guides/webview).
