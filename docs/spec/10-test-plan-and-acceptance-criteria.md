# 10 — Test Plan and Acceptance Criteria

## 1. Test strategy

Testing is layered:
1. Pure unit tests for IDs, URLs, schemas, annotation grammar, and status counts.
2. Adapter fixture tests for comments, declarations and hierarchy.
3. Figma API contract tests using sanitized response fixtures plus optional live integration tests.
4. VS Code extension-host tests for hover, commands, TreeView, SecretStorage and file watchers.
5. Claude MCP and hook integration tests using sanitized inputs, followed by a live manual test with an isolated Figma test file.
6. Security/privacy tests that search for token leakage, unsafe URLs, forged event behavior and Webview injection.
7. Performance and usability tests on representative workspaces.

## 2. Unit-test scenarios

### IDs
- Accept exactly 12 uppercase characters from the specified Crockford alphabet.
- Reject wrong length, punctuation, excluded characters, whitespace and malformed Unicode.
- Decide/document whether lower-case input is normalized in diagnostics and verify canonical output is uppercase.
- Simulate collision and verify generator retries.
- Verify one ID cannot map to multiple records after validation.

### URL parser
- Accept a canonical Figma `/design/<key>/<slug>` URL with a `node-id`.
- Parse `0-1` and equivalent percent-encoded node selection into `0:1`.
- Remove transient `p`/`t` query data from canonical base URL.
- Preserve file key and slug when constructing a node URL.
- Reject HTTP, `javascript:`, `file:`, arbitrary domain, URL with credentials, unsupported port and malformed node ID.
- Correctly handle file URLs without a node ID (file-only mapping).
- Correctly handle encoded query strings and Figma URLs copied from browser.

### Manifest/schema
- Valid single-file and multi-file manifest loads.
- Missing required fields and unsupported schema version are reported.
- Unknown file alias in a reference is rejected.
- Duplicate ID, malformed ID and duplicate mapping/node have defined diagnostics.
- `parentRef` cycles are detected.
- Env var missing and malformed Figma URL produce a precise message.
- PAT-shaped fields are forbidden or warned/rejected.
- Last-known-good config remains active when a newly saved file is invalid.

### Annotation grammar
- Recognize directive in line comments and block/doc comments for supported languages.
- Don't match inside ordinary strings, multiline strings, raw strings, template literals or comments that are disabled by an adapter.
- Avoid matching `@figma-ref` / `@figmaX` or malformed partial names.
- Track multiple references in one file and multiple uses of one ID.
- Record source range accurately (line/column convention tests).
- Unknown ID and invalid syntax are distinct outcomes.

### Coverage counts
- Distinguish annotation occurrences from unique IDs.
- Unused mapping only counted when full scan completed.
- Duplicate use of one ID is not automatically duplicate declaration/mapping.
- An ID used twice is listed with two occurrence locations.
- Files excluded by glob do not affect counts.
- Incomplete adapter scan labels state as incomplete instead of zero.

## 3. Figma API integration tests

Use a dedicated nonproduction Figma test file with:
- one top-level frame;
- one nested renderable node;
- one hidden/nonrenderable node if possible;
- one missing/deleted node ID fixture;
- a file the test account can access;
- an unavailable file scenario (permissions or fake 403 fixture).

Verify:
- PAT header is sent only to `api.figma.com` HTTPS endpoint.
- File metadata and target node query use correct scopes and IDs.
- Image endpoint requests exact node IDs, not entire file by default.
- URL selection syntax converts colon IDs to hyphen IDs correctly.
- Render URL/image is cached and not assumed permanent.
- API `null` image result is handled.
- 401/403/404/429/500, timeout and invalid JSON have distinct bounded handling.
- Concurrent hover requests coalesce into one effective fetch.
- Token is never included in logs, error messages, emitted events or preview metadata.

## 4. VS Code UX tests

- Hover a resolved annotation with fresh cache: preview and metadata appear rapidly.
- Hover an uncached annotation: response is immediate/loading and editor remains responsive.
- After async fetch, preview refreshes or quick-look command opens the image.
- Hover an unresolved ID: useful message plus dashboard navigation.
- Run Open in Figma from annotation, CodeLens, dashboard and command palette.
- Run Preview Reference with hover preview disabled/unavailable.
- Dashboard loads with no config, invalid config, missing token and offline state.
- Tree list supports keyboard focus and sensible labels.
- Count click applies correct filter.
- File changes update scan; branch switch reloads correct manifest.
- Invalid YAML does not destroy the previous valid view.
- Clear cache clears previews but doesn't delete manifest.
- Forget token clears SecretStorage and shows local mapping state remains intact.

