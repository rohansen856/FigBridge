# FigBridge — Specification Bundle (v0.1.0)

> This is the original product specification. Implementation decisions that supersede it are recorded in [`../phase0-spike-results.md`](../phase0-spike-results.md) (for example, the directive is `@figma`, not `@figma-ref`).

**Specification bundle version:** 0.1.0  
**Status:** Specification baseline; not implementation code  
**Product codename:** FigBridge (provisional; naming is not a product decision)

FigBridge is a local-first developer tool that creates a navigable, inspectable relationship between source-code components and exact Figma nodes. It is designed to work with the existing Figma for VS Code extension, Figma REST API, and Claude Code/Figma MCP rather than reimplementing a Figma viewer or replacing the MCP server.

## Product summary

Developers place a short, fixed-length, opaque identifier in a source-code comment. A repository-local `figma.design.yaml` manifest maps that identifier to a Figma file and node. The VS Code extension resolves this mapping, renders and caches a preview image, displays it on hover, opens the design, and maintains a dashboard of source annotations, mapped references, unresolved references, unused mappings, unavailable nodes, preview freshness, and Claude-triggered design changes.

An optional Claude Code bridge exposes project mappings as machine-readable context and consumes opt-in hook events to refresh the UI after Figma MCP operations. It does not attempt to intercept the official Figma extension's private state or impersonate its authentication session.

## Specification map

| File | Purpose |
|---|---|
| [`docs/00-viability-and-executive-summary.md`](./00-viability-and-executive-summary.md) | Decision, scope, feasibility and recommendation |
| [`docs/01-product-requirements.md`](./01-product-requirements.md) | PRD, users, requirements, MVP and success metrics |
| [`docs/02-technical-requirements.md`](./02-technical-requirements.md) | Architecture, modules, APIs, parser model, cache and errors |
| [`docs/03-application-flows.md`](./03-application-flows.md) | User journeys and flow diagrams |
| [`docs/04-design-brief.md`](./04-design-brief.md) | Extension UX, information architecture and interaction details |
| [`docs/05-annotation-and-manifest-spec.md`](./05-annotation-and-manifest-spec.md) | Annotation grammar, ID algorithm, manifest rules and examples |
| [`docs/06-data-and-storage-schema.md`](./06-data-and-storage-schema.md) | Configuration, index, cache, event and logical data schema |
| [`docs/07-claude-code-and-figma-mcp-integration.md`](./07-claude-code-and-figma-mcp-integration.md) | Claude context, MCP bridge, hook events and refresh semantics |
| [`docs/08-security-privacy-and-trust.md`](./08-security-privacy-and-trust.md) | Token handling, local boundaries, threat model and privacy |
| [`docs/09-implementation-plan.md`](./09-implementation-plan.md) | Phased plan, workstreams, estimates, gates and release plan |
| [`docs/10-test-plan-and-acceptance-criteria.md`](./10-test-plan-and-acceptance-criteria.md) | Acceptance criteria, test matrix, performance and reliability |
| [`docs/11-existing-projects-and-market-research.md`](./11-existing-projects-and-market-research.md) | Competitor/prior-art comparison and differentiation |
| [`docs/12-architecture-decisions.md`](./12-architecture-decisions.md) | ADRs documenting chosen and deferred decisions |
| [`docs/13-open-questions-and-risks.md`](./13-open-questions-and-risks.md) | Blocking decisions, risks, validation spikes |
| [`docs/14-glossary-and-reference-links.md`](./14-glossary-and-reference-links.md) | Terms and authoritative links |
| `examples/` | Removed from the repository (example apps are kept locally) |

## Decisions already supplied by the product owner

- Multi-language annotation support is desired.
- Hover should show a rendered image preview, not an embedded interactive Figma canvas.
- Annotation references should be opaque fixed-length IDs, not encrypted node IDs.
- VS Code is first; a Figma Dev Mode plugin and browser extension are future platform possibilities.
- Claude integration must support both code/design context and mutation-aware refresh.
- Initial authentication preference is a Figma personal access token (PAT).
- Mapping configuration is repository-local and version-controlled; credentials are not.
- Documentation is Markdown.
- “Background schema” means data model, manifest, indexes and local/service storage.

## Explicit non-goals for MVP

- Rebuilding a Figma viewer.
- Writing to Figma directly from FigBridge; Figma MCP remains the agent's write path.
- Generating or rewriting application code automatically.
- Performing pixel-perfect UI linting across every language and framework.
- Running a hosted backend, team account service, analytics pipeline or cloud database.
- Promising control of the official Figma extension's private panels, caches or session.
- Treating opaque IDs as an authorization or confidentiality mechanism.

## Key technical assumptions

1. The extension is local-first and makes Figma REST calls from the VS Code extension host.
2. The repository manifest is the source of truth; the extension's indexes and image cache are generated and can be rebuilt.
3. A 12-character Crockford Base32 ID is the current recommendation. It is deliberately opaque and collision-checked; it is not cryptographically encrypted.
4. The MVP uses the Figma REST API for metadata, node resolution and rendering. Claude's official Figma MCP remains independent.
5. Generic comment discovery is language-agnostic, but precise component nesting requires parser/language adapters. Initial adapter priorities remain a decision to confirm.
6. Claude hook event delivery is best-effort. If a tool result does not identify changed node IDs, the extension invalidates previews for the relevant configured file and refreshes on demand.

## How to use this bundle

Review the executive summary and open questions first. Then implement against the PRD and technical requirements. The examples are illustrative configurations and must be validated by the eventual schema/parser implementation before being treated as normative. Requirements are labelled `MUST`, `SHOULD`, or `MAY` in the RFC sense: mandatory, recommended, or optional.

## Research references

The principal sources are the official [Figma REST API documentation](https://developers.figma.com/docs/rest-api/file-endpoints/), [Figma authentication and PAT guidance](https://developers.figma.com/docs/rest-api/authentication/), [Figma MCP documentation](https://developers.figma.com/docs/figma-mcp-server/), [Figma for VS Code guide](https://help.figma.com/hc/en-us/articles/15023121296151-Figma-for-VS-Code), [vlint Marketplace listing](https://marketplace.visualstudio.com/items?itemName=EdwardNg.vlint), [Frame2Code repository](https://github.com/JewelArimattom/frame2code), and [VS Code Webview documentation](https://code.visualstudio.com/api/extension-guides/webview). More links and qualifications are in the research document.
