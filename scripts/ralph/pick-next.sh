#!/usr/bin/env bash
# scripts/ralph/pick-next.sh
#
# Ralph's picker for adepthood (Geoffe-Ga/adepthood). Prints the next open
# issue that is a real, unblocked, not-already-in-flight implementation issue
# AND is safe to start alongside whatever the fleet is already working — or
# nothing if the backlog is drained / nothing compatible remains.
#
# The picker is label-configurable. Tune via env vars:
#
#   RALPH_REQUIRE_LABELS  Space-separated labels an issue MUST have (ALL of
#                         them). Default: `agent-ready` — an issue nobody has
#                         specced is not build work, so the picker never hands
#                         one to a lane. REPLACES the default, it does not add
#                         to it, exactly like RALPH_EXCLUDE_LABELS below. Set it
#                         to the EMPTY string to require nothing and see the
#                         whole unlabelled backlog again; that is the escape
#                         hatch, and it is the only way to turn the gate off.
#                         When nothing is picked the picker says WHY on stderr,
#                         distinguishing "nothing passed the gate" (groom the
#                         backlog) from "candidates passed but are all in flight
#                         or conflicting" (nothing to groom) — see
#                         explain_empty_pick below.
#   RALPH_EXCLUDE_LABELS  Space-separated labels that DISQUALIFY an issue.
#                         REPLACES the default list below — it does not add to
#                         it. Setting it to one label silently re-admits `epic`,
#                         `blocked`, `wontfix` and the rest, which is a trap; to
#                         ADD a label, use RALPH_EXTRA_EXCLUDE_LABELS instead.
#   RALPH_EXTRA_EXCLUDE_LABELS
#                         Space-separated labels APPENDED to whatever
#                         RALPH_EXCLUDE_LABELS resolves to. This is the safe way
#                         to exclude one more thing, and exists so nobody has to
#                         restate nine defaults to add a tenth.
#   RALPH_BRIDGE_LABEL    Label marking a Dependabot bridge issue, whose durable
#                         `<!-- dependabot-pr:N -->` marker the in-flight scan
#                         honors. Default: "dependencies".
#   RALPH_SOLO_LABEL      Label marking an issue that must run ALONE (never in
#                         parallel with any other worker). Default: "solo".
#   RALPH_PARALLEL_LABEL  Label that overrides the same-epic guard so two issues
#                         under one epic may still run in parallel. Default:
#                         "parallelizable".
#   RALPH_RESPECT_EPICS   When "1" (default), a candidate that shares an
#                         epic-prefixed label with an active issue is skipped
#                         (likely ordered/overlapping) unless it carries the
#                         parallel label. Set "0" to disable the guard.
#   RALPH_DEFAULT_PRIORITY_RANK  Priority tier (0=P0 … 3=P3) assumed for an
#                         issue carrying no P-label. Default 1 (== P1). See the
#                         priority-tiering block below.
#
# Priority ordering: candidates are walked by [priority tier, number ascending],
# oldest-first within a tier. Tier 0 = P0 / priority-critical … tier 3 = P3 /
# priority-low (see the tiering block below — both label vocabularies are honored).
#
# Parallel awareness (see scripts/ralph/FLEET.md):
#   Issues already being worked — an open PR (`Closes|Fixes|Resolves #N`), a
#   bridge marker naming an open PR, or a live worktree under
#   .ralph/worktrees/issue-<N> — are excluded. Among
#   what remains, the FIRST worker (empty active set) gets the lowest eligible
#   issue as before. Additional workers only get an issue that is *independent*
#   of every active issue: not `solo`, and (unless `parallelizable`) not sharing
#   an epic label with an active issue. A `solo` issue, once active, blocks any
#   further parallel pick. Correctness across imperfect independence guesses is
#   guaranteed at merge time by the orchestrator's serialized-merge + sync.
#
# Exit codes:
#   0 — issue number printed (or nothing if backlog empty / nothing compatible)
#   2 — gh CLI not authenticated / missing
#
# Requires bash >= 4 (associative arrays `declare -A`, `${var,,}` lowercasing);
# on macOS use /opt/homebrew/bin/bash (bash 5), not the system bash 3.2.
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "pick-next: gh CLI not found" >&2
  exit 2
fi

