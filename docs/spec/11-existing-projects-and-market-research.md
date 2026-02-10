# 11 — Existing Projects and Market Research

This is a point-in-time evaluation of public documentation and listings, not a guarantee that no other project exists or that upstream capabilities will remain unchanged.

## 1. Summary

Several existing products cover parts of the proposed functionality. The closest direct precedent found is **vlint**, which already uses source annotations, a design manifest and a Figma-derived registry. **Frame2Code** covers Figma-to-agent/MCP workflows. The official Figma for VS Code extension covers viewing/inspection and development resources. Figma Code Connect covers reusable component-to-code mappings. The proposed product should reuse compatible conventions where permitted, avoid rebuilding the viewer, and focus on cross-language annotation resolution, fixed opaque IDs, hover image previews, mapping coverage dashboard and Claude-aware local invalidation.

The research did not verify a single off-the-shelf product that combines all desired items in the same workflow. That should be phrased as “not found in reviewed public materials”, not as proof of absolute novelty.

## 2. vlint — closest annotation/manifest precedent

**Public listing:** https://marketplace.visualstudio.com/items?itemName=EdwardNg.vlint

The reviewed Marketplace documentation describes vlint as a VS Code visual linter that binds Figma design specifications to React implementations. It documents:
- `@design-frame` file-level comments.
- `@design-component` annotations on React/JSX components.
- A workspace design manifest and generated `DESIGN_REF.json` registry.
- Figma REST API extraction of node geometry/layout/style data.
- Figma token storage through VS Code SecretStorage.
- Static AST analysis, diagnostics and optional quick fixes.
- An explicit design-code contract and handling for overrides.

Why this matters: the basic idea of source comments that bind components to Figma nodes, backed by a local manifest, is already implemented precedent. FigBridge should not claim that annotations or a manifest are new. Instead, evaluate whether vlint's current code, parser design, URL resolver, registry model or test harness can be reused legally and technically.

Limitations relative to FigBridge as documented in the listing:
- Primary validation target is React/JSX/TSX.
- Main job is comparing styles and generating CSS, not image hover previews.
- It uses named node/component keys in examples, rather than the proposed fixed-length opaque ID registry.
- The reviewed listing does not document the complete dashboard for unique usage counts/unused mappings or the Claude hook-based update visualization requested here.

**Action:** clone/review current repo and license during Phase 0; compare the actual current implementation because Marketplace content may be updated after research. Do not assume an unverified public repository URL or reuse code until the publisher's source/terms are verified.

## 3. Frame2Code — Figma + AI agent integration

**Repository:** https://github.com/JewelArimattom/frame2code

The reviewed repository describes a VS Code extension for Figma-to-code using AI agents and MCP. Features listed include Figma PAT connection, secure storage, structured design extraction, component detection, design token extraction, asset export, an MCP server, and prompts for multiple web frameworks.

Why it matters:
- It demonstrates an existing pattern for embedding a Figma API/MCP workflow into VS Code.
- It may have reusable implementation lessons for token entry/storage, design fetching, image/asset export, and MCP tool packaging.
- It is not a replacement for a stable source annotation registry or hierarchical audit dashboard based on the reviewed project description.

**Action:** inspect license, supported APIs, release state and architecture. Avoid duplicating work blindly, but don't assume its internal API is extensible or supports Flutter annotations.

## 4. Official Figma for VS Code

**Marketplace:** https://marketplace.visualstudio.com/items?itemName=figma.figma-vscode-extension  
**Guide:** https://help.figma.com/hc/en-us/articles/15023121296151-Figma-for-VS-Code

Documented capabilities include browsing/inspecting design files and frames, viewing component properties and code snippets, exporting assets, real-time comments/activity, and Dev resources that can link code files or other resources to design layers. If a resource link has a matching implementation in the current codebase, the extension can open that file in VS Code.

Why it matters:
- Reuse it as the design viewer/inspection surface.
- Add open/copy canonical Figma URLs and optionally use documented development-resource links.
- Do not reverse-engineer its private Webview state, local storage, auth session, command IDs or internal message protocol.

Important limitations:
- The extension is subject to Figma plan/seat eligibility and account access.
- A public URL-opening fallback remains necessary.
- A separate extension cannot assume it can ask the official extension to navigate to a particular node unless Figma documents a supported API for that action.

## 5. Figma Code Connect

**Documentation:** https://developers.figma.com/docs/code-connect/

Code Connect maps Figma components to real code components/usages and informs design-to-code context. It is useful for shared design-system components, especially if the team already maintains a formal component library.

