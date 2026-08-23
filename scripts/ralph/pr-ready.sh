#!/usr/bin/env bash
# scripts/ralph/pr-ready.sh
#
# Authoritative "is this lane safe to merge?" check for the Ralph orchestrator
# (ralph-tick.md Step 1). Prints exactly one status token and exits 0 (it is a
# query — a non-zero exit means a usage/tooling error, never a PR verdict):
#
#   ready            LGTM (fresh) + CI green + verified current with main → merge now
#   ready-unreviewed CI green (with real checks that actually passed) + verified
#                    current with main, but this PR HAS no review gate: Dependabot
#                    authored it AND pushed its HEAD commit, and `claude-review`
#                    reported SKIPPED → the orchestrator decides (see below)
#   behind           LGTM (fresh) + CI green but the branch is not current → sync first
#   unknown          GitHub has not finished computing mergeability (routine for a
#                    few seconds after every push) → wait for a later wake; a sync
#                    would merge nothing and push nothing
#   draft            the PR is a draft: a deliberate human hold → the loop does not
#                    act on it (same standing as `optout`)
#   blocked          a required check or review is missing → a sync cannot supply
#                    it; a human or the review gate must
#   conflicted       the branch conflicts with its base → needs a real conflict
#                    resolution (Gate 1), not a sync. OUTRANKS `awaiting-review`:
#                    a conflicting PR has no merge ref, so no `pull_request`-event
#                    run and no `claude-review` check ever exists, and the verdict
#                    the lane would wait for can never arrive
#   pending          CI still running → wait for a later wake
#   ci-failed        CI has a failing/errored check, CORROBORATED by the rollup
#                    naming it → Step 2 (ci-debugging)
#   transport-error  `gh` could not be asked, or answered non-zero with no failing
#                    check to corroborate it (no network, TLS, expired token,
#                    rate limit, 5xx, a PR with no checks at all) → RETRY on a
#                    later wake; do NOT dispatch a debugger. Distinct from
#                    `unknown`, which is a real answer about mergeability
#   changes-requested  a FRESH verdict (posted after the PR's HEAD commit) that
#                    is not LGTM (CHANGES_REQUESTED/COMMENTS) → Step 2
#                    (address-feedback): Gate 4 has spoken and wants changes
#   awaiting-review  no verdict yet, or only a stale one (predates HEAD) → wait
#   review-self-skipped  this PR edits the review workflow, so claude-code-action
#                    self-skipped (anti-tamper) and no verdict will EVER arrive →
#                    terminal: hand it to a human. The loop must stop re-checking
#                    it; a fresh human-posted LGTM still reaches `ready`.
#   optout           `do-not-auto-merge` on the PR, on the issue its body closes,
#                    or on the bridge issue whose marker names this PR → the
#                    loop does not act on this PR AT ALL (no merge, no sync, no
#                    ci-debugging worker); a human owns it. Checked first, and an
#                    unreadable label answer exits 2 rather than assuming no hold.
#
# An UNDETERMINABLE opt-out (the label, body, or marker lookup failed) is deliberately
# one of those tooling errors: reading a failed lookup as "unlabelled" would let a rate
# limit or an expired token silently defeat the one control a human retains over this
# loop. So is an UNPROVABLE one on a bot PR about to be merged (see below).
#
# WHY THE MARKER ROUTE EXISTS: the body-link route to the hold vanishes on exactly
# the PRs the hold exists for. Dependabot regenerates its PR body from its own template
# on every rebase and group recomputation, taking the bridge's appended `Closes #N` with
# it — so `linked_issue` comes back empty and "no link" would be read as "no hold", a
# fail-OPEN on the one PR class this loop merges with no review verdict. The bridge also
# stamps `<!-- dependabot-pr:<N> -->` into the ISSUE body, which that rewrite cannot
# reach because it lives on another object; that is the durable route.
#
# It is NOT a fallback: it runs on EVERY Dependabot-authored lane, whether or not the
# body links something. It was a fallback until #2127, and that was the bug — a
# regenerated body carrying an upstream changelog line (`Fixes #456`) still matches the
# reference pattern, `linked_issue` takes the LAST match, and the hold lookup then
# consulted an unrelated issue while the bridge went unread. A parked PR printed `ready`.
# The two routes are independent answers to "is there a hold?" and either may be the one
# that has it, so both are asked.
#
# The cost is one `gh issue list` per bot lane — paid on every bot lane now, not only
# unlinked ones. Human lanes still pay nothing (they routinely link nothing and must
# classify normally, and an empty author reads as human).
#
# A scan that matches NOTHING is silence, not proof: it is filtered by the `dependencies`
# label, which this repo has watched fail to stick — hence `ensure-issue-label.sh`. A
# lane where NEITHER route resolved anything therefore classifies normally and is refused
# only at the point of merge, so `behind` still prints `behind` (a sync is always safe,
# and re-linking the body is often what makes the hold provable again).
#
# An unresolvable hold on a bot PR that would otherwise merge is likewise one of those
# exit-2 tooling errors: no token, and the next wake retries.
#
# WHY THIS EXISTS: the previous all-lanes Monitor grepped `gh pr checks` output
# for ': pending'. That output is TAB-delimited (name<TAB>pending<TAB>...), so the
# grep never matched and a still-running CI was read as settled — a false READY
# that could merge a PR with pending/failing checks. CI state here is keyed off
# the `gh pr checks` EXIT CODE, which is authoritative: 0 = all passed, 8 = some
# pending, anything else = failure. No text parsing of the checks table at all.
#
# WHY `transport-error` EXISTS: that exit code is authoritative ABOUT CHECKS, and
# it was being read as authoritative about everything — including whether the call
# reached GitHub at all. `gh` also exits non-zero with no network, a TLS failure,
# an expired or rotated token, a secondary-rate-limit block, a 5xx, or a PR that
# reports no checks whatsoever, and every one of those printed `ci-failed` — which
# is not an idle label but a route to Step 2, so a dropped connection dispatched a
# worker to debug a build that had never failed. Observed on a live lane:
# `ci-failed` while the real state was nine SUCCESS and one IN_PROGRESS, and
# earlier in the same session a bare x509 certificate error. So a non-zero exit is
# now believed only when a second, independent query names a check that actually
# reports a failing conclusion; everything else says "I could not tell", which is
# a wait, not a debugging dispatch. The stderr `gh` wrote is kept and echoed
# rather than discarded — it is the one thing that says WHICH failure happened,
# and discarding it is why this went unnoticed. `unknown` was NOT reused: it means
# "GitHub has not finished computing mergeability", a real answer about a
# different question, and conflating the two would make both unreadable.
#
# WHY `ready-unreviewed` EXISTS: `claude-code-review.yml` cannot run while a PR
# is untouched by anyone but Dependabot (GitHub withholds the OAuth secret from
# runs Dependabot triggers), so such a PR never grows a verdict and could only
# ever print `awaiting-review` — a lane that waits for `ready` would hang forever
# on exactly the PRs auto-adoption exists to merge. Any bump we push to (a sync
# or a forward-adaptation) makes the review job runnable and lands back on the
# normal `ready` path; this token covers only the residual case of a bump already
# current and already green, where nothing of ours is ever pushed. It is a
# SEPARATE token rather than a looser `ready` on purpose: `ready` keeps its full
# four-part meaning (fresh LGTM + green CI + CLEAN + `behind_by == 0`), so the
# decision to merge something no reviewer ever saw is made visibly by the
# orchestrator, never silently here.
#
# Two conditions beyond "Dependabot authored it" make that safe, because the
# token's justification is "green CI against current main replaces the review":
#   * At least one NON-review check must have actually SUCCEEDED. `gh pr checks`
#     exits 0 when every check merely skipped, and every test workflow here is
#     `paths:`-filtered to its own sources — so a `github-actions` ecosystem bump
#     (which touches only `.github/workflows/*.yml`) matches none of them and
#     lands zero checks. Without this, "green" would mean "no CI ran at all" on
#     exactly the PRs that rewire the workflows holding our secrets.
#   * Dependabot must also have pushed the HEAD commit. `statusCheckRollup` is
#     per-HEAD-commit, so a bot force-push (a `@dependabot recreate`, a group
#     recomputation) after we adapted a branch would otherwise hand a fresh
#     all-SKIPPED rollup back to this token and re-clear hand-written — possibly
#     already-rejected — code as never-touched.
#
# Stale-verdict guard: a review verdict only counts when it was posted AFTER the
# PR's HEAD commit. An LGTM from before the latest push is stale (it reviewed
# older code) and must not gate a merge — and a stale non-LGTM likewise reads as
# `awaiting-review` (the re-review is owed), never as `changes-requested`.
#
# WHY `changes-requested` EXISTS (upstream report Creek-Vault#1097): this token
# used to be folded into `awaiting-review`, which watch-pr.sh counts as
# in-flight — so the hot watch could wake on an LGTM in seconds but slept out
# its full timeout on the one Gate 4 outcome that needs the orchestrator
# SOONER. Splitting it lets the watcher exit on it with no change to its
# in-flight set. Precedence is untouched: the check sits exactly where
# `awaiting-review` is emitted — after optout/pending/ci-failed and the
# missing-HEAD fail-closed guard — and fail-closed behaviour is preserved: an
# unreadable verdict lookup still aborts non-zero (a tooling error, no token),
# and a malformed freshness/flag field degrades to `awaiting-review`, never to
# the new token.
#
# Freshness guard: `mergeStateStatus` is NOT a freshness signal. GitHub only
# reports BEHIND when the base branch enforces strict/up-to-date status checks,
# which this repo does not — so a branch many commits behind `main` reports
# CLEAN, and its own green CI proves nothing about today's `main`. (A grouped pip
# bump 17 commits behind carried a ruff major that lints 144 errors against
# current `main`; merging its stale green would have turned `main` red.)
# Freshness therefore comes from the compare API's `behind_by`, and CLEAN is kept
# alongside it because DIRTY/CONFLICTING/BLOCKED/DRAFT/UNKNOWN are invisible to
# `behind_by`. The probe is LAZY by design — only a lane that would otherwise
# print `ready` pays for it, so the orchestrator never sync-thrashes.
#
# Usage:  pr-ready.sh <PR_NUMBER> [--repo <owner/repo>]
set -euo pipefail

