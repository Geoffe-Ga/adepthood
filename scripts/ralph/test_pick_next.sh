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
ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }
check() { # check <desc> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    ok "$1"
  else
    bad "$(printf '%s (expected [%s], got [%s])' "$1" "$2" "$3")"
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
    # Two modes. Default: emit the pre-jq'd TSV a scenario supplied (tests the
    # bash walk logic). Opt-in JSON mode ($STUBDIR/issue_json present): apply the
    # REAL --jq filter pick-next.sh passes to a JSON fixture, so the embedded
    # filter/sort (require/exclude + priority tiering) is exercised end-to-end.
    if [[ -f "$STUBDIR/issue_json" ]]; then
      filter=""; prev=""
      for a in "$@"; do
        [[ "$prev" == "--jq" ]] && { filter="$a"; break; }
        prev="$a"
      done
      jq -r "$filter" "$STUBDIR/issue_json"
    else
      cat "$STUBDIR/issue_list.tsv" 2>/dev/null || true
    fi ;;
  *"pr list"*)
    # pick-next asks for `number,body` in ONE call and splits the result, so the
    # stub emits the same "<pr-number>\t<one-line body>" shape its --jq builds.
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
# An open PR, in the "<pr-number>\t<body>" shape pick-next's pr-list --jq emits.
pr_open()    { printf '%s\t%s\n' "$1" "$2" >> "$STUBDIR/pr_bodies"; }        # <pr-num> <body>
# The legacy helper: an open PR whose body links an issue, PR number unimportant.
pr_closes()  { pr_open "9$1" "Closes #$1"; }
worktree()   { mkdir -p "$REPO/.ralph/worktrees/issue-$1"; }
run_pick()   { (cd "$REPO" && PATH="$BIN:$PATH" "$PICK"); }

# JSON-mode helpers: build the fixture the stub feeds to pick-next's REAL --jq
# filter (mirrors `gh issue list --json number,labels`), so require/exclude
# filtering AND the priority-tier sort are exercised, not bypassed.
ij_add()      { # <num> <labels-csv> [body]  — append one issue object
  local names
  names=$(jq -cn --arg s "$2" '$s | split(",") | map(select(length>0) | {name: .})')
  jq -cn --argjson n "$1" --argjson l "$names" --arg b "${3:-}" \
    '{number:$n, labels:$l, body:$b}' >> "$STUBDIR/issue_json.lines"
}
ij_finalize() { jq -s . "$STUBDIR/issue_json.lines" > "$STUBDIR/issue_json"; }

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

# 4b) The `solo` guard fires when solo is one of MANY labels — the exact case the
#     has_label fix was for (the old grep -qiwx only matched a lone `solo`).
new_scenario solo_multilabel
candidate 11 "bug,solo,backend"; candidate 12 "chore"
set_labels 10 "area,backend"
worktree 10
check "multi-label solo candidate skipped" "12" "$(run_pick)"

# 4c) An active issue with solo among many labels still monopolizes the fleet.
new_scenario active_solo_multilabel
candidate 11 "chore"
set_labels 10 "epic-x,solo,backend"
worktree 10
check "multi-label active solo blocks fills" "" "$(run_pick)"

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

# 10) A repo path segment matching "issue-<digits>" above .ralph/worktrees must not be mistaken for an active issue.
new_scenario parent_path_issue_segment
REPO2="$WORK/issue-777-fixture/repo"
git init -q -b main "$REPO2"
(cd "$REPO2" && git config user.email t@t.t && git config user.name t)
candidate 10 ""; candidate 11 ""
mkdir -p "$REPO2/.ralph/worktrees/issue-10"
check "path segment matching issue-<n> above worktrees dir is ignored" "11" \
  "$(cd "$REPO2" && PATH="$BIN:$PATH" "$PICK")"

# --- priority tiering (JSON mode: exercises the real embedded --jq sort) ------

# 11) P0 preempts a lower, older issue: #99 (P0) beats #10 (P3).
new_scenario prio_p0_preempts
ij_add 10 "P3,agent-ready"; ij_add 99 "P0,agent-ready"; ij_finalize
check "P0 preempts older P3" "99" "$(run_pick)"

# 12) Full tier order P0<P1<P2<P3, and oldest-first WITHIN a tier.
new_scenario prio_full_order
ij_add 40 "P3"; ij_add 30 "P2"; ij_add 21 "P1"; ij_add 20 "P1"; ij_add 10 "P0"
ij_finalize
check "lowest tier wins (P0)" "10" "$(run_pick)"

