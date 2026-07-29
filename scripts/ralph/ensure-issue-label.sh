#!/usr/bin/env bash
# scripts/ralph/ensure-issue-label.sh
#
# Apply a label to a GitHub issue and PROVE it stuck, reproducing the verbatim
# stderr of every gh call that fails.
#
# WHY THIS EXISTS: the Dependabot-to-Ralph bridge used to label its issues with
# `gh issue edit N --add-label X || true`, and two things were wrong with that.
#
#   1. `gh issue edit --add-label` performs the GraphQL mutation
#      `addLabelsToLabelable`, which the fine-grained PAT the workflow runs under
#      is denied ("Resource not accessible by personal access token") even though
#      the same token creates issues and edits PR bodies in the same run. The
#      REST endpoint used here, POST /repos/:repo/issues/:n/labels, needs only
#      `issues: write` and errors instead of silently dropping. Never reach for
#      `gh issue edit --add-label` in this script: that is the denied call.
#   2. `|| true` discarded the API's answer, so the workflow could only GUESS at
#      the cause of a missing label - and guessed wrong. Nothing is swallowed
#      here: every failing call's stderr is printed verbatim, INCLUDING when the
#      fallback token rescues the call, because a capability gap papered over by
#      a second token is still a capability gap worth knowing about.
#
# Tokens travel by environment only - never in argv, never echoed, no `set -x`:
#   GH_TOKEN           primary token (gh reads it itself)
#   FALLBACK_GH_TOKEN  optional second token, tried once if the primary fails
#                      and only when it actually differs from GH_TOKEN
#
# Usage:  ensure-issue-label.sh <issue-number> <label> [--repo <owner/repo>]
# Exit:   0 = applied and verified | 1 = label missing/unverifiable | 2 = usage
set -euo pipefail

readonly USAGE='usage: ensure-issue-label.sh <issue-number> <label> [--repo <owner/repo>]'
readonly EXIT_LABEL_FAILED=1
readonly ROLE_PRIMARY=primary
readonly ROLE_FALLBACK=fallback

die() { echo "ensure-issue-label: $1" >&2; exit 2; }

issue=""
label=""
# GITHUB_REPOSITORY is the Actions-native default; --repo wins when given.
repo="${GITHUB_REPOSITORY:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) [[ $# -ge 2 ]] || die "--repo needs a value"; repo="$2"; shift 2 ;;
    -*)     die "unknown option: $1" ;;
    *)
      if   [[ -z "$issue" ]]; then issue="$1"
      elif [[ -z "$label" ]]; then label="$1"
      else die "unexpected extra argument: $1"
      fi
      shift ;;
  esac
done
[[ "$issue" =~ ^[0-9]+$ ]] || die "$USAGE"
[[ -n "$label" ]]          || die "$USAGE"
[[ -n "$repo" ]]           || die "--repo is required when GITHUB_REPOSITORY is unset"

# --- reporting helpers -------------------------------------------------------
#
# Failure text is plain: callers own the `::error::` annotation (the workflow
# bridge re-emits the captured output that way, and double-prefixing reads
# badly). The one exception is the fallback-rescue warning below - that path
# exits 0, so nothing downstream would ever annotate it, yet a capability gap
# hidden behind a second token is exactly what must not go unnoticed.

# Print a heading followed by a captured gh stderr block, unedited. Verbatim is
# the whole point: an invented paraphrase is what sent the last investigation
# down the wrong path.
report_block() { # report_block <heading> <captured-stderr>
  printf '%s\n%s\n' "$1" "$2" >&2
}

# The one-time manual fix for a human. `gh issue edit` is fine from a laptop
# (an interactive login is not the denied PAT) - it is only wrong for this
# script's automated path.
report_remedy() {
  printf 'One-time manual fix: gh issue edit %s --repo %s --add-label %s\n' \
    "$issue" "$repo" "$label" >&2
}

# --- apply -------------------------------------------------------------------

# The REST label call. Reads its token from the environment so no token ever
# reaches a process listing.
post_label() {
  gh api --method POST "repos/$repo/issues/$issue/labels" -f "labels[]=$label"
}

