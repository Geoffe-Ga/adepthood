#!/usr/bin/env bash
# scripts/ci/check_scheduled_runs.sh
#
# Watch the scheduled workflows from OUTSIDE, because a workflow that never
# starts cannot report anything from inside itself.
#
# WHY THIS EXISTS: `startup_failure` is a real conclusion GitHub returns, and it
# is the quietest failure in the whole system. GitHub rejects the workflow file
# before scheduling any job -- so there is no job, no step, no log, and every
# in-workflow reporting job (including the one every scheduled workflow here now
# has) is never created and therefore never runs. Twelve scan workflows sat in
# that state and never executed once: each called a reusable workflow asking for
# a permission its caller did not hold. Nothing in the repo noticed, because the
# only thing that could have noticed was inside the workflows that were not
# starting.
#
# SCOPE, deliberately narrow: `startup_failure` and nothing else. "Has not run
# inside its window" is a tempting second check and a different problem -- it
# needs each cron's schedule, a clock, and a tolerance, and getting any of the
# three wrong produces false alarms that teach a reader to ignore this report.
# One check that is always right beats two where one cries wolf.
#
# It reads the schedule from the CHECKED-OUT TREE rather than from the API, with
# the same column-anchored match the legibility guard uses: an active cron is
# `schedule:` indented two spaces under `on:`, while the seventeen paused scans
# are parked as `  # schedule:` with their cron lines commented beneath. Matching
# the commented form would demand health from workflows that are switched off.
#
# Each sick workflow is routed through the SAME reporter every other failure
# uses (scripts/graph/report_workflow_failure.sh), under its own
# `<!-- workflow-failure:<file> -->` marker, so it gets its own single tracking
# issue rather than one shared issue naming several. No --log-file is passed,
# because a startup failure has no log to read -- that is the whole shape of it,
# and the reporter says so in the body rather than filing a blank.
#
# ONE call per sick workflow, not one per sick run. The marker means repeats
# become comments on the existing issue; per-run calls would just add N comments
# saying the same thing.
#
# Exit codes -- the caller branches on all three:
#   0  every actively scheduled workflow's recent runs are free of startup_failure
#   1  at least one startup_failure was seen (substantive: something is sick)
#   2  the sweep could not be completed, or an alarm could not be filed. NOT a
#      softer 1: it means part of the picture is missing, so it outranks 1 --
#      reading an incomplete sweep as a clean one is the failure this whole file
#      exists to prevent
#
# Usage:
#   check_scheduled_runs.sh [--workflows-dir <dir>] [--repo <owner/repo>]
#                           [--limit <N>] [--reporter <path>]
set -uo pipefail

readonly EXIT_OK=0
readonly EXIT_SICK=1
readonly EXIT_TRANSPORT=2

# How many recent runs of each workflow to inspect. Wide enough that a daily
# workflow's last few weeks are in view, small enough that the sweep is one
# cheap page per workflow.
readonly DEFAULT_RUN_LIMIT=20

# The conclusion this exists to find. Spelled once.
readonly SICK_CONCLUSION="startup_failure"

die() { echo "check-scheduled-runs: $1" >&2; exit "$EXIT_TRANSPORT"; }

