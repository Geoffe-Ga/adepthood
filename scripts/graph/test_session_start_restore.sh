#!/usr/bin/env bash
# scripts/graph/test_session_start_restore.sh
#
# Offline tests for the graph-restore step in .claude/hooks/session-start.sh:
# pins that a stale/missing graphify-out/graph.json is re-fetched from the
# rolling knowledge-graph release, a fresh graph is left alone (no curl call),
# and every failure mode (curl error, malformed download, optional pan-graph
# miss) is strictly fail-soft (single warning line, hook still exits 0).
#
# Run:  bash scripts/graph/test_session_start_restore.sh
set -euo pipefail

HOOK="$(cd "$(dirname "$0")/../../.claude/hooks" && pwd)/session-start.sh"
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
assert_identical() { # assert_identical <desc> <fileA> <fileB>
  if cmp -s "$2" "$3"; then ok "$1"; else bad "$1 ($2 and $3 differ)"; fi
}
assert_valid_json() { # assert_valid_json <desc> <path>
  local rc=0
  python3 -c 'import json,sys
json.load(open(sys.argv[1]))' "$2" >/dev/null 2>&1 || rc=$?
  check "$1" "0" "$rc"
}
log_state() { # log_state <path> -> "empty" or "nonempty"
  if [[ -s "$1" ]]; then echo "nonempty"; else echo "empty"; fi
}
warning_lines() { # warning_lines <path> -> count of lines mentioning warning
  grep -ci 'warning' "$1" || true
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
PROJ="$WORK/proj"
LOG="$WORK/curl.log"
STDOUT="$WORK/stdout.log"
STDERR="$WORK/stderr.log"
mkdir -p "$BIN"

unset CLAUDE_CODE_REMOTE

# Fake curl: logs its full argv, then serves ok/malformed/failing bytes to
# the -o target depending on CURL_MODE (ok|malformed|fail|panfail). panfail
# only fails the pan-graph.json request, so the required assets still land.
cat > "$BIN/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CURL_LOG"
out=""
url=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-o" ]]; then
    out="$arg"
  fi
  case "$arg" in
    http*) url="$arg" ;;
  esac
  prev="$arg"
done
mode="${CURL_MODE:-ok}"
if [[ "$mode" == "fail" ]]; then
  exit 22
fi
if [[ "$mode" == "panfail" && "$url" == *pan-graph.json* ]]; then
  exit 22
fi
if [[ -n "$out" ]]; then
  if [[ "$mode" == "malformed" ]]; then
    printf 'not valid json{' > "$out"
  else
    printf '{"ok": true}' > "$out"
  fi
fi
exit 0
STUB
chmod +x "$BIN/curl"

NOW="$(python3 -c 'import datetime
print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
STALE="$(python3 -c 'import datetime
d = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=3)
print(d.strftime("%Y-%m-%dT%H:%M:%SZ"))')"

reset_fixture() {
  rm -rf "$PROJ"
  mkdir -p "$PROJ"
  : > "$LOG"
}

run_hook() { # run_hook <curl_mode>
  local mode="$1"
  RC=0
  env PATH="$BIN:$PATH" CLAUDE_PROJECT_DIR="$PROJ" CURL_LOG="$LOG" CURL_MODE="$mode" \
    bash "$HOOK" >"$STDOUT" 2>"$STDERR" || RC=$?
}

# --- scenario 1: missing graph triggers restore, guard preserved -----------
reset_fixture
run_hook ok
check "scenario 1: hook exits 0" "0" "$RC"
assert_exists "scenario 1: graph.json installed" "$PROJ/graphify-out/graph.json"
assert_valid_json "scenario 1: installed graph.json is valid JSON" \
  "$PROJ/graphify-out/graph.json"
check_contains "scenario 1: curl log requested graph.json" "$(cat "$LOG")" "graph.json"

