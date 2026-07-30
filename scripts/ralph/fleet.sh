#!/usr/bin/env bash
# scripts/ralph/fleet.sh
#
# Worktree fleet manager for the parallel Ralph loop (Geoffe-Ga/adepthood).
#
# Ralph's outer loop can work several *parallelizable* backlog issues at once,
# each in its own git worktree so concurrent edits never collide on disk. This
# script is the mechanism the orchestrator (`.claude/commands/ralph-tick.md`)
# and the worker agent (`.claude/agents/ralph-worker.md`) use to create,
# inspect, sync, and tear down those worktrees — never more than
# `max_workers` (default 4) at a time.
#
# Design contract ("optimistic parallelism, pessimistic merge"):
#   * Parallel work is a speculation that the chosen issues are independent.
#   * Correctness is guaranteed at MERGE time, not pick time: the orchestrator
#     merges ONE PR per tick, then merges `origin/main` into every surviving
#     worktree and re-runs its local gate before that worktree may merge.
#   * A worktree with a merge conflict drops to Gate 1 (see the docs in
#     `scripts/ralph/FLEET.md`). Nothing here weakens a gate.
#
# Worktrees live under `.ralph/worktrees/issue-<N>` on branch
# `issue/<N>-<slug>`. The issue number is the primary key; there is no separate
# slot bookkeeping. The `.ralph/` directory is git-ignored.
#
# Config is read from `scripts/ralph/state.json`:
#   max_workers       Maximum concurrent worktrees (default 4).
#   parallel_enabled  When false, `free` reports at most 1 (sequential Ralph).
#
# Subcommands:
#   list             Print active worktrees, one per line:
#                      <issue>\t<branch>\t<path>
#   active           Print just the active issue numbers, space-separated.
#   count            Print the number of active worktrees.
#   free             Print how many more workers may be started right now.
#   path <N>         Print the worktree path for issue N (empty + exit 1 if none).
#   assign <N> <slug>  Create (or reuse) a worktree for issue N off origin/main;
#                      prints its absolute path. Refuses if the fleet is full.
#   adopt <N> <PR>   The bot-PR variant of assign: create (or reuse) a worktree
#                      for issue N attached to PR's EXISTING head branch (e.g.
#                      Dependabot's), so fixes push to that branch instead of
#                      opening a second PR. Prints its absolute path. Refuses a
#                      fork PR (its branch is not pushable) and a full fleet.
#   sync <N>         Integrate the latest origin/main into issue N's worktree
#                      branch by MERGE (no history rewrite ⇒ a plain push updates
#                      the PR; no force-push, ever). Exit 0 clean, exit 3 on
#                      conflict (merge aborted, worktree left clean).
#   release <N>      Remove issue N's worktree and delete its local branch.
#   reconcile        Release worktrees whose PR merged/closed or whose issue is
#                      closed, then `git worktree prune`. Needs the gh CLI.
#
# Exit codes: 0 ok · 1 usage/not-found · 2 tooling missing · 3 merge conflict.
set -euo pipefail

readonly DEFAULT_MAX_WORKERS=4
readonly WORKTREE_ROOT=".ralph/worktrees"
readonly STATE_FILE="scripts/ralph/state.json"

die() {
  echo "fleet: $*" >&2
  exit 1
}

# Resolve the MAIN worktree's root, so the script works from any worktree/subdir.
# `git rev-parse --show-toplevel` cannot do this: run inside a linked worktree it
# returns that worktree, so every lane path would be computed relative to another
# lane and `list`/`sync` would see no fleet at all — yet a synced worker's FIRST
# action is `fleet.sh sync` from inside its own worktree. `git worktree list`
# always prints the main worktree first, which is the one holding `.ralph/`.
repo_root() {
  local main
  main="$(git worktree list --porcelain 2>/dev/null |
    awk '/^worktree /{print substr($0, 10); exit}')" || true
  [[ -n "$main" ]] || die "not inside a git repository"
  printf '%s\n' "$main"
}

