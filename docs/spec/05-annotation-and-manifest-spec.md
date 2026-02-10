# 05 — Annotation and Manifest Specification

**Schema version:** `1` in the initial implementation.  
**Normative words:** MUST, MUST NOT, SHOULD, MAY.

## 1. Design goals

The syntax must be short, diff-friendly, language-neutral, valid inside existing source comments, and stable when a Figma file slug or selection URL changes. It must not embed API credentials or long URLs. The ID is opaque, but the source manifest remains the authoritative mapping. It is not encryption, an access token, or proof of authorization.

## 2. Canonical source annotation

Canonical directive:

```text
@figma <ID>
```

Recommended examples:

```dart
/// @figma F7KQ9M2X4P6D
class CheckoutScreen extends StatelessWidget {
  // ...
}
```

```tsx
// @figma 8J3TD9PH6Q2W
export function CheckoutSummary() {
  return <section>{/* children */}</section>;
}
```

The directive MUST be inside a source comment. The first adapter version should recognize ordinary line and block comments, plus language-specific documentation comments. It MUST NOT identify annotation-looking text in strings, raw string literals, generated files excluded from the scan, or ordinary Markdown documentation unless a future docs adapter is explicitly enabled.

### Optional future qualifiers (not required for MVP)

Avoid multiplying tags until needed. If the role must be explicit, a future schema may support:

```text
@figma <ID> role=screen
@figma <ID> role=component
@figma <ID> role=variant
```

For MVP, node kind and display metadata are held in the manifest. Hierarchy is inferred from source syntax/containment where the language adapter can determine it, and the Figma parent chain is available from Figma node metadata as a separate relationship.

## 3. Hierarchy semantics

There are two related but distinct hierarchies:

1. **Source hierarchy:** an annotation's containing declaration/component and the enclosing source declaration that owns it.
2. **Figma hierarchy:** the mapped node's parent/child path in the configured Figma file.

The extension must not assume these hierarchies are identical. The dashboard can show both and identify one mapped screen containing several nested annotated code components. If a language adapter knows the AST containment chain, it should report source parent relationships; if the mapping manifest includes an optional `parentRef`, that is an explicit logical override, not a substitute for the actual Figma parent chain.

### Parent mapping

- `parentRef` is optional and references another registered opaque ID.
- If absent, source parent is inferred from AST containment, while Figma parent is inferred from the mapped node's Figma parent chain.
- If explicit parent and inferred design parent differ, show a nonfatal relationship warning; do not silently rewrite either.
- Cycles in explicit parent mappings are invalid.
- Nested source annotations can map to components in separate Figma pages/files; a source parent-child relationship does not require the Figma nodes to have the same parent.

## 4. Opaque identifier algorithm

### Current recommendation

- Length: **12 characters**.
- Alphabet: Crockford Base32: `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (32 symbols, excludes visually confusing `I`, `L`, `O`, `U`).
- Entropy: 60 bits.
- Generation: cryptographically secure random source, with unbiased encoding (e.g., rejection sampling or a correct 60-bit extraction); no sequential counters or truncated timestamps.
- Collision handling: check current manifest before accepting; on collision regenerate; tests should simulate collision behavior.
- Normalization: IDs are stored upper-case. Parser may uppercase lower-case input for a helpful suggestion, but canonical saved IDs must be upper-case.
- Validation regex: `^[0-9A-HJKMNP-TV-Z]{12}$` (ensure implementation matches the intended alphabet exactly).

Twelve Base32 characters give 60 bits of namespace. For a million randomly generated references, the birthday-bound collision probability is roughly 4.3×10⁻⁷ before manifest collision checks. A collision check makes any observed collision recoverable. If expected registry sizes or policy change, ID length can be revised only through a schema migration.

### Why not encryption?

A reversible encrypted value would require key management and would create a false impression that the annotation is secret. Once a mapping manifest is committed to Git, anyone with that manifest can resolve the ID. The useful goals are brevity, readability and stable lookup; a random opaque ID provides them directly.

### ID immutability

- An ID MUST NOT be reused for a different file/node mapping once committed.
- To retarget a design, update that ID's mapping only with an explicit migration warning/review; the recommended default is to create a new ID and deprecate the old one.
- A rename of the Figma file slug does not require a new ID because the manifest stores file key and node ID separately.
- If a node is deleted/recreated and gets a new node ID, an explicit mapping repair is required.
- IDs are workspace/repository identifiers, not globally registered identifiers. Accidental reuse across repositories is acceptable unless those repositories later share a central registry.

## 5. Manifest source of truth

Filename default: `figma.design.yaml`.

The manifest MUST be version-controlled when the team wants consistent code mappings. It may include direct base URLs or environment placeholders. It MUST NOT contain a PAT, OAuth refresh token, session cookie, signed render URL, or transient Figma tracking/session parameter.

### Example

```yaml
schemaVersion: 1
project:
  name: food-couriers-app

