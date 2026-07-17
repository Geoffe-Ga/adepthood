#!/usr/bin/env bash
# scripts/graph/test_hook_guards.sh
#
# Offline tests for the PreToolUse hook-guard wiring in .claude/settings.json:
# pins the config shape (Bash + Read|Glob matchers, SessionStart untouched)
# and the fail-soft invariant (graphify absent or exiting non-zero must never
# block the tool call) by extracting the real command strings via jq and
# running them against fake PATH environments.
#
# Run:  bash scripts/graph/test_hook_guards.sh
set -euo pipefail

SETTINGS="$(cd "$(dirname "$0")/../../.claude" && pwd)/settings.json"
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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/nograph" "$WORK/binfail" "$WORK/binlog"

# nograph holds bash (so `bash -c` can launch) but deliberately no graphify,
# isolating the "graphify absent from PATH" case from bash's own resolution.
ln -s "$(command -v bash)" "$WORK/nograph/bash"

# --- group 1: config shape ---------------------------------------------------
ENTRY_COUNT="$(jq '.hooks.PreToolUse | length' "$SETTINGS")"
check "PreToolUse has exactly 2 entries" "2" "$ENTRY_COUNT"

BASH_MATCHER_COUNT="$(jq '[.hooks.PreToolUse[]? | select(.matcher == "Bash")] | length' "$SETTINGS")"
check "one PreToolUse entry matches Bash" "1" "$BASH_MATCHER_COUNT"

READ_MATCHER_COUNT="$(jq '[.hooks.PreToolUse[]? | select(.matcher == "Read|Glob")] | length' "$SETTINGS")"
check "one PreToolUse entry matches Read|Glob" "1" "$READ_MATCHER_COUNT"

SESSION_START_COUNT="$(jq '.hooks.SessionStart | length' "$SETTINGS")"
check "SessionStart still has exactly one entry" "1" "$SESSION_START_COUNT"

SESSION_START_CMD="$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$SETTINGS")"
check_contains "SessionStart hook is untouched" "$SESSION_START_CMD" "session-start.sh"

BASH_TIMEOUT="$(jq '[.hooks.PreToolUse[]? | select(.matcher == "Bash") | .hooks[0].timeout] | first' "$SETTINGS")"
check "Bash hook has a 10s timeout" "10" "$BASH_TIMEOUT"

READ_TIMEOUT="$(jq '[.hooks.PreToolUse[]? | select(.matcher == "Read|Glob") | .hooks[0].timeout] | first' "$SETTINGS")"
check "Read|Glob hook has a 10s timeout" "10" "$READ_TIMEOUT"

BASH_CMD="$(jq -r '.hooks.PreToolUse[]? | select(.matcher == "Bash") | .hooks[0].command' "$SETTINGS")"
READ_CMD="$(jq -r '.hooks.PreToolUse[]? | select(.matcher == "Read|Glob") | .hooks[0].command' "$SETTINGS")"

if [[ -z "$BASH_CMD" || -z "$READ_CMD" ]]; then
  bad "PreToolUse Bash and Read|Glob commands both extracted (non-empty)"
  echo "  skip - fail-soft and wiring checks (no command strings to run)"
else
  ok "PreToolUse Bash and Read|Glob commands both extracted (non-empty)"

  # --- group 2: binary absent = fail soft ------------------------------------
  rc=0
  env PATH="$WORK/nograph" bash -c "$BASH_CMD" </dev/null || rc=$?
  check "Bash hook exits 0 when graphify is absent from PATH" "0" "$rc"

  rc=0
  env PATH="$WORK/nograph" bash -c "$READ_CMD" </dev/null || rc=$?
  check "Read|Glob hook exits 0 when graphify is absent from PATH" "0" "$rc"

  # --- group 3: guard-failure = fail soft -------------------------------------
  cat > "$WORK/binfail/graphify" <<'STUB'
#!/usr/bin/env bash
echo "guard blocked" >&2
exit 2
STUB
  chmod +x "$WORK/binfail/graphify"

  rc=0
  env PATH="$WORK/binfail:$PATH" bash -c "$BASH_CMD" </dev/null || rc=$?
  check "Bash hook exits 0 when graphify guard blocks (exit 2)" "0" "$rc"

  rc=0
  env PATH="$WORK/binfail:$PATH" bash -c "$READ_CMD" </dev/null || rc=$?
  check "Read|Glob hook exits 0 when graphify guard blocks (exit 2)" "0" "$rc"

  # --- group 4: correct wiring -------------------------------------------------
  LOG="$WORK/graphify.log"
  : > "$LOG"
  cat > "$WORK/binlog/graphify" <<STUB
#!/usr/bin/env bash
echo "\$@" >> "$LOG"
exit 0
STUB
  chmod +x "$WORK/binlog/graphify"

  : > "$LOG"
  env PATH="$WORK/binlog:$PATH" bash -c "$BASH_CMD" </dev/null || true
  check_contains "Bash hook invokes graphify with hook-guard search" "$(cat "$LOG")" "hook-guard search"

  : > "$LOG"
  env PATH="$WORK/binlog:$PATH" bash -c "$READ_CMD" </dev/null || true
  check_contains "Read|Glob hook invokes graphify with hook-guard read" "$(cat "$LOG")" "hook-guard read"
fi

# --- summary ------------------------------------------------------------------
echo
echo "hook-guard tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
