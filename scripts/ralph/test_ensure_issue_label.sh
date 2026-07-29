#!/usr/bin/env bash
# scripts/ralph/test_ensure_issue_label.sh
#
# Offline tests for ensure-issue-label.sh — the label applier the
# Dependabot-to-Ralph workflow uses to stamp `dependencies` on the issue it
# files for each bot PR.
#
# WHY THIS EXISTS: labelling used to run as `gh issue edit N --add-label X
# || true`. On a fine-grained PAT that call is denied at the GraphQL layer
# (addLabelsToLabelable), and `|| true` discarded the error, so the workflow
# could only GUESS why the label was missing — and guessed wrong. The
# replacement must (a) apply via the REST labels endpoint, (b) retry once with
# a distinct fallback token, (c) verify by reading the labels back, and
# (d) print the VERBATIM stderr of every failing gh call. No swallowed errors,
# no invented causes.
#
# A fake, arg-aware `gh` on PATH makes the API choice observable. Every call's
# full argv is recorded, so the happy path pins the request SHAPE — the HTTP
# method, the REST labels path, the `labels[]` body parameter, and the absence
# of any GraphQL call. Both known routes to the denied `addLabelsToLabelable`
# mutation, the `gh issue edit --add-label` shorthand and a hand-rolled
# `gh api graphql`, are routed to an unmistakable stub failure. Each REST POST
# additionally records the token that made it, so "wrong API", "wrong request"
# and "retried when it must not" are all caught.
#
# Run:  bash scripts/ralph/test_ensure_issue_label.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/ensure-issue-label.sh"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }
check()    { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi; }
contains() { if [[ "$3" == *"$2"* ]]; then ok "$1"; else bad "$1 (needle [$2] absent from [$3])"; fi; }
lacks()    { if [[ "$3" != *"$2"* ]]; then ok "$1"; else bad "$1 (needle [$2] present in [$3])"; fi; }
differs()  { if [[ "$2" != "$3" ]]; then ok "$1"; else bad "$1 (both outputs were [$2])"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"
ATTEMPT_LOG="$WORK/attempts"
export ATTEMPT_LOG
# Full argv of every gh call, one call per line. ATTEMPT_LOG answers "how many
# POSTs, by which token"; REQ_LOG answers "which API, and with what request".
REQ_LOG="$WORK/requests"
export REQ_LOG

# Fixture identity. The sentinels let the stub tell the two tokens apart and let
# every scenario assert that neither value is ever echoed back to the log.
readonly ISSUE=42
readonly LABEL=dependencies
readonly REPO=owner/repo
readonly PRIMARY_SENTINEL=ralph-primary-sentinel
readonly FALLBACK_SENTINEL=ralph-fallback-sentinel
export FALLBACK_SENTINEL

# Verbatim gh stderr the stub replays. Case 3 asserts BOTH survive to the log —
# that pair of assertions is the direct regression guard against `|| true`.
readonly PRIMARY_ERR='HTTP 403: Resource not accessible by personal access token (https://api.github.com/repos/owner/repo/issues/42/labels)'
readonly FALLBACK_ERR='HTTP 403: Resource not accessible by integration (https://api.github.com/repos/owner/repo/issues/42/labels)'
readonly READBACK_ERR='HTTP 502: Bad gateway (https://api.github.com/repos/owner/repo/issues/42)'

# Arg-aware fake gh, driven by env vars each scenario sets:
#   POST_EC_PRIMARY / POST_ERR_PRIMARY     — REST POST result under the primary token
#   POST_EC_FALLBACK / POST_ERR_FALLBACK   — same under the fallback token
#   VIEW_EC / VIEW_ERR / VIEW_LABELS       — read-back result (labels newline separated)
# Every call appends its full argv to $REQ_LOG, so the request SHAPE is a
# first-class assertion; every POST additionally appends the attempting token's
# role to $ATTEMPT_LOG, so attempt COUNT is one too.
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
args="$*"
printf '%s\n' "$args" >> "$REQ_LOG"
case "$args" in
  *"issue edit"*)
    # The denied GraphQL mutation, via the CLI shorthand. Fail loudly so a
    # regression to it is visible.
    printf 'STUB-FORBIDDEN: gh issue edit uses the denied GraphQL mutation\n' >&2
    exit 1 ;;
  *graphql*)
    # The same denied mutation reached by hand. Checked BEFORE the REST case so
    # a `-f query=...addLabelsToLabelable...` payload cannot masquerade as one.
    printf 'STUB-FORBIDDEN: gh api graphql uses the denied GraphQL mutation\n' >&2
    exit 1 ;;
  *"issue view"*)
    if [[ -n "${VIEW_ERR:-}" ]]; then printf '%s\n' "$VIEW_ERR" >&2; fi
    if [[ "${VIEW_EC:-0}" -ne 0 ]]; then exit "${VIEW_EC:-0}"; fi
    if [[ -n "${VIEW_LABELS:-}" ]]; then printf '%s\n' "$VIEW_LABELS"; fi
    exit 0 ;;
  *"api"*"labels"*)
    role=primary
    if [[ "${GH_TOKEN:-}" == "$FALLBACK_SENTINEL" ]]; then role=fallback; fi
    printf '%s\n' "$role" >> "$ATTEMPT_LOG"
    if [[ "$role" == fallback ]]; then
      err="${POST_ERR_FALLBACK:-}"; ec="${POST_EC_FALLBACK:-0}"
    else
      err="${POST_ERR_PRIMARY:-}"; ec="${POST_EC_PRIMARY:-0}"
    fi
    if [[ -n "$err" ]]; then printf '%s\n' "$err" >&2; fi
    exit "$ec" ;;
  *)
    printf 'STUB-UNEXPECTED: %s\n' "$args" >&2
    exit 1 ;;
