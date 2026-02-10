# 04 — Product Design Brief

## 1. Design intent

FigBridge should feel like a compact developer utility, not a second design tool. It must fit naturally into VS Code's dark/light themes, use native editor affordances, expose the relevant Figma relationship immediately, and keep the canvas/viewer in Figma's product. The most frequent task is a small hover preview; the dashboard is the audit and navigation hub.

## 2. UX principles

1. **Fast in the code path:** a resolved ID should reveal what it points to with minimal interaction.
2. **Stable identifiers, visible meaning:** ID is short in source, but hover/dashboard shows human-readable frame/component name and file.
3. **No hidden guessing:** unresolved or ambiguous IDs are marked clearly; the extension never silently guesses a frame by similar name.
4. **Source-controlled truth:** manifest changes are visible as ordinary Git diffs; generated previews and secrets never pollute the source tree.
5. **Status is explainable:** “unused”, “unresolved”, “stale”, “unavailable” must have distinct definitions and actions.
6. **Keep existing tools:** Figma for VS Code remains the viewer; Figma MCP remains the agent context/write interface.
7. **No disruptive automation:** scanning is background/debounced; token requests and manifest writes require an explicit user action.
8. **Theme/accessibility:** use VS Code theme tokens/native components; status must not depend on color alone.

## 3. Information architecture

Recommended Activity Bar container: **FigBridge** (icon: neutral linked frame/code symbol). Top-level groups:

- **Overview** — current workspace status and aggregate counts.
- **Figma Files** — configured files, link, validation status and last refreshed metadata.
- **Mapped References** — IDs grouped by configured file or code hierarchy.
- **Unresolved** — source annotations whose IDs are missing from manifest or malformed.
- **Unused Mappings** — manifest refs with no occurrence in current scanned source.
- **Invalid / Unavailable** — inaccessible files, missing nodes, unsupported reference formats.
- **Preview Cache** — stale, expired, failed previews and clear/refresh actions.
- **Claude Activity** — only if opt-in hooks are enabled; recent sanitized Figma MCP operations and refresh status.

The TreeView should support context menus. The Overview may be native content or a Webview. Keep the primary view useful without JavaScript; prefer TreeView for navigation and reserve Webview for thumbnail galleries/more complex table layouts.

## 4. Dashboard layout

### Overview header
- Project/workspace name.
- Current configuration state: valid / warning / invalid.
- Figma connection state: connected / not configured / offline / auth error.
- Last full source scan and last successful remote validation.
- Buttons/commands: **Rescan**, **Validate Figma mappings**, **Add reference**, **Open config**, **Refresh previews**, **Setup Claude integration**.

### Summary counters
Show at least:
- Annotation occurrences.
- Unique IDs used.
- Manifest mappings unused by code.
- Unresolved annotation IDs.
- Mappings with invalid or unavailable Figma nodes.
- Stale/failed previews.

Each counter is clickable and applies the corresponding filter. Counters should show “—” or “Unknown” when indexing is incomplete, rather than a misleading zero.

### Reference row/card
- Thumbnail preview where cached/available.
- Human-readable name.
- Opaque ID (copy action).
- Figma file alias and node ID.
- Source usage count and top source location.
- Health state with text label.
- Actions: open Figma, open source, preview, copy annotation, refresh node.

### Empty states
- No config: explain how to initialize.
- No annotations: show example annotation and “Create reference” action.
- No PAT: explain secure setup; do not show a token field in the Webview.
- No mapped refs: differentiate empty project from invalid configuration.
- Scan incomplete: name skipped languages/folders and offer retry.
- No recent Claude events: explain how to opt in; don't imply that Claude is already connected.

## 5. Hover design

Hover content is deliberately compact:

1. Preview image (target width 320–420 px, subject to VS Code hover layout constraints).
2. Node title and reference ID.
3. Figma file name/alias.
4. Short status: cached, stale, refreshing, offline, unresolved.
5. Open-in-Figma action through a trusted extension command/link or an accompanying CodeLens/command if direct clickable action in the hover is unreliable.

