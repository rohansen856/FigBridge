#!/usr/bin/env bash
# Rebuilds packages/core/wasm/tree-sitter-dart.wasm with the current tree-sitter CLI.
# The npm tarball's prebuilt .wasm uses the pre-0.22 `dylink` section and does not load
# in web-tree-sitter >= 0.25, so the grammar is rebuilt from its sources.
set -euo pipefail
GRAMMAR_VERSION="1.0.0"          # npm tree-sitter-dart (UserNobody14/tree-sitter-dart, MIT)
CLI_VERSION="0.27.1"             # must produce the ABI that web-tree-sitter (packages/core) loads
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
npm pack "tree-sitter-dart@${GRAMMAR_VERSION}" --silent >/dev/null
tar xzf "tree-sitter-dart-${GRAMMAR_VERSION}.tgz"
cd package
npx --yes "tree-sitter-cli@${CLI_VERSION}" build --wasm -o "$ROOT/packages/core/wasm/tree-sitter-dart.wasm" .
cp LICENSE "$ROOT/packages/core/wasm/tree-sitter-dart.LICENSE"
echo "Built $ROOT/packages/core/wasm/tree-sitter-dart.wasm"