esac
STUB
chmod +x "$BIN/gh"

OUT=""
EC=0

# Reset every stub knob to the all-green default, then a scenario overrides only
# what it is about. Explicit re-export (not `VAR=x run`) keeps cases isolated.
scenario() {
  : > "$ATTEMPT_LOG"
  : > "$REQ_LOG"
  export POST_EC_PRIMARY=0 POST_ERR_PRIMARY=""
  export POST_EC_FALLBACK=0 POST_ERR_FALLBACK=""
  export VIEW_EC=0 VIEW_ERR="" VIEW_LABELS="agent-ready
$LABEL"
  export GH_TOKEN="$PRIMARY_SENTINEL"
  export FALLBACK_GH_TOKEN="$FALLBACK_SENTINEL"
  # Pinned, not inherited: GitHub Actions exports GITHUB_REPOSITORY on every
  # runner, so an unpinned value would make the repo-resolution cases pass or
  # fail depending on where the suite runs. The case that needs it absent
  # unsets it explicitly.
  export GITHUB_REPOSITORY="$REPO"
}

run() { # run <args...> — combined stdout+stderr into OUT, exit code into EC
  set +e
  OUT="$(PATH="$BIN:$PATH" "$SCRIPT" "$@" 2>&1)"
  EC=$?
  set -e
}

run_default() { run "$ISSUE" "$LABEL" --repo "$REPO"; }

attempts()      { awk 'END { print NR }' "$ATTEMPT_LOG"; }
attempts_with() { grep -c "^$1\$" "$ATTEMPT_LOG" || true; }

# Recorded requests. `requests` is every gh call; `api_calls` is just the REST
# ones (`gh api ...`), which is where the label write must happen.
requests()       { cat "$REQ_LOG"; }
api_calls()      { grep -e '^api ' "$REQ_LOG" || true; }
api_call_count() { grep -c -e '^api ' "$REQ_LOG" || true; }

# The whole reason this script exists: the label must never be written through
# GraphQL, where the workflow's fine-grained PAT is denied.
rest_only() { lacks "$1: no gh call reaches the GraphQL layer" "graphql" "$(requests)"; }

# Tokens are secrets: they must never reach stdout/stderr, in any scenario.
no_leak() {
  lacks "$1: primary token value not echoed" "$PRIMARY_SENTINEL" "$OUT"
  lacks "$1: fallback token value not echoed" "$FALLBACK_SENTINEL" "$OUT"
}

