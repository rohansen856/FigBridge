# FigBridge

Connects source code, Figma designs and Claude Code through short, stable IDs in code comments:

```dart
/// @figma F7KQ9M2X4P6D
class CheckoutScreen extends StatelessWidget { … }
```

A committed `figma.design.yaml` maps each ID to an exact Figma file and node. The VS Code extension shows the rendered node on hover, opens it in Figma, and keeps an inventory of mapping health. An optional Claude Code plugin gives Claude the same mappings through a read-only MCP server. After Claude edits a design through the Figma MCP, the plugin marks the affected previews stale.

User documentation: [`packages/vscode-extension/README.md`](packages/vscode-extension/README.md).

## Repository layout

| Path | What it is |
|---|---|
| `packages/core` | Pure TypeScript, no VS Code dependency. Includes:<br>• opaque IDs and the Figma URL parser<br>• manifest schema, loader and env placeholders<br>• tree-sitter scanner (TS/TSX/JS/Dart + fallback lexer)<br>• reference index and health checks<br>• Figma REST client and preview cache<br>• Claude event schema and spool |
| `packages/vscode-extension` | The extension: hovers, CodeLens, diagnostics and quick fixes, TreeViews, script-free preview panel, mapping flows, Claude activity. Bundles the Claude plugin. |
| `packages/claude` | The `figbridge-claude` CLI (`mcp` = read-only MCP server over stdio, `hook` = PostToolUse/PostToolUseFailure hook) and the Claude Code plugin/marketplace it builds into. |
| `schemas/figma.design.schema.json` | Generated JSON Schema for the manifest (from `packages/core/src/manifest/schema.ts`) |
| `fixtures/` | Scanner fixtures, a demo workspace mapped to real nodes of the test file, and sanitised Claude hook payloads |
| `docs/spec/` | Original specification bundle |
| `docs/phase0-spike-results.md` | Phase 0 evidence and the decisions that supersede the spec |
| `scripts/` | Dart grammar rebuild, icon generator, license-notice generator |

## Development

Requires Node 20+ and pnpm 9.

```sh
pnpm install
pnpm build          # core → claude plugin → extension (bundles WASM, schema, plugin)
pnpm test           # unit and integration tests (vitest)
pnpm lint && pnpm typecheck

# VS Code extension-host tests (opens a test window; downloads VS Code unless VSCODE_PATH is set)
VSCODE_PATH=/usr/share/code/code pnpm --filter figbridge test:e2e

# Package the VSIX
pnpm --filter figbridge package     # → packages/vscode-extension/figbridge.vsix
```

### Live Figma tests (opt-in)

These tests use real Figma API quota. Starter plans and View seats get very few render calls.

```sh
# .env at the repo root (git-ignored): FIGMA_ACCESS_TOKEN=figd_…
FIGMA_LIVE=1 pnpm --filter @figbridge/core test src/figma/live.test.ts
FIGMA_LIVE_ENV=$PWD/.env VSCODE_PATH=/usr/share/code/code pnpm --filter figbridge test:e2e
```

The token is only read from `.env` by these tests. The extension itself stores tokens in VS Code SecretStorage, and the e2e profile is deleted after each run.

### Trying the Claude plugin locally

```sh
pnpm --filter @figbridge/claude build
claude plugin marketplace add "$PWD/packages/claude/marketplace"
claude plugin install figbridge@figbridge-local
```

## Status

The MVP is implemented and passes its automated tests on Linux. These items are still open before a public release:
- **Hook payload capture:** capture a real successful `PostToolUse` payload. Phase 0 captured real failure payloads only.
- **Cross-platform checks:** visual hover checks on macOS and Windows, plus Remote-SSH/WSL.
- **Release decisions:** final product name, publisher and trademark check, and a review of Figma's developer terms for a PAT-based public extension.

See [`docs/phase0-spike-results.md`](docs/phase0-spike-results.md).
