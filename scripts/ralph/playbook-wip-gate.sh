#!/usr/bin/env bash
# scripts/ralph/playbook-wip-gate.sh
#
# The weekly playbook's drain gate: may `weekly-playbook.yml` spend Claude
# tokens and file a new `playbook` issue this week, or is one still open?
#
# Prints exactly ONE token and exits 0 — it is a query, so a non-zero exit means
# a usage/tooling fault here, never a WIP verdict (the same contract
# `pr-ready.sh` keeps):
#
#   clear            no open `playbook` issue — the WIP limit is genuinely free
#   wip-limit-hit    at least one is open — Ralph has not drained last week's
#                    delta, so filing another would fork the playbook's state
#   transport-error  `gh` could not be asked, or answered with something that is
#                    not a count (no network, TLS, rate limit, 5xx, a malformed
#                    reply) — the WIP state is UNKNOWN and no verdict is claimed
#   auth-error       `gh` reports the credential is missing or rejected. Distinct
#                    from `transport-error` because it does NOT resolve itself
#                    next week: left as a soft stand-down it would skip forever
#                    while reporting success, which is the failure mode the
#                    live-model-check lane was built around
#
# WHY THIS EXISTS AS A SCRIPT: the check lived inline in the workflow as
#
#     OPEN=$(gh issue list --label playbook --state open --json number \
#              --jq 'length' || echo 0)
#
# and `|| echo 0` collapsed "there are none" into the same value as "the API did
# not answer". On a transport failure the workflow read 0, concluded the WIP
# limit was clear, and filed a duplicate issue beside one that already existed —
# the exact condition the limit exists to prevent. `pr-ready.sh` was bitten by
# the mirror image of this (a transport error reported as a merge verdict) and
# fixed the same way, with a token that means "I could not tell". A workflow
# `run:` block has no test seam; this has one, at
# backend/tests/scripts/test_playbook_wip_gate.py.
#
# `gh` stderr is deliberately NOT redirected: it carries the only description of
# what went wrong, and discarding it is half of how the original bug hid.
#
# Usage:  playbook-wip-gate.sh [--repo <owner/repo>] [--label L] [--limit N]
set -euo pipefail

readonly EXIT_USAGE=2

# `gh`'s documented exit code for "authentication required". Every other
# non-zero is treated as transport, which fails soft; misreading a rate limit as
# an auth fault would only cost one loud week, while the reverse costs silence.
readonly GH_EXIT_AUTH=4

die() { echo "playbook-wip-gate: $1" >&2; exit "$EXIT_USAGE"; }

# GITHUB_REPOSITORY is the Actions-native default; --repo wins when given.
repo="${GITHUB_REPOSITORY:-}"
label="playbook"
# The count only ever needs to answer "is it more than zero?", so a small page
# is enough; the token, not the number, is what the caller acts on.
limit="5"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)  [[ $# -ge 2 ]] || die "--repo needs a value";  repo="$2";  shift 2 ;;
    --label) [[ $# -ge 2 ]] || die "--label needs a value"; label="$2"; shift 2 ;;
    --limit) [[ $# -ge 2 ]] || die "--limit needs a value"; limit="$2"; shift 2 ;;
    *)       die "unknown argument: $1" ;;
  esac
done

[[ "$limit" =~ ^[0-9]+$ ]] || die "--limit must be a number"
[[ -n "$repo" ]] || die "no repository: pass --repo or set GITHUB_REPOSITORY"

# One call, one filter, no pipe — a pipe would let an early-exiting reader kill
# `gh` with SIGPIPE and report that as a failure (how the Dependabot bridge
# minted duplicate issues).
count=""
gh_ec=0
count="$(gh issue list --repo "$repo" --label "$label" --state open \
           --limit "$limit" --json number --jq 'length')" || gh_ec=$?

if [[ "$gh_ec" -eq "$GH_EXIT_AUTH" ]]; then
  echo "auth-error"
  exit 0
fi

if [[ "$gh_ec" -ne 0 ]]; then
  echo "transport-error"
  exit 0
fi

# A zero exit carrying something that is not a count is not an answer either:
# `gh` printing nothing, or jq emitting `null`, must never read as "none open".
if [[ ! "$count" =~ ^[0-9]+$ ]]; then
  printf 'playbook-wip-gate: gh exited 0 with a non-numeric count: %q\n' "$count" >&2
  echo "transport-error"
  exit 0
fi

if [[ "$count" -gt 0 ]]; then
  echo "wip-limit-hit"
else
  echo "clear"
fi
