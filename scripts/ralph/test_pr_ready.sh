#!/usr/bin/env bash
# scripts/ralph/test_pr_ready.sh
#
# Offline tests for pr-ready.sh — the authoritative CI + review-verdict
# readiness check the orchestrator (ralph-tick.md Step 1) uses before merging a
# lane. CI state is keyed off the `gh pr checks` EXIT CODE (0=green, 8=pending,
# else=failed), never a text grep of its TAB-delimited output, and an LGTM
# verdict only counts when it is fresher than the PR's HEAD commit (stale-verdict
# guard). A fresh verdict that is NOT LGTM is its own token, `changes-requested`
# — distinct from the missing/stale `awaiting-review`, so watch-pr.sh can wake
# on it. We put a fake, arg-aware `gh` on PATH and assert every classification.
#
# Three further dimensions are pinned here: a `do-not-auto-merge` opt-out that
# short-circuits every other check; a freshness guard proving `CLEAN` alone
# never means "up to date with main" — plus that the freshness probe stays LAZY
# (a pending/red/unreviewed lane must never pay for it); and `ready-unreviewed`,
# the token for a Dependabot PR whose review gate provably cannot run, which must
# stay tight enough that no human PR ever reaches it — so "green" has to mean CI
# actually ran (an all-skipped rollup is not a review), the bot has to have pushed
# HEAD (a force-push must not re-clear our commits), and both `gh` answers are
# parsed by field count so a stray `|` fails closed.
#
# A fifth dimension guards the hold itself against the bot erasing it: Dependabot
# regenerates its PR body from its own template on rebase, taking the bridge's
# appended `Closes #N` with it, so the body-link route vanishes on exactly the PRs
# the hold exists for. The bridge's `<!-- dependabot-pr:<N> -->` marker lives on
# the ISSUE, which that rewrite cannot reach, so it is the durable route — and a
# bot lane where NEITHER route resolves may still classify, but may never merge.
#
# Run:  bash scripts/ralph/test_pr_ready.sh
set -euo pipefail

