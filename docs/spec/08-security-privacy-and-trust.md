# 08 — Security, Privacy and Trust Requirements

## 1. Security posture

FigBridge is local-first, but it handles a Figma PAT, private design images, source paths and AI-tool events. Local-first reduces data exposure; it does not make sensitive data automatically safe. The extension should follow least privilege, keep secrets separate, process only configured design references, and show users when remote/API access is required.

## 2. Assets to protect

- Figma PAT.
- Figma file keys and private design URLs (not authentication secrets, but may disclose project identity).
- Rendered previews from private designs.
- Source paths, symbol names and line ranges.
- Manifest mapping between code concepts and design nodes.
- Claude tool name/input/output fields and session identifiers.
- Local cache and event spool integrity.
- Any VS Code commands that modify repository files.

## 3. Threat model

### T1 — Credential accidentally committed
**Risk:** PAT is placed in manifest, `.env`, settings, generated logs, or an MCP response and committed.  
**Controls:** SecretStorage only; PAT fields forbidden by schema; `.gitignore` guidance; test scans for token-like values; log redaction; explicit “Forget token” command; never copy token into a CLI argument because process lists may expose it.

### T2 — Malicious/malformed manifest
**Risk:** YAML tags, arbitrary URL hosts, oversized fields, symlink paths or crafted node IDs trigger unsafe behavior.  
**Controls:** safe YAML parser without custom tag execution; schema and length bounds; HTTPS allowlist for Figma hosts; fixed API origin; no arbitrary file fetching; path canonicalization; validation before API use.

