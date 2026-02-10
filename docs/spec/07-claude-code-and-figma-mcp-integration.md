# 07 — Claude Code and Figma MCP Integration

## 1. Goal and boundaries

Claude integration must make the same mapping registry available to Claude that the developer sees in VS Code, and reflect relevant Figma MCP operations in the extension. The design must not couple these functions to the official Figma extension's private UI implementation.

There are two distinct flows:

- **Design context:** Claude resolves `@figma <ID>` through FigBridge and then uses the official Figma MCP server to obtain live design context or perform permitted design mutations.
- **Change observation:** Claude Code runs an opt-in `PostToolUse` hook after a tool operation. The hook emits a sanitized event; FigBridge updates its status and invalidates stale previews.

Figma MCP is the authoritative interface for AI access to live Figma design data. FigBridge's MCP interface is a local mapping resolver, not a competing Figma API/MCP server. See [Figma MCP introduction](https://developers.figma.com/docs/figma-mcp-server/) and [what MCP sends vs. what the agent does](https://developers.figma.com/docs/figma-mcp-server/mcp-vs-agent/).

## 2. Integration component A: read-only FigBridge MCP

### 2.1 Purpose

Provide Claude with a deterministic, repository-specific answer to: “What design node does this annotation refer to, and which source components already map to that node?” Claude should not need to parse the YAML format or search for URL query parameters on every request.

### 2.2 Candidate tool surface

| Tool | Input | Output |
|---|---|---|
| `figbridge_resolve_ref` | `refId` | `found`, `refId`, file alias/name/key, node ID, canonical URL, display name/kind, source locations, remote/cache status |
| `figbridge_list_refs` | Optional query, file alias, status, limit/cursor | Compact paginated list; excludes tokens and source content |
| `figbridge_find_refs_for_source` | Workspace-relative path, optional symbol/range | IDs and design mappings near/inside the source declaration |
| `figbridge_get_file_summary` | File alias | File URL/name, reference count, status, version/last validation metadata |
| `figbridge_get_source_context` | Ref ID, optional `includeSnippets=false` | Reference plus declaration name and path/line locations; source text is opt-in and narrowly bounded |
| `figbridge_get_preview_status` | Ref ID | Cache state and last refresh/error code; no signed URL by default |

All tools are read-only in MVP. If a future tool changes the manifest, it must be a separately permissioned write tool, preview edits, and use a safe repository write path. Do not expose an arbitrary file-read or shell-execution tool through FigBridge MCP.

### 2.3 MCP server process model