READY="$(cd "$(dirname "$0")" && pwd)/pr-ready.sh"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }
check() { # check <desc> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}
probed() { # probed <desc> <yes|no> <sentinel path> — did the compare probe run?
  if [[ -e "$3" ]]; then check "$1" "$2" "yes"; else check "$1" "$2" "no"; fi
}
no_merge_token() { # no_merge_token <desc> <token> — any token the loop won't merge on
  # For malformed answers the property is what matters, not which refusal token:
  # `ready` and `ready-unreviewed` both merge, so only those two are wrong.
  if [[ "$2" != "ready" && "$2" != "ready-unreviewed" ]]; then ok "$1"; else bad "$1 (got '$2')"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"

# Arg-aware fake gh. Behaviour is driven by env vars the test sets per case:
#   CHECKS_EC     — exit code `gh pr checks` should return (0 green / 8 pending / other failed)
#   MERGE_STATE   — mergeStateStatus (CLEAN / BEHIND / ...)
#   HEAD_DATE     — RFC3339 committedDate of the PR HEAD commit
#   HEAD_AUTHOR   — `authors[0].login` of that same HEAD commit, the third field of
#                   the `--json mergeStateStatus,commits` answer; defaults to the
#                   bot-user spelling so a case can vary one condition at a time,
#                   and any other value means one of OURS pushed last
#   VERDICT       — the "<createdAt>|<isLGTM>" scalar the verdict jq resolves to
#   COMMENTS_JSON — raw `--json comments` payload; when set, the stub runs the
#                   REAL jq with pr-ready.sh's own `--jq` expression against it,
#                   so the production verdict regex is genuinely exercised
#                   (otherwise a scalar stub would mask a broken regex).
#   PR_LABELS     — comma-separated labels for `pr view --json labels`
#   PR_LABELS_EC  — exit code that same call returns (non-0 = API failure)
#   ISSUE_LABELS  — comma-separated labels for `issue view --json labels` on the
#                   issue the PR body links via Closes|Fixes|Resolves #N
#   ISSUE_LABELS_FOR — when set, ISSUE_LABELS answers ONLY that issue number and
#                   every other issue reads as unlabelled, so a test can pin
#                   WHICH of several linked issues the hold lookup resolved
#   ISSUE_LABELS_EC — exit code that same call returns (non-0 = API failure)
#   ISSUE_LIST_JSON — raw `--json number,body` payload for the `issue list` scan
#                   that finds the bridge issue by its durable marker; when the
#                   caller passes `--jq` the stub runs the REAL jq against it, so a
#                   containment match loose enough to hit a longer PR number is
#                   caught here rather than masked by a scalar stub. An empty list
#                   by default, so unrelated cases stay deterministic
#   ISSUE_LIST_EC — exit code that same call returns (non-0 = API failure)
#   ISSUE_LIST_SENTINEL — file the stub touches when the issue-list endpoint is hit,
#                   so a test can prove that scan stays off human lanes entirely
#   PR_BODY       — the body `pr view --json body,author` returns, emitted AFTER
#                   PR_AUTHOR as "<author>|<body>": the author leads because a login
#                   can never contain `|` and a multi-line body can
#   PR_BODY_EC    — exit code that same call returns (non-0 = API failure)
#   BASE_REF / HEAD_OID — the "<baseRefName>|<headRefOid>" compare inputs
#   BEHIND_BY     — `.behind_by` from `gh api .../compare/<base>...<head>`; set it
#                   empty or non-numeric to exercise the fail-closed path
#   COMPARE_EC    — exit code that same compare call returns (non-0 = API failure)
#   COMPARE_SENTINEL — file the stub touches when the compare endpoint is hit, so
#                   a test can prove the freshness probe stayed lazy
#   PR_AUTHOR     — `.author.login`, answered on BOTH the early body call and
#                   `pr view --json author,statusCheckRollup`; `app/dependabot` is
#                   the one value that can clear the review gate or reach the marker
#                   fallback, and the empty default reads as a human on both
#   REVIEW_CONCLUSIONS — comma-joined `claude-review` conclusions from that same
#                   rollup (the real shape repeats one entry per triggering
#                   event, e.g. `SKIPPED,SKIPPED`); empty = no such check
#   NON_REVIEW_SUCCESSES — third field of that same answer: how many NON-review
#                   checks reported SUCCESS; defaults to 1, so a case sets 0 to
#                   isolate the all-skipped rollup that `gh pr checks` still exits
#                   0 on
#   ROLLUP_JSON   — raw `--json author,statusCheckRollup` payload; when set the stub
#                   runs the REAL jq with pr-ready.sh's own `--jq` against it (and
#                   PR_AUTHOR/REVIEW_CONCLUSIONS/NON_REVIEW_SUCCESSES are ignored),
#                   so the production SUCCESS filter is genuinely exercised
#   REVIEW_EC     — exit code that same call returns (non-0 = API failure)
#   REVIEW_SENTINEL — file the stub touches when the review-gate endpoint is hit,
#                   so a test can prove that probe stayed lazy too
# Real gh applies --jq, so — like test_fleet.sh — the stub emits the already
# extracted scalar and branches on which --json field the caller asked for. Label
# lists arrive one-per-line, exactly as `--jq '.labels[].name'` yields them.
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
args="$*"
case "$args" in
  "api "*"compare"*)
    [[ -n "${COMPARE_SENTINEL:-}" ]] && : > "$COMPARE_SENTINEL"
    printf '%s\n' "${BEHIND_BY-0}"    # `-` not `:-` so an empty value stays empty
    exit "${COMPARE_EC:-0}" ;;
  *"pr checks"*)            exit "${CHECKS_EC:-0}" ;;
  *"pr view"*"--json labels"*)
    printf '%s' "${PR_LABELS:-}" | tr ',' '\n'
    exit "${PR_LABELS_EC:-0}" ;;
  *"issue view"*"--json labels"*)
    n=""
    for tok in "$@"; do
      if [[ "$tok" =~ ^[0-9]+$ ]]; then n="$tok"; break; fi
    done
    if [[ -z "${ISSUE_LABELS_FOR:-}" || "$n" == "$ISSUE_LABELS_FOR" ]]; then
      printf '%s' "${ISSUE_LABELS:-}" | tr ',' '\n'
    fi
    exit "${ISSUE_LABELS_EC:-0}" ;;
  *"issue list"*)
    [[ -n "${ISSUE_LIST_SENTINEL:-}" ]] && : > "$ISSUE_LIST_SENTINEL"
    expr="" prev=""
    for a in "$@"; do [[ "$prev" == "--jq" ]] && expr="$a"; prev="$a"; done
    # Real jq when the caller filters server-side, raw payload when it filters its
    # own — either way the containment match is exercised, never simulated.
    if [[ -n "$expr" ]]; then
      printf '%s' "${ISSUE_LIST_JSON:-[]}" | jq -rc "$expr"
    else
      printf '%s\n' "${ISSUE_LIST_JSON:-[]}"
    fi
    exit "${ISSUE_LIST_EC:-0}" ;;
  *"pr view"*"--json body"*)
    printf '%s|%s\n' "${PR_AUTHOR:-}" "${PR_BODY:-}"
    exit "${PR_BODY_EC:-0}" ;;
  *"pr view"*"--json baseRefName"*) printf '%s|%s\n' "${BASE_REF:-main}" "${HEAD_OID:-c0ffee1}" ;;
  *"pr view"*"--json author"*)
    [[ -n "${REVIEW_SENTINEL:-}" ]] && : > "$REVIEW_SENTINEL"
    if [[ -n "${ROLLUP_JSON:-}" ]]; then
      expr="" prev=""
      for a in "$@"; do [[ "$prev" == "--jq" ]] && expr="$a"; prev="$a"; done
      printf '%s' "$ROLLUP_JSON" | jq -rc "$expr"
    else
      # `-` not `:-` on the count so a test can send an empty (non-numeric) field
      printf '%s|%s|%s\n' "${PR_AUTHOR:-}" "${REVIEW_CONCLUSIONS:-}" "${NON_REVIEW_SUCCESSES-1}"
    fi
    exit "${REVIEW_EC:-0}" ;;
  *"--json mergeStateStatus"*)
    printf '%s|%s|%s\n' "${MERGE_STATE:-CLEAN}" "${HEAD_DATE:-}" "${HEAD_AUTHOR-dependabot[bot]}" ;;
  *"--json comments"*)
    if [[ -n "${COMMENTS_JSON:-}" ]]; then
      expr="" prev=""
      for a in "$@"; do [[ "$prev" == "--jq" ]] && expr="$a"; prev="$a"; done
      printf '%s' "$COMMENTS_JSON" | jq -rc "$expr"
    else
      printf '%s\n' "${VERDICT:-|false}"
    fi ;;
  *)                        echo '' ;;
esac
STUB
chmod +x "$BIN/gh"

run() { PATH="$BIN:$PATH" "$READY" "$@" 2>/dev/null; }