# `gh pr checks` exit code that means "checks still pending" (gh's documented
# contract: 0 = pass, 8 = pending, other = failure). "Failure" there covers the
# command failing as well as a check failing, which is why the other end of that
# mapping needs corroborating — see `failing_checks_confirmed`.
readonly CHECKS_PENDING_EC=8

# The rollup conclusions that constitute a genuinely red lane. FAILURE is the
# common one; the rest are the terminal-but-not-passing states GitHub also
# reports, and a lane sitting in any of them needs a debugger just as much.
# NEUTRAL and SKIPPED are deliberately absent: neither is a failure.
readonly FAILING_CONCLUSIONS_RE='FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE'

# The `mergeStateStatus` values that mean the branch conflicts with its base.
# Named once and consulted from both places that care, because the two used to
# be spelled out separately and a drift between them is invisible.
readonly CONFLICT_MERGE_STATE_DIRTY="DIRTY"
readonly CONFLICT_MERGE_STATE_CONFLICTING="CONFLICTING"

# The per-PR/per-issue human hold. `pick-next.sh` already excludes issues wearing
# it from work entirely; this honours the same meaning on the PR side.
readonly OPTOUT_LABEL="do-not-auto-merge"

# The issue-link vocabulary the rest of the loop uses (pick-next.sh's in-flight
# scan, the Dependabot bridge). Case-insensitive via `grep -i`.
readonly ISSUE_LINK_RE='(closes|fixes|resolves)[[:space:]]+#[0-9]+'