# Read an integer/bool field from state.json with a fallback. Pure-python so we
# never depend on jq being present for config (gh already needs jq, but config
# reads happen even in offline tests).
state_get() {
  local key="$1" default="$2" file
  file="$(repo_root)/$STATE_FILE"
  if [[ ! -f "$file" ]]; then
    printf '%s\n' "$default"
    return 0
  fi
  python3 - "$file" "$key" "$default" <<'PY'
import json
import sys

path, key, default = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    value = data.get(key, default)
except (OSError, ValueError):
    value = default
if isinstance(value, bool):
    value = "true" if value else "false"
print(value)
PY
}

max_workers() {
  local raw
  raw="$(state_get max_workers "$DEFAULT_MAX_WORKERS")"
  [[ "$raw" =~ ^[0-9]+$ ]] || raw="$DEFAULT_MAX_WORKERS"
  printf '%s\n' "$raw"
}

parallel_enabled() {
  [[ "$(state_get parallel_enabled true)" == "true" ]]
}

# Absolute path of the worktree directory for an issue (may not exist yet).
issue_dir() {
  printf '%s/%s/issue-%s\n' "$(repo_root)" "$WORKTREE_ROOT" "$1"
}

# Emit "<issue>\t<branch>\t<path>" for every active Ralph worktree, sorted by
# issue number. Derived from live git state — never from stored bookkeeping —
# so the loop stays re-entrant.
list_worktrees() {
  local root
  root="$(repo_root)"
  git -C "$root" worktree list --porcelain | awk -v root="$root/$WORKTREE_ROOT/issue-" '
    /^worktree /   { path = substr($0, 10) }
    /^branch /     { branch = substr($0, 8); sub(/^refs\/heads\//, "", branch) }
    /^$/           { emit() }
    END            { emit() }
    function emit() {
      if (path != "" && index(path, root) == 1) {
        issue = substr(path, length(root) + 1)
        sub(/\/.*/, "", issue)
        printf "%s\t%s\t%s\n", issue, branch, path
      }
      path = ""; branch = ""
    }
  ' | sort -n
}

count_active() {
  list_worktrees | grep -c . || true
}

cmd_list() {
  list_worktrees
}

cmd_active() {
  list_worktrees | cut -f1 | paste -sd' ' -
}

cmd_count() {
  count_active
}

cmd_free() {
  local cap active free
  cap="$(max_workers)"
  parallel_enabled || cap=1
  active="$(count_active)"
  free=$((cap - active))
  ((free < 0)) && free=0
  printf '%s\n' "$free"
}

cmd_path() {
  local issue="$1" dir
  [[ -n "$issue" ]] || die "path: missing issue number"
  dir="$(issue_dir "$issue")"
  if [[ -d "$dir" ]]; then
    printf '%s\n' "$dir"
  else
    exit 1
  fi
}

cmd_assign() {
  local issue="$1" slug="${2:-}" root dir branch base
  [[ -n "$issue" ]] || die "assign: usage: assign <issue> <slug>"
  [[ "$issue" =~ ^[0-9]+$ ]] || die "assign: issue must be numeric, got '$issue'"
  root="$(repo_root)"
  dir="$(issue_dir "$issue")"

  # Re-entrant: an existing worktree for this issue is simply reused.
  if [[ -d "$dir" ]]; then
    printf '%s\n' "$dir"
    return 0
  fi

  # Enforce the cap only when creating a *new* worktree.
  if [[ "$(cmd_free)" -le 0 ]]; then
    die "assign: fleet is full ($(count_active)/$(max_workers) workers active)"
  fi

  slug="$(sanitize_slug "$slug")"
  branch="issue/${issue}-${slug}"
  base="origin/main"

  git -C "$root" fetch --quiet origin main || die "assign: could not fetch origin/main"
  mkdir -p "$root/$WORKTREE_ROOT"

  if git -C "$root" show-ref --verify --quiet "refs/heads/$branch"; then
    # Branch already exists (prior tick) — attach a worktree to it.
    git -C "$root" worktree add "$dir" "$branch" >&2
  else
    git -C "$root" worktree add "$dir" -b "$branch" "$base" >&2
  fi
  printf '%s\n' "$dir"
}

# Attach a lane to a PR's own head branch. The local branch name must equal
# headRefName EXACTLY: cmd_reconcile finds lanes with `gh pr list --head
# "$branch"`, so any deviation silently breaks worktree GC.
cmd_adopt() {
  local issue="$1" pr="${2:-}" root dir head_line head_ref is_fork on_branch
  [[ -n "$issue" && -n "$pr" ]] || die "adopt: usage: adopt <issue> <pr>"
  [[ "$issue" =~ ^[0-9]+$ ]] || die "adopt: issue must be numeric, got '$issue'"
  [[ "$pr" =~ ^[0-9]+$ ]] || die "adopt: PR must be numeric, got '$pr'"
  root="$(repo_root)"
  dir="$(issue_dir "$issue")"

  command -v gh >/dev/null 2>&1 || die "adopt: gh CLI required"
  head_line="$(gh pr view "$pr" --json headRefName,isCrossRepository \
    --jq '(.headRefName // "") + "|" + ((.isCrossRepository // false) | tostring)' \
    2>/dev/null || true)"
  # Split on the LAST separator, not the first: git permits '|' inside a branch
  # name, so a head branch called `foo|false` would otherwise shift the fields
  # and hand the fork test the string "false|true" — a fork PR reading as
  # same-repo, with the truncated name then matching some unrelated base-repo
  # branch. isCrossRepository is the final field, so the last '|' is the seam.
  head_ref="${head_line%|*}"
  is_fork="${head_line##*|}"
  [[ -n "$head_ref" ]] || die "adopt: could not resolve the head branch of PR #$pr"
  # A fork's branch lives in another repository — we cannot push fixes to it.
  # Demand the literal "false": any other answer (including a malformed or
  # truncated one) means the PR's origin is undetermined, which must refuse.
  [[ "$is_fork" == "false" ]] ||
    die "adopt: PR #$pr is cross-repository or its origin is undeterminable; its branch is not pushable"

  # Re-entrant: an existing worktree for this issue is reused — but only if it is
  # already on the PR's head branch. A lane `assign` created sits on
  # `issue/<N>-<slug>`, and silently reusing it would push the fix to a branch the
  # PR does not track: a second PR, and a lane `reconcile` can never find again.
  if [[ -d "$dir" ]]; then
    on_branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    [[ "$on_branch" == "$head_ref" ]] ||
      die "adopt: worktree for issue $issue is on '$on_branch', not PR #$pr's '$head_ref' — release it first"
    printf '%s\n' "$dir"
    return 0
  fi

  # Enforce the cap only when creating a *new* worktree.
  if [[ "$(cmd_free)" -le 0 ]]; then
    die "adopt: fleet is full ($(count_active)/$(max_workers) workers active)"
  fi

  # The bot branch is usually pushed after this clone existed, so fetch the ref
  # itself rather than trust a possibly-absent origin/<ref>. The explicit refspec
  # guarantees the tracking ref below exists, and its `+` accepts the bot's
  # force-pushes — it updates only refs/remotes, never a local branch.
  git -C "$root" fetch --quiet origin "+refs/heads/$head_ref:refs/remotes/origin/$head_ref" \
    || die "adopt: could not fetch origin/$head_ref"
  mkdir -p "$root/$WORKTREE_ROOT"

  if git -C "$root" show-ref --verify --quiet "refs/heads/$head_ref"; then
    # Never reset, never force: a local tip the remote no longer contains means
    # the bot force-pushed, and attaching would build on state that is gone.
    # Both revs are fully qualified: a tag sharing the branch's name outranks the
    # branch in `git rev-parse`, so unqualified names would test one object while
    # `worktree add` below checks out another.
    git -C "$root" merge-base --is-ancestor \
      "refs/heads/$head_ref" "refs/remotes/origin/$head_ref" \
      || die "adopt: local '$head_ref' diverged from origin/$head_ref — resolve by hand, then re-adopt"
    git -C "$root" worktree add "$dir" "$head_ref" >&2
  else
    git -C "$root" worktree add --track -b "$head_ref" "$dir" "origin/$head_ref" >&2
  fi
  printf '%s\n' "$dir"
}

# Normalize an arbitrary title fragment into a safe kebab slug. Truncate first,
# then trim a trailing hyphen so a mid-word cut never yields a dangling '-'.
sanitize_slug() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | cut -c1-40)"
  raw="${raw#-}"
  raw="${raw%-}"
  [[ -n "$raw" ]] || raw="issue"
  printf '%s\n' "$raw"
}