H="2026-07-01T10:00:00Z"          # HEAD commit time baseline
FRESH="2026-07-01T11:00:00Z"      # a verdict posted AFTER HEAD (valid)
STALE="2026-07-01T09:00:00Z"      # a verdict posted BEFORE HEAD (stale)

# --- usage: missing PR number exits 2 --------------------------------------
rc=0
PATH="$BIN:$PATH" "$READY" >/dev/null 2>&1 || rc=$?
check "missing PR number exits 2" "2" "$rc"

# --- pending: gh pr checks exit 8 is NEVER ready (the core bug) -------------
check "exit 8 → pending" "pending" \
  "$(CHECKS_EC=8 run 100)"

# --- CI failure surfaced: non-0/non-8 exit → ci-failed ---------------------
check "exit 1 → ci-failed" "ci-failed" \
  "$(CHECKS_EC=1 run 100)"
check "exit 2 → ci-failed" "ci-failed" \
  "$(CHECKS_EC=2 run 100)"

# --- ready: green + CLEAN + fresh LGTM -------------------------------------
check "green + CLEAN + fresh LGTM → ready" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" run 100)"

# --- behind: green + fresh LGTM but not up-to-date -------------------------
check "green + BEHIND + fresh LGTM → behind" "behind" \
  "$(CHECKS_EC=0 MERGE_STATE=BEHIND HEAD_DATE=$H VERDICT="$FRESH|true" run 100)"

# --- stale-verdict guard: an LGTM older than HEAD does NOT count ------------
check "green + CLEAN + STALE LGTM → awaiting-review" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$STALE|true" run 100)"

# --- changes-requested: a fresh non-LGTM verdict is actionable, not in-flight
# Upstream report Creek-Vault#1097: collapsing "missing", "stale", and "fresh
# non-LGTM" into one token made watch-pr.sh (whose in-flight set contains
# awaiting-review) structurally blind to a CHANGES_REQUESTED/COMMENTS verdict —
# the one Gate 4 outcome that needs the orchestrator SOONER. The four-way
# distinction pinned here: missing and stale verdicts genuinely wait
# (awaiting-review); a verdict posted AFTER HEAD that is not LGTM is a Gate 4
# failure the watcher must wake on (changes-requested).
check "no verdict yet → awaiting-review" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="|false" run 100)"

check "stale non-LGTM verdict → awaiting-review" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$STALE|false" run 100)"

check "fresh LGTM + green + current → ready" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 run 100)"

check "green + CLEAN + fresh non-LGTM → changes-requested" "changes-requested" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|false" run 100)"

# Fail closed: only the literal jq `false` flag on a provably fresh timestamp
# may claim the new token — a malformed flag (a stray `|` shifting fields, a
# non-boolean) degrades to awaiting-review, never to changes-requested.
check "malformed verdict flag → awaiting-review, never changes-requested" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|garbage" run 100)"

# --- REAL jq: exercise the production verdict regex against real bodies ----
# The verdict `claude-code-review.yml` posts is `## Verdict: <X>` at the END of a
# long `## Summary …` body. These cases feed raw comment JSON through pr-ready.sh's
# own `--jq`, so a regex that fails to match `## Verdict:` — or that reads "LGTM"
# from prose instead of the verdict line — is caught here (a scalar stub can't).
if command -v jq >/dev/null 2>&1; then
  cj() { printf '{"comments":[%s]}' "$1"; }   # wrap comment object(s) as a payload

  # Canonical `## Verdict: LGTM`, fresh + CLEAN → ready.
  check "real ## Verdict: LGTM (fresh) → ready" "ready" \
    "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H \
       COMMENTS_JSON="$(cj '{"createdAt":"'"$FRESH"'","body":"## Summary\ngood\n\n## Verdict: LGTM\n"}')" \
       run 100)"

  # `**Verdict:** CHANGES_REQUESTED` whose prose mentions "LGTM" must NOT count as
  # LGTM — the exact false-positive a whole-body match would cause. It IS a
  # fresh non-LGTM verdict, so it classifies as changes-requested.
  check "real CHANGES_REQUESTED w/ 'LGTM' in prose → changes-requested" "changes-requested" \
    "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H \
       COMMENTS_JSON="$(cj '{"createdAt":"'"$FRESH"'","body":"Not ready for LGTM yet.\n\n**Verdict:** CHANGES_REQUESTED\n"}')" \
       run 100)"

  # No verdict-bearing comment at all → awaiting-review.
  check "real no-verdict comment → awaiting-review" "awaiting-review" \
    "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H \
       COMMENTS_JSON="$(cj '{"createdAt":"'"$FRESH"'","body":"just a chat comment"}')" \
       run 100)"

  # Latest verdict wins: an LGTM posted after an earlier CHANGES_REQUESTED → ready.
  check "real latest-verdict-wins (LGTM after CR) → ready" "ready" \
    "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H \
       COMMENTS_JSON="$(cj '{"createdAt":"'"$STALE"'","body":"## Verdict: CHANGES_REQUESTED\n"},{"createdAt":"'"$FRESH"'","body":"## Verdict: LGTM\n"}')" \
       run 100)"

  # A real, fresh `## Verdict: LGTM` that predates HEAD is still stale → awaiting.
  check "real ## Verdict: LGTM but stale → awaiting-review" "awaiting-review" \
    "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H \
       COMMENTS_JSON="$(cj '{"createdAt":"'"$STALE"'","body":"## Verdict: LGTM\n"}')" \
       run 100)"