# The only label the Dependabot bridge puts on the issues it files, and the page
# size it scans them with. Both mirror the bridge's own query so the two sides
# see the same set; the label is what keeps the fallback scan cheap.
readonly BRIDGE_ISSUE_LABEL="dependencies"
readonly BRIDGE_SCAN_LIMIT=200

# Placeholder slug `gh` substitutes from the current repo when no --repo is given.
readonly CURRENT_REPO_SLUG='{owner}/{repo}'

# The one PR class whose review gate provably cannot exist. Dependabot spells its
# login differently per field, and both spellings are exact-match tightness guards
# on `ready-unreviewed` — without them, any future skip condition on the review
# workflow would start auto-merging unreviewed human PRs. `gh pr view --json
# author` reports the app form (NOT the `dependabot[bot]` form the Actions context
# uses), while a commit's `authors[].login` reports the bot-user form. Both were
# read off a live bump to confirm.
readonly DEPENDABOT_AUTHOR="app/dependabot"
readonly DEPENDABOT_COMMIT_AUTHOR="dependabot[bot]"

# The `claude-code-review.yml` job name as it appears in the status rollup, and
# the conclusions GitHub reports for a job whose `if:` evaluated false and for one
# that genuinely passed.
readonly REVIEW_CHECK_NAME="claude-review"
readonly SKIPPED_CONCLUSION="SKIPPED"
# The one workflow whose own edits make it self-skip. Matched exactly, because
# editing any *other* workflow does not suppress the review.
readonly REVIEW_WORKFLOW_PATH=".github/workflows/claude-code-review.yml"
readonly SUCCESS_CONCLUSION="SUCCESS"

# How many non-review checks must have actually passed before "CI is green" may
# stand in for a review. One is enough to prove CI ran at all, which is the whole
# claim; all-skipped is what this rules out.
readonly MIN_NON_REVIEW_SUCCESSES=1

die() { echo "pr-ready: $1" >&2; exit 2; }