REQUIRE_LABELS="${RALPH_REQUIRE_LABELS-agent-ready}"
EXCLUDE_LABELS="${RALPH_EXCLUDE_LABELS:-epic wontfix duplicate invalid question blocked needs-spec future-work do-not-auto-merge in-progress}"
# Appended, never substituted. The override above replaces the whole default
# list, so a caller who set it to add `dependencies` silently re-admitted every
# default — a trap the docs used to warn about rather than remove. Adding here
# cannot spring it.
EXCLUDE_LABELS="$EXCLUDE_LABELS ${RALPH_EXTRA_EXCLUDE_LABELS:-}"
SOLO_LABEL="${RALPH_SOLO_LABEL:-solo}"
BRIDGE_LABEL="${RALPH_BRIDGE_LABEL:-dependencies}"
PARALLEL_LABEL="${RALPH_PARALLEL_LABEL:-parallelizable}"
RESPECT_EPICS="${RALPH_RESPECT_EPICS:-1}"

# Priority tiering. Candidates are ordered by priority tier first, then
# oldest-first WITHIN a tier: tier 0 (critical/breakage) preempts tier 1
# (bugs + feature issues) preempts tier 2 (quality) preempts tier 3 (hygiene).
#
# TWO label vocabularies map onto the same four tiers, so the picker honors both
# the repo's long-standing `priority-*` labels AND the maintenance pipeline's
# P0–P3 labels:
#   tier 0  ← `P0` or `priority-critical`
#   tier 1  ← `P1` or `priority-high`
#   tier 2  ← `P2` or `priority-medium`
#   tier 3  ← `P3` or `priority-low`
# An issue with none of these sorts at RALPH_DEFAULT_PRIORITY_RANK.
#
#   RALPH_DEFAULT_PRIORITY_RANK  Tier an unlabeled issue is treated as. Default
#                                1 (== P1), so legacy/unlabeled feature work
#                                keeps flowing at feature priority and only P2/P3
#                                scan hygiene sorts behind it. With no P-labels
#                                anywhere, every issue ranks equal and ordering
#                                collapses to the previous oldest-first behavior
#                                — this change is backward compatible.
DEFAULT_RANK="${RALPH_DEFAULT_PRIORITY_RANK:-1}"
if ! printf '%s' "$DEFAULT_RANK" | grep -qE '^[0-9]+$'; then
  DEFAULT_RANK=1
fi

# jq array literals from the space-separated env vars.
require_json=$(printf '%s\n' $REQUIRE_LABELS | jq -R . | jq -s .)
exclude_json=$(printf '%s\n' $EXCLUDE_LABELS | jq -R . | jq -s .)