# The one-time manual fix a human runs when automation cannot apply the label.
remedy_offered() {
  contains "$1: names the issue in the manual remedy" "gh issue edit $ISSUE" "$OUT"
  contains "$1: names the label in the manual remedy" "--add-label $LABEL" "$OUT"
}

# --- 1. primary token applies the label, read-back confirms it ---------------
scenario
run_default
check    "primary success exits 0" "0" "$EC"
check    "primary success makes exactly one POST" "1" "$(attempts)"
check    "the single POST used the primary token" "1" "$(attempts_with primary)"
contains "primary success credits the primary token" "primary" "$OUT"
contains "primary success names the label" "$LABEL" "$OUT"
lacks    "primary success never calls gh issue edit" "STUB-FORBIDDEN" "$OUT"
lacks    "primary success makes no unmodelled gh call" "STUB-UNEXPECTED" "$OUT"
no_leak  "primary success"

# The request SHAPE, not just its outcome. Each of these pins one property of
# the REST call that the fine-grained PAT is actually permitted to make; the
# needles are built from the fixture constants so the expectation cannot drift
# away from the arguments the script was handed.
API_CALLS="$(api_calls)"
check    "the label write is the only gh api call" "1" "$(api_call_count)"
contains "the label write uses HTTP POST" "--method POST" "$API_CALLS"
contains "the label write targets the REST labels endpoint" \
         "repos/$REPO/issues/$ISSUE/labels" "$API_CALLS"
contains "the label write sends the label as a labels[] body parameter" \
         "labels[]=$LABEL" "$API_CALLS"
rest_only "primary success"

# --- 2. primary denied, fallback rescues — the denial is STILL reported ------
# A capability gap that the fallback papers over must never go unlogged.
scenario
export POST_EC_PRIMARY=1 POST_ERR_PRIMARY="$PRIMARY_ERR"
run_default
check    "fallback rescue exits 0" "0" "$EC"
check    "fallback rescue makes exactly two POSTs" "2" "$(attempts)"
check    "fallback rescue tried the primary token first" "1" "$(attempts_with primary)"
check    "fallback rescue retried with the fallback token" "1" "$(attempts_with fallback)"
contains "fallback rescue still reports the primary error verbatim" "$PRIMARY_ERR" "$OUT"
contains "fallback rescue credits the fallback token" "fallback" "$OUT"
lacks    "fallback rescue never calls gh issue edit" "STUB-FORBIDDEN" "$OUT"
no_leak  "fallback rescue"
rest_only "fallback rescue"
contains "the fallback retry repeats the same REST labels endpoint" \
         "repos/$REPO/issues/$ISSUE/labels" "$(api_calls)"
check    "fallback rescue makes exactly two gh api calls" "2" "$(api_call_count)"

# --- 3. both tokens denied — BOTH errors verbatim (anti-`|| true`) ----------
scenario
export POST_EC_PRIMARY=1 POST_ERR_PRIMARY="$PRIMARY_ERR"
export POST_EC_FALLBACK=1 POST_ERR_FALLBACK="$FALLBACK_ERR"
export VIEW_LABELS="agent-ready"
run_default
check    "both-denied exits 1" "1" "$EC"
check    "both-denied made two POSTs" "2" "$(attempts)"
contains "both-denied reports the primary error verbatim" "$PRIMARY_ERR" "$OUT"
contains "both-denied reports the fallback error verbatim" "$FALLBACK_ERR" "$OUT"
remedy_offered "both-denied"
no_leak  "both-denied"
rest_only "both-denied"

# --- 4. POST claims success but the label is not there (silently dropped) ----
# Near-miss labels in BOTH directions: `dependencies-bot` catches a prefix match
# and `extra-dependencies` catches a suffix-anchored one, so only a whole-line
# comparison survives.
scenario
export VIEW_LABELS="agent-ready
dependencies-bot
extra-dependencies"
run_default
DROPPED_OUT="$OUT"
check    "silently-dropped exits 1" "1" "$EC"
contains "silently-dropped echoes the labels actually read back" "dependencies-bot" "$OUT"
contains "a label ENDING in the wanted label is not the wanted label" \
         "extra-dependencies" "$OUT"