settings:
  # Values must be plain strings or explicitly recognized ${env:NAME} placeholders.
  preview:
    format: png
    scale: 1
    cacheTtlMinutes: 1440
    maxWidth: 420
  scan:
    include:
      - "**/*.{ts,tsx,js,jsx,dart,py,rs,go}"
    exclude:
      - "**/node_modules/**"
      - "**/.git/**"
      - "**/build/**"
      - "**/dist/**"
      - "**/.dart_tool/**"
      - "**/generated/**"

files:
  app:
    name: Main application design
    url: "${env:FIGMA_FILE_URL}"

refs:
  F7KQ9M2X4P6D:
    file: app
    nodeId: "0:1"
    name: Checkout screen
    kind: screen
    tags: [checkout, mobile]
  8J3TD9PH6Q2W:
    file: app
    nodeId: "12:34"
    name: Checkout summary card
    kind: component
    parentRef: F7KQ9M2X4P6D
```

The example is illustrative. The official implementation MUST validate all fields through the versioned JSON Schema; unknown fields should either produce a clear warning or fail in strict mode, rather than being silently interpreted.

## 6. Figma file config rules

Each `files` entry has a stable local alias and one of:
- `url`: canonical HTTPS Figma URL or `${env:FIGMA_FILE_URL}` placeholder.
- `fileKey` plus optional `baseUrl`/slug metadata if URL is not required.

The extension MUST extract and validate the file key. The canonical file URL should omit node-specific query params and transient values. Node selection lives in the reference. The manifest may hold multiple files with different aliases.

`nodeId` MUST be stored in API canonical form with a colon (e.g. `0:1`). The Figma URL builder converts this to the URL query form (e.g. `node-id=0-1`). `nodeId` is a string because node identifiers are not numeric database primary keys.

Environment substitution rules:
- Only `${env:UPPERCASE_NAME}` is supported initially.
- The extension may read OS environment plus values from a workspace `.env` file only if configured/available.
- Only allowlisted names used by manifest fields are read; do not make the entire process environment available to a Webview or MCP.
- The primary allowed initial variable is `FIGMA_FILE_URL`; users may define aliases such as `FIGMA_FILE_URL_APP` after schema support is added.
- `.env` is never the preferred credential store. PAT goes to VS Code SecretStorage.
- Values containing malformed URLs or non-HTTPS hosts fail validation.

## 7. Manifest invariants

- `schemaVersion` is required and supported values are explicit.
- Reference ID keys are unique and valid opaque IDs.
- Every `refs.<id>.file` points to an existing file alias.
- Every `refs.<id>.nodeId` is a non-empty normalized node identifier.
- `parentRef`, if supplied, points to an existing ID and the parent graph is acyclic.
- `file` entries must parse to unique file keys unless aliases deliberately point to one same file; duplicate file keys should trigger a warning to reduce confusion.
- `nodeId` may be shared by more than one reference ID only with an explicit warning or use case (e.g. aliases/roles); do not automatically deduplicate because labels/semantics may differ.
- `name`, `kind` and `tags` are labels/metadata, not lookup keys.
- Manifest edits are atomic from the extension perspective: load/validate new version before replacing last-known-good state.

## 8. Annotation-to-mapping resolution

Given an annotation occurrence:
1. Parse ID according to grammar.
2. Normalize case only for diagnostics; canonical ID is uppercase.
3. Look up `refs[ID]`.
4. Resolve its `file` alias.
5. Parse/resolve that file's canonical URL or key.
6. If offline/unvalidated, local resolution state is `configured-unverified`; do not mark it invalid.
7. If remote node check returns not found/null, mark `node-missing`.
8. Fetch/render preview only on hover, dashboard request, or refresh—not for every annotation during initial scan.

## 9. Quick actions and code edits

- “Generate reference” creates a new ID and a pending mapping proposal, then writes through a VS Code `WorkspaceEdit` only after user confirmation.
- “Copy annotation” copies the canonical comment directive, not the Figma URL.
- “Open Figma” resolves the manifest and builds a URL with `node-id` selected.
- “Retarget mapping” must show old and new canonical file/node values and require confirmation.
- “Delete mapping” should warn if code usages exist and offer to remove annotations, preserve them unresolved, or cancel. The safe default is cancel.

## 10. Migration and schema evolution

- Schema uses integer `schemaVersion`.
- Future schema updates must include a migration routine or a clear manual migration diagnostic.
- Never rewrite schema silently on activation.
- Preserve comments and key ordering on YAML edits where feasible; if a library rewrites the whole file, prefer adding a new entry with minimal formatting churn or generate a patch that preserves existing text.
- Unknown future schema versions result in read-only mode with a precise message, not destructive edits.

## 11. URL examples

Input:
`https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers---Food-Delivery-App?node-id=0-1&p=f&t=example-0`

Normalized file base (conceptual):
`https://www.figma.com/design/aHvbMOTkjQ3dmWBoWbMuv2/Food-Couriers---Food-Delivery-App`

Stored config: file alias `app`, normalized base URL or environment placeholder.  
Stored reference: `nodeId: "0:1"`.  
Annotation: `@figma F7KQ9M2X4P6D`.  
Generated open URL: base URL + `?node-id=0-1`.

The sample IDs here are examples only. Implementations must generate IDs from a secure random source and check the manifest for collisions.