# Integrate latest origin/main by MERGE (not rebase): no history rewrite, so the
# in-flight PR branch updates with a plain push — never a force-push. The merge
# commits are squashed away when the PR finally merges.
cmd_sync() {
  local issue="$1" dir
  [[ -n "$issue" ]] || die "sync: missing issue number"
  dir="$(issue_dir "$issue")"
  [[ -d "$dir" ]] || die "sync: no worktree for issue $issue"
  git -C "$dir" fetch --quiet origin main || die "sync: could not fetch origin/main"
  if git -C "$dir" merge --no-edit origin/main >&2; then
    return 0
  fi
  git -C "$dir" merge --abort >/dev/null 2>&1 || true
  echo "fleet: merge conflict in issue $issue — worktree left clean, drop to Gate 1" >&2
  exit 3
}

cmd_release() {
  local issue="$1" root dir branch
  [[ -n "$issue" ]] || die "release: missing issue number"
  root="$(repo_root)"
  dir="$(issue_dir "$issue")"
  branch=""
  if [[ -d "$dir" ]]; then
    branch="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    git -C "$root" worktree remove --force "$dir" >&2 || rm -rf "$dir"
  fi
  git -C "$root" worktree prune >/dev/null 2>&1 || true
  if [[ -n "$branch" && "$branch" != "HEAD" ]]; then
    git -C "$root" branch -D "$branch" >/dev/null 2>&1 || true
  fi
}