lacks    "silently-dropped does not blame the read-back call" "$READBACK_ERR" "$OUT"
remedy_offered "silently-dropped"
no_leak  "silently-dropped"
rest_only "silently-dropped"

# --- 5. the read-back itself errors — a different diagnosis than case 4 ------
scenario
export VIEW_EC=1 VIEW_ERR="$READBACK_ERR"
run_default
READBACK_OUT="$OUT"
check    "read-back failure exits 1" "1" "$EC"
contains "read-back failure reports its error verbatim" "$READBACK_ERR" "$OUT"
remedy_offered "read-back failure"
no_leak  "read-back failure"
rest_only "read-back failure"
differs  "unverifiable and dropped states get distinct diagnoses" \
         "$DROPPED_OUT" "$READBACK_OUT"

# --- 6. no usable fallback ⇒ exactly ONE attempt -----------------------------
scenario
unset FALLBACK_GH_TOKEN
export POST_EC_PRIMARY=1 POST_ERR_PRIMARY="$PRIMARY_ERR"
run_default
check    "unset fallback exits 1" "1" "$EC"
check    "unset fallback makes exactly one POST" "1" "$(attempts)"
check    "unset fallback never reaches the fallback branch" "0" "$(attempts_with fallback)"
contains "unset fallback reports the primary error verbatim" "$PRIMARY_ERR" "$OUT"
no_leak  "unset fallback"
rest_only "unset fallback"

scenario
export FALLBACK_GH_TOKEN="$PRIMARY_SENTINEL"   # byte-identical to GH_TOKEN
export POST_EC_PRIMARY=1 POST_ERR_PRIMARY="$PRIMARY_ERR"
run_default
check    "identical fallback exits 1" "1" "$EC"
check    "identical fallback makes exactly one POST" "1" "$(attempts)"
contains "identical fallback reports the primary error verbatim" "$PRIMARY_ERR" "$OUT"
no_leak  "identical fallback"
rest_only "identical fallback"

# --- 7. usage errors exit 2 (house style: die() in pr-ready.sh) --------------
scenario
run
check "missing issue number exits 2" "2" "$EC"
no_leak "missing issue number"

scenario
run "$ISSUE"
check "missing label exits 2" "2" "$EC"
check "missing label makes no POST" "0" "$(attempts)"
no_leak "missing label"

scenario
run "not-a-number" "$LABEL" --repo "$REPO"
check "non-numeric issue number exits 2" "2" "$EC"
check "non-numeric issue number makes no POST" "0" "$(attempts)"
no_leak "non-numeric issue number"

scenario
run "$ISSUE" "$LABEL" --repo
check "--repo with no value exits 2" "2" "$EC"
check "--repo with no value makes no POST" "0" "$(attempts)"
no_leak "--repo with no value"

scenario
run "$ISSUE" "$LABEL" --not-an-option
check "unknown option exits 2" "2" "$EC"
check "unknown option makes no POST" "0" "$(attempts)"
no_leak "unknown option"

scenario
run "$ISSUE" "$LABEL" "surplus" --repo "$REPO"
check "extra positional argument exits 2" "2" "$EC"
check "extra positional argument makes no POST" "0" "$(attempts)"
no_leak "extra positional argument"

# The Actions-native default is the ONLY other source of the repo, so with it
# gone and no --repo there is nothing to interpolate into the API path.
scenario
unset GITHUB_REPOSITORY
run "$ISSUE" "$LABEL"
check "no repo from either source exits 2" "2" "$EC"
check "no repo from either source makes no POST" "0" "$(attempts)"
no_leak "no repo from either source"

# --- 8. a repo value is interpolated into an API path, so validate it --------
# INTENTIONALLY RED: path traversal in --repo must be rejected before it can
# redirect the write at another resource. Asserted as ONE composite check so the
# pending guard reads as a single gap rather than two.
scenario
run "$ISSUE" "$LABEL" --repo "owner/../../user"
check "path-traversal --repo is rejected before any gh call" \
      "ec=2 posts=0" "ec=$EC posts=$(attempts)"
no_leak "path-traversal --repo"

printf '\nensure-issue-label tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
