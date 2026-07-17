#!/usr/bin/env bash
# scripts/graph/test_scan_graph_preamble.sh
#
# Offline guard tests for two graph-orientation deliverables:
#   1. Every prompts/scans/<scan>.md carries a fail-soft "Graph-first
#      orientation" step inside its ## Context section, kept small enough
#      (<= MAX_PREAMBLE_LINES lines) that it orients without bloating the
#      self-contained scan prompt the reusable _claude-scan.yml runner reads.
#   2. The .claude/skills/graph/SKILL.md skill exists, passes the structural
#      skill-craft bars, links the CLI docs instead of duplicating them, and
#      never claims a non-existent `graphify status` subcommand.
#
# Pure text assertions: no graphify, no network, no build. Run:
#   bash scripts/graph/test_scan_graph_preamble.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCANS_DIR="$ROOT/prompts/scans"
SKILL="$ROOT/.claude/skills/graph/SKILL.md"
MARKER="Graph-first orientation"
FALLBACK="absent or stale"
MAX_PREAMBLE_LINES=8

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }
check_contains() { # check_contains <desc> <file> <needle>
  if grep -qF -- "$3" "$2"; then ok "$1"; else bad "$1 (missing '$3' in $2)"; fi
}
check_absent() { # check_absent <desc> <file> <needle>
  if grep -qF -- "$3" "$2"; then bad "$1 (found forbidden '$3' in $2)"; else ok "$1"; fi
}

# --- group 1: every scan prompt carries a bounded, fail-soft preamble ---------
# while-read instead of mapfile so macOS system bash 3.2 can run this too.
SCANS=()
while IFS= read -r f; do SCANS+=("$f"); done \
  < <(find "$SCANS_DIR" -maxdepth 1 -name '*.md' ! -name '_*' | sort)
if [[ "${#SCANS[@]}" -eq 0 ]]; then
  bad "found scan prompts to check"
fi
for scan in "${SCANS[@]}"; do
  name="$(basename "$scan")"
  check_contains "$name has the graph-orientation marker" "$scan" "$MARKER"
  check_contains "$name states the fail-soft fallback" "$scan" "$FALLBACK"

  # The marker must land inside ## Context (after its heading, before
  # ## Output Format), where the analysis strategy lives — not stranded in
  # Role/Goal.
  marker_line="$(grep -nF -- "$MARKER" "$scan" | head -1 | cut -d: -f1 || true)"
  ctx_line="$(grep -nE -- "^## Context" "$scan" | head -1 | cut -d: -f1 || true)"
  out_line="$(grep -nF -- "## Output Format" "$scan" | head -1 | cut -d: -f1 || true)"
  if [[ -n "$marker_line" && -n "$ctx_line" && -n "$out_line" \
        && "$ctx_line" -lt "$marker_line" && "$marker_line" -lt "$out_line" ]]; then
    ok "$name orientation sits between ## Context and ## Output Format"
  else
    bad "$name orientation is not inside the ## Context body"
  fi

  # Bound the preamble: count from the marker line to the next top-level list
  # item, blank line, or heading; that span is the orientation block itself.
  span="$(awk -v marker="$MARKER" '
    index($0, marker) { started = 1; count = 1; next }
    started {
      if ($0 == "" || $0 ~ /^## / || $0 ~ /^- /) { print count; started = 0; exit }
      count++
    }
    END { if (started) print count }
  ' "$scan")"
  if [[ -n "$span" && "$span" -le "$MAX_PREAMBLE_LINES" ]]; then
    ok "$name orientation block is <= $MAX_PREAMBLE_LINES lines ($span)"
  else
    bad "$name orientation block exceeds $MAX_PREAMBLE_LINES lines (got '${span:-0}')"
  fi
done

# --- group 2: the /graph skill exists and passes structural bars --------------
if [[ ! -f "$SKILL" ]]; then
  bad "graph skill exists at .claude/skills/graph/SKILL.md"
else
  ok "graph skill exists at .claude/skills/graph/SKILL.md"

  frontmatter="$(awk 'NR==1 && $0=="---"{f=1;next} f&&$0=="---"{exit} f{print}' "$SKILL")"
  if [[ -n "$frontmatter" ]]; then ok "skill has a YAML frontmatter block"; else bad "skill has a YAML frontmatter block"; fi
  if printf '%s\n' "$frontmatter" | grep -qE '^name:[[:space:]]*graph[[:space:]]*$'; then
    ok "frontmatter name is 'graph'"
  else
    bad "frontmatter name is 'graph'"
  fi
  # Strip the trailing YAML block-scalar indicator (`>-` / `>`) that keys like
  # `description: >-` legitimately use before checking for XML angle brackets,
  # so a real `<tag>` in the content still trips this but the block scalar does
  # not (skill-craft's rule bans XML in frontmatter, not the block scalar).
  if printf '%s\n' "$frontmatter" | sed -E 's/:[[:space:]]*>-?[[:space:]]*$//' | grep -qE '[<>]'; then
    bad "frontmatter has no XML angle brackets"
  else
    ok "frontmatter has no XML angle brackets"
  fi

  check_contains "skill description advertises the /graph trigger" "$SKILL" "/graph"
  check_contains "skill cross-references flare (do-not-use)" "$SKILL" "flare"
  check_contains "skill cross-references de-slopify (do-not-use)" "$SKILL" "de-slopify"
  check_contains "skill links the CLI docs, not duplicates them" "$SKILL" "scripts/graph/README.md"
  check_contains "skill has an Instructions section" "$SKILL" "## Instructions"
  check_contains "skill has an Examples section" "$SKILL" "## Examples"
  check_contains "skill has a Troubleshooting section" "$SKILL" "## Troubleshooting"
  check_contains "skill documents the pan-graph default" "$SKILL" "pan-graph.json"

  # Accuracy guard: there is no `graphify status` subcommand (only `hook
  # status`); a prior graph PR was rejected for a false CLI claim. The skill's
  # status verb must read graph-meta.json, never invoke `graphify status`.
  check_absent "skill never claims a 'graphify status' subcommand" "$SKILL" "graphify status"
  check_contains "skill status verb reads graph-meta.json" "$SKILL" "graph-meta.json"
fi

# --- summary ------------------------------------------------------------------
echo
echo "scan-graph-preamble tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
