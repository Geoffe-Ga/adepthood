#!/usr/bin/env bash
# scripts/graph/report_workflow_failure.sh
#
# Open-or-update ONE tracking issue for a failing scheduled workflow.
#
# WHY THIS EXISTS: graph-semantic.yml failed six weekly runs across more than a
# month and nobody noticed — while CLAUDE.md was instructing every agent to
# prefer the knowledge graph over grep sweeps, so a tool that had never once
# been built was being reached for the whole time. The extraction failure was
# the cheap defect; the silence around it was the expensive one. A scheduled job
# whose failure nobody sees is a job that is not running, and it looks identical
# to a job with nothing to do.
#
# ONE issue, not one per run. A bot that files weekly is noise, and noise is
# exactly how the original six failures went unread. So: find the tracking issue
# by a durable marker in its body, comment on it if it exists, file it if it does
# not — and if the search itself could not be completed, file NOTHING and exit
# non-zero. Reading a failed lookup as "nothing is tracking this" is how one
# tracking issue silently becomes one per week.
#
# The report names the failing STEP and the first DISTINCT error lines. Distinct
# matters: thirteen chunks failing with the same sentence and a different number
# is one fact, and reprinting it thirteen times rebuilds the wall of text that
# made this invisible in the first place. Lines are deduplicated by their shape
# with digit runs normalised, so `chunk 5/13 failed: Connection error.` and
# `chunk 6/13 failed: Connection error.` count once between them.
#
# Usage:
#   report_workflow_failure.sh --workflow <file.yml> --run-url <url>
#                              [--log-file <path>] [--repo <owner/repo>]
#                              [--label <label>]...
#
# Reads GH_TOKEN/GITHUB_TOKEN via `gh` as usual. Exits 0 when the failure is
# tracked, 1 when it could not be, 2 on a usage error.
set -uo pipefail

# How many distinct error lines to quote. Enough to carry the cause and its
# consequence; short enough that the issue stays readable at a glance.
readonly MAX_ERROR_LINES=6
# Page size for the tracking-issue search. The marker makes the match exact; the
# label keeps the scan cheap.
readonly ISSUE_SCAN_LIMIT=200
readonly TRACKING_LABEL="ci-failure"

readonly EXIT_OK=0
readonly EXIT_FAILED=1
readonly EXIT_USAGE=2

die() { echo "report-workflow-failure: $1" >&2; exit "$EXIT_USAGE"; }

workflow=""
run_url=""
log_file=""
repo_args=()
labels=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workflow) [[ $# -ge 2 ]] || die "--workflow needs a value"; workflow="$2"; shift 2 ;;
    --run-url)  [[ $# -ge 2 ]] || die "--run-url needs a value"; run_url="$2"; shift 2 ;;
    --log-file) [[ $# -ge 2 ]] || die "--log-file needs a value"; log_file="$2"; shift 2 ;;
    --repo)     [[ $# -ge 2 ]] || die "--repo needs a value"; repo_args+=(--repo "$2"); shift 2 ;;
    --label)    [[ $# -ge 2 ]] || die "--label needs a value"; labels+=("$2"); shift 2 ;;
    *)          die "unknown argument: $1" ;;
  esac
done
[[ -n "$workflow" ]] || die "usage: --workflow <file.yml> --run-url <url> [--log-file <path>]"
[[ -n "$run_url" ]] || die "usage: --workflow <file.yml> --run-url <url> [--log-file <path>]"
[[ "${#labels[@]}" -gt 0 ]] || labels=("$TRACKING_LABEL")

# The durable link between a workflow and its one tracking issue. It lives in the
# issue BODY, the same shape the Dependabot bridge uses, because a title can be
# edited and a label can fail to stick.
marker="<!-- workflow-failure:${workflow} -->"

# --- what failed ------------------------------------------------------------
# `gh run view --log-failed` emits TAB-separated `<job>\t<step>\t<timestamp>
# <message>`. Pull the step off the first such line and the first MAX_ERROR_LINES
# distinct messages, keying uniqueness on the message with digit runs collapsed.
failing_step=""
error_lines=""
if [[ -n "$log_file" && -r "$log_file" ]]; then
  failing_step="$(awk -F'\t' 'NF >= 3 { print $2; exit }' "$log_file")"
  error_lines="$(awk -F'\t' -v maximum="$MAX_ERROR_LINES" '
    NF < 3 { next }
    {
      message = $3
      for (i = 4; i <= NF; i++) message = message "\t" $i
      sub(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[^ ]*[ ]+/, "", message)
      if (message == "") next
      shape = message
      gsub(/[0-9]+/, "N", shape)
      if (shape in seen) next
      seen[shape] = 1
      print message
      if (++kept >= maximum) exit
    }
  ' "$log_file")"
fi
[[ -n "$failing_step" ]] || failing_step="(step name unavailable)"
[[ -n "$error_lines" ]] || error_lines="(no failure log was readable for this run)"

title="CI: ${workflow} is failing"
detail="$(printf '**Workflow:** `%s`\n**Failing step:** `%s`\n**Run:** %s\n\nFirst distinct error lines:\n\n```\n%s\n```\n' \
  "$workflow" "$failing_step" "$run_url" "$error_lines")"

# --- is anything already tracking this? -------------------------------------
# A failed search is NOT "no tracking issue". Exit rather than file a duplicate.
existing="$(gh issue list "${repo_args[@]+"${repo_args[@]}"}" \
  --state open --limit "$ISSUE_SCAN_LIMIT" --json number,body \
  --jq ".[] | select((.body // \"\") | contains(\"$marker\")) | .number")" || {
  echo "::error::report-workflow-failure: could not search for the tracking issue of $workflow — refusing to file one, because a failed search read as 'none exists' turns one tracking issue into one per run." >&2
  exit "$EXIT_FAILED"
}
existing="$(head -n 1 <<<"$existing")"

if [[ -n "$existing" ]]; then
  body="$(printf 'Failed again.\n\n%s' "$detail")"
  gh issue comment "$existing" "${repo_args[@]+"${repo_args[@]}"}" --body "$body" || {
    echo "::error::report-workflow-failure: could not comment on the tracking issue #$existing for $workflow" >&2
    exit "$EXIT_FAILED"
  }
  echo "report-workflow-failure: updated tracking issue #$existing for $workflow"
  exit "$EXIT_OK"
fi

label_args=()
for label in "${labels[@]}"; do label_args+=(--label "$label"); done

body="$(printf '%s\n\nThis workflow runs on a schedule, so its failures are invisible unless something says so — which is why this issue exists rather than a weekly run of new ones. **Subsequent failures will be added as comments here, not filed as new issues.** Close it once the workflow is green again.\n\n%s\n' \
  "$detail" "$marker")"

# `--label` on a repo missing the label makes gh fail the whole create, which
# would trade a tracked failure for no report at all. Retry unlabelled rather
# than lose the alarm; the marker, not the label, is what makes it findable.
if ! gh issue create "${repo_args[@]+"${repo_args[@]}"}" \
     --title "$title" --body "$body" "${label_args[@]}"; then
  echo "report-workflow-failure: labelled create failed; retrying without labels" >&2
  gh issue create "${repo_args[@]+"${repo_args[@]}"}" --title "$title" --body "$body" || {
    echo "::error::report-workflow-failure: could not file a tracking issue for $workflow" >&2
    exit "$EXIT_FAILED"
  }
fi
echo "report-workflow-failure: filed a tracking issue for $workflow"
exit "$EXIT_OK"