### T3 — Workspace content injection into Webview
**Risk:** malicious names/tags/paths from manifest or Figma API are inserted as raw HTML/JavaScript.  
**Controls:** escape text; strict CSP; external scripts forbidden; no `eval`; limited Webview API; validate every message; use resource URI helpers and restrictive local resource roots. See [VS Code Webview security](https://code.visualstudio.com/api/extension-guides/webview).

### T4 — Malicious local event/hook file
**Risk:** a repo file forges an event, path traversal writes outside spool, or content contains a command/prompt injection.  
**Controls:** explicit opt-in installation; validate strict JSON schema; constrain paths; treat summaries as untrusted display text; never execute commands supplied in events; no automatic prompt insertion into Claude; deduplicate event IDs; bounded size/count; validate file key/node ID formats.

### T5 — Prompt injection in Figma text or node names
**Risk:** content inside Figma design data instructs Claude to exfiltrate secrets or execute actions.  
**Controls:** treat Figma text as untrusted design data; FigBridge's resolver returns minimal metadata; instructions warn agent not to treat frame text as system instructions; Figma MCP data is not elevated in authority; never pass PAT to Claude.

### T6 — Leaked private design previews
**Risk:** thumbnails are copied to repository or external telemetry.  
**Controls:** previews cached under extension global storage; no automatic upload/telemetry; bounded retention and clear-cache command; no preview data in Git; optionally disable persistent image caching in sensitive workspaces.

### T7 — Overbroad API permissions
**Risk:** a token can access more Figma resources than the current manifest needs.  
**Controls:** request only the scopes required by endpoints; don't use a team/org token for personal use; explain PAT account access and expiration; use a dedicated token per integration; offer explicit clear/replace token workflows. Figma recommends OAuth for products serving multiple users, while a PAT is appropriate for personal tooling. See [Figma authentication](https://developers.figma.com/docs/rest-api/authentication/).

### T8 — Tool-event spoofing or incorrect refresh claim
**Risk:** a fake or malformed hook event makes UI claim that a design changed.  
**Controls:** local scope and path ACLs; event is a signal to invalidate, not proof of final remote state; verify final state through Figma API on refresh; distinguish “tool call observed”, “mutation reported successful”, and “preview refreshed”.

### T9 — Source code exfiltration through MCP
**Risk:** FigBridge MCP returns too much code context to Claude or any MCP client.  
**Controls:** no arbitrary filesystem tool; default outputs only relative paths, symbols, IDs and mapping metadata; optional bounded snippets only under explicit input; never transmit workspace data to a FigBridge server; MCP process reads only configured workspace root and manifest.

### T10 — Unsafe URL opening or SSRF
**Risk:** crafted manifest points API requests at an attacker host or links to a command/data URI.  
**Controls:** only permit HTTPS Figma URLs for parsing; always call fixed Figma API host; `vscode.openExternal` only with validated `https://www.figma.com/...`; reject `javascript:`, `file:`, custom schemes, username/password in URLs and unexpected ports.

## 4. PAT handling

- The user enters the token into a VS Code SecretStorage-backed input command, not the dashboard HTML.
- Token key is namespaced by extension ID and optionally workspace; decide whether one global token is enough after product use-case testing.
- Never store the PAT in `figma.design.yaml`, `.env`, `.vscode/settings.json`, `.mcp.json`, command arguments, diagnostics, test snapshots, telemetry, crash logs or preview metadata.
- Never add token to a URL. Send via `X-Figma-Token` header over HTTPS.
- Validate minimal scopes. For rendering and node data, `file_content:read` is the key documented scope; `file_metadata:read` applies when calling the metadata endpoint.
- On 401/403, do not repeatedly retry. Present a redacted reason and secure token replacement flow.
- Provide “Forget Figma token” and document that the user can revoke it from Figma settings.
- Figma's current PAT guidance says newly generated PATs have maximum expiration of 90 days; remind users to replace expiring tokens. Confirm policy during implementation because provider policy can change. [PAT docs](https://developers.figma.com/docs/rest-api/personal-access-tokens/), [changelog](https://developers.figma.com/docs/rest-api/changelog/).

## 5. Environment files

The user permits Figma base URLs in `.env` or hardcoded config. This must not be interpreted as permission to store tokens there. FigBridge should read only named URL variables needed by the manifest and must not display the contents of `.env` in the dashboard. Existing `.env` files may contain unrelated application secrets; the extension must not parse and retain all their values globally or pass the whole environment to the Webview/MCP.

## 6. Data flow inventory

| Data | Origin | Destination | Default retained? |
|---|---|---|---|
| Figma PAT | User | SecretStorage; Figma REST `X-Figma-Token` header | SecretStorage only |
| Manifest | Workspace | Extension host/MCP resolver | Yes, in Git as user authored |
| Annotation IDs | Source files | In-memory index/dashboard/MCP mapping tool | Yes in source; runtime index recomputable |
| Design node JSON | Figma REST | Minimal normalizer/cache in memory | Only required metadata, no full file JSON by default |
| Rendered image | Figma REST render endpoint | Extension global cache / hover | Local only; bounded TTL/capacity |
| Claude hook payload | Claude Code | Hook process | Raw payload not retained; sanitized event only |
| MCP outputs | MCP server | Claude Code | Controlled by Claude; FigBridge does not archive by default |
| Diagnostics | Extension host | Output channel/local logs | Only if needed; redacted and bounded |

## 7. Logging rules

- No debug log may print headers, token values, full environment, raw event payloads, complete Figma JSON, or source file contents by default.
- Log normalized error codes, endpoint category (not auth header), status code, duration and hashed/truncated file aliases only where helpful.
- Verbose logs must be opt-in, with a clear warning and bounded rotation.
- Tests include seeded fake PAT strings and assert they never appear in any output/cache fixture.

## 8. Supply chain and licensing

- Pin direct dependencies and review licenses before release.
- Check vlint and Frame2Code licenses and exact repository status before porting code. Architectural inspiration is distinct from code reuse; reused code requires license obligations to be followed.
- Keep the VS Code extension bundle dependency surface small; audit extension dependencies and MCP SDK packages.
- Do not download/execute code based on Figma node text, manifest strings or MCP output.
- Sign/publish release artifacts according to marketplace practices; publish a clear privacy policy even if telemetry is not used.

## 9. Security validation checklist

- [ ] PAT not found in repo search, logs, Webview messages, hook event fixtures or snapshots.
- [ ] Manifest with `javascript:` or a non-Figma host rejected.
- [ ] YAML custom tags/aliases cannot trigger arbitrary object construction or resource exhaustion.
- [ ] Webview has CSP and no untrusted raw HTML.
- [ ] Event path traversal/symlink writes are rejected.
- [ ] Forged events cannot invoke VS Code commands, open arbitrary URIs or inject Claude context.
- [ ] Cache is local, size-bounded, and clearable.
- [ ] File/node API results respect Figma account permissions; access errors aren't bypassed.
- [ ] MCP server exposes no shell/file traversal or PAT access.
- [ ] Hook configuration installation/cleanup is explicit and reversible.
- [ ] PAT expiry and revocation are handled without infinite retries.