else
  echo "  skip - real-jq verdict-regex cases (jq not installed)"
fi

# --- opt-out: a human owns this PR, the loop must not act on it -------------
OPTOUT="do-not-auto-merge"

check "opt-out label on the PR → optout" "optout" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     PR_LABELS="$OPTOUT" run 100)"

check "opt-out label on the linked issue → optout" "optout" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     PR_BODY="Bumps ruff to 0.16.0. Closes #1982" \
     ISSUE_LABELS="dependencies,$OPTOUT" run 100)"

# Checked FIRST: opt-out wins even while CI is still running.
check "opt-out short-circuits pending CI" "optout" \
  "$(CHECKS_EC=8 PR_LABELS="dependencies,$OPTOUT" run 100)"

# Dependabot's own labels must not be read as an opt-out.
check "dependabot labels without the opt-out → ready" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     PR_LABELS="dependencies,python" BEHIND_BY=0 run 100)"

# Exact label match: a label that merely CONTAINS the opt-out name is not one.
check "label containing the opt-out name is not an opt-out" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     PR_LABELS="$OPTOUT-after-review" BEHIND_BY=0 run 100)"

# Linking an issue is not itself an opt-out — only the label on it is.
check "linked issue without the opt-out label → ready" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     PR_BODY="Closes #1982" ISSUE_LABELS="dependencies" BEHIND_BY=0 run 100)"

# --- an UNDETERMINABLE hold is a tooling error, never "no hold" -------------
# Every world below is an otherwise-perfect ready lane, so the failed lookup is
# the only difference: swallowing it would let a rate limit, a 5xx, or an expired
# token auto-merge the very PR a human reserved.
rc=0
out="$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
   PR_LABELS_EC=1 run 100)" || rc=$?
check "PR label lookup failure exits 2" "2" "$rc"
check "PR label lookup failure prints no verdict" "" "$out"

rc=0
out="$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
   PR_BODY_EC=1 run 100)" || rc=$?
check "PR body lookup failure exits 2" "2" "$rc"
check "PR body lookup failure prints no verdict" "" "$out"

rc=0
out="$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
   PR_BODY="Closes #1982" ISSUE_LABELS_EC=1 run 100)" || rc=$?
check "linked-issue label lookup failure exits 2" "2" "$rc"
check "linked-issue label lookup failure prints no verdict" "" "$out"

# Control: failing closed did not break the happy path.
rc=0
out="$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
   PR_LABELS="dependencies,python" PR_BODY="Closes #1982" ISSUE_LABELS="dependencies" \
   run 100)" || rc=$?
check "all three lookups succeed with no hold → ready" "ready" "$out"
check "a classified lane exits 0" "0" "$rc"

# --- the hold lookup resolves the LAST issue link, not the first ------------
# A bot PR body embeds the dependency's own changelog, whose "* Fixes #456" lines
# sit BEFORE the bridge's appended Closes. Reading the first link would point the
# hold lookup at an unrelated tracker's issue and miss the hold on the bridge one.
CHANGELOG_BODY="Bumps ruff from 0.15.0 to 0.16.0.

Release notes:
* Fixes #456 panic in the formatter
* Resolves #789 for the import sorter

Closes #1982"

check "hold on the last-linked issue outranks a changelog link" "optout" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
     PR_BODY="$CHANGELOG_BODY" ISSUE_LABELS_FOR=1982 \
     ISSUE_LABELS="dependencies,$OPTOUT" run 100)"

# The twin: exactly one link is read, and it is the last — a hold on an issue the
# changelog merely mentions governs somebody else's repository, not this PR.
check "hold on a changelog-linked issue is not this PR's hold" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
     PR_BODY="$CHANGELOG_BODY" ISSUE_LABELS_FOR=456 ISSUE_LABELS="$OPTOUT" run 100)"

# --- freshness: CLEAN is NOT proof of being up to date with main ------------
# GitHub only reports BEHIND when the base branch enforces strict status checks,
# which this repo does not. A grouped pip bump sitting 17 commits behind main can
# be MERGEABLE+CLEAN with its own checks green; merging it lands a ruff major bump
# that was never compiled against today's main and turns main red.
check "green + CLEAN + fresh LGTM but 17 commits behind → behind" "behind" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     BEHIND_BY=17 run 100)"

check "green + CLEAN + fresh LGTM + behind_by 0 → ready" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     BEHIND_BY=0 run 100)"

check "green + CLEAN + fresh LGTM + behind_by 1 → behind" "behind" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     BEHIND_BY=1 run 100)"

# Fail closed: an unusable freshness answer must never be read as up-to-date.
check "compare API error → behind" "behind" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     COMPARE_EC=1 BEHIND_BY=0 run 100)"

check "compare returns empty → behind" "behind" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     BEHIND_BY='' run 100)"

check "compare returns non-numeric → behind" "behind" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     BEHIND_BY=null run 100)"

# behind_by is irrelevant once GitHub already says BEHIND.
check "green + BEHIND + fresh LGTM + behind_by 0 → behind" "behind" \
  "$(CHECKS_EC=0 MERGE_STATE=BEHIND HEAD_DATE=$H VERDICT="$FRESH|true" \
     BEHIND_BY=0 run 100)"

# --- laziness: only a would-be-ready lane may pay for the compare probe -----
# FLEET.md makes syncing lazy; probing freshness on every unready lane would make
# the orchestrator sync-thrash. BEHIND_BY=17 stays set to prove the token comes
# from the earlier check, not from a probe.
S_PENDING="$WORK/compare-pending"
check "pending stays pending with a stale branch" "pending" \
  "$(CHECKS_EC=8 BEHIND_BY=17 COMPARE_SENTINEL="$S_PENDING" run 100)"