pr=""
repo_slug=""
repo_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) [[ $# -ge 2 ]] || die "--repo needs a value"; repo_args+=(--repo "$2"); repo_slug="$2"; shift 2 ;;
    -*)     die "unknown option: $1" ;;
    *)      [[ -z "$pr" ]] || die "unexpected extra argument: $1"; pr="$1"; shift ;;
  esac
done
[[ "$pr" =~ ^[0-9]+$ ]] || die "usage: pr-ready.sh <PR_NUMBER> [--repo <owner/repo>]"

# The canonical verdict line `claude-code-review.yml` posts is
# `## Verdict: <LGTM|CHANGES_REQUESTED|COMMENTS>` (also tolerated: `**Verdict:**`
# and a bare `Verdict:`), sitting at the END of a longer `## Summary …` body — so
# the match must be case-insensitive AND multiline (`m`, so `^` anchors to the
# verdict line — which sits at the END of a multi-line `## Summary …` body, not
# at string start), prefix-tolerant, and keyed to the verdict LINE (a stray
# "LGTM" in prose must not count). This mirrors the canonical parser in
# `.claude/skills/await-claude-review/SKILL.md`. Backslashes are doubled because
# this text is spliced into a jq string literal, where `\s` is an invalid escape
# and must reach the regex engine as `\\s`.
readonly VERDICT_RE='(?im)^\\s*(?:#{1,6}\\s+|\\*\\*)?verdict[:*\\s]'
readonly VERDICT_LGTM_RE="${VERDICT_RE}+lgtm"

# `${arr[@]+"${arr[@]}"}` expands to nothing when the array is empty instead of
# tripping `set -u` on bash 3.2 (stock /bin/bash on macOS).
gh_args=("$pr" ${repo_args[@]+"${repo_args[@]}"})

# --- opt-out, checked FIRST so a held PR is never even probed ---------------
# Labels arrive one per line, so match whole lines: `do-not-auto-merge-after-
# review` is a different label and must not read as an opt-out. The list is
# passed as an argument rather than piped in, because a pipeline would run the
# reader in a subshell: its failure could not stop the script, and `pipefail`
# would hand the whole test a non-zero status even when the hold WAS on stdout.
has_optout_label() { printf '%s\n' "$1" | grep -qxF "$OPTOUT_LABEL"; }

# One object's labels, one per line. Non-zero (not empty output) on API failure,
# so the caller can refuse to classify rather than infer "unlabelled" — see the
# die messages below.
labels_of() { # labels_of <pr|issue> <number>
  gh "$1" view "$2" ${repo_args[@]+"${repo_args[@]}"} --json labels --jq '.labels[].name'
}

# The last issue this PR's body closes, or empty when it links none. LAST, not
# first: the repo's PR-body convention puts `Closes #N` at the end, and the
# Dependabot bridge appends it after the bot's release notes — whose upstream
# changelog lines ("* Fixes #<n>") would otherwise be read as the governing
# link and send the hold lookup below at an unrelated issue number.
linked_issue() {
  local body="$1"
  { printf '%s' "$body" | grep -oiE "$ISSUE_LINK_RE" || true; } | tail -n 1 | tr -dc '0-9'
}

# The bridge's durable link, in the one shape both sides agree on — copied
# verbatim from `dependabot-to-ralph-issue.yml`, which writes it. Inventing a
# second linking convention here would be a second thing to drift silently, and
# a drift restores the fail-open with nothing anywhere to report it.
marker_for() { printf '<!-- dependabot-pr:%s -->' "$1"; }
PR_MARKER="$(marker_for "$pr")"
readonly PR_MARKER

# Every open bridge issue whose body carries THIS PR's marker, one number per
# line; empty when none does. Non-zero on API failure, like `labels_of`, so the
# caller refuses to classify rather than inferring "no hold". The match is on the
# whole marker including its closing `-->`: a bare number is a substring of every
# longer one, so a looser test would inherit an unrelated bump's hold. Splicing
# $pr into the jq string is safe because arg parsing already proved it matches
# ^[0-9]+$ — nothing else here reaches the query.
bridge_issues_for_pr() {
  gh issue list ${repo_args[@]+"${repo_args[@]}"} \
    --label "$BRIDGE_ISSUE_LABEL" --state open --limit "$BRIDGE_SCAN_LIMIT" \
    --json number,body \
    --jq ".[] | select((.body // \"\") | contains(\"$PR_MARKER\")) | .number"
}

# Stops the WHOLE script when one candidate issue carries the hold, so a hold
# found on any route wins outright. A failed lookup stops it too: "unreadable"
# must never collapse into "no hold". Safe to `exit` from because every caller
# below invokes it directly, never in a pipeline or a command substitution.
exit_if_issue_holds() { # exit_if_issue_holds <issue number> <how it links this PR>
  local labels
  labels="$(labels_of issue "$1")" ||
    die "could not read labels of issue #$1 ($2 PR #$pr); refusing to guess whether $OPTOUT_LABEL is set"
  has_optout_label "$labels" || return 0
  echo "optout"; exit 0
}

