#!/usr/bin/env bash
# scripts/ralph/test_issue_evidence.sh
#
# Offline tests for issue-evidence.sh — the `gh` transport that feeds open issue
# bodies to backend/scripts/issue_evidence.py and comments on the ones whose
# premise expired.
#
# WHY THIS EXISTS: the judgements are unit-tested in
# backend/tests/scripts/test_issue_evidence.py, which never sees `gh`. Everything
# that can go wrong in the transport is therefore invisible to that suite, and
# the two things most likely to go wrong are the two this repo has already been
# bitten by:
#
#   1. A `gh` failure read as a verdict. An expired token or a rate limit yields
#      no issues; treating that as "nothing expired" is the bug #2219 fixed in
#      pr-ready.sh. Case 3 and case 4 fail `gh` and assert the run exits 2 with
#      no verdict printed.
#   2. A bot re-posting the same finding every run. Case 2 seeds the marker into
#      the issue's existing comments and asserts nothing is posted.
#
# A fake, arg-aware `gh` on PATH makes both observable, and every call's argv is
# recorded so "did it try to edit or close anything" is a first-class assertion:
# this tool is read-only except for a single comment.
#
# Run:  bash scripts/ralph/test_issue_evidence.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/issue-evidence.sh"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }
check()    { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi; }
contains() { if [[ "$3" == *"$2"* ]]; then ok "$1"; else bad "$1 (needle [$2] absent from [$3])"; fi; }
lacks()    { if [[ "$3" != *"$2"* ]]; then ok "$1"; else bad "$1 (needle [$2] present in [$3])"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"
REQ_LOG="$WORK/requests"
export REQ_LOG

readonly REPO=owner/repo

# Arg-aware fake gh. Scenario knobs:
#   LIST_EC / LIST_JSON       — `gh issue list` exit code and stdout
#   VIEW_EC / VIEW_COMMENTS   — `gh issue view --json comments` result
#   COMMENT_EC                — `gh issue comment` exit code
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
args="$*"
printf '%s\n' "$args" >> "$REQ_LOG"
case "$args" in
  *"issue list"*)
    [ "${LIST_EC:-0}" -eq 0 ] || { echo "HTTP 401: Bad credentials" >&2; exit "${LIST_EC}"; }
    printf '%s' "${LIST_JSON:-[]}"; exit 0 ;;
  *"issue view"*)
    [ "${VIEW_EC:-0}" -eq 0 ] || { echo "HTTP 502: Bad gateway" >&2; exit "${VIEW_EC}"; }
    printf '%s' "${VIEW_COMMENTS:-}"; exit 0 ;;
  *"issue comment"*)
    [ "${COMMENT_EC:-0}" -eq 0 ] || { echo "HTTP 403: forbidden" >&2; exit "${COMMENT_EC}"; }
    echo "https://github.com/owner/repo/issues/1#issuecomment-1"; exit 0 ;;
esac
echo "unexpected gh call: $args" >&2
exit 99
STUB
chmod +x "$BIN/gh"

# A repo fixture the cited evidence is checked against. The script resolves its
# root with `git rev-parse`, so this has to be a real repository.
REPO_DIR="$WORK/repo"
mkdir -p "$REPO_DIR/backend/src" "$REPO_DIR/backend/scripts" "$REPO_DIR/frontend/src"
printf 'pickSeedDocuments\n' > "$REPO_DIR/frontend/src/a.ts"
printf 'a\n' > "$REPO_DIR/backend/src/a.py"
cp "$(cd "$(dirname "$0")/../../backend/scripts" && pwd)/issue_evidence.py" \
   "$REPO_DIR/backend/scripts/issue_evidence.py"
: > "$REPO_DIR/backend/scripts/__init__.py"
git -C "$REPO_DIR" init -q
git -C "$REPO_DIR" add -A
git -C "$REPO_DIR" -c user.email=t@t -c user.name=t commit -qm init

