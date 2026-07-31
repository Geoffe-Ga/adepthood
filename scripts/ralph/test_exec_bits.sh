#!/usr/bin/env bash
# scripts/ralph/test_exec_bits.sh
#
# Regression guard for the executable bits on the Ralph shell tooling
# (upstream report Creek-Vault#1096): watch-pr.sh shipped there as 100644, so
# the documented direct invocation — `scripts/ralph/watch-pr.sh <PR>`, exactly
# what ralph-tick.md Step 5 tells the orchestrator to background — exited 126
# on every local session, and the armed watcher silently never existed. CI
# never noticed because the suites are launched via `bash <script>`, which
# ignores the mode entirely.
#
# So this suite asserts the mode git RECORDS (`git ls-files -s`), not the
# checkout's, and covers every scripts/ralph/*.sh: the launchers because
# ralph-tick.md and fleet.sh invoke them directly, and the test suites because
# their own `Run:` headers document direct invocation too. It still catches a
# regression when run via `bash` — the index is the artifact that ships.
#
# Run:  bash scripts/ralph/test_exec_bits.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }

# The one mode a directly-invoked script may ship with. 100644 exits 126 at
# launch; anything else (a symlink, a gitlink) is not a script at all.
readonly EXECUTABLE_MODE="100755"

listed=0
while read -r mode _ _ path; do
  listed=$((listed + 1))
  if [[ "$mode" == "$EXECUTABLE_MODE" ]]; then
    ok "$path is $EXECUTABLE_MODE"
  else
    bad "$path is $mode, not $EXECUTABLE_MODE — its documented direct invocation exits 126"
  fi
done < <(git -C "$DIR" ls-files -s -- '*.sh')

# The guard must be guarding something: an empty listing means the lookup
# itself broke (wrong directory, not a git checkout), not that all is well.
if [[ "$listed" -gt 0 ]]; then
  ok "the guard covered $listed tracked shell scripts under scripts/ralph/"
else
  bad "git ls-files listed no scripts/ralph/*.sh — the guard checked nothing"
fi

# --- summary ---------------------------------------------------------------
echo
echo "exec-bit tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
