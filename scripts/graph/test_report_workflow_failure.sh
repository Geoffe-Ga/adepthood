#!/usr/bin/env bash
# scripts/graph/test_report_workflow_failure.sh
#
# Offline tests for report_workflow_failure.sh — the "a scheduled job whose
# failure nobody sees is a job that is not running" alarm.
#
# graph-semantic.yml failed every week for over a month and nobody noticed,
# while CLAUDE.md was telling every agent to prefer the knowledge graph over
# grep sweeps. That is the expensive half of the defect, and it repeats: the
# playbook loop once stood down for twelve days looking exactly like a workflow
# with nothing to do.
#
# The alarm has two failure modes and both are pinned here. Filing nothing is
# the bug it exists to fix. Filing one issue per run is ALSO the bug, because
# weekly noise is precisely how the original failures went unread — so the
# second run must comment on the first run's issue, and a search that could not
# be completed must refuse to file rather than guess and duplicate.
#
# `gh` is stubbed on PATH; nothing here touches the network.
#
# Run:  bash scripts/graph/test_report_workflow_failure.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPORT="$HERE/report_workflow_failure.sh"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }
check() { # check <desc> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}
contains() { # contains <desc> <needle> <haystack>
  if grep -qF -- "$2" <<<"$3"; then ok "$1"; else bad "$1 (no '$2' in: ${3:0:300})"; fi
}
lacks() { # lacks <desc> <needle> <haystack>
  if grep -qF -- "$2" <<<"$3"; then bad "$1 (found '$2')"; else ok "$1"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"
CALLS="$WORK/gh-calls"

# Stub gh. Driven by:
#   ISSUE_LIST_JSON — `issue list --json number,body` payload the search sees
#   ISSUE_LIST_EC   — exit code for that search (non-zero = could not ask)
#   CREATE_EC / COMMENT_EC — exit codes for the two write paths
# Every invocation is appended to $CALLS, so a test can assert not only what
# happened but what did NOT (the duplicate-filing guard is entirely a
# did-not-happen assertion).
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALLS"
case "$*" in
  *"issue list"*)
    expr="" prev=""
    for a in "$@"; do [[ "$prev" == "--jq" ]] && expr="$a"; prev="$a"; done
    payload="${ISSUE_LIST_JSON:-[]}"
    if [[ -n "$expr" ]]; then
      printf '%s' "$payload" | jq -rc "$expr"
    else
      printf '%s\n' "$payload"
    fi
    exit "${ISSUE_LIST_EC:-0}" ;;
  *"issue create"*)
    echo "https://github.com/o/r/issues/4242"
    exit "${CREATE_EC:-0}" ;;
  *"issue comment"*)
    echo "https://github.com/o/r/issues/4242#issuecomment-1"
    exit "${COMMENT_EC:-0}" ;;
  *) echo '' ;;
esac
STUB
chmod +x "$BIN/gh"

# A real `gh run view --log-failed` tail from the failing workflow: TAB-separated
# job, step, then an RFC3339 timestamp followed by the message. Thirteen chunks
# fail with the same sentence and a different number, which is exactly the shape
# that must NOT produce thirteen lines of report.
LOG="$WORK/log-failed.txt"
{
  printf 'Extract and publish semantic graph\tSemantic extraction (claude backend)\t2026-08-17T05:53:01.1Z [graphify] chunk 1/13 failed: Connection error.\n'
  printf 'Extract and publish semantic graph\tSemantic extraction (claude backend)\t2026-08-17T05:53:02.1Z [graphify] chunk 2/13 failed: Connection error.\n'
  printf 'Extract and publish semantic graph\tSemantic extraction (claude backend)\t2026-08-17T05:53:03.1Z [graphify] chunk 3/13 failed: Connection error.\n'
  printf 'Extract and publish semantic graph\tSemantic extraction (claude backend)\t2026-08-17T05:53:50.1Z [graphify] WARNING: 13/13 semantic chunk(s) failed — Partial results returned.\n'
  printf 'Extract and publish semantic graph\tSemantic extraction (claude backend)\t2026-08-17T05:53:51.1Z [graphify extract] error: all semantic chunks failed for backend '"'"'claude'"'"' (485 uncached files)\n'
} > "$LOG"

MARKER='<!-- workflow-failure:graph-semantic.yml -->'
RUN_URL="https://github.com/o/r/actions/runs/31999432521"

# The standard invocation. Cases vary behaviour through the stub's env vars, not
# through arguments, so this deliberately takes none — the argument-varying cases
# below call $REPORT directly.
run() {
  : > "$CALLS"
  PATH="$BIN:$PATH" GH_CALLS="$CALLS" "$REPORT" \
    --workflow graph-semantic.yml \
    --run-url "$RUN_URL" \
    --log-file "$LOG" 2>&1
}

