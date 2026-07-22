#!/usr/bin/env bash
# scripts/graph/test_append_benchmark_trend.sh
#
# Offline tests for scripts/graph/append_benchmark_trend.py: parses the text
# stdout of `graphify benchmark` and appends one per-day record to a JSONL
# trend ledger. The ledger is append-only and idempotent per day - re-running
# on the same date must neither duplicate nor rewrite an earlier line.
#
# Run:  bash scripts/graph/test_append_benchmark_trend.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO/scripts/graph/append_benchmark_trend.py"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }
check() { # check <desc> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The Graph: and Reduction: lines are real `graphify benchmark` stdout verbatim
# (variable space runs, thousands commas); the rest is surrounding noise.
cat >"$WORK/bench.txt" <<'EOF'
Benchmark: graph-assisted retrieval vs full-file reads

  Graph:           16,144 nodes, 36,585 edges
  Queries:         25 sampled
  Reduction:       20.9x fewer tokens per query

Done.
EOF

TREND="$WORK/trend.jsonl"
LINE_DAY1='{"date": "2026-07-10", "reduction_avg": 20.9, "nodes": 16144, "edges": 36585}'
LINE_DAY2='{"date": "2026-07-11", "reduction_avg": 20.9, "nodes": 16144, "edges": 36585}'

run_append() { # run_append <date> -> sets RC
  RC=0
  python3 "$SCRIPT" --benchmark "$WORK/bench.txt" --out "$TREND" --date "$1" \
    >"$WORK/append.log" 2>&1 || RC=$?
}

# --- scenario 1: benchmark stdout -> exact JSONL line ------------------------
run_append 2026-07-10
check "scenario 1: append exits 0" "0" "$RC"
check "scenario 1: exact JSONL line" "$LINE_DAY1" "$(sed -n 1p "$TREND" 2>/dev/null)"
check "scenario 1: exactly one line" "1" "$(wc -l <"$TREND" 2>/dev/null | tr -d ' ')"
check "scenario 1: trailing newline" "" "$(tail -c 1 "$TREND" 2>/dev/null)"
if [[ -s "$WORK/append.log" ]]; then ok "scenario 1: prints a human line"; else bad "scenario 1: prints a human line (log empty)"; fi

# --- scenario 2: same date twice is idempotent -------------------------------
run_append 2026-07-10
check "scenario 2: rerun exits 0" "0" "$RC"
check "scenario 2: still exactly one line" "1" "$(wc -l <"$TREND" 2>/dev/null | tr -d ' ')"
check "scenario 2: line unchanged" "$LINE_DAY1" "$(sed -n 1p "$TREND" 2>/dev/null)"

# --- scenario 3: new date appends, earlier line preserved --------------------
run_append 2026-07-11
check "scenario 3: append exits 0" "0" "$RC"
check "scenario 3: two lines" "2" "$(wc -l <"$TREND" 2>/dev/null | tr -d ' ')"
check "scenario 3: first line byte-for-byte preserved" "$LINE_DAY1" "$(sed -n 1p "$TREND" 2>/dev/null)"
check "scenario 3: second line carries the new date" "$LINE_DAY2" "$(sed -n 2p "$TREND" 2>/dev/null)"

# --- scenario 4: malformed benchmark text exits non-zero ---------------------
printf 'no benchmark lines here\n' >"$WORK/garbage.txt"
RC=0
python3 "$SCRIPT" --benchmark "$WORK/garbage.txt" --out "$WORK/garbage.jsonl" --date 2026-07-10 \
  >"$WORK/garbage.log" 2>&1 || RC=$?
if [[ "$RC" -ne 0 ]]; then ok "scenario 4: malformed benchmark exits non-zero"; else bad "scenario 4: malformed benchmark exits non-zero (got 0)"; fi

# --- scenario 5: empty stdin (default input) exits non-zero ------------------
RC=0
printf '' | python3 "$SCRIPT" --out "$WORK/empty.jsonl" --date 2026-07-10 \
  >"$WORK/empty.log" 2>&1 || RC=$?
if [[ "$RC" -ne 0 ]]; then ok "scenario 5: empty stdin exits non-zero"; else bad "scenario 5: empty stdin exits non-zero (got 0)"; fi

# --- summary -----------------------------------------------------------------
echo
echo "benchmark trend tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
