# FigBridge

Link source code to the exact Figma frame or component it implements, using short, stable IDs in ordinary comments.

```dart
/// @figma F7KQ9M2X4P6D
class CheckoutScreen extends StatelessWidget { … }
```

```tsx
// @figma 8J3TD9PH6Q2W
export function CheckoutSummary() { … }
```

A committed `figma.design.yaml` maps each ID to a Figma file and node. You can also paste a Figma link directly, with no manifest entry needed:

```tsx
// @figma https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers?node-id=1-520
export function FoodCard() { … }
```

FigBridge then gives you:

- **Hover previews.** A rendered image of the exact node, with its name, file and status.
- **Open in Figma.** Opens the node itself, not just the file.
- **Mapping health.** Annotations, mappings, unused mappings, unknown or malformed IDs, and deleted nodes, all in the FigBridge sidebar and the Problems panel.
- **Source and design hierarchy.** Annotated screens contain annotated components. Design-side parents can be declared in the manifest. The two hierarchies are kept separate.
- **Claude Code integration (optional).** Claude can resolve `@figma` IDs through a read-only MCP server. After Claude edits a design with the Figma MCP, the affected previews are marked stale.

FigBridge works alongside the official Figma for VS Code extension and the Figma MCP. It doesn't replace either one.

## Quick start

1. **Create a manifest.** Run **FigBridge: Create Manifest** and paste a link to your Figma file. This writes `figma.design.yaml` at the workspace root.
2. **Add a token.** Run **FigBridge: Set Figma Access Token**. Create a *personal access token* in Figma → Settings → Security with these read-only scopes:
   - `file_content:read`
   - `file_metadata:read`

   The token is stored only in VS Code's secret storage.
3. **Annotate code.** In Figma, right-click a frame → *Copy link to selection*. Then in VS Code, put the cursor above a class or function and run **FigBridge: Insert Figma Reference…**. FigBridge generates an ID, adds the mapping to the manifest and inserts the comment.
4. Hover the ID.

## Annotations

- **Syntax:** `@figma <ID>` or `@figma <Figma link>`, inside a comment. Any comment style works (`//`, `///`, `/* */`, JSX `{/* */}`).
- **Links vs IDs:**
  - A link needs no manifest. It must select a node; in Figma, use *Copy link to selection*.
  - An ID keeps comments short and lets you retarget or retire mappings in one place.
  - When the manifest maps the same node, a link annotation shows that mapping's name and counts as a use of it.
- **What is ignored:** text inside strings, template literals and JSX text is never treated as an annotation.
- **ID format:** 12 characters from `0-9 A-Z`, excluding `I L O U` (Crockford Base32, 60 random bits).
- **What IDs are and aren't:** they are opaque and stable when files or frames are renamed. They are **not** secrets. Anyone with the manifest can resolve them, and Figma's own permissions still decide who can see a design.
- **Language support:**

| Language | What FigBridge understands |
|---|---|
| TypeScript, JavaScript, TSX, JSX | Full syntax: which declaration or JSX element a comment annotates, and nesting |
| Dart / Flutter | Full syntax: classes, methods, functions, top-level variables, widget expressions, nesting |
| Other languages (Python, Kotlin, Swift, Go, Rust, …) | Comments only, matched to the file; no declaration or nesting info. Add them to `settings.scan.include`. |

An annotation directly above a declaration belongs to that declaration. An annotation above an expression, such as a widget or JSX element, marks a *usage*. The source hierarchy nests annotations inside the nearest annotated declaration that encloses them.

## The manifest

FigBridge finds every `figma.design.yaml` in the workspace. Each one defines a project rooted at its directory, so a monorepo can keep one manifest per app. Files outside every manifest still get link annotations.

```yaml
schemaVersion: 1
project:
  name: food-couriers

files:
  app:
    name: Food Couriers app
    url: "${env:FIGMA_FILE_URL}"      # or a literal https://www.figma.com/design/… URL

refs:
  F7KQ9M2X4P6D:
    file: app
    nodeId: "1:666"                   # API form: colon, not hyphen
    name: Order details
    kind: screen                      # screen | component | variant | asset | section | other
    tags: [checkout]
  8J3TD9PH6Q2W:
    file: app
    nodeId: "1:667"
    parentRef: F7KQ9M2X4P6D           # optional logical parent
    deprecated: true                  # optional
    replacedBy: H2C4N6P8R0T2          # optional

retired: [RETRD0000001]               # IDs that must never be reused

settings:
  preview: { format: png, scale: 1, ttlMinutes: 1440, hoverWidth: 360 }
  scan:
    include: ["**/*.{ts,tsx,js,jsx,dart}"]
    exclude: ["**/generated/**"]      # added to the built-in excludes (node_modules, build, …)
```

- **Environment placeholders:** only `${env:FIGMA_…}` is allowed. Values come from the process environment, or from the workspace `.env` file in trusted workspaces. Only the variables the manifest names are read.
- **No secrets:** tokens are rejected in the manifest.
- **Validation:** the file is checked against a JSON Schema, with line-accurate errors. If you save an invalid edit, FigBridge keeps using the last valid version.
- **Schema completions:** with the Red Hat YAML extension installed, you get completions from the bundled schema.

## Previews, caching and Figma rate limits