## 5. Claude integration tests

### MCP bridge
- Resolve valid ref -> exact file alias/key/node ID/canonical URL and source paths.
- Resolve unknown ref -> `found=false`, no guessed design.
- List refs with pagination/limit and optional filter.
- Find refs for source path with safe normalization and path traversal protection.
- MCP process outputs protocol-only data on stdout; diagnostics only on stderr.
- Process doesn't read PAT or include secret environment values.
- Missing manifest gives actionable error, not arbitrary directory scan.
- Large ref registry respects output limits.

### Hooks/events
- Actual Figma MCP read operation is classified as read, not mutation.
- Actual mutation operation is classified as mutation after completed result.
- Unknown tool namespace does not produce false successful-change label.
- Failed call does not mark preview “updated”.
- Node-known event invalidates exact reference.
- File-known event invalidates refs in that file.
- Unknown target shows broad “possibly stale” state.
- Duplicate event is idempotent.
- Corrupt/oversized JSON is rejected safely.
- Event path cannot escape configured spool.
- Hook executable failure never blocks Figma MCP invocation.
- With extension closed, event is queued only within bounded retention and is processed or safely discarded next activation.
- Uninstall/cleanup removes only FigBridge-managed hook entries, preserving user-defined settings.

## 6. Security test matrix

| Attack/test | Expected result |
|---|---|
| Manifest URL `https://evil.example/...` | Rejected before API call |
| URI scheme `javascript:` | Rejected; never opened |
| HTML in Figma node name | Rendered as escaped text, not HTML/script |
| Malformed YAML custom tag | Safe error; no object construction/execution |
| PAT seeded in fake API error body | Redacted from logs/dashboard |
| PAT seeded in env file accidentally | Not copied to registry/Claude/event output; warn only if narrowly detected and safe |
| Event includes `../../outside` | Rejected; no file write outside spool |
| Event contains arbitrary command | Display/ignore as text; never execute |
| Webview posts unknown command | Dropped |
| Large render response | Enforce configured size limit; fail safely |
| Figma returns 429 | Backoff and show delayed status; no tight loop |
| Malicious URL in manifest has user/password | Rejected |
| Symbol/string contains `@figma ...` | No false annotation |
| MCP request asks for PAT | Tool does not exist; never returns token |

## 7. Performance tests

Fixture workspace scales:
- Small: 100 files / 50 references.
- Medium: 2,000 source files / 2,000 annotations / 500 mappings.
- Large: 10,000 source files / 10,000 annotations / 2,000 mappings, with configurable exclusions.

Measure:
- Activation time to first dashboard (before remote sync).
- Full/incremental scan latency and memory.
- Hover response time for cached and uncached images.
- API request count per action/number of concurrent hovers.
- Dashboard refresh cost after one file edit and one Claude event.
- Cache size and eviction behavior.

Initial target budgets are in the TRD. Any target not met should trigger profiling and documented changes rather than hiding the metrics.

## 8. Cross-platform tests

Support claims should match actual testing. Validate on:
- VS Code stable on Linux, Windows and macOS.
- Figma URL opener behavior for each platform.
- SecretStorage available and token persists across restart.
- Path separators, URI casing and symlink handling.
- Claude Code hook script execution and event spool permissions.
- The chosen language parser's native/WASM assets if any.

If the first release cannot validate every platform, clearly label the tested subset and do not imply full parity.

## 9. Acceptance criteria for MVP release

MVP is acceptable when:
- A repo manifest can map one or more opaque IDs to Figma node IDs.
- An annotation in a supported language resolves consistently and isn't found inside a string.
- Hover/quick-look shows the exact node's rendered image or an actionable failure.
- Open-in-Figma constructs the correct node URL.
- Dashboard counts and groups are exact for a complete supported-language scan.
- Used vs unused vs unresolved definitions are visible and correct.
- PAT is stored only in SecretStorage and redaction tests pass.
- Claude can resolve refs via FigBridge MCP without receiving credentials.
- Hook flow has been tested with real Figma MCP calls and gracefully handles unknowns/failures.
- The extension can work offline for local scanning/mapping.
- Documentation lists supported languages, API scopes, fallback behavior, and hook setup.
- No known critical/high security defect remains.
