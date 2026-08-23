#!/usr/bin/env bash
# scripts/ralph/issue-evidence.sh
#
# Re-run the evidence open issues cite, and comment on the ones whose premise
# has expired. This is the `gh` transport; every judgement lives in
# `backend/scripts/issue_evidence.py`, which never touches the network and never
# shells out.
#
# WHY THE SPLIT: issue bodies are untrusted text written by many hands, and this
# script runs under a write-capable token. Handing a quoted `grep` from a body to
# a shell would be arbitrary command execution. The checker therefore re-runs the
# grep in-process over a vetted pattern subset, and this script's only job is to
# fetch JSON in and post comments out.
#
# WHY IT NEVER GUESSES: a `gh` failure — rate limit, expired token, network — is
# reported as a transport error and stops the run. It is NEVER allowed to look
# like "no issues, therefore nothing expired", which is the conflation #2219
# fixed in pr-ready.sh. Nothing here is wrapped in `|| true` and nothing is
# redirected to /dev/null.
#
# READ-ONLY except for one comment. It never edits a body, never changes a
# label, never closes anything. A tool that reorganises the backlog on a
# heuristic is worse than the decay it treats.
#
# COMMENTS FIRE ONCE PER TRANSITION. Each comment carries a hidden marker
# digesting the expired-claim set; a re-run that finds the same thing finds its
# own marker already present and posts nothing. A bot that re-posts weekly is
# noise, and noise is how a broken loop goes unnoticed for twelve days.
#
# Usage:
#   issue-evidence.sh [--label L] [--state S] [--limit N] [--comment] [--repo R]
#
#   --label    Issue label to check. Repeatable. Default: agent-ready.
#   --state    open | closed | all. Default: open.
#   --limit    Max issues fetched. Default: 200.
#   --comment  Actually post comments. Omitted = dry run, which prints what it
#              would have posted. Default is dry so a human can read the first
#              run of any change before a bot speaks in the backlog.
#
# Exit: 0 = report produced, nothing expired
#       1 = at least one premise expired (advisory; no gate consumes this)
#       2 = transport or usage failure — NO verdict was reached
set -euo pipefail

readonly EXIT_EXPIRED=1
readonly EXIT_TRANSPORT=2

die() { echo "issue-evidence: $1" >&2; exit "$EXIT_TRANSPORT"; }

repo="${GITHUB_REPOSITORY:-}"
state="open"
limit="200"
do_comment=0
labels=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)   [[ $# -ge 2 ]] || die "--label needs a value";  labels+=("$2"); shift 2 ;;
    --state)   [[ $# -ge 2 ]] || die "--state needs a value";  state="$2";     shift 2 ;;
    --limit)   [[ $# -ge 2 ]] || die "--limit needs a value";  limit="$2";     shift 2 ;;
    --repo)    [[ $# -ge 2 ]] || die "--repo needs a value";   repo="$2";      shift 2 ;;
    --comment) do_comment=1; shift ;;
    *)         die "unknown argument: $1" ;;
  esac
done

[[ ${#labels[@]} -gt 0 ]] || labels=("agent-ready")
[[ "$limit" =~ ^[0-9]+$ ]] || die "--limit must be a number"

command -v gh  >/dev/null 2>&1 || die "gh CLI not found"
command -v jq  >/dev/null 2>&1 || die "jq not found"

root="$(git rev-parse --show-toplevel)" || die "not inside a git repository"
python_bin="${PYTHON:-python3}"
command -v "$python_bin" >/dev/null 2>&1 || die "$python_bin not found"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
issues_json="$workdir/issues.json"
payload_json="$workdir/payload.json"

label_args=()
for label in "${labels[@]}"; do label_args+=(--label "$label"); done

# The fetch. stderr is deliberately NOT swallowed: an auth or rate-limit failure
# must be readable in the run log rather than mistaken for an empty backlog.
if ! gh issue list --repo "$repo" --state "$state" "${label_args[@]}" \
       --limit "$limit" --json number,title,body,state >"$issues_json"; then
  die "gh issue list failed — transport error, no verdict reached"
fi

# `gh issue list` yields a JSON array; anything else means the fetch failed in a
# way that still exited 0. The checker refuses a non-array too, but failing here
# names the transport as the cause.
jq -e 'type == "array"' >/dev/null <"$issues_json" \
  || die "gh returned no issue array — transport error, no verdict reached"

set +e
( cd "$root/backend" && PYTHONPATH=. "$python_bin" -m scripts.issue_evidence \
    --issues-json "$issues_json" --root "$root" --json-out "$payload_json" )
checker_status=$?
set -e

if [[ "$checker_status" -gt "$EXIT_EXPIRED" ]]; then
  die "checker could not read its input (exit $checker_status)"
fi

closed_not_done="$(jq -r '.closed_not_done | map("#\(.)") | join(", ")' "$payload_json")"
if [[ -n "$closed_not_done" ]]; then
  echo "Closed but apparently not done (closed with no commit, evidence still holds): $closed_not_done"
fi

# One comment per issue whose premise expired, and only when this exact finding
# has not been reported before.
count="$(jq -r '.comment | length' "$payload_json")"
index=0
while [[ "$index" -lt "$count" ]]; do
  number="$(jq -r ".comment[$index].number" "$payload_json")"
  marker="$(jq -r ".comment[$index].marker" "$payload_json")"
  jq -r ".comment[$index].body" "$payload_json" >"$workdir/comment.md"
  index=$((index + 1))

  if [[ "$do_comment" -eq 0 ]]; then
    echo "--- would comment on #$number ---"
    cat "$workdir/comment.md"
    continue
  fi

  if ! gh issue view "$number" --repo "$repo" --json comments \
         --jq '.comments[].body' >"$workdir/existing.txt"; then
    die "gh issue view $number failed — transport error, no comment posted"
  fi
  # `grep -c` exits 1 on zero matches, so its count is never captured here.
  if grep -qF "$marker" "$workdir/existing.txt"; then
    echo "#$number: this finding was already reported — not re-posting."
    continue
  fi

  if ! gh issue comment "$number" --repo "$repo" --body-file "$workdir/comment.md"; then
    die "gh issue comment $number failed — transport error"
  fi
  echo "#$number: commented (premise expired)."
done

exit "$checker_status"