Why it does not replace FigBridge's proposed core:
- FigBridge needs source-annotation-level mapping for arbitrary screen/component nodes, including non-published frames.
- It needs local inventory, per-ID usage counts, unresolved and unused code mappings.
- It needs editor hover previews and a source-level hierarchy.
- It needs a local Claude Code mapping resolver plus event-aware preview invalidation.

Code Connect can complement the product: when a mapped node represents a reusable design-system component, Code Connect may provide richer code-example semantics while FigBridge provides navigation and usage audit.

## 6. Figma MCP

**Documentation:** https://developers.figma.com/docs/figma-mcp-server/

Figma MCP can provide design data/context to supported AI clients and, with proper tools/workflows, let agents create or modify native Figma content. The server does not automatically understand an arbitrary repo-specific ID convention unless that mapping information is supplied. It also does not guarantee the agent will produce correct final code; the agent uses design context and source instructions to adapt it.

FigBridge's complementary responsibilities:
- Resolve `@figma <ID>` against the repo manifest.
- Return precise URL/file/node location and source usage paths.
- Keep track of cached image preview freshness.
- Observe Claude tool events via hooks where available.

## 7. Comparison matrix

| Capability | Official Figma VS Code | vlint | Frame2Code | Code Connect | Proposed FigBridge |
|---|---|---|---|---|---|
| View/inspect Figma inside VS Code | Yes | API/diagnostic-focused | Figma integration UI described | Figma Dev Mode experience | Reuse official viewer; own preview/list UI |
| Source-code annotations | Dev resources, different model | Yes | Not core in reviewed docs | Mapping/config-based | Yes, opaque annotation IDs |
| Local manifest/registry | Not primary feature | Yes | Has project configuration/state for design extraction | Code Connect config/mappings | Yes, canonical YAML manifest |
| Hierarchical multi-language source mapping | Not documented as this workflow | React/JSX-focused | Web framework-focused generation | Component mappings | Core goal via adapters |
| Hover rendered node preview at annotation | General design inspection, not same contract | Not documented as primary | Design UI, not documented as annotation hover | Not primary | Yes, with VS Code fallback |
| Usage counts / unused code mappings | Not primary | Not documented as full inventory | Not primary | Component relationship, not local usage audit | Yes |
| Claude agent context | Some supported workflows/coding suggestions | Not central in listing | Yes via MCP | Improves component mapping context | Yes via local resolver + official Figma MCP |
| Claude mutation-aware preview invalidation | Not core documented feature | Not core | Not core in reviewed docs | Not core | Yes, opt-in hooks and conservative refresh |
| Requires hosted backend | Figma service | Figma REST/local config | Figma REST/MCP integration | Figma service | No |

“Not documented” means it was not established in the reviewed public material; it should not be interpreted as proof of impossibility in every version.

## 8. Adjacent approaches to consider

- **Source comments with raw Figma URLs:** lowest implementation cost and a good fallback. Poorly suited to a large mapping inventory and repeats long URLs.
- **CodeLens/hover provider only:** tiny custom extension can handle navigation but lacks a robust registry/dashboard unless a manifest/index is added.
- **Figma Dev resources linking source files:** useful reverse-link capability for the official viewer; less convenient for every arbitrary nested code component, and may require links to be managed in Figma.
- **Custom Figma plugin:** can create links/IDs from selected nodes, but doesn't have automatic local repository access without a supported bridge.
- **Browser extension:** useful for copy/reference workflow but unable to access VS Code SecretStorage or source tree automatically. Requires extra local bridge/native messaging and permissions.

## 9. Differentiation and product positioning

Position FigBridge as:

> A local-first, language-adaptable reference layer connecting exact Figma nodes to source annotations, with instant previews, mapping health, and Claude-aware refresh—while reusing Figma's own viewer and MCP server.

Avoid claims such as:
- “First tool to link Figma and code.”
- “Secure because IDs are encrypted.”
- “Automatically synced in real time” unless proven through an authoritative change-feed mechanism.
- “Works with every language” before adapters are tested.
- “Fully controls the official Figma extension.”

## 10. Research sources

- Figma for VS Code guide: https://help.figma.com/hc/en-us/articles/15023121296151-Figma-for-VS-Code
- Official marketplace: https://marketplace.visualstudio.com/items?itemName=figma.figma-vscode-extension
- vlint marketplace: https://marketplace.visualstudio.com/items?itemName=EdwardNg.vlint
- Frame2Code repository: https://github.com/JewelArimattom/frame2code
- Figma Code Connect: https://developers.figma.com/docs/code-connect/
- Figma REST file/node/render endpoints: https://developers.figma.com/docs/rest-api/file-endpoints/
- Figma MCP: https://developers.figma.com/docs/figma-mcp-server/
- VS Code Webview security: https://code.visualstudio.com/api/extension-guides/webview
