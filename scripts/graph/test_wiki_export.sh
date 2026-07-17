#!/usr/bin/env bash
# scripts/graph/test_wiki_export.sh
#
# Offline tests for scripts/graph/wiki_export.py: pins that a graphify
# node-link graph.json (plus an optional .graphify_analysis.json) is
# rendered into an agent-crawlable wiki - one index.md plus exactly one
# community-NN-slug.md article per community, no "Community N" placeholder
# leaks, god/surprise content surfaced, deterministic output, and graceful
# behavior when the analysis file is omitted.
#
# Run:  bash scripts/graph/test_wiki_export.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO/scripts/graph/wiki_export.py"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }
check() { # check <desc> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}
check_contains() { # check_contains <desc> <haystack> <needle>
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1 (expected '$2' to contain '$3')"; fi
}
assert_exists() { # assert_exists <desc> <path>
  if [[ -e "$2" ]]; then ok "$1"; else bad "$1 (missing: $2)"; fi
}
assert_missing() { # assert_missing <desc> <path>
  if [[ ! -e "$2" ]]; then ok "$1"; else bad "$1 (unexpectedly present: $2)"; fi
}
count_occurrences() { # count_occurrences <path> <needle> -> match count, 0 if unreadable
  grep -Fc -- "$2" "$1" 2>/dev/null || true
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

write_fixtures() { # write_fixtures <graph_path> <analysis_path>
  python3 - "$1" "$2" <<'PY'
import json
import sys

graph_path, analysis_path = sys.argv[1], sys.argv[2]

nodes = [
    {"id": "src_a", "label": "a.py", "source_file": "src/a.py",
     "source_location": "L1", "community": 0, "community_name": "Practice Engine"},
    {"id": "src_a_foo", "label": "foo()", "source_file": "src/a.py",
     "source_location": "L10", "community": 0, "community_name": "Practice Engine"},
    {"id": "src_a_bar", "label": "bar()", "source_file": "src/a.py",
     "source_location": "L20", "community": 0, "community_name": "Practice Engine"},
    {"id": "src_b", "label": "b.py", "source_file": "src/b.py",
     "source_location": "L1", "community": 1, "community_name": "Candle & Ink Tokens"},
    {"id": "src_b_baz", "label": "baz()", "source_file": "src/b.py",
     "source_location": "L5", "community": 1, "community_name": "Candle & Ink Tokens"},
]
links = [
    {"source": "src_a", "target": "src_a_foo", "relation": "contains"},
    {"source": "src_a", "target": "src_a_bar", "relation": "contains"},
    {"source": "src_b", "target": "src_b_baz", "relation": "contains"},
]
graph = {
    "directed": True,
    "multigraph": False,
    "graph": {},
    "nodes": nodes,
    "links": links,
}
analysis = {
    "communities": {"0": ["src_a", "src_a_foo"], "1": ["src_b"]},
    "gods": [{"id": "src_a_foo", "label": "foo()", "degree": 4}],
    "surprises": [
        {
            "source": "baz()",
            "target": "foo()",
            "source_files": ["src/b.py", "src/a.py"],
            "relation": "calls",
            "why": "bridges separate communities",
        }
    ],
    "questions": [],
}

with open(graph_path, "w", encoding="utf-8") as fh:
    json.dump(graph, fh, indent=2, sort_keys=True)
with open(analysis_path, "w", encoding="utf-8") as fh:
    json.dump(analysis, fh, indent=2, sort_keys=True)
PY
}

GRAPH="$WORK/graph.json"
ANALYSIS="$WORK/analysis.json"
write_fixtures "$GRAPH" "$ANALYSIS"

# --- scenario 1: exit 0 and index.md created --------------------------------
OUT1="$WORK/out1"
RC=0
python3 "$SCRIPT" --graph "$GRAPH" --analysis "$ANALYSIS" --out-dir "$OUT1" \
  >"$WORK/run1.log" 2>&1 || RC=$?
check "scenario 1: wiki_export exits 0" "0" "$RC"
assert_exists "scenario 1: index.md created" "$OUT1/index.md"

# --- scenario 2: exactly one article per community ---------------------------
ARTICLE_COUNT="$(find "$OUT1" -maxdepth 1 -name 'community-*.md' 2>/dev/null \
  | wc -l | tr -d ' ' || true)"
check "scenario 2: exactly one article per community" "2" "$ARTICLE_COUNT"
assert_exists "scenario 2: practice engine article filename" \
  "$OUT1/community-00-practice-engine.md"
assert_exists "scenario 2: candle ink tokens article filename" \
  "$OUT1/community-01-candle-ink-tokens.md"
assert_missing "scenario 2: community id is zero-padded, not bare" \
  "$OUT1/community-0-practice-engine.md"

# --- scenario 3: index.md names every community ------------------------------
INDEX_CONTENT="$(cat "$OUT1/index.md" 2>/dev/null || true)"
check_contains "scenario 3: index mentions Practice Engine" \
  "$INDEX_CONTENT" "Practice Engine"
check_contains "scenario 3: index mentions Candle & Ink Tokens" \
  "$INDEX_CONTENT" "Candle & Ink Tokens"
check_contains "scenario 3: index links to practice engine article" \
  "$INDEX_CONTENT" "community-00-practice-engine.md"
check_contains "scenario 3: index links to candle ink tokens article" \
  "$INDEX_CONTENT" "community-01-candle-ink-tokens.md"

# --- scenario 4: no unnamed placeholder leaks --------------------------------
PLACEHOLDER_0="$(count_occurrences "$OUT1/index.md" "Community 0")"
PLACEHOLDER_1="$(count_occurrences "$OUT1/index.md" "Community 1")"
check "scenario 4: no 'Community 0' placeholder in index" "0" "$PLACEHOLDER_0"
check "scenario 4: no 'Community 1' placeholder in index" "0" "$PLACEHOLDER_1"

# --- scenario 5: article content ---------------------------------------------
PE_CONTENT="$(cat "$OUT1/community-00-practice-engine.md" 2>/dev/null || true)"
CI_CONTENT="$(cat "$OUT1/community-01-candle-ink-tokens.md" 2>/dev/null || true)"
check_contains "scenario 5: practice engine article lists member label a.py" \
  "$PE_CONTENT" "a.py"
check_contains "scenario 5: practice engine article lists god node foo()" \
  "$PE_CONTENT" "foo()"
check_contains "scenario 5: surprise line appears in a community article" \
  "$PE_CONTENT $CI_CONTENT" "bridges separate communities"

# --- scenario 6: determinism --------------------------------------------------
OUT2="$WORK/out2"
RC=0
python3 "$SCRIPT" --graph "$GRAPH" --analysis "$ANALYSIS" --out-dir "$OUT2" \
  >"$WORK/run2.log" 2>&1 || RC=$?
check "scenario 6: second run exits 0" "0" "$RC"
DIFF_RC=0
diff -r "$OUT1" "$OUT2" >"$WORK/diff.log" 2>&1 || DIFF_RC=$?
check "scenario 6: two runs produce byte-identical output" "0" "$DIFF_RC"

# --- scenario 7: missing analysis is graceful --------------------------------
OUT3="$WORK/out3"
RC=0
python3 "$SCRIPT" --graph "$GRAPH" --out-dir "$OUT3" \
  >"$WORK/run3.log" 2>&1 || RC=$?
check "scenario 7: exits 0 without --analysis" "0" "$RC"
assert_exists "scenario 7: index.md produced without analysis" "$OUT3/index.md"
assert_exists "scenario 7: practice engine article produced without analysis" \
  "$OUT3/community-00-practice-engine.md"
assert_exists "scenario 7: candle ink tokens article produced without analysis" \
  "$OUT3/community-01-candle-ink-tokens.md"

# --- scenario 8: unnamed community falls back to bare id, never a placeholder -
UNNAMED="$WORK/unnamed.json"
python3 - "$UNNAMED" <<'PY'
import json
import sys

nodes = [
    {"id": "src_x", "label": "x.py", "source_file": "src/x.py",
     "source_location": "L1", "community": 7},
    {"id": "src_x_fn", "label": "fn()", "source_file": "src/x.py",
     "source_location": "L4", "community": 7},
    {"id": "orphan", "label": "orphan.py", "source_file": "src/orphan.py",
     "source_location": "L1"},
]
graph = {"directed": True, "multigraph": False, "graph": {},
         "nodes": nodes, "links": []}
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(graph, fh, indent=2, sort_keys=True)
PY

OUT4="$WORK/out4"
RC=0
python3 "$SCRIPT" --graph "$UNNAMED" --out-dir "$OUT4" \
  >"$WORK/run4.log" 2>&1 || RC=$?
check "scenario 8: exits 0 for an unnamed community" "0" "$RC"
assert_exists "scenario 8: bare-id article filename used" \
  "$OUT4/community-07-7.md"
PLACEHOLDER_7="$(count_occurrences "$OUT4/index.md" "Community 7")"
check "scenario 8: no 'Community 7' placeholder leaks" "0" "$PLACEHOLDER_7"
ARTICLE_COUNT_4="$(find "$OUT4" -maxdepth 1 -name 'community-*.md' 2>/dev/null \
  | wc -l | tr -d ' ' || true)"
check "scenario 8: node without a community is skipped (one article only)" \
  "1" "$ARTICLE_COUNT_4"

# --- scenario 9: surprise bridges keyed by (label, file), not label alone -----
# Two unrelated nodes in different communities share the label "helper()" but
# live in different files. A surprise bridge touches only the src/a.py one, so
# it must appear solely in that community's article - never leak into the
# same-labelled node's community in src/b.py.
COLLIDE="$WORK/collide.json"
COLLIDE_ANALYSIS="$WORK/collide_analysis.json"
python3 - "$COLLIDE" "$COLLIDE_ANALYSIS" <<'PY'
import json
import sys

graph_path, analysis_path = sys.argv[1], sys.argv[2]
nodes = [
    {"id": "a_helper", "label": "helper()", "source_file": "src/a.py",
     "source_location": "L1", "community": 0, "community_name": "Alpha"},
    {"id": "a_core", "label": "core()", "source_file": "src/a.py",
     "source_location": "L2", "community": 0, "community_name": "Alpha"},
    {"id": "b_helper", "label": "helper()", "source_file": "src/b.py",
     "source_location": "L1", "community": 1, "community_name": "Beta"},
    {"id": "b_core", "label": "core()", "source_file": "src/b.py",
     "source_location": "L2", "community": 1, "community_name": "Beta"},
    {"id": "c_widget", "label": "widget()", "source_file": "src/c.py",
     "source_location": "L1", "community": 2, "community_name": "Gamma"},
]
graph = {"directed": True, "multigraph": False, "graph": {},
         "nodes": nodes, "links": []}
analysis = {
    "communities": {"0": ["a_helper"], "1": ["b_helper"], "2": ["c_widget"]},
    "gods": [],
    "surprises": [
        {
            "source": "helper()",
            "target": "widget()",
            "source_files": ["src/a.py", "src/c.py"],
            "relation": "calls",
            "why": "alpha reaches into gamma",
        }
    ],
    "questions": [],
}
with open(graph_path, "w", encoding="utf-8") as fh:
    json.dump(graph, fh, indent=2, sort_keys=True)
with open(analysis_path, "w", encoding="utf-8") as fh:
    json.dump(analysis, fh, indent=2, sort_keys=True)
PY

OUT5="$WORK/out5"
RC=0
python3 "$SCRIPT" --graph "$COLLIDE" --analysis "$COLLIDE_ANALYSIS" \
  --out-dir "$OUT5" >"$WORK/run5.log" 2>&1 || RC=$?
check "scenario 9: exits 0 for a colliding-label graph" "0" "$RC"
ALPHA_HITS="$(count_occurrences "$OUT5/community-00-alpha.md" "alpha reaches into gamma")"
BETA_HITS="$(count_occurrences "$OUT5/community-01-beta.md" "alpha reaches into gamma")"
GAMMA_HITS="$(count_occurrences "$OUT5/community-02-gamma.md" "alpha reaches into gamma")"
check "scenario 9: surprise appears in the src/a.py community (Alpha)" \
  "1" "$ALPHA_HITS"
check "scenario 9: surprise does NOT leak into the same-labelled Beta community" \
  "0" "$BETA_HITS"
check "scenario 9: surprise appears in the target community (Gamma)" \
  "1" "$GAMMA_HITS"

# --- summary ------------------------------------------------------------------
echo
echo "wiki export tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