probed "pending lane never probes freshness" "no" "$S_PENDING"

S_FAILED="$WORK/compare-ci-failed"
check "ci-failed stays ci-failed with a stale branch" "ci-failed" \
  "$(CHECKS_EC=1 BEHIND_BY=17 COMPARE_SENTINEL="$S_FAILED" run 100)"
probed "ci-failed lane never probes freshness" "no" "$S_FAILED"

S_REVIEW="$WORK/compare-awaiting-review"
check "stale verdict stays awaiting-review with a stale branch" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$STALE|true" \
     BEHIND_BY=17 COMPARE_SENTINEL="$S_REVIEW" run 100)"
probed "unreviewed lane never probes freshness" "no" "$S_REVIEW"

S_READY="$WORK/compare-ready"
check "ready lane still classifies as ready" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     BEHIND_BY=0 COMPARE_SENTINEL="$S_READY" run 100)"
probed "would-be-ready lane does probe freshness" "yes" "$S_READY"

S_OPTOUT="$WORK/compare-optout"
check "opt-out lane classifies as optout" "optout" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" \
     PR_LABELS="$OPTOUT" BEHIND_BY=17 COMPARE_SENTINEL="$S_OPTOUT" run 100)"
probed "opt-out lane never probes freshness" "no" "$S_OPTOUT"

S_CHANGES="$WORK/compare-changes-requested"
check "fresh non-LGTM stays changes-requested with a stale branch" "changes-requested" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|false" \
     BEHIND_BY=17 COMPARE_SENTINEL="$S_CHANGES" run 100)"
probed "changes-requested lane never probes freshness" "no" "$S_CHANGES"

# --- ready-unreviewed: the PR class whose review gate cannot exist -----------
# `claude-code-review.yml` never runs while Dependabot is the only pusher (GitHub
# withholds the OAuth secret from runs it triggers), so the job reports SKIPPED,
# no verdict is ever posted, and `awaiting-review` would hang the lane forever.
DEPENDABOT="app/dependabot"
# The commit form of the same identity. `pr view --json author` reports the app
# slug above; a commit's `authors[].login` reports this — both read off a live bump.
DEPENDABOT_COMMIT="dependabot[bot]"
SKIPPED="SKIPPED"
NO_VERDICT="|false"

# A bot PR whose body carries no issue link reaches its hold only through the
# bridge issue's durable marker, so every bot lane below that expects a MERGE token
# has to be given a resolvable, hold-free bridge issue — that is the realistic
# rewritten-body world. Without it these are the fail-closed case pinned at the end
# of this file, not the token they are here to test. Do not drop it.
BRIDGED='[{"number":1982,"body":"<!-- dependabot-pr:100 -->"}]'

check "reviewless dependabot bump + green + CLEAN + behind_by 0 → ready-unreviewed" "ready-unreviewed" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" ISSUE_LIST_JSON="$BRIDGED" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" BEHIND_BY=0 run 100)"

# The rollup carries one entry per triggering event (push + pull_request), so a
# repeated SKIPPED is the ordinary live shape, not an anomaly.
check "duplicate SKIPPED rollup entries → ready-unreviewed" "ready-unreviewed" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" ISSUE_LIST_JSON="$BRIDGED" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED,$SKIPPED" BEHIND_BY=0 run 100)"

# `ready` keeps its full four-part meaning: a reviewed PR is never downgraded to
# the token that asks the orchestrator to decide.
check "reviewless setup but WITH a fresh LGTM → plain ready" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" ISSUE_LIST_JSON="$BRIDGED" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" BEHIND_BY=0 run 100)"

# With the review gate gone the freshness guard carries the whole safety burden,
# so it must still bind exactly as hard as it does on the `ready` path.
check "reviewless + 17 commits behind → behind, never ready-unreviewed" "behind" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" BEHIND_BY=17 run 100)"

check "reviewless + DIRTY → behind, never ready-unreviewed" "behind" \
  "$(CHECKS_EC=0 MERGE_STATE=DIRTY HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" BEHIND_BY=0 run 100)"

# The tightness guard: should a future skip condition land on that workflow, a
# human PR reporting SKIPPED must NOT start auto-merging unreviewed.
check "human-authored PR with a SKIPPED claude-review → awaiting-review" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="Geoffe-Ga" REVIEW_CONCLUSIONS="$SKIPPED" BEHIND_BY=0 run 100)"

# One entry that did run means the job DID review this code and a verdict is owed.
check "not every claude-review conclusion SKIPPED → awaiting-review" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED,SUCCESS" BEHIND_BY=0 run 100)"

# A still-queued run reports an empty conclusion: that differs from SKIPPED, and
# must not be read as "there was no entry".
check "a queued (empty) conclusion alongside SKIPPED → awaiting-review" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED," BEHIND_BY=0 run 100)"

# No claude-review entry at all is unproven, not proof of absence — fail closed.
check "dependabot PR with no claude-review entry → awaiting-review" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="" BEHIND_BY=0 run 100)"

# An unreadable answer may only ever hold the lane, never release it.
check "review-gate lookup failure → awaiting-review" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" REVIEW_EC=1 BEHIND_BY=0 run 100)"