# Release any worktree whose work is finished: PR merged/closed, or the issue
# itself closed with no open PR. Keeps the fleet from silting up.
cmd_reconcile() {
  command -v gh >/dev/null 2>&1 || die "reconcile: gh CLI required" 2
  local issue branch _path pr_state issue_state
  while IFS=$'\t' read -r issue branch _path; do
    [[ -n "$issue" ]] || continue
    pr_state="$(gh pr list --head "$branch" --state all --limit 1 \
      --json state --jq '.[0].state // ""' 2>/dev/null || true)"
    if [[ "$pr_state" == "MERGED" || "$pr_state" == "CLOSED" ]]; then
      echo "fleet: releasing issue $issue (PR $pr_state)" >&2
      cmd_release "$issue"
      continue
    fi
    if [[ -z "$pr_state" ]]; then
      issue_state="$(gh issue view "$issue" --json state --jq .state 2>/dev/null || true)"
      if [[ "$issue_state" == "CLOSED" ]]; then
        echo "fleet: releasing issue $issue (issue closed, no PR)" >&2
        cmd_release "$issue"
      fi
    fi
  done < <(list_worktrees)
  git -C "$(repo_root)" worktree prune >/dev/null 2>&1 || true
}

usage() {
  sed -n '2,51p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    list)      cmd_list ;;
    active)    cmd_active ;;
    count)     cmd_count ;;
    free)      cmd_free ;;
    path)      cmd_path "${1:-}" ;;
    assign)    cmd_assign "${1:-}" "${2:-}" ;;
    adopt)     cmd_adopt "${1:-}" "${2:-}" ;;
    sync)      cmd_sync "${1:-}" ;;
    release)   cmd_release "${1:-}" ;;
    reconcile) cmd_reconcile ;;
    -h | --help | help | "") usage 0 ;;
    *) die "unknown subcommand '$cmd' (try: help)" ;;
  esac
}

main "$@"