# --- first failure: nothing is tracking it yet, so file one ------------------
out="$(ISSUE_LIST_JSON='[]' run)"; ec=$?
check "the first failure exits 0" "0" "$ec"
calls="$(cat "$CALLS")"
contains "the first failure files an issue" "issue create" "$calls"
lacks "the first failure does not comment" "issue comment" "$calls"
contains "the report names the workflow" "graph-semantic.yml" "$calls"
contains "the report names the failing step" "Semantic extraction (claude backend)" "$calls"
contains "the report carries the first error line" "Connection error." "$calls"
contains "the report links the run" "$RUN_URL" "$calls"
contains "the new issue carries the durable marker" "$MARKER" "$calls"

# The thirteen identical chunk failures must collapse: a report that reprints
# every one of them is a wall nobody reads, which is the failure mode being
# fixed, not a second copy of the fix.
chunk_mentions="$(grep -oF 'chunk ' <<<"$calls" | wc -l | tr -d ' ')"
if [[ "$chunk_mentions" -le 2 ]]; then
  ok "repeated identical errors are collapsed, not reprinted ($chunk_mentions)"
else
  bad "repeated identical errors are collapsed, not reprinted (got $chunk_mentions mentions)"
fi

# The distinct final error is the diagnostic one and must survive the collapse.
contains "the distinct closing error survives deduplication" "all semantic chunks failed" "$calls"

# --- the seventh failure: update the existing issue, never file a second -----
# "A bot that files weekly is noise, and noise is precisely how this went
# unseen." One issue, N comments.
EXISTING="[{\"number\":2345,\"body\":\"tracking\\n$MARKER\"}]"
out="$(ISSUE_LIST_JSON="$EXISTING" run)"; ec=$?
check "a repeat failure exits 0" "0" "$ec"
calls="$(cat "$CALLS")"
contains "a repeat failure comments on the existing issue" "issue comment 2345" "$calls"
lacks "a repeat failure files no second issue" "issue create" "$calls"
contains "the comment links the new run" "$RUN_URL" "$calls"

# --- an unreadable search must not become a duplicate -----------------------
# Reading a failed lookup as "nothing is tracking this" is how one tracking
# issue becomes one per run. Fail loudly instead.
out="$(ISSUE_LIST_EC=1 run)"; ec=$?
if [[ "$ec" -ne 0 ]]; then ok "an unreadable search exits non-zero"; else bad "an unreadable search exits non-zero (got 0)"; fi
calls="$(cat "$CALLS")"
lacks "an unreadable search files nothing" "issue create" "$calls"
lacks "an unreadable search comments nothing" "issue comment" "$calls"
contains "an unreadable search says why" "could not" "$out"

# --- the marker must be matched whole ---------------------------------------
# A different workflow's tracking issue must not be mistaken for this one's.
OTHER="[{\"number\":99,\"body\":\"<!-- workflow-failure:graph-build.yml -->\"}]"
out="$(ISSUE_LIST_JSON="$OTHER" run)"
calls="$(cat "$CALLS")"
contains "another workflow's tracker does not absorb this failure" "issue create" "$calls"
lacks "another workflow's tracker is not commented on" "issue comment 99" "$calls"

# --- a write failure is reported, not swallowed -----------------------------
# An alarm that fails silently is the thing being fixed.
out="$(ISSUE_LIST_JSON='[]' CREATE_EC=1 run)"; ec=$?
if [[ "$ec" -ne 0 ]]; then ok "a failed issue create exits non-zero"; else bad "a failed issue create exits non-zero (got 0)"; fi

out="$(ISSUE_LIST_JSON="$EXISTING" COMMENT_EC=1 run)"; ec=$?
if [[ "$ec" -ne 0 ]]; then ok "a failed issue comment exits non-zero"; else bad "a failed issue comment exits non-zero (got 0)"; fi

# --- a missing or empty log still reports ------------------------------------
# The run failed; that fact must reach a human even if the log could not be
# read. A reporter that needs a perfect log to say anything is one more way for
# a failure to stay invisible.
out="$(ISSUE_LIST_JSON='[]' PATH="$BIN:$PATH" GH_CALLS="$CALLS" "$REPORT" \
  --workflow graph-semantic.yml --run-url "$RUN_URL" \
  --log-file "$WORK/nope.txt" 2>&1)"; ec=$?
check "a missing log still exits 0" "0" "$ec"
contains "a missing log still files the report" "issue create" "$(cat "$CALLS")"

# --- usage ------------------------------------------------------------------
ec=0
PATH="$BIN:$PATH" GH_CALLS="$CALLS" "$REPORT" --workflow graph-semantic.yml >/dev/null 2>&1 || ec=$?
check "a missing --run-url is a usage error" "2" "$ec"

# --- the workflow actually calls it ------------------------------------------
# An alarm nothing invokes is the same silent gap it exists to close.
WORKFLOW="$(cd "$HERE/../.." && pwd)/.github/workflows/graph-semantic.yml"
wf="$(cat "$WORKFLOW" 2>/dev/null || true)"
contains "graph-semantic.yml invokes the failure reporter" \
  "scripts/graph/report_workflow_failure.sh" "$wf"
contains "the reporter runs only on failure" "if: failure()" "$wf"
contains "the reporting job may write issues" "issues: write" "$wf"

printf '\nreport_workflow_failure tests: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
