#!/usr/bin/env bash
# scripts/graph/update.sh — incremental AST-only graph refresh.
#
# Re-extracts only changed files against the existing graphify-out/graph.json,
# exiting 0 with a "no changes" message when the graph is already current.
# Local only: no LLM calls, no API keys, safe to run inside any git worktree.
#
# Usage: ./scripts/graph/update.sh [extra graphify args...]
# Env:   GRAPHIFY_FORCE=1  bypass graphify's shrink guard after intentional
#                          file deletions (see scripts/graph/README.md).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
OUT_DIR="$REPO_ROOT/graphify-out"

if [[ ! -f "$OUT_DIR/graph.json" ]]; then
  echo "No graph found at $OUT_DIR/graph.json — run ./scripts/graph/build.sh first." >&2
  exit 1
fi

if ! command -v graphify >/dev/null 2>&1; then
  echo "graphify CLI not found — installing pinned toolchain into the active environment..."
  python3 -m pip install -r "$SCRIPT_DIR/requirements.txt"
fi

echo "Refreshing code graph (incremental) for $REPO_ROOT ..."
cd "$REPO_ROOT"
graphify update "$REPO_ROOT" "$@"
