# Changelog

## 0.1.3

- New logo and Activity Bar icon.
- **Get started with FigBridge** walkthrough in VS Code's Welcome page.
- Marketplace metadata: banner, homepage, issue tracker; marked as Preview.

## 0.1.2

- **Batched renders:** one request renders every preview in a Figma file (up to 50 nodes).
- **Starter-plan files** are detected from Figma's rate-limit response. They are never rendered on hover; **Render All Previews** renders them on request.
- Rate-limit blocks are tracked per endpoint tier and remembered across restarts. Metadata checks keep working while renders are blocked.

## 0.1.1

- `@figma <Figma link>` annotations, with no manifest entry needed.
- Manifests are discovered anywhere in the workspace, one project per manifest.
- `/figbridge` Claude Code skill for building UI from references; the MCP server works across nested projects.
- Dart 3 syntax (records, patterns) is supported by the Dart grammar.

## 0.1.0 — unreleased

First preview: `@figma` annotations for TS/JS/TSX/JSX and Dart, `figma.design.yaml` manifest with schema validation, hover and panel previews with caching, mapping health views, mapping create/retarget/retire flows, and an optional Claude Code plugin (read-only MCP server + edit-aware preview invalidation).