# Run post_label, optionally under an override token, capturing its stderr in
# APPLY_STDERR and returning gh's own exit code. The `2>&1 >/dev/null` order
# routes stderr to the capture and drops the (unused) response body. The
# assignment lives inside a command substitution, so an override token cannot
# leak back into this shell's environment.
apply_label() { # apply_label [override-token]
  local ec=0
  if [[ $# -eq 0 ]]; then
    APPLY_STDERR="$(post_label 2>&1 >/dev/null)" || ec=$?
  else
    APPLY_STDERR="$(GH_TOKEN="$1" post_label 2>&1 >/dev/null)" || ec=$?
  fi
  return "$ec"
}

# A fallback is only worth an extra API call when it exists and is a genuinely
# different credential; retrying the same token would just re-earn the same 403.
fallback_usable() {
  [[ -n "${FALLBACK_GH_TOKEN:-}" && "${FALLBACK_GH_TOKEN}" != "${GH_TOKEN:-}" ]]
}

applied_by=""
primary_stderr=""
fallback_stderr=""
fallback_tried=0

if apply_label; then
  applied_by="$ROLE_PRIMARY"
else
  primary_stderr="$APPLY_STDERR"
  if fallback_usable; then
    fallback_tried=1
    if apply_label "$FALLBACK_GH_TOKEN"; then
      applied_by="$ROLE_FALLBACK"
    else
      fallback_stderr="$APPLY_STDERR"
    fi
  fi
fi

if [[ -z "$applied_by" ]]; then
  printf 'ensure-issue-label: could not apply label %s to issue #%s in %s.\n' \
    "$label" "$issue" "$repo" >&2
  report_block "Verbatim gh stderr from the $ROLE_PRIMARY token attempt:" "$primary_stderr"
  if [[ "$fallback_tried" -eq 1 ]]; then
    report_block "Verbatim gh stderr from the $ROLE_FALLBACK token attempt:" "$fallback_stderr"
  else
    echo "No usable FALLBACK_GH_TOKEN was set, so only one attempt was made." >&2
  fi
  report_remedy
  exit "$EXIT_LABEL_FAILED"
fi

# The fallback succeeded, so the run continues - but the primary token's gap is
# real and must be logged rather than papered over.
if [[ "$applied_by" == "$ROLE_FALLBACK" ]]; then
  report_block \
    "::warning::ensure-issue-label: the $ROLE_PRIMARY token could not apply label $label to issue #$issue; the $ROLE_FALLBACK token succeeded. Verbatim gh stderr from the $ROLE_PRIMARY attempt:" \
    "$primary_stderr"
fi

# --- verify ------------------------------------------------------------------

# A 2xx on the POST is not proof: read the labels back. stderr goes to its own
# file so a failed read reports its real error instead of contaminating the
# label list.
readback_stderr="$(mktemp)"
trap 'rm -f "$readback_stderr"' EXIT

labels=""
readback_ec=0
labels="$(gh issue view "$issue" --repo "$repo" \
  --json labels --jq '.labels[].name' 2>"$readback_stderr")" || readback_ec=$?

if [[ "$readback_ec" -ne 0 ]]; then
  printf 'ensure-issue-label: applied label %s to issue #%s with the %s token, but the read-back call failed, so the label is UNVERIFIED. This is usually a transient API error and the apply may well have stuck - check the issue before acting.\n' \
    "$label" "$issue" "$applied_by" >&2
  report_block "Verbatim gh stderr from the read-back call:" "$(cat "$readback_stderr")"
  report_remedy
  exit "$EXIT_LABEL_FAILED"
fi

# Exact, per-label comparison: a repo label named `<label>-bot` must not be read
# as `<label>`. -x anchors the whole line, -F keeps the label a literal.
if ! printf '%s\n' "$labels" | grep -qxF -- "$label"; then
  printf 'ensure-issue-label: the %s token API call reported success, but issue #%s does not carry label %s - it was silently dropped.\n' \
    "$applied_by" "$issue" "$label" >&2
  report_block "Labels actually read back from issue #$issue:" "$labels"
  report_remedy
  exit "$EXIT_LABEL_FAILED"
fi

printf 'ensure-issue-label: label %s applied to issue #%s with the %s token and verified.\n' \
  "$label" "$issue" "$applied_by"