# Issue #7's body claims zero hits for a grep that now matches: expired.
EXPIRED_JSON='[{"number":7,"title":"t","state":"OPEN","body":"`grep -rn \"pickSeedDocuments\" frontend/src` returns nothing."}]'
# Issue #8's citation still resolves: holds.
HOLDS_JSON='[{"number":8,"title":"t","state":"OPEN","body":"See `backend/src/a.py:1`."}]'

run() {
  ( cd "$REPO_DIR" && PATH="$BIN:$PATH" bash "$SCRIPT" --repo "$REPO" "$@" ) 2>"$WORK/err"
}

# --- case 1: an expired premise is commented on, exactly once ---------------
: > "$REQ_LOG"
out="$(LIST_JSON="$EXPIRED_JSON" VIEW_COMMENTS="" run --comment || true)"
ec=$?
requests="$(cat "$REQ_LOG")"
contains "case 1: reports the expired issue" "#7" "$out"
contains "case 1: posts a comment" "issue comment 7" "$requests"
lacks    "case 1: never edits the issue" "issue edit" "$requests"
lacks    "case 1: never closes the issue" "issue close" "$requests"

# --- case 2: the same finding twice posts nothing the second time -----------
: > "$REQ_LOG"
marker="$( ( cd "$REPO_DIR/backend" && PYTHONPATH=. python3 - <<'PY'
import json, sys
sys.path.insert(0, ".")
from scripts.issue_evidence import check_issue, comment_marker
from pathlib import Path
body = '`grep -rn "pickSeedDocuments" frontend/src` returns nothing.'
print(comment_marker(check_issue({"number": 7, "title": "t", "body": body}, Path(".."))))
PY
) )"
out="$(LIST_JSON="$EXPIRED_JSON" VIEW_COMMENTS="$marker" run --comment || true)"
requests="$(cat "$REQ_LOG")"
contains "case 2: says the finding was already reported" "already reported" "$out"
lacks    "case 2: posts no second comment" "issue comment" "$requests"

# --- case 3: a failing fetch is a transport error, never a verdict ----------
set +e
LIST_EC=1 run --comment >"$WORK/out" 2>"$WORK/err"
ec=$?
set -e
check    "case 3: exits 2 on a failed fetch" "2" "$ec"
contains "case 3: names the transport" "transport error" "$(cat "$WORK/err")"
lacks    "case 3: prints no verdict" "expired" "$(cat "$WORK/out")"

# --- case 4: a fetch that exits 0 with a non-array is still a transport error
set +e
LIST_JSON='{"message":"API rate limit exceeded"}' run --comment >"$WORK/out" 2>"$WORK/err"
ec=$?
set -e
check    "case 4: exits 2 on a non-array payload" "2" "$ec"
contains "case 4: names the transport" "transport error" "$(cat "$WORK/err")"

# --- case 5: dry run is the default and posts nothing -----------------------
: > "$REQ_LOG"
out="$(LIST_JSON="$EXPIRED_JSON" VIEW_COMMENTS="" run || true)"
requests="$(cat "$REQ_LOG")"
contains "case 5: shows what it would post" "would comment on #7" "$out"
lacks    "case 5: posts nothing without --comment" "issue comment" "$requests"

# --- case 6: a holding issue exits 0 and is never commented on --------------
: > "$REQ_LOG"
set +e
LIST_JSON="$HOLDS_JSON" run --comment >"$WORK/out" 2>"$WORK/err"
ec=$?
set -e
check    "case 6: exits 0 when nothing expired" "0" "$ec"
lacks    "case 6: comments on nothing" "issue comment" "$(cat "$REQ_LOG")"

# --- case 7: an expired premise sets the advisory exit code -----------------
set +e
LIST_JSON="$EXPIRED_JSON" VIEW_COMMENTS="" run --comment >"$WORK/out" 2>"$WORK/err"
ec=$?
set -e
check "case 7: exits 1 when a premise expired" "1" "$ec"

echo "issue-evidence tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