# --- scenario 2: fresh graph is a no-op -------------------------------------
reset_fixture
mkdir -p "$PROJ/graphify-out"
printf '{"sentinel": true}' > "$PROJ/graphify-out/graph.json"
printf '{"built_at": "%s"}' "$NOW" > "$PROJ/graphify-out/graph-meta.json"
cp "$PROJ/graphify-out/graph.json" "$WORK/sentinel-scenario2.json"
run_hook ok
check "scenario 2: hook exits 0" "0" "$RC"
check "scenario 2: curl never invoked when graph is fresh" "empty" "$(log_state "$LOG")"
assert_identical "scenario 2: fresh graph.json left byte-identical" \
  "$WORK/sentinel-scenario2.json" "$PROJ/graphify-out/graph.json"

# --- scenario 3: stale meta triggers re-download ----------------------------
reset_fixture
mkdir -p "$PROJ/graphify-out"
printf '{"old": true}' > "$PROJ/graphify-out/graph.json"
printf '{"built_at": "%s"}' "$STALE" > "$PROJ/graphify-out/graph-meta.json"
run_hook ok
check "scenario 3: hook exits 0" "0" "$RC"
check "scenario 3: curl invoked when meta is stale" "nonempty" "$(log_state "$LOG")"
check "scenario 3: stale graph.json replaced by fresh download" \
  '{"ok": true}' "$(cat "$PROJ/graphify-out/graph.json")"

# --- scenario 4: missing/unparseable meta triggers re-download -------------
reset_fixture
mkdir -p "$PROJ/graphify-out"
printf '{"old": true}' > "$PROJ/graphify-out/graph.json"
printf 'not json' > "$PROJ/graphify-out/graph-meta.json"
run_hook ok
check "scenario 4: hook exits 0" "0" "$RC"
check "scenario 4: curl invoked when meta is unparseable" "nonempty" "$(log_state "$LOG")"

# --- scenario 5: fail-soft on curl failure ----------------------------------
reset_fixture
mkdir -p "$PROJ/graphify-out"
printf '{"sentinel": true}' > "$PROJ/graphify-out/graph.json"
cp "$PROJ/graphify-out/graph.json" "$WORK/sentinel-scenario5.json"
run_hook fail
check "scenario 5: hook exits 0 despite curl failure" "0" "$RC"
check "scenario 5: exactly one warning line on curl failure" "1" "$(warning_lines "$STDERR")"
assert_identical "scenario 5: sentinel graph.json left byte-identical" \
  "$WORK/sentinel-scenario5.json" "$PROJ/graphify-out/graph.json"

# --- scenario 6: fail-soft on malformed download ----------------------------
reset_fixture
run_hook malformed
check "scenario 6: hook exits 0 despite malformed download" "0" "$RC"
check "scenario 6: exactly one warning line on malformed download" \
  "1" "$(warning_lines "$STDERR")"
assert_missing "scenario 6: malformed download never installed as graph.json" \
  "$PROJ/graphify-out/graph.json"

# --- scenario 7: optional pan-graph failure is tolerated --------------------
reset_fixture
run_hook panfail
check "scenario 7: hook exits 0 when pan-graph download fails" "0" "$RC"
check "scenario 7: no warning line when only optional pan-graph fails" \
  "0" "$(warning_lines "$STDERR")"
assert_exists "scenario 7: graph.json installed despite pan-graph failure" \
  "$PROJ/graphify-out/graph.json"
assert_valid_json "scenario 7: installed graph.json is valid JSON" \
  "$PROJ/graphify-out/graph.json"

# --- scenario 8: curl calls carry a timeout budget --------------------------
reset_fixture
run_hook ok
check "scenario 8: hook exits 0" "0" "$RC"
check_contains "scenario 8: curl invoked with a --max-time budget" \
  "$(cat "$LOG")" "--max-time"

# --- summary ------------------------------------------------------------------
echo
echo "session-start restore tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
