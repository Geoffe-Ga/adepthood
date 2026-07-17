#!/bin/bash
set -euo pipefail

# Install session dependencies only in remote (web) environments; every
# session continues past this block to the graph-restore step below.
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-/home/user/adepthood}"
  cd "$PROJECT_DIR"

  echo "Installing frontend dependencies..."
  cd "$PROJECT_DIR/frontend"
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi

  echo "Installing backend dependencies..."
  cd "$PROJECT_DIR"
  if [ ! -d .venv ]; then
    python3 -m venv .venv
  fi
  source .venv/bin/activate
  pip install -q -r backend/requirements.txt -r backend/requirements-dev.txt

  echo "Installing pre-commit hooks..."
  pip install -q pre-commit
  pre-commit install
  pre-commit install --hook-type commit-msg
  pre-commit install --hook-type pre-push

  echo "Session setup complete."
fi

# Fail-soft graph restore: refresh graphify-out from the rolling knowledge-graph
# release unless a local copy is already fresh; never abort the session on error.
GRAPH_FRESH_MAX_AGE_SECONDS=172800 # 48h
GRAPH_FETCH_TIMEOUT_SECONDS=8
GRAPH_RELEASE_BASE_URL="https://github.com/Geoffe-Ga/adepthood/releases/download/knowledge-graph"

json_is_valid() { # json_is_valid <path>
  python3 - "$1" <<'PY'
import json
import sys

try:
    with open(sys.argv[1]) as handle:
        json.load(handle)
except Exception:  # any read/parse error means invalid
    sys.exit(1)
PY
}

graph_is_fresh() { # graph_is_fresh <graph_dir>
  local graph_dir="$1"
  [ -f "$graph_dir/graph.json" ] || return 1
  [ -f "$graph_dir/graph-meta.json" ] || return 1
  python3 - "$graph_dir/graph-meta.json" "$GRAPH_FRESH_MAX_AGE_SECONDS" <<'PY'
import datetime
import json
import sys

meta_path = sys.argv[1]
max_age_seconds = int(sys.argv[2])
try:
    with open(meta_path) as handle:
        built_at = json.load(handle)["built_at"]
    # macOS python 3.9 rejects a bare trailing "Z"; normalize to an offset.
    timestamp = datetime.datetime.fromisoformat(built_at.replace("Z", "+00:00"))
    now = datetime.datetime.now(datetime.timezone.utc)
    age_seconds = (now - timestamp).total_seconds()
    sys.exit(0 if 0 <= age_seconds <= max_age_seconds else 1)
except Exception:  # any parse error means treat as stale
    sys.exit(1)
PY
}

fetch_optional_asset() { # fetch_optional_asset <tmp_dir> <asset>
  local tmp_dir="$1"
  local asset="$2"
  if curl -fsSL --max-time "$GRAPH_FETCH_TIMEOUT_SECONDS" \
    -o "$tmp_dir/$asset" "$GRAPH_RELEASE_BASE_URL/$asset" &&
    json_is_valid "$tmp_dir/$asset"; then
    return 0
  fi
  rm -f "$tmp_dir/$asset"
  return 0
}

restore_published_graph() {
  local root=""
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR:-}" ]; then
    root="$CLAUDE_PROJECT_DIR"
  else
    root="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)" || root=""
  fi
  if [ -z "$root" ]; then
    echo "warning: graph-restore could not resolve the repo root; skipping" >&2
    return 0
  fi

  local graph_dir="$root/graphify-out"
  if graph_is_fresh "$graph_dir"; then
    return 0
  fi

  local tmp_dir=""
  tmp_dir="$(mktemp -d)" || {
    echo "warning: graph-restore could not create a temp dir; skipping" >&2
    return 0
  }

  # graph.json is required: a failed or malformed download must never clobber
  # an existing graphify-out/graph.json, so validate in the temp dir first.
  if ! curl -fsSL --max-time "$GRAPH_FETCH_TIMEOUT_SECONDS" \
    -o "$tmp_dir/graph.json" "$GRAPH_RELEASE_BASE_URL/graph.json"; then
    echo "warning: graph-restore could not download graph.json; keeping existing graph" >&2
    rm -rf "$tmp_dir"
    return 0
  fi
  if ! json_is_valid "$tmp_dir/graph.json"; then
    echo "warning: graph-restore got malformed graph.json; keeping existing graph" >&2
    rm -rf "$tmp_dir"
    return 0
  fi

  # graph-meta.json and pan-graph.json are best-effort; their failure is silent.
  fetch_optional_asset "$tmp_dir" "graph-meta.json"
  fetch_optional_asset "$tmp_dir" "pan-graph.json"

  mkdir -p "$graph_dir"
  mv -f "$tmp_dir/graph.json" "$graph_dir/graph.json"
  [ -f "$tmp_dir/graph-meta.json" ] && mv -f "$tmp_dir/graph-meta.json" "$graph_dir/graph-meta.json"
  [ -f "$tmp_dir/pan-graph.json" ] && mv -f "$tmp_dir/pan-graph.json" "$graph_dir/pan-graph.json"
  rm -rf "$tmp_dir"
  return 0
}

restore_published_graph || true
