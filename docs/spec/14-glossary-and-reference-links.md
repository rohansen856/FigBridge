# 14 — Glossary and Authoritative Reference Links

## Glossary

- **Annotation:** A source-code comment such as `@figma F7KQ9M2X4P6D`.
- **Opaque ID / reference ID:** A short identifier whose target is resolved through the manifest. It is not encrypted data or an authorization credential.
- **Figma file key:** The key embedded in a Figma design URL.
- **Figma node ID:** The ID of an individual frame/component/layer in a Figma file. The REST API form uses colon delimiters, while web URLs typically use hyphens in `node-id`.
- **Manifest:** The committed `figma.design.yaml` file that maps opaque IDs to file aliases and node IDs.
- **Occurrence:** One appearance of an annotation in a source file. One reference ID can have multiple occurrences.
- **Unused mapping:** A manifest mapping with zero occurrences in the complete source scan. It does not mean the Figma component itself is unused in Figma.
- **Unresolved annotation:** An annotation ID found in code that does not exist in the manifest or is invalid.
- **Preview cache:** Local image/metadata copies used to make hover and dashboard views fast.
- **FigBridge MCP:** Proposed read-only MCP bridge that exposes local annotation and mapping data to Claude Code.
- **Figma MCP:** Figma's official MCP service, providing design context and supported write-back operations to compatible AI clients.
- **PostToolUse hook:** Claude Code hook event that runs after successful tool invocation, with event payload details dependent on the tool.
- **Source hierarchy:** Parent/child relationships between code declarations annotated with refs.
- **Design hierarchy:** Parent/child relationships between Figma nodes.
- **Local-first:** Core mapping state stays on the user's machine/repository; no FigBridge service is required.

## Figma official documentation

1. **REST API file, node and image endpoints** — https://developers.figma.com/docs/rest-api/file-endpoints/  
   Describes file JSON, targeted nodes and image rendering. The image endpoint returns node-to-image URLs; rendered image URLs expire after 30 days. `file_content:read` is the relevant scope for node content/rendering.
2. **Authentication** — https://developers.figma.com/docs/rest-api/authentication/  
   Compares OAuth, plan access token and PAT use cases.
3. **Personal access tokens** — https://developers.figma.com/docs/rest-api/personal-access-tokens/  
   Token creation, scope selection, use with `X-Figma-Token`, and revocation.
4. **Scopes** — https://developers.figma.com/docs/rest-api/scopes/  
   Lists `file_content:read`, `file_metadata:read` and related scopes.
5. **REST API changelog** — https://developers.figma.com/docs/rest-api/changelog/  
   Includes policy updates for PAT expiration; verify the current rules at release time.
6. **Figma MCP server introduction** — https://developers.figma.com/docs/figma-mcp-server/  
   Explains design context extraction and write-to-canvas workflows.
7. **Remote MCP setup** — https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/  
   Documents connection steps for supported clients including Claude Code.
8. **MCP vs. agent responsibilities** — https://developers.figma.com/docs/figma-mcp-server/mcp-vs-agent/  
   Clarifies that MCP supplies design context; the agent remains responsible for code-generation decisions.
9. **Figma for VS Code** — https://help.figma.com/hc/en-us/articles/15023121296151-Figma-for-VS-Code  
   Documents file browsing, frame inspection, code snippets, Dev resources and code links.
10. **Code Connect** — https://developers.figma.com/docs/code-connect/  
    Maps Figma design-system components to code snippets/implementations.

## VS Code and Claude official documentation

11. **VS Code Webview guide/security** — https://code.visualstudio.com/api/extension-guides/webview  
    Resource roots, CSP, remote image policy, input sanitization and Webview safety.
12. **VS Code Extension API reference** — https://code.visualstudio.com/api/references/vscode-api  
    HoverProvider, CodeLens, TreeView, commands, SecretStorage and other extension API details.
13. **VS Code extension guide** — https://code.visualstudio.com/api/get-started/your-first-extension  
    Extension structure and development workflow.
14. **Claude Code hooks** — https://docs.anthropic.com/en/docs/claude-code/hooks  
    Hook events such as `PostToolUse`, payloads and matcher configuration; validate against the current Claude Code version at implementation time.
15. **Claude Code MCP** — https://docs.anthropic.com/en/docs/claude-code/mcp  
    MCP server setup and configuration; exact CLI/settings syntax should be tested against the supported version.

## Existing projects and prior art

16. **vlint Marketplace listing** — https://marketplace.visualstudio.com/items?itemName=EdwardNg.vlint  
    Documents annotated React components, a manifest, Figma extraction, VS Code SecretStorage and style validation.
17. **Frame2Code GitHub repository** — https://github.com/JewelArimattom/frame2code  
    Describes a Figma-to-code VS Code extension and MCP integration for AI agents.
18. **Official Figma VS Code Marketplace page** — https://marketplace.visualstudio.com/items?itemName=figma.figma-vscode-extension

## Reference and currency notes

- These links were checked as part of the research for this specification.
- Provider APIs, authentication policies, seat eligibility, MCP catalogs and hook payloads can change. Verify them during implementation and again before a public release.
- A public product page doesn't prove every advertised behavior is available in every plan or platform. Validate required Figma access in the project's actual account.
- “Not found in reviewed documentation” is not evidence that a feature is impossible or that no unreviewed competitor exists.