# --- "green" must mean CI RAN, not that nothing ran -------------------------
# A `github-actions` ecosystem bump touches only `.github/workflows/*.yml`, which
# matches no test workflow's `paths:` filter — so every check skips, `gh pr checks`
# exits 0 anyway, and this token would merge an unreviewed, untested rewrite of the
# workflows that hold our PAT and API tokens.
check "reviewless bump where NO non-review check succeeded → awaiting-review" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" NON_REVIEW_SUCCESSES=0 \
     BEHIND_BY=0 run 100)"

# The positive twin: one non-review check that actually passed is the whole claim
# behind the token, so the guard discriminates rather than refusing every bump.
check "same bump with one non-review SUCCESS → ready-unreviewed" "ready-unreviewed" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" ISSUE_LIST_JSON="$BRIDGED" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" NON_REVIEW_SUCCESSES=1 \
     BEHIND_BY=0 run 100)"

# Same pair through the REAL rollup jq, so the `conclusion == SUCCESS` filter is
# exercised rather than stubbed: a scalar count would mask a filter that counts
# every non-review check regardless of how it ended.
if command -v jq >/dev/null 2>&1; then
  rj() { printf '{"author":{"login":"%s"},"statusCheckRollup":[%s]}' "$DEPENDABOT" "$1"; }
  REVIEW_ENTRY='{"name":"claude-review","conclusion":"SKIPPED"}'

  # Present but not SUCCESS — a skipped job and a still-queued one (null) — is
  # exactly the all-skipped rollup, so neither may count toward the requirement.
  check "non-review checks present but none SUCCESS → awaiting-review" "awaiting-review" \
    "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" BEHIND_BY=0 \
       ROLLUP_JSON="$(rj "$REVIEW_ENTRY,{\"name\":\"backend\",\"conclusion\":\"SKIPPED\"},{\"name\":\"frontend\",\"conclusion\":null}")" \
       run 100)"

  check "real rollup with one non-review SUCCESS → ready-unreviewed" "ready-unreviewed" \
    "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" BEHIND_BY=0 \
       ROLLUP_JSON="$(rj "$REVIEW_ENTRY,{\"name\":\"backend\",\"conclusion\":\"SUCCESS\"},{\"name\":\"frontend\",\"conclusion\":null}")" \
       run 100)"
else
  echo "  skip - real-jq rollup cases (jq not installed)"
fi

# --- the bot must also have pushed HEAD -------------------------------------
# `statusCheckRollup` is per-HEAD-commit: a `@dependabot recreate` force-push over
# our adaptation commits hands back a fresh all-SKIPPED rollup while the PR author
# stays the bot, re-clearing hand-written code as never-touched.
check "reviewless rollup but OUR commit is HEAD → awaiting-review" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" HEAD_AUTHOR="Geoffe-Ga" \
     BEHIND_BY=0 run 100)"

# The two spellings are distinct on purpose: the app slug is what `--json author`
# reports and is never what a commit's `authors[].login` says.
check "the PR-author spelling as HEAD-commit author → awaiting-review" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" HEAD_AUTHOR="$DEPENDABOT" \
     BEHIND_BY=0 run 100)"

# --- both answers are parsed by FIELD COUNT, so a stray `|` fails closed -----
# A login, an enum, an RFC3339 stamp and a count can none of them contain `|`, so a
# surplus field means a malformed answer — trimming it to fit is the `|` bypass
# already found and fixed once in fleet.sh.
check "a surplus field in the review-gate answer → awaiting-review" "awaiting-review" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" NON_REVIEW_SUCCESSES='1|x' \
     BEHIND_BY=0 run 100)"

no_merge_token "a surplus field in the mergeState answer yields no merge token (any refusal will do)" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" \
     HEAD_AUTHOR="$DEPENDABOT_COMMIT|x" BEHIND_BY=0 run 100)"

# The human hold outranks the new token exactly as it outranks `ready`.
check "opt-out on a would-be ready-unreviewed PR → optout" "optout" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" BEHIND_BY=0 \
     PR_LABELS="dependencies,$OPTOUT" run 100)"

# --- laziness: the review-gate probe costs nothing on lanes it cannot help ---
# Same contract as the compare probe. PR_AUTHOR stays set to the one value that
# WOULD clear the gate, so a fired sentinel is the only thing under test.
S_GATE_LGTM="$WORK/gate-fresh-lgtm"
check "fresh LGTM still classifies as ready" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
     ISSUE_LIST_JSON="$BRIDGED" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" REVIEW_SENTINEL="$S_GATE_LGTM" run 100)"
probed "a fresh verdict never probes the review gate" "no" "$S_GATE_LGTM"

# A fresh non-LGTM verdict answers the review question by itself: the review
# ran and wants changes, so ready-unreviewed can never apply and the gate probe
# would be a wasted API call on every lane awaiting its fix worker.
S_GATE_CHANGES="$WORK/gate-changes-requested"
check "fresh non-LGTM still classifies as changes-requested" "changes-requested" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|false" BEHIND_BY=0 \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" REVIEW_SENTINEL="$S_GATE_CHANGES" run 100)"
probed "a fresh non-LGTM verdict never probes the review gate" "no" "$S_GATE_CHANGES"

S_GATE_PENDING="$WORK/gate-pending"
check "reviewless lane with pending CI stays pending" "pending" \
  "$(CHECKS_EC=8 PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" \
     REVIEW_SENTINEL="$S_GATE_PENDING" run 100)"
probed "pending lane never probes the review gate" "no" "$S_GATE_PENDING"

S_GATE_FAILED="$WORK/gate-ci-failed"
check "reviewless lane with red CI stays ci-failed" "ci-failed" \
  "$(CHECKS_EC=1 PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" \
     REVIEW_SENTINEL="$S_GATE_FAILED" run 100)"