# An undeterminable hold is a TOOLING error, never "no hold". Reading a failed
# lookup as unlabelled would let a rate limit, a 5xx, or an expired token
# silently defeat the one control a human has over this loop and auto-merge the
# PR they reserved. `die` exits 2, which this script's contract already defines
# as a tooling error and never a verdict: the orchestrator acts on no lane it
# cannot classify, and the next wake retries.
pr_labels="$(labels_of pr "$pr")" ||
  die "could not read labels of PR #$pr; refusing to guess whether $OPTOUT_LABEL is set"
if has_optout_label "$pr_labels"; then
  echo "optout"; exit 0
fi

# The author rides along on the body call rather than costing a round trip of its
# own; it gates the marker fallback below. Author FIRST because a login cannot
# contain `|` and a body freely can, so the split has to be on the first
# separator — and by parameter expansion, never `read`, which would truncate a
# multi-line body at its first newline.
body_line="$(gh pr view "${gh_args[@]}" --json body,author \
  --jq '(.author.login // "") + "|" + (.body // "")')" ||
  die "could not read the body and author of PR #$pr; refusing to guess whether a linked issue carries $OPTOUT_LABEL"
pr_author="${body_line%%|*}"
pr_body="${body_line#*|}"

# Set when a bot lane's hold could be neither found nor ruled out. It is NOT
# "no hold" — the scan is label-filtered — so it defers rather than decides: the
# lane classifies normally and is refused only where it would otherwise merge.
hold_unproven=""

issue_n="$(linked_issue "$pr_body")"
if [[ -n "$issue_n" ]]; then
  exit_if_issue_holds "$issue_n" "linked by"
fi

# The marker route runs for EVERY bot lane, not only one whose body links
# nothing. `linked_issue` takes the last reference match, so a regenerated body
# carrying an upstream changelog line -- `Fixes #456` -- resolves an unrelated
# issue in this repo. The hold lookup then consulted that issue, the bridge was
# never reached, and a PR a human had parked printed `ready` and merged. Checking
# the body link first and the marker as well costs one extra scan on bot lanes
# and closes that: the two routes are independent answers to "is there a hold?",
# and either may be the one that has it.
#
# Only Dependabot rewrites its own body, so only Dependabot can have lost the
# link, and the scan stays off human lanes. An empty author reads as human here,
# which is safe: the sole merge-without-review path re-verifies the author itself
# and fails closed on empty. A failed scan dies at once -- unlike a matchless
# one, no later answer can arrive to settle it.
if [[ "$pr_author" == "$DEPENDABOT_AUTHOR" ]]; then
  bridge_issues="$(bridge_issues_for_pr)" ||
    die "could not scan for the bridge issue of PR #$pr; refusing to guess whether $OPTOUT_LABEL is set"
  if [[ -z "$bridge_issues" ]]; then
    # Unchanged from #2027, deliberately: unproven means NEITHER route resolved
    # anything. A body that did resolve an issue is a resolution, so widening the
    # scan must not start refusing lanes that classified fine before.
    [[ -n "$issue_n" ]] || hold_unproven="yes"
  else
    while IFS= read -r bridge_n; do
      [[ -n "$bridge_n" ]] || continue
      exit_if_issue_holds "$bridge_n" "marker-linked to"
    done <<<"$bridge_issues"
  fi
fi