The MCP server can be shipped as an executable Node process inside the extension package, but must be runnable independently by Claude Code. It should:
- load the workspace root and `figma.design.yaml` using an explicit path/current working directory;
- reuse the pure core manifest resolver;
- write diagnostics only to stderr and reserve stdout for MCP protocol messages;
- provide explicit startup errors when no manifest is found;
- serve only configured data and safe source-location metadata;
- never read VS Code SecretStorage or need the Figma PAT;
- never expose the entire user environment;
- avoid fetching live Figma design JSON by default (Claude's official Figma MCP handles that);
- return an explicit unresolved result when a code annotation is absent from the manifest.

If the user needs VS Code's current unsaved buffer state, the MCP server cannot automatically see that unless a bridge is added. MVP should use the checked-in manifest plus on-disk source scanner and document that unsaved editor buffers may not be reflected by the standalone MCP process. A later IPC bridge could expose a current in-memory index without granting arbitrary file access.

### 2.4 Configuration example (conceptual)

A project-level Claude Code MCP entry may point to the bundled executable/CLI with the workspace path. Exact `.mcp.json` command/argument syntax depends on the shipped package layout and Claude Code version; implementation must generate and test a working config rather than copy an unverified placeholder into a user's project.

The integration setup command should:
1. Explain what FigBridge MCP reads.
2. Show the config diff.
3. Offer project scope or user scope.
4. Add only the FigBridge server entry.
5. Avoid changing Figma server authentication or permissions.
6. Offer a test/health check and clean removal.

## 3. Guidance for Claude

A small project-instruction file may be generated or supplied as optional content. It should say:

- Treat `@figma <ID>` as a stable locator.
- Resolve it with `figbridge_resolve_ref` before editing a mapped component.
- Use the returned canonical URL/node ID with the official Figma MCP when live design context is needed.
- Do not invent an ID or guess a node based only on display name.
- If the ref is unresolved, report the missing mapping and ask the developer to repair it.
- After an intentional Figma mutation, let the PostToolUse hook mark cache state; if no hook is configured, tell the developer to refresh manually.
- Do not copy credentials or use any token found in the repository; FigBridge must not place PATs in its own MCP context.
- For nested components, resolve each annotation rather than assuming a page reference fully describes children.

Keep the generated instruction concise and repository-oriented. Do not overwrite an existing `CLAUDE.md`; offer a non-destructive snippet or a dedicated `.claude/rules/figbridge.md` file if appropriate.

## 4. Integration component B: Claude Code hook

### 4.1 Event choice

Use `PostToolUse` for observing completed operations. Do not block or rewrite the tool result in MVP. `PreToolUse` could be used for future guardrails, but is not required and should not be installed for this feature.

Official Claude Code hooks documentation: [Hooks reference](https://docs.anthropic.com/en/docs/claude-code/hooks). The hook payload includes tool name and input, and after successful execution includes tool response; exact fields depend on tool. The product must verify this against the supported Claude Code version at implementation time.

### 4.2 Match/filter behavior

- Prefer a tool-name matcher targeting the Figma MCP namespace if the actual naming syntax is verified in the current Claude Code release.
- In the hook program, filter tool names through a conservative allowlist/prefix known from the active connection (for example a tool namespace configured by the user). Do not assume every installation names tools identically.
- Classify tools as read, mutation or unknown using a reviewed operation list plus conservative fallback. Unknown tools must not be classified as writes solely by their names unless the user explicitly chooses a broader policy.
- Parse input/output for validated Figma file keys and node IDs. Use known schemas where possible. Do not scrape raw transcript files or broad conversation logs merely to infer nodes.
- Do not block the tool call, replace output, add context to Claude, or alter permissions in the MVP.

### 4.3 Event contract

Example sanitized event:

```json
{
  "v": 1,
  "eventId": "b83f24d2-0548-49c0-873b-a7cf3e5d10c2",
  "ts": "<ISO 8601 timestamp>",
  "hookEvent": "PostToolUse",
  "server": "plugin_figma_figma",
  "tool": "use_figma",
  "kind": "mutation",
  "result": "success",
  "fileKey": "aHvbMOTkjQ3dmWBoWbMuv2",
  "nodeIds": ["1:666"],
  "target": "node",
  "dedupeKey": "3f2a9c0d1e4b5a67"
}
```

> **Implemented (v0.1):** this is the actual event schema (`packages/core/src/claude/events.ts`). Real tool names are `mcp__<server>__<tool>` where the server varies by install (`plugin_figma_figma`, `claude_ai_Figma`, `figma`, `figma-desktop`); classification uses the tool suffix. Failures arrive on the separate `PostToolUseFailure` hook event. See `docs/phase0-spike-results.md`.

This example is illustrative; the actual Figma tool names and payload structure must come from the user's live tool response. Do not assume that `update_node` is the official tool name. Raw tool output should be omitted by default because it may contain large or sensitive design data.

### 4.4 Event transport

Preferred MVP default: hook writes a bounded, sanitized JSON file into a workspace event spool that is gitignored and watched by the extension. This avoids opening an HTTP server. Validate symlink/path safety and ensure the hook only writes under an explicitly configured allowed directory. The hook should create files atomically, with file permissions tightened where supported.

Alternative transports may be evaluated:
- Unix domain socket / named pipe: better separation, but needs cross-platform plumbing and lifecycle management.
- Loopback HTTP server: simple but requires origin/auth token protection; don't bind to `0.0.0.0`; avoid if event spool meets requirements.
- `vscode://` custom URI: can be a user-click navigation channel but is not a guaranteed background event transport.

The implementation spike decides the transport. Do not hard-code a localhost port in this specification.

### 4.5 Safe invalidation logic

- If event includes validated file and node IDs, mark that preview stale and any cached ancestors/descendants if hierarchy-dependent rendering is supported.
- If it includes only file key, mark all configured references in that file stale.
- If it only shows a Figma mutation tool with unknown target, mark references as “possibly stale after Claude activity” and offer a user-triggered refresh of configured files.
- If event indicates failure, do not label the target “updated”; display “Figma operation failed” only if the outcome is explicit.
- If event is malformed or duplicate, ignore it and record a redacted diagnostic.
- Never read a tool output `image` or large design payload into the dashboard unless explicitly needed.

## 5. Visualization in FigBridge's own tab

The dashboard should show a **Claude Activity** group only after the hook integration is enabled. Each row contains:
- time;
- operation category (read/mutation/unknown);
- Figma file/node if extracted;
- “preview refreshed”, “stale — refresh pending”, “failed”, or “target unknown” status;
- open-design and refresh controls.

This tab visualizes FigBridge's observation of the event. It does not reproduce Claude's transcript or render Claude's tool response verbatim. The actual image preview comes from the Figma REST render endpoint and is keyed by the same manifest ID used by source code.

## 6. Authentication separation

There are independent credentials/sessions:
- Figma personal access token used by FigBridge REST API previews.
- OAuth or other supported authentication used by official Figma MCP.
- Claude Code's own authorization/configuration.

Do not attempt to share or extract tokens between them. FigBridge's PAT can be revoked independently. Prefer granular scope `file_content:read` and optional `file_metadata:read` for this product; exact required scopes must be validated against chosen endpoints. Note that Figma PATs can have broad account access subject to permissions/scope, and Figma documents them as user-bound credentials. See [Figma authentication](https://developers.figma.com/docs/rest-api/authentication/) and [PATs](https://developers.figma.com/docs/rest-api/personal-access-tokens/).

## 7. Failure modes and graceful degradation

| Situation | Required fallback |
|---|---|
| FigBridge MCP not configured in Claude Code | Claude can still use Figma MCP; mapping resolution is manual, and extension offers setup command |
| Figma MCP not connected | Claude can still resolve IDs but cannot fetch live design context or perform Figma mutations |
| Hook not installed | Dashboard shows hook integration disabled; manual refresh works |
| Hook process fails | Do not affect Claude's tool call; event may be lost and user can manually refresh |
| Tool name unknown | Record a non-mutating/unknown event or ignore; never misstate successful mutation |
| Node ID not present in output | Invalidate by file when known; otherwise use conservative status and user-triggered refresh |
| Local manifest mismatch | Return unresolved with config path/ref ID; do not guess |
| API token absent/expired | Local mapping tools continue; previews use cache or show setup message |
| Extension closed | Events may queue in local spool with bounded retention; process on next activation |

## 8. Testing requirements

- Test against at least one actual Claude Code invocation of Figma MCP read and one mutation workflow in a nonproduction test Figma file.
- Capture only sanitized fixture payloads for unit tests; do not commit live session IDs, access tokens, raw design content or private URLs.
- Verify the installed Claude Code hook matcher and field names; tools are not guaranteed to keep a fixed namespace across all versions/servers.
- Test no-hook, hook-failure, duplicate-event, out-of-order-event, unknown-target and failed-mutation cases.
- Verify FigBridge MCP returns correct mapping even when Figma MCP is unavailable, because the bridge is reading local manifest/source metadata.
- Validate that neither MCP server prints PATs, environment dumps or unrelated source files.
