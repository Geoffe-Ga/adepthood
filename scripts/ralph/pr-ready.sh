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
#                    resolution (Gate 1), not a sync
#   pending          CI still running → wait for a later wake
#   ci-failed        CI has a failing/errored check → Step 2 (ci-debugging)
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
# WHY THE MARKER FALLBACK EXISTS: the body-link route to the hold vanishes on exactly
# the PRs the hold exists for. Dependabot regenerates its PR body from its own template
# on every rebase and group recomputation, taking the bridge's appended `Closes #N` with
# it — so `linked_issue` comes back empty and "no link" would be read as "no hold", a
# fail-OPEN on the one PR class this loop merges with no review verdict. The bridge also
# stamps `<!-- dependabot-pr:<N> -->` into the ISSUE body, which that rewrite cannot
# reach because it lives on another object; that is the durable route. It is scanned only
# on a Dependabot-authored PR whose body links nothing (human PRs routinely link nothing
# and must classify normally, and an empty author reads as human), so in steady state the
# extra `gh issue list` costs no lane anything. A scan that matches NOTHING is silence,
# not proof: it is filtered by the `dependencies` label, which this repo has watched fail
# to stick — hence `ensure-issue-label.sh`. Such a lane therefore classifies normally and
# is refused only at the point of merge, so `behind` still prints `behind` (a sync is
# always safe, and re-linking the body is often what makes the hold provable again).
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
# contract: 0 = pass, 8 = pending, other = failure).
readonly CHECKS_PENDING_EC=8

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
elif [[ "$pr_author" == "$DEPENDABOT_AUTHOR" ]]; then
  # Only Dependabot rewrites its own body, so only Dependabot can have lost the
  # link. An empty author reads as human here, which is safe: the sole
  # merge-without-review path re-verifies the author itself and fails closed on
  # empty. A failed scan dies at once — unlike a matchless one, no later answer
  # can arrive to settle it.
  bridge_issues="$(bridge_issues_for_pr)" ||
    die "could not scan for the bridge issue of PR #$pr; refusing to guess whether $OPTOUT_LABEL is set"
  if [[ -z "$bridge_issues" ]]; then
    hold_unproven="yes"
  else
    while IFS= read -r bridge_n; do
      [[ -n "$bridge_n" ]] || continue
      exit_if_issue_holds "$bridge_n" "marker-linked to"
    done <<<"$bridge_issues"
  fi
fi

# --- CI state from the exit code, not the text table -----------------------
ci_ec=0
gh pr checks "${gh_args[@]}" >/dev/null 2>&1 || ci_ec=$?
if [[ "$ci_ec" -eq "$CHECKS_PENDING_EC" ]]; then
  echo "pending"; exit 0
elif [[ "$ci_ec" -ne 0 ]]; then
  echo "ci-failed"; exit 0
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

# Without a HEAD commit time we cannot prove the verdict is fresh — fail closed.
if [[ -z "$head_date" ]]; then
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
  case "$merge_state" in
    UNKNOWN) echo "unknown" ;;
    DRAFT) echo "draft" ;;
    BLOCKED) echo "blocked" ;;
    DIRTY | CONFLICTING) echo "conflicted" ;;
    # CLEAN-but-stale, BEHIND, and anything not enumerated above. The fallback
    # is deliberately `behind` rather than a new "unclassified" token: a sync is
    # always safe, so an unrecognised state costs one wasted sync instead of
    # wedging the lane on a token no caller knows how to route.
    *) echo "behind" ;;
  esac
fi