# True when a second, independent query names at least one check that actually
# reports a failing conclusion. Returns non-zero when it cannot ask, when the
# answer is malformed, and when nothing failed — so `ci-failed` is claimed only
# on positive evidence and every other outcome falls through to
# `transport-error`.
#
# Both shapes in the rollup are read: a CheckRun carries `conclusion`, a legacy
# commit-status context carries `state` instead, and a filter reading only the
# first would call a genuinely red PR a network blip. jq's `//` handles the
# absent/null field for us. LAZY — only a lane whose `gh pr checks` already went
# non-zero pays for it, so a green or pending lane costs exactly what it did.
failing_checks_confirmed() {
  local failures
  failures="$(gh pr view "${gh_args[@]}" --json statusCheckRollup \
    --jq "[.statusCheckRollup[]? | ((.conclusion // .state // \"\") | ascii_upcase)
           | select(test(\"^($FAILING_CONCLUSIONS_RE)$\"))] | length" \
    2>/dev/null)" || return 1
  [[ "$failures" =~ ^[0-9]+$ ]] || return 1
  [[ "$failures" -gt 0 ]]
}

# --- CI state from the exit code, not the text table -----------------------
# Stderr is CAPTURED, not discarded. `gh` narrates a transport failure there and
# says nothing when a check merely reports FAILURE, so throwing it away was what
# made a dropped connection indistinguishable from a broken build — and the
# message is the one thing that tells a human which happened.
ci_ec=0
ci_err="$(gh pr checks "${gh_args[@]}" 2>&1 >/dev/null)" || ci_ec=$?
if [[ "$ci_ec" -eq "$CHECKS_PENDING_EC" ]]; then
  echo "pending"; exit 0
elif [[ "$ci_ec" -ne 0 ]]; then
  # A non-zero that is not 8 means "something went wrong", which is NOT the same
  # as "a check went red". `gh` also exits non-zero with no network, a TLS
  # failure, an expired token, a secondary-rate-limit block, a 5xx, or a PR that
  # reports no checks at all — and every one of those used to print `ci-failed`,
  # dispatching a ci-debugging worker to read logs for a failure that never
  # happened, on a PR that was often about to go green. So the verdict is only
  # believed when a second query corroborates it by naming a failing check;
  # otherwise the honest answer is "I could not tell", which is its own token.
  if failing_checks_confirmed; then
    echo "ci-failed"; exit 0
  fi
  [[ -z "$ci_err" ]] ||
    printf 'pr-ready: gh pr checks exited %s: %s\n' "$ci_ec" "${ci_err%%$'\n'*}" >&2
  echo "transport-error"; exit 0
fi

# --- CI is green: check mergeability + a FRESH LGTM verdict -----------------
# One call yields "<mergeStateStatus>|<HEAD committedDate>|<HEAD author login>",
# another the latest top-level verdict as "<createdAt>|<isLGTM>". gh applies --jq
# server-side. The HEAD author rides along here rather than in its own call: it is
# only needed by `review_gate_absent`, and `gh` already hands us the commit.
# (`gh` caps `commits` at 100. That is already how `head_date` is derived, and it
# fails CLOSED for the author too: on an adopted lane the bot's bump is commit 1
# and ours follow, so a truncated tail can only ever read as one of OURS.)
merge_line="$(gh pr view "${gh_args[@]}" \
  --json mergeStateStatus,commits \
  --jq '(.mergeStateStatus // "") + "|" + (.commits[-1].committedDate // "") + "|" + (.commits[-1].authors[0].login // "")')"
# Split by field count, not by seeking one separator: an enum, an RFC3339 stamp,
# and a login can none of them contain `|`, so a surplus field means the answer is
# malformed — blanked here so every branch below fails closed on it.
IFS='|' read -r merge_state head_date head_author merge_rest <<<"$merge_line"
[[ -z "$merge_rest" ]] || { merge_state=""; head_date=""; head_author=""; }

verdict_line="$(gh pr view "${gh_args[@]}" \
  --json comments \
  --jq "([.comments[] | select(.body != null and (.body | test(\"$VERDICT_RE\")))] | last) as \$v
        | ((\$v.createdAt // \"\") + \"|\" + ((\$v.body // \"\" | test(\"$VERDICT_LGTM_RE\")) | tostring))")"
verdict_date="${verdict_line%%|*}"
verdict_lgtm="${verdict_line#*|}"

# True when the branch conflicts with its base. Read off the `mergeStateStatus`
# already in hand, so it costs no extra round trip.
is_conflicted() {
  [[ "$merge_state" == "$CONFLICT_MERGE_STATE_DIRTY" ||
     "$merge_state" == "$CONFLICT_MERGE_STATE_CONFLICTING" ]]
}

# A conflict makes the verdict UNREACHABLE, so it outranks every wait for one.
# GitHub builds no merge ref for a conflicting PR, and `pull_request`-event
# workflows run against that ref — so `claude-review` never appears in the rollup
# at all (any green checks are `push`-event runs on the branch), and no amount of
# re-kicking can produce a verdict. Waiting is therefore not merely slow, it can
# never end. Emitting `conflicted` here instead sends the lane to the one action
# that unblocks it. Observed on a live lane that reported `awaiting-review` while
# the PR was in fact CONFLICTING; ralph-tick.md had to carry this as a manual
# "check mergeStateStatus FIRST" instruction because the helper would not say it.
#
# Returns 0 when it does NOT fire, so a bare call is safe under `set -e` — a
# function ending on a false test would abort the whole script instead.
exit_if_conflicted() {
  is_conflicted || return 0
  echo "conflicted"; exit 0
}

# Without a HEAD commit time we cannot prove the verdict is fresh — fail closed.
if [[ -z "$head_date" ]]; then
  exit_if_conflicted
  echo "awaiting-review"; exit 0
fi

# True when every comma-separated conclusion is SKIPPED. Walked by parameter
# expansion rather than a `printf | tr | grep -q` pipeline, because `grep -q`
# closing the pipe early is a SIGPIPE/`pipefail` inversion in the one test gating
# unreviewed merges. The appended comma makes a trailing empty field — a
# still-queued run — a value that must MATCH rather than one word splitting drops.
all_conclusions_skipped() {
  local remaining="$1," entry
  while [[ -n "$remaining" ]]; do
    entry="${remaining%%,*}"
    [[ "$entry" == "$SKIPPED_CONCLUSION" ]] || return 1
    remaining="${remaining#*,}"
  done
}

# True only when this PR has no review gate to wait for: Dependabot authored it,
# Dependabot also pushed its HEAD commit (so nothing of ours is on the branch —
# see the force-push note in the header), at least one non-review check actually
# SUCCEEDED (so "green" is not "nothing ran"), and every `claude-review` entry in
# its rollup reported SKIPPED (the rollup carries one entry per triggering event,
# so a single non-SKIPPED entry means the job did run and a verdict is genuinely
# owed). Fails CLOSED: a failed call, an empty author, a malformed answer, or no
# `claude-review` entry at all all read as "the gate exists", so an unreadable
# answer can only ever hold the lane at `awaiting-review`. LAZY like
# `branch_is_current` — only a lane already lacking a fresh verdict pays.
review_gate_absent() {
  local line author conclusions passes rest
  line="$(gh pr view "${gh_args[@]}" --json author,statusCheckRollup \
    --jq "(.author.login // \"\") + \"|\" + ([.statusCheckRollup[]? | select((.name // \"\") == \"$REVIEW_CHECK_NAME\") | (.conclusion // \"\")] | join(\",\")) + \"|\" + ([.statusCheckRollup[]? | select((.name // \"\") != \"$REVIEW_CHECK_NAME\" and (.conclusion // \"\") == \"$SUCCESS_CONCLUSION\")] | length | tostring)" \
    2>/dev/null)" || return 1
  # Split by field count, not by seeking the first or last separator: a login, a
  # list of enum conclusions, and a count can none of them contain `|`, so a
  # surplus field means a malformed answer and no `|` in any value can shift the
  # fields under us — which seeking either end would allow.
  IFS='|' read -r author conclusions passes rest <<<"$line"
  [[ -z "$rest" ]] || return 1
  [[ "$author" == "$DEPENDABOT_AUTHOR" ]] || return 1
  # $head_author came from the mergeStateStatus,commits call above — no extra API
  # round trip, and the empty default fails closed exactly like the rest.
  [[ "$head_author" == "$DEPENDABOT_COMMIT_AUTHOR" ]] || return 1
  [[ "$passes" =~ ^[0-9]+$ ]] || return 1
  [[ "$passes" -ge "$MIN_NON_REVIEW_SUCCESSES" ]] || return 1
  [[ -n "$conclusions" ]] || return 1
  all_conclusions_skipped "$conclusions"
}

# True when this PR edits the review workflow itself, which is why no verdict
# will ever arrive for it.
#
# claude-code-action self-skips as anti-tamper on any PR touching the workflow it
# runs from, and the Post-review step handles that by warning and exiting 0. So
# the `claude-review` check reports SUCCESS rather than SKIPPED: the
# review-gate-absent path does not apply, no verdict comment exists, and the lane
# printed `awaiting-review` forever while ralph-tick Step 1 sent it hunting a
# merge conflict that was never there. Exiting 0 with a warning was right when a
# human drove these PRs; it is wrong now that a loop reads the check as a gate.
#
# Detected here rather than by changing that workflow, deliberately: the
# anti-tamper behaviour is worth keeping exactly as it is, the check must not go
# red (that routes to ci-debugging, which cannot fix it either), and no verdict
# may ever be fabricated. This only names the condition the orchestrator already
# faced.
#
# Fails OPEN, unlike the freshness probe: an unreadable file list falls through
# to the old `awaiting-review`. A false positive here parks a lane as needing a
# human when nothing asked for that, which is worse than one more wait.
review_edits_own_workflow() {
  local files
  files="$(gh pr view "${gh_args[@]}" --json files --jq '.files[].path' 2>/dev/null)" || return 1
  [[ -n "$files" ]] || return 1
  grep -Fxq "$REVIEW_WORKFLOW_PATH" <<<"$files"
}


# Fresh LGTM ⇔ latest verdict is LGTM AND its createdAt is strictly newer than
# the HEAD commit. RFC3339 UTC timestamps are fixed-width, so a lexical string
# compare is a correct chronological compare (portable — no date arithmetic).
# Absent that, three states stay distinguishable because they route differently
# (see the header): a FRESH non-LGTM verdict is `changes-requested` — the
# review ran and wants changes, so neither waiting nor `ready-unreviewed` can
# ever apply — while a missing or stale verdict waits as `awaiting-review`
# unless there is no review to wait for, in which case the lane still has to
# clear every non-review condition below. The freshness test mirrors the LGTM
# one exactly, and the flag must be the literal jq `false`: a malformed field
# (a stray `|` shifting it) matches neither branch and degrades to
# `awaiting-review` — fail closed, never a fresh-verdict claim.
ready_token="ready"
if [[ "$verdict_lgtm" != "true" || -z "$verdict_date" ]] || ! [[ "$verdict_date" > "$head_date" ]]; then
  if [[ "$verdict_lgtm" == "false" && -n "$verdict_date" ]] && [[ "$verdict_date" > "$head_date" ]]; then
    echo "changes-requested"; exit 0
  fi
  # A verdict that already ARRIVED (above) still speaks; from here down every
  # remaining branch is a wait for one that has not, and on a conflicting PR no
  # such verdict can ever come.
  exit_if_conflicted
  review_edits_own_workflow && { echo "review-self-skipped"; exit 0; }
  review_gate_absent || { echo "awaiting-review"; exit 0; }
  ready_token="ready-unreviewed"
fi

# True only when the compare API proves the head is 0 commits behind its base.
# Fails CLOSED: an API error, an empty answer, or a non-integer all read as "not
# current", because `behind`'s remedy (fleet.sh sync) is always safe and a false
# `ready` is not.
branch_is_current() {
  local ref_line base head_oid slug behind
  ref_line="$(gh pr view "${gh_args[@]}" --json baseRefName,headRefOid \
    --jq '(.baseRefName // "") + "|" + (.headRefOid // "")' 2>/dev/null)" || return 1
  base="${ref_line%%|*}"
  head_oid="${ref_line#*|}"
  [[ -n "$base" && -n "$head_oid" ]] || return 1
  slug="$CURRENT_REPO_SLUG"
  [[ -z "$repo_slug" ]] || slug="$repo_slug"
  behind="$(gh api "repos/$slug/compare/$base...$head_oid?per_page=1" \
    --jq '.behind_by' 2>/dev/null)" || return 1
  [[ "$behind" =~ ^[0-9]+$ ]] || return 1
  [[ "$behind" -eq 0 ]]
}

# CLEAN is kept as well as the freshness probe: it is the only signal for
# DIRTY/CONFLICTING/BLOCKED/DRAFT/UNKNOWN, and short-circuiting on it keeps the
# probe off every lane that is not already one step from merging.
if [[ "$merge_state" == "CLEAN" ]] && branch_is_current; then
  # The deferred refusal sits HERE, at the only point where an unprovable hold
  # could do harm: every token above is a wait or a remedy no human reserving the
  # PR would object to, while these two merge it. Refusing earlier would wedge
  # lanes that were never about to merge.
  [[ -z "$hold_unproven" ]] ||
    die "PR #$pr is Dependabot's, its body links no issue, and no open $BRIDGE_ISSUE_LABEL issue carries $PR_MARKER, so $OPTOUT_LABEL can be neither found nor ruled out; re-run the Dependabot-to-Ralph bridge reconciler (gh workflow run dependabot-to-ralph-issue.yml) to re-link the PR body, then retry"
  echo "$ready_token"
else
  # Not mergeable -- but `behind`'s remedy (fleet.sh sync) only helps one of the
  # reasons why. These four each get their own token because a sync cannot
  # supply a missing check, un-draft a PR a human parked, resolve a conflict, or
  # hurry GitHub's mergeability computation. Collapsed together, every wake
  # synced a no-op and dispatched a worker with nothing to do -- and against
  # DRAFT the loop fought a human indefinitely.
  # The conflict arm is `is_conflicted` rather than a second `DIRTY |
  # CONFLICTING` pattern: the same two states are consulted before the
  # awaiting-review wait as well, and two hand-maintained copies of that list is
  # exactly the drift that would silently restore the wait-forever bug.
  if is_conflicted; then
    echo "conflicted"
  else
    case "$merge_state" in
      UNKNOWN) echo "unknown" ;;
      DRAFT) echo "draft" ;;
      BLOCKED) echo "blocked" ;;
      # CLEAN-but-stale, BEHIND, and anything not enumerated above. The fallback
      # is deliberately `behind` rather than a new "unclassified" token: a sync is
      # always safe, so an unrecognised state costs one wasted sync instead of
      # wedging the lane on a token no caller knows how to route.
      *) echo "behind" ;;
    esac
  fi
fi