# All open issues as "<number>\t<labels-csv>\t<bridge-pr>", filtered by
# require/exclude labels and ordered by [priority-tier, number ascending].
# Fetched once; reused for candidates and for looking up active issues' labels.
#
# The third column is the PR number in this issue's `<!-- dependabot-pr:N -->`
# marker, empty when it carries none. It rides along on the SAME call — adding
# `body` to the existing --json costs no extra request, and the marker is
# extracted server-side by jq so no issue body ever reaches the shell.
open_tsv=$(
  gh issue list \
    --state open \
    --limit 300 \
    --json number,labels,body \
    --jq "
      ( $require_json | map(select(length>0)) ) as \$req
      | ( $exclude_json | map(select(length>0)) ) as \$exc
      | map(. as \$i | (\$i.labels | map(.name)) as \$names
          | select(
              ( \$req | all(. as \$r | \$names | index(\$r)) )
              and ( \$exc | any(. as \$x | \$names | index(\$x)) | not )
            )
          | { number: \$i.number, names: \$names,
              bridge: ( ((\$i.body // \"\")
                         | capture(\"<!-- dependabot-pr:(?<n>[0-9]+) -->\")?
                         | .n) // \"\" ),
              rank: ( if   ((\$names | index(\"P0\")) or (\$names | index(\"priority-critical\"))) then 0
                      elif ((\$names | index(\"P1\")) or (\$names | index(\"priority-high\")))     then 1
                      elif ((\$names | index(\"P2\")) or (\$names | index(\"priority-medium\")))   then 2
                      elif ((\$names | index(\"P3\")) or (\$names | index(\"priority-low\")))      then 3
                      else $DEFAULT_RANK end ) })
      | sort_by([.rank, .number])
      | .[]
      | \"\(.number)\t\(.names | join(\",\"))\t\(.bridge)\"
    "
)

# Full label map (unfiltered) so we can inspect the labels of active issues even
# if they carry an excluded label (e.g. an in-flight issue with `in-progress`).
labels_of() {
  local n="$1"
  gh issue view "$n" --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null || true
}

# The picker's silence is ambiguous, and the orchestrator's scripted response to
# nothing is to announce the fleet is done. Name the cause on stderr — but the
# two causes are NOT interchangeable and must not share a message:
#
#   gate      Nothing survived the require/exclude filter. If the require gate
#             is on, that is the likely reason, and grooming (specifying and
#             labelling work) is the fix.
#   conflict  Candidates DID survive the filter; the in-flight and fleet-conflict
#             guards then skipped every one. The gate is irrelevant here — those
#             issues already passed it — so re-running without it reveals
#             nothing and nothing needs grooming. Note the picker's active set is
#             built from ALL open PRs regardless of author, so a PR nobody in the
#             fleet opened can land a candidate here.
#
# Only the `gate` branch is conditional on the gate being on; `conflict` is a
# fact about the walk and is always worth saying. stdout stays byte-identical to
# the contract above and exit codes are untouched, so a gh/jq transport failure
# stays distinguishable from a substantive empty pick.
explain_empty_pick() {
  case "$1" in
    gate)
      [[ -n "$REQUIRE_LABELS" ]] || return 0
      printf 'pick-next: nothing picked; no open issue passed the require gate (%s). Re-run with RALPH_REQUIRE_LABELS= to see what it holds back.\n' \
        "$REQUIRE_LABELS" >&2
      ;;
    conflict)
      printf 'pick-next: nothing picked; %s candidate(s) passed the filters but every one is already in flight or conflicts with the active fleet. Nothing needs grooming.\n' \
        "$2" >&2
      ;;
  esac
}

if [[ -z "$open_tsv" ]]; then
  explain_empty_pick gate
  exit 0
fi

# Every open PR as "<number>\t<body, newlines flattened>", fetched in ONE call
# and split locally into the two things the in-flight scan needs. Flattening the
# body keeps one PR to one line so `cut` can separate the columns.
open_prs_tsv=$(
  gh pr list \
    --state open \
    --limit 300 \
    --json number,body \
    --jq '.[] | "\(.number)\t\((.body // "") | gsub("[\n\r]"; " "))"' \
  || true
)

# Route 1 — the body link. Issue numbers a PR body claims (case-insensitive).
inflight=$(
  printf '%s\n' "$open_prs_tsv" \
  | cut -f2- \
  | grep -oiE '(closes|fixes|resolves)[[:space:]]+#[0-9]+' \
  | grep -oE '[0-9]+' \
  | sort -u || true
)

# The numbers of the PRs that are open right now — route 2's whole input.
open_pr_numbers=$(
  printf '%s\n' "$open_prs_tsv" | cut -f1 | grep -E '^[0-9]+$' | sort -u || true
)

# Route 2 — the bridge marker. Dependabot regenerates its PR body from its own
# template on every rebase and group recomputation, erasing the `Closes #<issue>`
# line the bridge appended — after which route 1 no longer sees the bridge issue
# as in flight and the picker offers it as BUILD work. That is worse than a
# wasted tick: a `dependencies` issue must only ever be ADOPTED (drive the
# existing Dependabot branch), so a build lane on one opens a SECOND PR for a
# bump that already has one.
#
# The durable link is `<!-- dependabot-pr:N -->`, which the bridge writes into
# the ISSUE body and no PR-body rewrite can touch. Note the direction inverts
# relative to pr-ready.sh's lookup: that goes PR -> bridge issue, this goes
# bridge issue -> open PR. Matching only OPEN PRs is deliberate — the bridge
# reconciler closes issues whose PR has merged, and a stale marker must not
# wedge the picker on an issue nothing is working.
bridged=""
while IFS=$'\t' read -r _n _labels _bridge_pr; do
  [[ -n "${_bridge_pr:-}" ]] || continue
  printf '%s' "$_labels" | tr ',' '\n' | grep -qix "$BRIDGE_LABEL" || continue
  grep -qx "$_bridge_pr" <<<"$open_pr_numbers" || continue
  bridged+="$_n"$'\n'
done <<<"$open_tsv"

# Issue numbers with a live worktree (started, PR not yet opened).
worktree_issues=""
if repo_root=$(git rev-parse --show-toplevel 2>/dev/null); then
  wt_dir="$repo_root/.ralph/worktrees"
  if [[ -d "$wt_dir" ]]; then
    worktree_issues=$(
      find "$wt_dir" -maxdepth 1 -type d -name 'issue-*' 2>/dev/null \
        | sed 's#^.*/issue-##' | sort -u || true
    )
  fi
fi

# The active set = body-linked issues ∪ marker-linked issues ∪ worktree issues.
active=$(
  printf '%s\n%s\n%s\n' "$inflight" "$bridged" "$worktree_issues" \
  | grep -E '^[0-9]+$' | sort -u || true
)

is_active() { [[ -n "$active" ]] && grep -qx "$1" <<<"$active"; }

# Pre-fetch each active issue's labels ONCE. conflicts_with_active() runs per
# candidate and consults active-issue labels in both the solo and epic loops;
# without this cache that would be up to 2×(active workers) `gh issue view` calls
# per candidate. Keyed by issue number.
declare -A ACTIVE_LABELS=()
if [[ -n "$active" ]]; then
  while IFS= read -r _a; do
    [[ -n "$_a" ]] || continue
    ACTIVE_LABELS["$_a"]="$(labels_of "$_a")"
  done <<<"$active"
fi

# Exact per-token membership: has_label "<labels-csv>" "<label>" (case-insensitive).
# Matches a whole comma-separated label, NOT a substring or the joined line — so
# a `solo` guard fires on "bug,solo,backend", not only on a lone "solo" label.
has_label() {
  local want="${2,,}" tok
  local -a toks
  IFS=',' read -ra toks <<<"$1"
  for tok in "${toks[@]}"; do
    [[ "${tok,,}" == "$want" ]] && return 0
  done
  return 1
}

# Epic-prefixed labels of an issue (labels beginning with "epic").
epic_labels() {
  printf '%s\n' "${1//,/$'\n'}" | grep -iE '^epic' | sort -u || true
}

# Does the candidate (labels CSV) conflict with any active issue?
conflicts_with_active() {
  local cand_labels="$1"
  [[ -n "$active" ]] || return 1 # first worker: never conflicts

  # A candidate that must run solo cannot join a non-empty fleet.
  if has_label "$cand_labels" "$SOLO_LABEL"; then
    return 0
  fi

  # If any active issue is solo, it monopolizes the fleet.
  local a a_labels
  while IFS= read -r a; do
    [[ -n "$a" ]] || continue
    a_labels="${ACTIVE_LABELS[$a]:-}"
    if has_label "$a_labels" "$SOLO_LABEL"; then
      return 0
    fi
  done <<<"$active"

  # Same-epic guard (unless the candidate opts into parallel).
  if [[ "$RESPECT_EPICS" == "1" ]] \
    && ! has_label "$cand_labels" "$PARALLEL_LABEL"; then
    local cand_epics
    cand_epics="$(epic_labels "$cand_labels")"
    if [[ -n "$cand_epics" ]]; then
      while IFS= read -r a; do
        [[ -n "$a" ]] || continue
        local a_epics
        a_epics="$(epic_labels "${ACTIVE_LABELS[$a]:-}")"
        [[ -n "$a_epics" ]] || continue
        if comm -12 <(printf '%s\n' "$cand_epics") <(printf '%s\n' "$a_epics") \
          | grep -q .; then
          return 0
        fi
      done <<<"$active"
    fi
  fi

  return 1
}

# Walk candidates ascending; print the first that is neither active nor
# conflicting with the active set.
while IFS=$'\t' read -r n cand_labels _bridge; do
  [[ -z "$n" ]] && continue
  is_active "$n" && continue
  if conflicts_with_active "$cand_labels"; then
    continue
  fi
  echo "$n"
  exit 0
done <<<"$open_tsv"

# Candidates existed but none was compatible with the current fleet. The require
# gate is not the cause here — every one of these already passed it.
# Counted with mapfile rather than `grep -c`, which exits 1 on zero matches and
# would need its status swallowed to be used inline — the exact shape this
# change is meant to avoid.
mapfile -t _candidate_lines <<<"$open_tsv"
explain_empty_pick conflict "${#_candidate_lines[@]}"
exit 0