here="$(cd "$(dirname "$0")/../.." && pwd)"
workflows_dir="$here/.github/workflows"
reporter="$here/scripts/graph/report_workflow_failure.sh"
repo="${GITHUB_REPOSITORY:-}"
limit="$DEFAULT_RUN_LIMIT"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workflows-dir) [[ $# -ge 2 ]] || die "--workflows-dir needs a value"; workflows_dir="$2"; shift 2 ;;
    --repo)          [[ $# -ge 2 ]] || die "--repo needs a value"; repo="$2"; shift 2 ;;
    --limit)         [[ $# -ge 2 ]] || die "--limit needs a value"; limit="$2"; shift 2 ;;
    --reporter)      [[ $# -ge 2 ]] || die "--reporter needs a value"; reporter="$2"; shift 2 ;;
    *)               die "unknown argument: $1" ;;
  esac
done

[[ "$limit" =~ ^[0-9]+$ ]] || die "--limit must be a number, got: $limit"
[[ -n "$repo" ]] || die "no repository: pass --repo or set GITHUB_REPOSITORY"
[[ -d "$workflows_dir" ]] || die "no workflows directory at $workflows_dir"
[[ -r "$reporter" ]] || die "no failure reporter at $reporter"

server="${GITHUB_SERVER_URL:-https://github.com}"

summary() { # summary <line>
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
  printf '%s\n' "$1"
}

summary "## Scheduled workflow health"
summary ""
summary "Latest run of each actively scheduled workflow. Grouped by workflow and dated, not counted by conclusion: a workflow whose last ten runs are nine successes and one startup failure is a different animal depending on which one was last."
summary ""

checked=0
sick=0
transport=0

for workflow in "$workflows_dir"/*.yml; do
  [[ -e "$workflow" ]] || continue
  name="$(basename "$workflow")"

  # Column-anchored: `  schedule:` and nothing else on the line. grep exits 1
  # for "no match" and 2 for "could not read", and those must not be confused.
  grep_status=0
  grep -qE '^  schedule:[[:space:]]*$' "$workflow" || grep_status=$?
  if [[ "$grep_status" -eq 1 ]]; then
    continue
  fi
  if [[ "$grep_status" -ne 0 ]]; then
    summary "- \`$name\`: **could not be read** to see whether it is scheduled."
    transport=1
    continue
  fi

  checked=$((checked + 1))
  runs=""
  gh_status=0
  runs="$(gh run list --repo "$repo" --workflow "$name" --limit "$limit" \
            --json conclusion,createdAt,databaseId)" || gh_status=$?
  if [[ "$gh_status" -ne 0 ]]; then
    summary "- \`$name\`: **could not be asked** -- \`gh run list\` exited $gh_status. Health UNKNOWN; this is not a clean bill."
    transport=1
    continue
  fi

  # `gh` exiting 0 is not the same as `gh` answering. Anything that is not the
  # run ARRAY this asked for must stop here rather than be counted: `.[]`
  # iterates an OBJECT's values, so a `{}` body yields a count of zero, passes
  # the numeric guard below, and prints a clean bill -- a transport fault
  # wearing the one answer that means "all clear". That substitution is the
  # whole defect this file exists to refuse, and it would have been made here.
  if ! printf '%s' "$runs" | jq -e 'type == "array"' >/dev/null 2>&1; then
    summary "- \`$name\`: **unreadable run list** -- \`gh\` exited 0 with something that is not a run array. Health UNKNOWN; this is not a clean bill."
    transport=1
    continue
  fi

  # A run still in flight has an empty conclusion; say so rather than printing
  # a blank, which reads as a missing field rather than as a running job.
  latest="$(printf '%s' "$runs" | jq -r '.[0] | if . == null then "never run|-" else ((.conclusion // "") | if . == "" then "in progress" else . end) + "|" + .createdAt end')"
  latest_conclusion="${latest%%|*}"
  latest_at="${latest#*|}"

  sick_count="$(printf '%s' "$runs" | jq -r --arg bad "$SICK_CONCLUSION" '[.[] | select(.conclusion == $bad)] | length')"
  if [[ ! "$sick_count" =~ ^[0-9]+$ ]]; then
    summary "- \`$name\`: **unreadable run list** -- \`gh\` exited 0 with something that is not a run array. Health UNKNOWN."
    transport=1
    continue
  fi

  if [[ "$sick_count" -eq 0 ]]; then
    summary "- \`$name\`: $latest_conclusion ($latest_at)"
    continue
  fi

  sick=1
  summary "- \`$name\`: $latest_conclusion ($latest_at) -- **$sick_count \`$SICK_CONCLUSION\` in the last $limit runs**. GitHub rejected the workflow file before creating any job, so there is no log and nothing inside the workflow could have reported it."

  newest_sick_id="$(printf '%s' "$runs" | jq -r --arg bad "$SICK_CONCLUSION" '[.[] | select(.conclusion == $bad)] | .[0].databaseId')"
  run_url="$server/$repo/actions/runs/$newest_sick_id"
  report_status=0
  bash "$reporter" \
    --workflow "$name" \
    --repo "$repo" \
    --run-url "$run_url" \
    --headline "Startup failure: GitHub rejected $name before creating a single job, so it has not run and cannot report on itself. The usual cause is a called reusable workflow asking for a permission this file does not grant; check its top-level and job-level permissions blocks against the callee's." \
    --label bug \
    --label infra || report_status=$?
  if [[ "$report_status" -ne 0 ]]; then
    summary "  - could not open or update the tracking issue for \`$name\` (reporter exited $report_status)."
    transport=1
  fi
done

summary ""
if [[ "$checked" -eq 0 ]]; then
  # A sweep over nothing passes for the wrong reason, and would do so silently
  # forever if the enumeration ever broke.
  summary "**No actively scheduled workflow was found in \`$workflows_dir\`.** Either every cron is paused or this sweep is looking in the wrong place; both mean it is proving nothing."
  exit "$EXIT_TRANSPORT"
fi

if [[ "$transport" -eq 1 ]]; then
  summary "Swept $checked scheduled workflow(s), but part of the picture is missing -- see the lines above. An incomplete sweep is not a clean one."
  exit "$EXIT_TRANSPORT"
fi
if [[ "$sick" -eq 1 ]]; then
  summary "Swept $checked scheduled workflow(s); at least one is failing at startup and now has a tracking issue."
  exit "$EXIT_SICK"
fi
summary "Swept $checked scheduled workflow(s); none has failed at startup in its last $limit runs."
exit "$EXIT_OK"