Do not show a full table, raw API JSON, API token status details unrelated to the hovered node, or large tool logs. Image alt text should state “Figma preview: <node name>”. If an image is unavailable, show the reason and a direct link.

## 6. Code adornments

- **Hover provider:** triggered over the opaque ID token and optionally the whole annotation directive.
- **CodeLens:** optional `Open Figma · Preview · Copy ID` above a declaration that has a resolved annotation. Avoid CodeLens clutter for every nested reference by making it configurable.
- **Diagnostics:** unresolved/malformed references get a warning with source range and quick actions. Do not mark a normal code line as an error that blocks builds.
- **Decorations:** minimally use icons/status in the gutter only when explicitly enabled; avoid persistent visual noise.

## 7. Status semantics and wording

| Status | Meaning | Recommended label |
|---|---|---|
| Resolved | ID exists in manifest and file/node can be resolved locally or remotely | `Mapped` |
| Unresolved annotation | Code ID has no manifest entry | `Missing mapping` |
| Unused mapping | Manifest entry has zero source occurrences after a complete scan | `Unused in code` |
| Invalid node | Remote validation confirms node not found in configured file | `Node missing` |
| Access denied | Token valid but file isn't accessible/scoped | `No access` |
| Offline unknown | No remote check available and cached/local mapping exists | `Not checked offline` |
| Preview stale | Cache is expired or an event may have changed the design | `Refresh needed` |
| Preview failed | Most recent render attempt failed | `Preview unavailable` |
| Unsupported association | Scanner found comment, but language adapter can't identify owning declaration | `Owner unknown` |
| Incomplete index | One or more workspace folders/languages weren't fully scanned | `Scan incomplete` |

“Unused” never means that a Figma node is unused in the Figma design system; it only means the configured registry entry has no source occurrence under the current scan.

## 8. Interaction rules

- Keyboard actions must exist for all context-menu-only actions.
- All navigation must support keyboard focus and reveal the source location.
- Clicking a node title should choose the configured default: open Figma; secondary action opens code.
- The view remembers filters within the current VS Code session, but should not store potentially sensitive source text.
- Destructive actions (delete reference from manifest, clear all cache, remove token, uninstall hooks) require confirmation when data would be lost.
- Generate ID should show a diff preview of the manifest/source changes before commit.
- Avoid an action called “Sync” unless its actual semantics (metadata check, preview render, or manifest update) are stated explicitly.

## 9. Figma visual system and branding

- Use standard VS Code light/dark/high-contrast theme colors for views and code decorations.
- Prefer built-in Codicons for status and action affordances.
- A small custom icon may combine a code bracket and frame outline, but should avoid using Figma's brand mark as if this were an official Figma product.
- Avoid bright color cards for all counters; use restrained status colors and textual labels.
- Dashboard thumbnails should preserve aspect ratio and use contain rather than crop by default so entire screens remain visible.
- Long file names and IDs should be ellipsized but available by tooltip/copy action.

## 10. Figma viewer coexistence

The extension should:
- open a canonical URL via VS Code's external URI handler;
- optionally add or inspect documented Figma Dev resources when supported by public APIs and permissions;
- not depend on internal command IDs or internal Webview messages from the official extension;
- not claim to select a frame inside the official extension if it only opened an external browser tab;
- provide fallback URL and copy command when embedded navigation cannot be requested.

## 11. Accessibility

- Status has text, not only color.
- Thumbnail alt text includes mapped node name and file alias.
- Tree items have clear accessibility labels.
- Keyboard focus order is predictable.
- Reduced motion is respected; no animations are required for MVP.
- Webview uses semantic elements, accessible table headers and visible focus.
- Contrast follows VS Code theme constraints rather than hardcoded brand colors.

## 12. UX validation tasks

Run usability tests with at least 3 developers in different languages/workspaces:
1. Find the Figma frame for a source class in under 5 seconds.
2. Identify missing mappings from dashboard without reading documentation.
3. Explain the difference between “unused mapping” and “missing mapping”.
4. Repair an invalid file/node reference.
5. Understand whether a preview is fresh after a Claude MCP operation.
6. Add a reference without accidentally writing a PAT to a file.
7. Work offline and correctly interpret unknown validation state.