probed "ci-failed lane never probes the review gate" "no" "$S_GATE_FAILED"

S_GATE_OPTOUT="$WORK/gate-optout"
check "reviewless lane under a hold stays optout" "optout" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" BEHIND_BY=0 \
     PR_LABELS="$OPTOUT" PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" \
     REVIEW_SENTINEL="$S_GATE_OPTOUT" run 100)"
probed "opt-out lane never probes the review gate" "no" "$S_GATE_OPTOUT"

S_GATE_NONE="$WORK/gate-no-verdict"
check "no-verdict lane classifies as ready-unreviewed" "ready-unreviewed" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" BEHIND_BY=0 \
     ISSUE_LIST_JSON="$BRIDGED" \
     PR_AUTHOR="$DEPENDABOT" REVIEW_CONCLUSIONS="$SKIPPED" \
     REVIEW_SENTINEL="$S_GATE_NONE" run 100)"
probed "no-verdict lane does probe the review gate" "yes" "$S_GATE_NONE"

# --- the hold must outlive Dependabot rewriting its own PR body -------------
# A rebase or group recomputation regenerates that body from the bot's template,
# taking the bridge's appended `Closes #N` with it — so on exactly the bot PRs a
# human reserves, the body-link route to the hold silently disappears and reading
# "no link" as "no hold" fails OPEN. The bridge also stamps a marker into the
# ISSUE body, which the PR rewrite cannot reach because it lives on another
# object; that is the durable route. A rewritten body still carries the upstream
# changelog's bare "Fixes" headings, so detection has to key on the reference
# form, never the keyword alone.
REWRITTEN_BODY="Bumps ruff from 0.15.0 to 0.16.0.

<h3>Bug fixes</h3>
<h3>Fixes</h3>
Dependabot will resolve any conflicts with this PR."

check "hold reached through the issue marker when the body link is gone → optout" "optout" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
     PR_AUTHOR="$DEPENDABOT" PR_BODY="$REWRITTEN_BODY" ISSUE_LIST_JSON="$BRIDGED" \
     ISSUE_LABELS_FOR=1982 ISSUE_LABELS="dependencies,$OPTOUT" run 100)"

# The marker route is checked as EARLY as the body route, so the hold outranks
# every other token. Lazier placement would let a held bot PR still be synced or
# handed a ci-debugging worker that pushes commits onto a branch a human owns.
check "the marker hold short-circuits pending CI" "optout" \
  "$(CHECKS_EC=8 PR_AUTHOR="$DEPENDABOT" PR_BODY="$REWRITTEN_BODY" \
     ISSUE_LIST_JSON="$BRIDGED" ISSUE_LABELS_FOR=1982 \
     ISSUE_LABELS="dependencies,$OPTOUT" run 100)"

# Marker matching is on the WHOLE marker: a bare `100` also occurs inside `1002`,
# so a loose containment test would inherit a hold from an unrelated bump.
NEAR_MISS='[{"number":1002,"body":"<!-- dependabot-pr:1002 -->"},{"number":1982,"body":"<!-- dependabot-pr:100 -->"}]'

check "a hold on a longer PR number is not this PR's hold" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
     PR_AUTHOR="$DEPENDABOT" PR_BODY="$REWRITTEN_BODY" ISSUE_LIST_JSON="$NEAR_MISS" \
     ISSUE_LABELS_FOR=1002 ISSUE_LABELS="dependencies,$OPTOUT" run 100)"

# The twin: with only the longer number present nothing matches, which is silence
# about a hold, not proof of none — so the merge is refused, not granted.
NEAR_MISS_ONLY='[{"number":1002,"body":"<!-- dependabot-pr:1002 -->"}]'

rc=0
out="$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
   PR_AUTHOR="$DEPENDABOT" PR_BODY="$REWRITTEN_BODY" ISSUE_LIST_JSON="$NEAR_MISS_ONLY" run 100)" || rc=$?
check "a near-miss marker leaves the hold unproven and exits 2" "2" "$rc"
check "a near-miss marker prints no verdict" "" "$out"

# The bridge can leave more than one issue pointing at a bump (a re-run, a manual
# duplicate), and a hold on ANY of them is still a human saying no.
TWO_BRIDGES='[{"number":1982,"body":"<!-- dependabot-pr:100 -->"},{"number":1990,"body":"superseded\n<!-- dependabot-pr:100 -->"}]'

check "a hold on the second marker match still wins → optout" "optout" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
     PR_AUTHOR="$DEPENDABOT" PR_BODY="$REWRITTEN_BODY" ISSUE_LIST_JSON="$TWO_BRIDGES" \
     ISSUE_LABELS_FOR=1990 ISSUE_LABELS="dependencies,$OPTOUT" run 100)"

# Neither route resolving does not mean there is no hold: the scan is filtered by
# the `dependencies` label, which this repo has watched fail to stick (hence
# ensure-issue-label.sh). Merging on that silence is the fail-open being fixed.
rc=0
out="$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$NO_VERDICT" BEHIND_BY=0 \
   PR_AUTHOR="$DEPENDABOT" PR_BODY="$REWRITTEN_BODY" REVIEW_CONCLUSIONS="$SKIPPED" \
   ISSUE_LIST_JSON='[]' run 100)" || rc=$?
check "an unprovable hold blocks ready-unreviewed with exit 2" "2" "$rc"
check "an unprovable hold prints no ready-unreviewed verdict" "" "$out"