- **Cost of a render:** an uncached render calls Figma's render API and usually takes **5–10 seconds**. The hover shows "Rendering…" and the image appears the next time you hover. **FigBridge: Preview Design** opens a larger view that updates itself.
- **Where images are cached:** in VS Code's extension storage, never in your repository. The default cap is 250 MB, controlled by `figbridge.cache.maxMB`. Set `figbridge.preview.persist` to `false` to keep images in memory only.
- **Staying current:** after `ttlMinutes`, FigBridge first checks the file's version with a cheap metadata call. It re-renders only if the file changed.
- **Rate limits.** Figma limits renders based on the plan that owns the file:
  - Starter-plan files, and View or Collab seats: only a few render requests per month.
  - Dev and Full seats on paid plans: about 10–20 per minute.

  Logging in with OAuth wouldn't raise these limits. FigBridge keeps its usage low:
  - **Batched renders.** One request renders every reference in a Figma file, up to 50 nodes, so the first hover in a file prepares all of its previews.
  - **Starter-file detection.** When Figma reports a Starter-plan or low-quota file, FigBridge stops rendering on hover and shows when renders are allowed again. **FigBridge: Render All Previews** then renders everything with one request per file.
  - **Cheap revalidation.** Previews are checked through the file-metadata endpoint, which has a separate, larger budget, and are re-rendered only when the file changed.
  - **No rendering while scanning.** Duplicate requests are merged, and FigBridge waits as long as Figma asks after a 429, even across restarts.

## Claude Code integration (optional)

Run **FigBridge: Set Up Claude Code Integration…**. It shows exactly what will happen, then runs `claude plugin marketplace add …` and `claude plugin install figbridge@figbridge-local` in a terminal. FigBridge never edits your `.mcp.json`, settings or `CLAUDE.md`.

**What the plugin adds:**
- **A read-only MCP server** with `figbridge_resolve_ref`, `figbridge_search_refs`, `figbridge_refs_for_source` and `figbridge_health`. It reads only `figma.design.yaml` and the source files the manifest selects. It never needs your Figma token and never uses the network.
- **Hooks** on `PostToolUse` and `PostToolUseFailure` for Figma MCP tools. They record a small, sanitised event in a per-user folder, outside the repository. FigBridge then marks the affected previews stale.
  - **Failed calls** are shown as failures, never as updates.
  - **Unknown target:** when Claude's call doesn't say which file changed, FigBridge shows *target unknown* and asks you to refresh.
- **A skill** that tells Claude how to use `@figma` references.

**`/figbridge` in Claude Code:** type something like `/figbridge implement all annotated widgets from their Figma references`. Claude then:
- finds the annotated declarations;
- resolves each one to its Figma node and reads the design through the Figma MCP;
- writes the UI only, in your project's framework, reusing your theme and components.

Before replacing UI that already exists, it asks: overwrite, skip, overwrite all for this run, or always overwrite in this project. Saying "don't ask me" in the request skips the questions. The "always" choice is saved in `.claude/figbridge.local.json`.

**Requirements and removal:** the plugin needs Node.js 20+ on your `PATH`. Remove it with `claude plugin uninstall figbridge@figbridge-local`.

## Privacy and security

- **No telemetry, no FigBridge servers.** The only network calls go to `api.figma.com` and Figma's image CDN, using your token.
- **Untrusted workspaces:** FigBridge only scans annotations. It doesn't call Figma, read `.env` or process Claude events.
- **Webview:** the preview panel runs no scripts.
- **Deleting local data:** **FigBridge: Delete All Local FigBridge Data…** removes cached previews, Claude activity and the stored token.

## Commands

**Navigation and previews:**
- Open in Figma · Preview Design · Render All Previews · Refresh Preview · Refresh Previews for Figma File · Refresh All Cached Previews
- Validate Mappings Against Figma · Rescan Workspace

**Mappings:**
- Insert Figma Reference… · Create Mapping for Reference… · Retarget Mapping… · Retire Mapping…
- Copy Annotation · Copy Figma URL · Find Reference… (filters: `status:unused`, `lang:dart`, `file:app`, `tag:checkout`, `kind:screen`)

**Setup and data:**
- Create Manifest · Open Manifest
- Set / Forget Figma Access Token
- Set Up Claude Code Integration…
- Clear Preview Cache · Clear Claude Activity · Delete All Local FigBridge Data…

## Settings

| Setting | Default | |
|---|---|---|
| `figbridge.manifestPath` | `figma.design.yaml` | Manifest location relative to the workspace folder |
| `figbridge.hover.enabled` | `true` | |
| `figbridge.hover.waitMs` | `1500` | How long a hover waits for an uncached render |
| `figbridge.codeLens.enabled` | `true` | |
| `figbridge.preview.persist` | `true` | `false` = memory-only previews |
| `figbridge.cache.maxMB` | `250` | |
| `figbridge.openWith` | `browser` | `figmaExtension` (experimental) uses the Figma for VS Code extension's undocumented URI handler |
| `figbridge.claude.recordReads` | `false` | Also list Figma MCP reads in Claude Activity |

## Known limitations

- **Preview staleness:** previews can't detect Figma changes instantly. They are refreshed by TTL plus version checks, Claude events, or a manual refresh.
- **Remote hosts:** on remote extension hosts (SSH, WSL, Codespaces), small previews are shown inline and larger ones in the preview panel.
- **Official Figma panel:** FigBridge can't open a node inside the official Figma for VS Code panel through a supported API. It opens the node in your browser or the Figma app instead.
