#!/usr/bin/env bash
# scripts/graph/test_semantic_staleness.sh
#
# Offline tests for scripts/graph/semantic_staleness.py: reads a published
# graph-meta.json and reports whether the semantic layer is stale (built more
# than STALE_AFTER_DAYS = 14 days ago). Cron-safe contract: every invocation
# exits 0 - staleness is reported via stdout and $GITHUB_OUTPUT, never via
# the exit code.
#
# Run:  bash scripts/graph/test_semantic_staleness.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO/scripts/graph/semantic_staleness.py"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }
check() { # check <desc> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}
has_line() { # has_line <desc> <file> <exact line>
  if grep -qxF -- "$3" "$2" 2>/dev/null; then ok "$1"; else bad "$1 (no line '$3' in $2)"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# built_at fixtures are real timestamps offset from UTC now (no mocked clock),
# placed well clear of - or exactly on - the 14-day threshold.
built_at_days_ago() { # built_at_days_ago <days>
  python3 -c 'import datetime as dt, sys; print((dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=int(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"
}

write_meta() { # write_meta <path> <kind> <built_at or "">
  python3 - "$1" "$2" "$3" <<'PY'
import json
import sys

path, kind, built_at = sys.argv[1], sys.argv[2], sys.argv[3]
meta = {"kind": kind}
if built_at:
    meta["built_at"] = built_at
with open(path, "w", encoding="utf-8") as fh:
    json.dump(meta, fh)
PY
}

run_staleness() { # run_staleness <meta path> -> sets RC, fills $OUT
  OUT="$WORK/gh_output.txt"
  : >"$OUT"
  RC=0
  GITHUB_OUTPUT="$OUT" python3 "$SCRIPT" --meta "$1" >"$WORK/staleness.log" 2>&1 || RC=$?
}

# --- scenario 1: fresh code+semantic meta -> stale=false ---------------------
write_meta "$WORK/meta_fresh.json" "code+semantic" "$(built_at_days_ago 2)"
run_staleness "$WORK/meta_fresh.json"
check "scenario 1: fresh meta exits 0" "0" "$RC"
has_line "scenario 1: stale=false" "$OUT" "stale=false"
has_line "scenario 1: age_days=2" "$OUT" "age_days=2"
if [[ -s "$WORK/staleness.log" ]]; then ok "scenario 1: prints a summary line"; else bad "scenario 1: prints a summary line (log empty)"; fi

# --- scenario 2: aged (>14d) code+semantic meta -> stale=true ----------------
write_meta "$WORK/meta_aged.json" "code+semantic" "$(built_at_days_ago 20)"
run_staleness "$WORK/meta_aged.json"
check "scenario 2: aged meta exits 0" "0" "$RC"
has_line "scenario 2: stale=true" "$OUT" "stale=true"
has_line "scenario 2: age_days=20" "$OUT" "age_days=20"

# --- scenario 3: code-only meta is never stale, even when old ----------------
write_meta "$WORK/meta_code_only.json" "code-only" "$(built_at_days_ago 20)"
run_staleness "$WORK/meta_code_only.json"
check "scenario 3: code-only meta exits 0" "0" "$RC"
has_line "scenario 3: stale=false" "$OUT" "stale=false"
has_line "scenario 3: empty age_days" "$OUT" "age_days="

# --- scenario 4: missing meta file is graceful -------------------------------
run_staleness "$WORK/does_not_exist.json"
check "scenario 4: missing meta exits 0" "0" "$RC"
has_line "scenario 4: stale=false" "$OUT" "stale=false"

# --- scenario 5: exactly 14 days old is NOT stale ----------------------------
write_meta "$WORK/meta_boundary.json" "code+semantic" "$(built_at_days_ago 14)"
run_staleness "$WORK/meta_boundary.json"
check "scenario 5: boundary meta exits 0" "0" "$RC"
has_line "scenario 5: stale=false at the threshold" "$OUT" "stale=false"
has_line "scenario 5: age_days=14" "$OUT" "age_days=14"

# --- summary -----------------------------------------------------------------
echo
echo "semantic staleness tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
