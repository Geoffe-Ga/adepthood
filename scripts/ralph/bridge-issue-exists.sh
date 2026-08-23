#!/usr/bin/env bash
# scripts/ralph/bridge-issue-exists.sh
#
# The Dependabot bridge's dedup check: does an OPEN `dependencies` issue already
# carry this PR's `<!-- dependabot-pr:N -->` marker?
#
# WHY THIS EXISTS AS A SCRIPT: the check used to live inline in
# `.github/workflows/dependabot-to-ralph-issue.yml` as
#
#     gh issue list ... --jq '.[].body' 2>/dev/null | grep -qF "$marker"
#
# and had two defects, neither of which a workflow `run:` block can be tested
# for.
#
#   1. SIGPIPE under `pipefail`. `grep -q` exits the moment it finds the marker.
#      Once the accumulated bodies of the open `dependencies` issues outgrow the
#      pipe buffer (64 KiB on Linux), that early exit kills `gh` with SIGPIPE and
#      the pipeline reports 141 — under `set -o pipefail`, EVEN THOUGH GREP
#      MATCHED. The bridge read 141 as "no issue exists" and filed a duplicate
#      for a PR it had already bridged. Latent rather than loud: it needs a large
#      enough open backlog, and the upstream `body_links_issue` check catches
#      most re-runs first, so it surfaced as occasional duplicate-issue noise.
#
#      The fix is not a bigger buffer or a `|| true`: it is to stop piping `gh`
#      into an early-exiting reader at all. The whole match happens inside the
#      single `--jq` filter `gh` already runs, so there is no second process to
#      close the pipe early — the same shape `pr-ready.sh` uses for the mirror
#      lookup.
#
#   2. `2>/dev/null` discarded gh's real error, making an auth or API failure
#      indistinguishable from "no match" — and "no match" is the answer that
#      files a duplicate. Nothing is swallowed here: gh's stderr passes through
#      verbatim and a failed lookup exits 2, which is neither "found" nor "not
#      found" and must never be collapsed into either.
#
# The match is on the WHOLE marker including its closing `-->`: `100` is a prefix
# of `1002`, so a looser test would let one bump's issue answer for another's.
#
# Usage:  bridge-issue-exists.sh <pr-number> [--repo <owner/repo>] [--label L]
#                                            [--limit N]
# Output: the matching issue numbers, one per line (empty when there are none).
# Exit:   0 = at least one open bridge issue carries this PR's marker
#         1 = none does — it is safe to file one
#         2 = usage error, or the lookup failed and NO answer was reached
set -euo pipefail

readonly EXIT_NO_MATCH=1
readonly EXIT_UNKNOWN=2

die() { echo "bridge-issue-exists: $1" >&2; exit "$EXIT_UNKNOWN"; }

pr=""
# GITHUB_REPOSITORY is the Actions-native default; --repo wins when given.
repo="${GITHUB_REPOSITORY:-}"
label="dependencies"
limit="200"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)  [[ $# -ge 2 ]] || die "--repo needs a value";  repo="$2";  shift 2 ;;
    --label) [[ $# -ge 2 ]] || die "--label needs a value"; label="$2"; shift 2 ;;
    --limit) [[ $# -ge 2 ]] || die "--limit needs a value"; limit="$2"; shift 2 ;;
    -*)      die "unknown option: $1" ;;
    *)
      [[ -z "$pr" ]] || die "unexpected extra argument: $1"
      pr="$1"; shift ;;
  esac
done

[[ "$pr" =~ ^[0-9]+$ ]] || die "usage: bridge-issue-exists.sh <pr-number> [--repo owner/repo]"
[[ "$limit" =~ ^[0-9]+$ ]] || die "--limit must be a number"
[[ -n "$repo" ]] || die "no repository: pass --repo or set GITHUB_REPOSITORY"

# The bridge's durable link, in the one shape every reader agrees on. Defined
# here the same way `pr-ready.sh` defines it and the bridge workflow writes it;
# test_bridge_issue_exists.sh case 8 is the tripwire on all three staying equal.
marker_for() { printf '<!-- dependabot-pr:%s -->' "$1"; }
marker="$(marker_for "$pr")"

repo_args=(--repo "$repo")

# One call, one filter, no pipe. Splicing $marker into the jq string is safe
# because $pr was already proved to match ^[0-9]+$ above — nothing else reaches
# the query. stderr is deliberately NOT redirected.
matches=""
if ! matches="$(gh issue list "${repo_args[@]}" \
                  --label "$label" --state open --limit "$limit" \
                  --json number,body \
                  --jq ".[] | select((.body // \"\") | contains(\"$marker\")) | .number")"; then
  die "gh issue list failed; whether an issue already exists for PR #$pr is UNKNOWN"
fi

[[ -n "$matches" ]] || exit "$EXIT_NO_MATCH"
printf '%s\n' "$matches"