rc=0
out="$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
   PR_AUTHOR="$DEPENDABOT" PR_BODY="$REWRITTEN_BODY" ISSUE_LIST_JSON='[]' run 100)" || rc=$?
check "an unprovable hold blocks ready with exit 2" "2" "$rc"
check "an unprovable hold prints no ready verdict" "" "$out"

# A failed scan is a tooling error like every other lookup here, and dies at once
# rather than deferring: there is nothing to defer, no answer can arrive later.
rc=0
out="$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
   PR_AUTHOR="$DEPENDABOT" PR_BODY="$REWRITTEN_BODY" ISSUE_LIST_EC=1 run 100)" || rc=$?
check "marker scan failure exits 2" "2" "$rc"
check "marker scan failure prints no verdict" "" "$out"

# --- the fallback stays off every lane that cannot need it ------------------
# Only Dependabot rewrites its own bodies, so a human PR without a link must not
# pay an API call for it — and must never be held by a scan that cannot apply.
S_ISSUE_HUMAN="$WORK/issue-list-human"
check "a human PR with no issue link still classifies as ready" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
     ISSUE_LIST_SENTINEL="$S_ISSUE_HUMAN" run 100)"
probed "a human PR never scans for a marker" "no" "$S_ISSUE_HUMAN"

S_ISSUE_LINKED="$WORK/issue-list-linked"
check "a bot PR whose body still links an issue classifies from the link" "ready" \
  "$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=0 \
     PR_AUTHOR="$DEPENDABOT" PR_BODY="Closes #1982" ISSUE_LABELS="dependencies" \
     ISSUE_LIST_SENTINEL="$S_ISSUE_LINKED" run 100)"
probed "an intact body link never scans for a marker" "no" "$S_ISSUE_LINKED"

# The knowing cost of checking the hold FIRST, pinned rather than hidden: an
# unlinked bot lane pays for the scan even while CI is still running. That is the
# price of a hold that outranks every other token, and it is worth it.
S_ISSUE_PENDING="$WORK/issue-list-pending"
check "an unlinked bot lane with pending CI still classifies as pending" "pending" \
  "$(CHECKS_EC=8 PR_AUTHOR="$DEPENDABOT" PR_BODY="$REWRITTEN_BODY" \
     ISSUE_LIST_SENTINEL="$S_ISSUE_PENDING" run 100)"
probed "an unlinked bot lane scans for a marker before CI settles" "yes" "$S_ISSUE_PENDING"

# An unproven hold refuses only the MERGE. Wedging a lane that is not about to
# merge would strand it: `behind`'s remedy (a sync) is safe and, by re-linking the
# body or re-labelling the issue, is often what makes the hold provable again.
rc=0
out="$(CHECKS_EC=1 PR_AUTHOR="$DEPENDABOT" PR_BODY="$REWRITTEN_BODY" \
   ISSUE_LIST_JSON='[]' run 100)" || rc=$?
check "an unprovable hold still reports ci-failed" "ci-failed" "$out"
check "an unprovable hold does not fail a red lane" "0" "$rc"

rc=0
out="$(CHECKS_EC=0 MERGE_STATE=CLEAN HEAD_DATE=$H VERDICT="$FRESH|true" BEHIND_BY=17 \
   PR_AUTHOR="$DEPENDABOT" PR_BODY="$REWRITTEN_BODY" ISSUE_LIST_JSON='[]' run 100)" || rc=$?
check "an unprovable hold still reports behind" "behind" "$out"
check "an unprovable hold does not fail a stale lane" "0" "$rc"

# --- cross-file coupling: the bridge marker ---------------------------------
# The marker shape exists twice — the bridge writes it, pr-ready.sh reads it — and
# a silent drift between the two copies restores the exact fail-open being fixed,
# with nothing anywhere to report that the hold stopped being found.
MARKER_PREFIX='<!-- dependabot-pr:'
BRIDGE_WORKFLOW="$(cd "$(dirname "$0")/../.." && pwd)/.github/workflows/dependabot-to-ralph-issue.yml"

check "the bridge still stamps the marker onto the issue" "yes" \
  "$(grep -qF "$MARKER_PREFIX" "$BRIDGE_WORKFLOW" 2>/dev/null && echo yes || echo no)"
check "pr-ready.sh still looks for that same marker" "yes" \
  "$(grep -qF "$MARKER_PREFIX" "$READY" 2>/dev/null && echo yes || echo no)"

# --- cross-file coupling: the review check's NAME ---------------------------
# pr-ready.sh matches the review check by the literal string `claude-review`, which
# only holds while that job key carries no `name:` override — GitHub would then
# report the override instead and every Dependabot lane would wedge at
# awaiting-review forever, with no error anywhere to explain it.
REVIEW_WORKFLOW="$(cd "$(dirname "$0")/../.." && pwd)/.github/workflows/claude-code-review.yml"
job_keys="$(awk '$0 == "  claude-review:" {j = 1; next}
                 j && /^  [^[:space:]#]/ {exit}
                 j && /^    [^[:space:]#]/ {sub(/:.*/, "", $1); print $1}' \
            "$REVIEW_WORKFLOW" 2>/dev/null || true)"

check "the claude-review job key still exists" "yes" \
  "$(grep -qx '  claude-review:' "$REVIEW_WORKFLOW" 2>/dev/null && echo yes || echo no)"
check "the claude-review job declares no name: override" "" \
  "$(printf '%s\n' "$job_keys" | grep -x name || true)"

# --- summary ---------------------------------------------------------------
echo
echo "pr-ready tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