new_scenario prio_within_tier
ij_add 22 "P1"; ij_add 20 "P1"; ij_add 21 "P1"; ij_finalize
check "oldest-first within a tier" "20" "$(run_pick)"

# 13) Unlabeled issue defaults to rank 1 (== P1): it beats a P2 but loses to P0.
new_scenario prio_default_rank
ij_add 5 "P2"; ij_add 9 ""; ij_add 3 "P0"; ij_finalize
check "unlabeled ranks as P1 (beats P2)" "3" \
  "$(run_pick)"                                   # P0 #3 first
new_scenario prio_default_beats_p2
ij_add 5 "P2"; ij_add 9 ""; ij_finalize
check "unlabeled (default P1) beats P2" "9" "$(run_pick)"

# 14) RALPH_DEFAULT_PRIORITY_RANK override: push unlabeled to the back (rank 3).
new_scenario prio_default_override
ij_add 9 ""; ij_add 5 "P2"; ij_finalize
check "default-rank override sends unlabeled behind P2" "5" \
  "$(cd "$REPO" && PATH="$BIN:$PATH" RALPH_DEFAULT_PRIORITY_RANK=3 "$PICK")"

# 15) require/exclude filtering still applies in JSON mode: agent-ready gate.
new_scenario prio_require_gate
ij_add 10 "P0"; ij_add 11 "P3,agent-ready"; ij_finalize
check "require agent-ready filters out ungated P0" "11" \
  "$(cd "$REPO" && PATH="$BIN:$PATH" RALPH_REQUIRE_LABELS=agent-ready "$PICK")"

# --- repo's native priority-* vocabulary maps onto the same tiers -------------

# 16) The exact production bug: a `priority-critical` issue (#1175-style) must
# preempt an OLDER non-critical backlog, not sit behind it by number.
new_scenario prio_critical_preempts
ij_add 100 "bug,frontend"; ij_add 101 "priority-medium"; ij_add 175 "bug,priority-critical,full-stack"
ij_finalize
check "priority-critical preempts older non-critical backlog" "175" "$(run_pick)"

# 17) Full priority-* tier order, oldest-first within a tier.
new_scenario prio_named_order
ij_add 40 "priority-low"; ij_add 30 "priority-medium"; ij_add 20 "priority-high"
ij_add 10 "priority-critical"; ij_finalize
check "priority-critical is tier 0" "10" "$(run_pick)"

# 18) The two vocabularies are interchangeable within a tier (P0 == critical):
# oldest of the two tier-0 issues wins regardless of which label spelling.
new_scenario prio_mixed_vocab
ij_add 50 "P0"; ij_add 40 "priority-critical"; ij_add 30 "P1"; ij_finalize
check "mixed P0/priority-critical share tier 0 (oldest wins)" "40" "$(run_pick)"

# 19) priority-high outranks a P2 and an unlabeled default (rank 1 beats 2).
new_scenario prio_high_beats_medium
ij_add 5 "priority-medium"; ij_add 9 "priority-high"; ij_finalize
check "priority-high (tier 1) beats priority-medium (tier 2)" "9" "$(run_pick)"

# --- the bridge marker route -------------------------------------------------
# Dependabot regenerates its PR body from its own template on every rebase and
# group recomputation, erasing the `Closes #<issue>` line the bridge appended.
# Once that happens the body scan no longer sees the bridge issue as in flight,
# so the picker offers it as BUILD work — and a build lane on a `dependencies`
# issue opens a SECOND PR on a brand-new branch for a bump that already has one.
# Confirmed live on merged PRs #2112/#2114, whose bodies carry zero reference
# matches while their bridge issues #2113/#2115 still carry the marker.
#
# The durable link is the `<!-- dependabot-pr:N -->` marker, which lives in the
# ISSUE body and therefore survives a PR-body rewrite. These cases pin the route
# that reads it. Note the direction inverts relative to pr-ready.sh's lookup:
# that one goes PR -> bridge issue, this one goes bridge issue -> open PR.

# 20) A bridge issue whose marker names an OPEN PR is in flight even with no
#     `Closes` line anywhere — the exact post-rewrite state.
new_scenario bridge_marker_holds
ij_add 10 "dependencies" "<!-- dependabot-pr:2112 -->"; ij_add 30 ""; ij_finalize
pr_open 2112 "Bumps foo from 1 to 2."
check "marker naming an open PR holds the bridge issue" "30" "$(run_pick)"

