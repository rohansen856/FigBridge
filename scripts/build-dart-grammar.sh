#!/usr/bin/env bash
# Rebuilds packages/core/wasm/tree-sitter-dart.wasm with the current tree-sitter CLI.
# Built from a pinned commit of UserNobody14/tree-sitter-dart (MIT): the npm release
# (1.0.0) predates Dart 3 records/patterns and ships a WASM that current web-tree-sitter
# can't load.
set -euo pipefail
GRAMMAR_REPO="https://github.com/UserNobody14/tree-sitter-dart.git"
GRAMMAR_COMMIT="be07cf7118d3dba06236a3f19541685a68209934"   # Dart 3.10 syntax (records, patterns)
CLI_VERSION="0.27.1"   # must produce the ABI that web-tree-sitter (packages/core) loads
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -C "$WORK" init -q
git -C "$WORK" fetch -q --depth 1 "$GRAMMAR_REPO" "$GRAMMAR_COMMIT"
git -C "$WORK" checkout -q FETCH_HEAD
cd "$WORK"
npx --yes "tree-sitter-cli@${CLI_VERSION}" build --wasm -o "$ROOT/packages/core/wasm/tree-sitter-dart.wasm" .
cp LICENSE "$ROOT/packages/core/wasm/tree-sitter-dart.LICENSE"
echo "Built $ROOT/packages/core/wasm/tree-sitter-dart.wasm from $GRAMMAR_COMMIT"
