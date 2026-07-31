#!/usr/bin/env bash
# scripts/ralph/watch-pr.sh
#
# Per-lane hot watch for the Ralph orchestrator (ralph-tick.md Step 5, LOCAL
# platform path). Local terminal sessions get NO PR webhooks at all —
# `subscribe_pr_activity` is remote-only — so without this a lane that goes
# ready sits unnoticed until the 1200–1800s ScheduleWakeup fallback fires: an
# up-to-27-minute PR-open→merge latency. On BOTH platforms a background Bash
# task's exit re-invokes the session, so a watcher process that exits on
# state-change IS a wake. This script is that watcher: it polls
# `pr-ready.sh <PR>` every INTERVAL seconds and exits the moment the lane
# leaves its in-flight states (`pending`, `awaiting-review`), printing one
# `WATCH <PR> <token>` line that the woken orchestrator reads as the lane's
# fresh classification.
#
# Exit-code contract: wait outcomes ALWAYS exit 0 — `WATCH <PR> ready`,
# `WATCH <PR> gone` (PR merged/closed under us), `WATCH <PR> timeout <last>`,
# and `WATCH <PR> already-watching` are all successful watches. Exit 2 means a
# usage error only, mirroring pr-ready.sh's query contract.
#
# Idempotence: a pidfile (/tmp/ralph-watch-<reposlug>-<PR>.pid) makes blind
# re-launching safe. ralph-tick just launches a watcher for every open PR on
# every wake; a PR already under a live watch short-circuits with
# `WATCH <PR> already-watching` instead of stacking watchers, and a stale
# pidfile (dead pid) is taken over.
#
# API resilience: pr-ready.sh exits non-zero on tooling errors (rate limit,
# expired token, 5xx). A watcher that died on one would silently reintroduce
# the full-fallback latency, so errors NEVER end the loop; each error instead
# probes `gh pr view --json state`, because a vanished (merged/closed) PR is
# the one benign cause of a classify failure — that ends the watch as `gone`.
#
# Usage:  watch-pr.sh <PR_NUMBER> [INTERVAL_SECONDS=30] [TIMEOUT_SECONDS=1800]
set -euo pipefail

readonly DEFAULT_INTERVAL_SECONDS=30
readonly DEFAULT_TIMEOUT_SECONDS=1800

# Consecutive pr-ready.sh failures tolerated silently. Past this the watcher
# notes the streak on stderr (once) — purely informational: the loop never
# dies on API errors, because a dead watcher is a silent latency regression.
readonly MAX_QUIET_ERRORS=3

# The two pr-ready.sh tokens that mean "still in flight — keep waiting". Every
# other token (ready, ready-unreviewed, behind, ci-failed, optout) is terminal
# for the watch: the orchestrator has something to act on RIGHT NOW.
readonly IN_FLIGHT_TOKENS=("pending" "awaiting-review")

die() {
  echo "watch-pr: $1" >&2
  exit 2
}

pr="${1:-}"
interval="${2:-$DEFAULT_INTERVAL_SECONDS}"
timeout="${3:-$DEFAULT_TIMEOUT_SECONDS}"
[[ "$pr" =~ ^[0-9]+$ ]] || die "usage: watch-pr.sh <PR_NUMBER> [INTERVAL_SECONDS] [TIMEOUT_SECONDS]"
[[ "$interval" =~ ^[1-9][0-9]*$ ]] || die "INTERVAL_SECONDS must be a positive integer"
[[ "$timeout" =~ ^[1-9][0-9]*$ ]] || die "TIMEOUT_SECONDS must be a positive integer"

READY="$(cd "$(dirname "$0")" && pwd)/pr-ready.sh"

# --- pidfile idempotence -----------------------------------------------------
# Slug from the origin remote's basename (handles both URL forms, trailing
# slashes, and `.git`); fall back to the repo directory name so a remote-less
# checkout still gets a stable, distinct pidfile.
slug="$(git remote get-url origin 2>/dev/null | sed -e 's#/*$##' -e 's#.*/##' -e 's#\.git$##')" || slug=""
[[ -n "$slug" ]] || slug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
pidfile="/tmp/ralph-watch-${slug}-${pr}.pid"

if [[ -f "$pidfile" ]]; then
  old_pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "WATCH $pr already-watching"
    exit 0
  fi
fi
echo "$$" >"$pidfile"

# Remove the pidfile only while it is still OURS: if a later watcher took over
# a stale file, its lock must not be deleted from under it.
cleanup() {
  [[ "$(cat "$pidfile" 2>/dev/null || true)" == "$$" ]] && rm -f "$pidfile"
  return 0
}
trap cleanup EXIT

# --- helpers -----------------------------------------------------------------
is_in_flight() {
  local t
  for t in "${IN_FLIGHT_TOKENS[@]}"; do
    [[ "$1" == "$t" ]] && return 0
  done
  return 1
}

# True when the PR is MERGED or CLOSED. Probed only when pr-ready.sh cannot
# classify — a vanished PR is the benign explanation, and anything else
# (including this probe itself failing) just keeps the watch alive.
pr_gone() {
  local state
  state="$(gh pr view "$pr" --json state --jq '.state' 2>/dev/null)" || return 1
  [[ "$state" == "MERGED" || "$state" == "CLOSED" ]]
}

# --- watch loop --------------------------------------------------------------
last_token="unknown"
errors=0
SECONDS=0
while ((SECONDS < timeout)); do
  ec=0
  token="$("$READY" "$pr" 2>/dev/null)" || ec=$?
  if ((ec == 0)) && [[ -n "$token" ]]; then
    errors=0
    last_token="$token"
    if ! is_in_flight "$token"; then
      echo "WATCH $pr $token"
      exit 0
    fi
  else
    if pr_gone; then
      echo "WATCH $pr gone"
      exit 0
    fi
    errors=$((errors + 1))
    if ((errors == MAX_QUIET_ERRORS + 1)); then
      echo "watch-pr: pr-ready.sh failed $errors consecutive times on PR #$pr; still watching" >&2
    fi
  fi
  sleep "$interval"
done

echo "WATCH $pr timeout $last_token"
exit 0
