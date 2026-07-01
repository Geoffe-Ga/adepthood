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
#                         them). Empty (default) = no required label; any open
#                         issue is a candidate.
#   RALPH_EXCLUDE_LABELS  Space-separated labels that DISQUALIFY an issue.
#                         Default excludes housekeeping / deferred / in-flight
#                         markers. Override to taste.
#   RALPH_SOLO_LABEL      Label marking an issue that must run ALONE (never in
#                         parallel with any other worker). Default: "solo".
#   RALPH_PARALLEL_LABEL  Label that overrides the same-epic guard so two issues
#                         under one epic may still run in parallel. Default:
#                         "parallelizable".
#   RALPH_RESPECT_EPICS   When "1" (default), a candidate that shares an
#                         epic-prefixed label with an active issue is skipped
#                         (likely ordered/overlapping) unless it carries the
#                         parallel label. Set "0" to disable the guard.
#
# Parallel awareness (see scripts/ralph/FLEET.md):
#   Issues already being worked — either an open PR (`Closes|Fixes|Resolves #N`)
#   or a live worktree under .ralph/worktrees/issue-<N> — are excluded. Among
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

REQUIRE_LABELS="${RALPH_REQUIRE_LABELS:-}"
EXCLUDE_LABELS="${RALPH_EXCLUDE_LABELS:-epic wontfix duplicate invalid question blocked needs-spec future-work do-not-auto-merge in-progress}"
SOLO_LABEL="${RALPH_SOLO_LABEL:-solo}"
PARALLEL_LABEL="${RALPH_PARALLEL_LABEL:-parallelizable}"
RESPECT_EPICS="${RALPH_RESPECT_EPICS:-1}"

# jq array literals from the space-separated env vars.
require_json=$(printf '%s\n' $REQUIRE_LABELS | jq -R . | jq -s .)
exclude_json=$(printf '%s\n' $EXCLUDE_LABELS | jq -R . | jq -s .)

# All open issues as "<number>\t<comma-separated-labels>", ascending by number,
# filtered by require/exclude labels. Fetched once; reused for candidates and
# for looking up active issues' labels.
open_tsv=$(
  gh issue list \
    --state open \
    --limit 300 \
    --json number,labels \
    --jq "
      ( $require_json | map(select(length>0)) ) as \$req
      | ( $exclude_json | map(select(length>0)) ) as \$exc
      | sort_by(.number)
      | map(. as \$i | (\$i.labels | map(.name)) as \$names
          | select(
              ( \$req | all(. as \$r | \$names | index(\$r)) )
              and ( \$exc | any(. as \$x | \$names | index(\$x)) | not )
            )
          | \"\(\$i.number)\t\(\$names | join(\",\"))\")
      | .[]
    "
)

# Full label map (unfiltered) so we can inspect the labels of active issues even
# if they carry an excluded label (e.g. an in-flight issue with `in-progress`).
labels_of() {
  local n="$1"
  gh issue view "$n" --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null || true
}

if [[ -z "$open_tsv" ]]; then
  exit 0
fi

# Issue numbers already in flight via an open PR (case-insensitive markers).
inflight=$(
  gh pr list \
    --state open \
    --limit 300 \
    --json body \
    --jq '.[].body' \
  | grep -oiE '(closes|fixes|resolves)[[:space:]]+#[0-9]+' \
  | grep -oE '[0-9]+' \
  | sort -u || true
)

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

# The active set = in-flight PR issues ∪ worktree issues.
active=$(printf '%s\n%s\n' "$inflight" "$worktree_issues" | grep -E '^[0-9]+$' | sort -u || true)

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
while IFS=$'\t' read -r n cand_labels; do
  [[ -z "$n" ]] && continue
  is_active "$n" && continue
  if conflicts_with_active "$cand_labels"; then
    continue
  fi
  echo "$n"
  exit 0
done <<<"$open_tsv"

# Backlog drained, or nothing compatible with the current fleet remains.
exit 0
