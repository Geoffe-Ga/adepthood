#!/usr/bin/env bash
# scripts/ralph/test_pick_next.sh
#
# Offline tests for pick-next.sh's parallel-awareness logic — the solo-label
# guard, the same-epic guard, and the worktree / in-flight-PR exclusions added
# for the fleet loop (see scripts/ralph/FLEET.md).
#
# pick-next.sh talks to GitHub only through `gh ... --jq ...`, so we put a fake
# `gh` on PATH that emits the already-jq-extracted values a scenario needs. Each
# scenario writes three inputs into a scratch dir the stub reads:
#   issue_list.tsv   "<number>\t<labels-csv>" per candidate (post require/exclude)
#   pr_bodies        newline-joined open-PR bodies (for Closes/Fixes/Resolves)
#   labels/<N>       labels CSV for issue N (used to inspect active issues)
# and creates .ralph/worktrees/issue-<N> dirs to simulate live workers.
#
# Run:  bash scripts/ralph/test_pick_next.sh
set -euo pipefail

PICK="$(cd "$(dirname "$0")" && pwd)/pick-next.sh"
PASS=0
FAIL=0
check() { # check <desc> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"
  else
    FAIL=$((FAIL + 1)); printf 'FAIL  - %s (expected [%s], got [%s])\n' "$1" "$2" "$3"
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- a git repo so pick-next's worktree detection resolves a toplevel ---------
REPO="$WORK/repo"
git init -q -b main "$REPO"
(cd "$REPO" && git config user.email t@t.t && git config user.name t)

# --- fake gh: reads scenario inputs from $STUBDIR (exported per scenario) ------
BIN="$WORK/bin"; mkdir -p "$BIN"
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
# Emit the value real gh would produce *after* applying --jq for each call
# pick-next.sh makes. Scenario data lives under $STUBDIR.
args="$*"
case "$args" in
  *"issue list"*)
    cat "$STUBDIR/issue_list.tsv" 2>/dev/null || true ;;
  *"pr list"*)
    cat "$STUBDIR/pr_bodies" 2>/dev/null || true ;;
  *"issue view"*)
    # find the numeric arg (the issue number) and print its labels csv
    for tok in "$@"; do
      if [[ "$tok" =~ ^[0-9]+$ ]]; then
        cat "$STUBDIR/labels/$tok" 2>/dev/null || true
        break
      fi
    done ;;
  *) : ;;
esac
STUB
chmod +x "$BIN/gh"

# --- scenario harness ---------------------------------------------------------
# new_scenario resets a fresh STUBDIR + clean worktree state.
new_scenario() {
  STUBDIR="$WORK/scn.$1"; export STUBDIR
  rm -rf "$STUBDIR" "$REPO/.ralph"
  mkdir -p "$STUBDIR/labels"
  : > "$STUBDIR/issue_list.tsv"
  : > "$STUBDIR/pr_bodies"
}
candidate() { printf '%s\t%s\n' "$1" "$2" >> "$STUBDIR/issue_list.tsv"; }   # <num> <labels-csv>
set_labels() { printf '%s' "$2" > "$STUBDIR/labels/$1"; }                    # <num> <labels-csv>
pr_closes()  { printf 'Closes #%s\n' "$1" >> "$STUBDIR/pr_bodies"; }
worktree()   { mkdir -p "$REPO/.ralph/worktrees/issue-$1"; }
run_pick()   { (cd "$REPO" && PATH="$BIN:$PATH" "$PICK"); }

# 1) First worker (empty fleet) gets the lowest candidate.
new_scenario first
candidate 10 ""; candidate 11 ""; candidate 12 ""
check "first worker gets lowest issue" "10" "$(run_pick)"

# 2) An issue with a live worktree is excluded.
new_scenario worktree_excl
candidate 10 ""; candidate 11 ""; candidate 12 ""
worktree 10
check "worktree issue excluded" "11" "$(run_pick)"

# 3) An issue already covered by an open PR is excluded.
new_scenario inflight_excl
candidate 10 ""; candidate 11 ""
pr_closes 10
check "in-flight PR issue excluded" "11" "$(run_pick)"

# 4) A `solo` candidate is skipped while another worker is active.
new_scenario solo_skip
candidate 11 "solo"; candidate 12 ""
set_labels 10 ""            # active issue 10 (worktree) is not solo
worktree 10
check "solo candidate skipped when fleet active" "12" "$(run_pick)"

# 5) An active `solo` issue monopolizes the fleet (nothing else is pickable).
new_scenario solo_monopoly
candidate 11 ""
set_labels 10 "solo"       # the active worktree issue is solo
worktree 10
check "active solo blocks all fills" "" "$(run_pick)"

# 6) Same-epic candidate is skipped; a different-epic one is picked.
new_scenario epic_guard
candidate 11 "epic-foo"; candidate 12 "epic-bar"
set_labels 10 "epic-foo"   # active issue shares epic-foo with candidate 11
worktree 10
check "same-epic candidate skipped, cross-epic picked" "12" "$(run_pick)"

# 7) `parallelizable` overrides the same-epic guard.
new_scenario epic_override
candidate 11 "epic-foo,parallelizable"
set_labels 10 "epic-foo"
worktree 10
check "parallelizable overrides same-epic guard" "11" "$(run_pick)"

# 8) RALPH_RESPECT_EPICS=0 disables the epic guard entirely.
new_scenario epic_disabled
candidate 11 "epic-foo"
set_labels 10 "epic-foo"
worktree 10
check "epic guard off => same-epic candidate allowed" "11" \
  "$(cd "$REPO" && PATH="$BIN:$PATH" RALPH_RESPECT_EPICS=0 "$PICK")"

# 9) Backlog drained => empty output.
new_scenario drained
check "empty candidate list => nothing" "" "$(run_pick)"

echo
echo "pick-next tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