# 21) The body-link route is unchanged: this ADDS a route, it does not replace
#     one. Same issue, no marker, but the PR still says Closes.
new_scenario bridge_body_link_still_works
ij_add 10 "dependencies"; ij_add 30 ""; ij_finalize
pr_open 2112 "Closes #10"
check "the body-link route still holds it" "30" "$(run_pick)"

# 22) A marker naming a CLOSED/merged PR must not wedge the picker: the bridge
#     reconciler closes those issues, and a stale marker must not outlive them.
new_scenario bridge_marker_closed_pr
ij_add 10 "dependencies" "<!-- dependabot-pr:2112 -->"; ij_add 30 ""; ij_finalize
# No open PR #2112 at all — only an unrelated one.
pr_open 4000 "Bumps bar."
check "a marker naming a non-open PR does not hold the issue" "10" "$(run_pick)"

# 23) A `dependencies` issue with no marker is unaffected.
new_scenario bridge_no_marker
ij_add 10 "dependencies"; ij_add 30 ""; ij_finalize
pr_open 2112 "Bumps foo."
check "a bridge issue with no marker is still available" "10" "$(run_pick)"

# 24) A NON-dependencies issue carrying a marker-shaped string is unaffected —
#     the route is scoped to the bridge label, not to any body that looks like it.
new_scenario bridge_marker_wrong_label
ij_add 10 "bug" "<!-- dependabot-pr:2112 -->"; ij_add 30 ""; ij_finalize
pr_open 2112 "Bumps foo."
check "a non-dependencies issue is unaffected by the marker" "10" "$(run_pick)"

# 25) The near-miss guard: PR #21120's marker must not answer for PR #2112.
new_scenario bridge_marker_near_miss
ij_add 10 "dependencies" "<!-- dependabot-pr:21120 -->"; ij_add 30 ""; ij_finalize
pr_open 2112 "Bumps foo."
check "PR #21120's marker is not PR #2112's" "10" "$(run_pick)"

# --- the exclude-label trap ---------------------------------------------------
# RALPH_EXCLUDE_LABELS REPLACES the default list, so a caller who set it to add
# one label silently re-admitted `epic`, `blocked`, `wontfix` and the rest. The
# documented workaround was "repeat all nine defaults", which is a trap dressed
# as documentation. RALPH_EXTRA_EXCLUDE_LABELS adds without replacing.

# 26) The trap itself, pinned so it cannot be re-introduced by accident: an
#     override really does drop the defaults.
new_scenario exclude_override_replaces
ij_add 10 "blocked"; ij_add 11 ""; ij_finalize
check "an override replaces the defaults (blocked re-admitted)" "10" \
  "$(cd "$REPO" && PATH="$BIN:$PATH" RALPH_EXCLUDE_LABELS=dependencies "$PICK")"

# 27) The additive variable keeps every default AND adds the new one.
new_scenario exclude_extra_adds
ij_add 10 "blocked"; ij_add 11 "dependencies"; ij_add 12 ""; ij_finalize
check "the extra list adds without dropping the defaults" "12" \
  "$(cd "$REPO" && PATH="$BIN:$PATH" RALPH_EXTRA_EXCLUDE_LABELS=dependencies "$PICK")"

# 28) Both set: the override still replaces, and extra still adds to whatever
#     the effective base list is.
new_scenario exclude_extra_with_override
ij_add 10 "blocked"; ij_add 11 "dependencies"; ij_add 12 ""; ij_finalize
check "extra adds on top of an explicit override" "10" \
  "$(cd "$REPO" && PATH="$BIN:$PATH" RALPH_EXCLUDE_LABELS=wontfix \
      RALPH_EXTRA_EXCLUDE_LABELS=dependencies "$PICK")"

# --- cross-file coupling: the bridge marker -----------------------------------
# The marker shape now exists in four places. A silent drift restores exactly the
# double-PR failure this route was added to stop, with nothing to report it.
MARKER_PREFIX='<!-- dependabot-pr:'
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
for peer in ".github/workflows/dependabot-to-ralph-issue.yml" "scripts/ralph/pr-ready.sh" \
            "scripts/ralph/bridge-issue-exists.sh" "scripts/ralph/pick-next.sh"; do
  if grep -qF "$MARKER_PREFIX" "$ROOT/$peer"; then
    ok "$peer still uses the same bridge marker shape"
  else
    bad "$peer no longer carries $MARKER_PREFIX — the bridge link has drifted"
  fi
done

echo
echo "pick-next tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
