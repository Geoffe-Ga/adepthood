#!/usr/bin/env bash
# scripts/ralph/test_bridge_issue_exists.sh
#
# Offline tests for bridge-issue-exists.sh — the Dependabot bridge's dedup
# check, extracted from `.github/workflows/dependabot-to-ralph-issue.yml` so it
# can be tested at all.
#
# WHY THIS EXISTS: the check used to be
#
#     gh issue list ... --jq '.[].body' 2>/dev/null | grep -qF "$marker"
#
# inside a `run:` block carrying `set -euo pipefail`. `grep -q` exits the moment
# it finds the marker, so once the accumulated bodies outgrow the pipe buffer
# (64 KiB on Linux) `gh` is killed by SIGPIPE and exits 141 — and under
# `pipefail` the pipeline reports 141 EVEN THOUGH GREP MATCHED. The bridge then
# concluded "no issue exists" and filed a duplicate for a PR it had already
# bridged. Case 1 reproduces that directly with a stub that emits more than a
# pipe buffer with the marker near the front; it passes only because the fix
# stopped piping `gh` into an early-exiting reader.
#
# The second, smaller problem on the same line was `2>/dev/null`, which made an
# auth or API failure indistinguishable from "no match" — the same anti-pattern
# that made the missing-label bug take four failed runs to diagnose. Cases 4
# and 5 pin the replacement: a genuine `gh` failure exits 2, never 1, and its
# stderr is reproduced verbatim.
#
# The stub feeds a JSON fixture through the REAL `--jq` filter the script
# passes, so the filter itself — including the whole-marker containment that
# keeps `#1002` from matching `#100` — is under test rather than mocked away.
#
# Run:  bash scripts/ralph/test_bridge_issue_exists.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/bridge-issue-exists.sh"
PASS=0
FAIL=0

ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }
check()    { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi; }
contains() { if [[ "$3" == *"$2"* ]]; then ok "$1"; else bad "$1 (needle [$2] absent from [$3])"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"
export STUB_JSON="$WORK/issues.json"

readonly REPO=owner/repo
readonly GH_ERR='HTTP 401: Bad credentials (https://api.github.com/repos/owner/repo/issues)'
export GH_ERR

# Arg-aware fake gh. It applies the script's OWN --jq filter to $STUB_JSON, so
# a change to that filter changes what these tests see.
cat > "$BIN/gh" <<'STUB'
#!/usr/bin/env bash
if [ "${LIST_EC:-0}" -ne 0 ]; then
  printf '%s\n' "$GH_ERR" >&2
  exit "$LIST_EC"
fi
filter=""
prev=""
for arg in "$@"; do
  [ "$prev" = "--jq" ] && filter="$arg"
  prev="$arg"
done
jq -r "$filter" < "$STUB_JSON"
STUB
chmod +x "$BIN/gh"

command -v jq >/dev/null 2>&1 || { echo "jq is required for these tests" >&2; exit 2; }

run() { PATH="$BIN:$PATH" bash "$SCRIPT" "$@" --repo "$REPO"; }

# --- case 1: the SIGPIPE regression ----------------------------------------
# One matching issue whose marker is near the FRONT, followed by far more than a
# pipe buffer of further bodies. Under the old pipe-into-`grep -q`, `grep` exits
# at the match, `gh` dies of SIGPIPE, and `pipefail` reports 141 as "no match".
filler="$(head -c 4000 < /dev/zero | tr '\0' 'x')"
{
  printf '[{"number":1982,"body":"<!-- dependabot-pr:100 -->"}'
  for _ in $(seq 1 40); do
    printf ',{"number":9999,"body":"%s"}' "$filler"
  done
  printf ']'
} > "$STUB_JSON"
bytes="$(wc -c < "$STUB_JSON" | tr -d ' ')"
if [[ "$bytes" -gt 65536 ]]; then
  ok "case 1 fixture exceeds a 64 KiB pipe buffer ($bytes bytes)"
else
  bad "case 1 fixture is only $bytes bytes — it cannot reproduce the SIGPIPE loss"
fi
rc=0; out="$(run 100)" || rc=$?
check    "case 1: a match past the pipe buffer is still a match" "0" "$rc"
contains "case 1: names the matching issue" "1982" "$out"

# --- case 2: a small list still matches ------------------------------------
printf '[{"number":1982,"body":"<!-- dependabot-pr:100 -->"}]' > "$STUB_JSON"
rc=0; out="$(run 100)" || rc=$?
check "case 2: a small list matches" "0" "$rc"
check "case 2: prints the issue number" "1982" "$out"

# --- case 3: no marker anywhere --------------------------------------------
printf '[{"number":1982,"body":"nothing to see"}]' > "$STUB_JSON"
rc=0; out="$(run 100)" || rc=$?
check "case 3: no marker exits 1" "1" "$rc"
check "case 3: prints nothing" "" "$out"

# --- case 4: a gh failure is NOT 'no match' --------------------------------
printf '[]' > "$STUB_JSON"
rc=0
err="$(LIST_EC=1 run 100 2>&1 >/dev/null)" || rc=$?
check    "case 4: a gh failure exits 2, not 1" "2" "$rc"
contains "case 4: reproduces gh's verbatim stderr" "$GH_ERR" "$err"

# --- case 5: the empty list is a real answer, not a failure ----------------
printf '[]' > "$STUB_JSON"
rc=0; run 100 >/dev/null || rc=$?
check "case 5: an empty backlog exits 1" "1" "$rc"

# --- case 6: a near-miss marker must not match -----------------------------
# `<!-- dependabot-pr:1002 -->` contains `<!-- dependabot-pr:100` as a prefix, so
# a match on anything less than the whole marker inherits another bump's issue.
printf '[{"number":1002,"body":"<!-- dependabot-pr:1002 -->"}]' > "$STUB_JSON"
rc=0; run 100 >/dev/null || rc=$?
check "case 6: PR #1002's marker does not answer for PR #100" "1" "$rc"

# --- case 7: usage errors exit 2, never 1 ----------------------------------
rc=0; PATH="$BIN:$PATH" bash "$SCRIPT" not-a-number --repo "$REPO" >/dev/null 2>&1 || rc=$?
check "case 7: a non-numeric PR exits 2" "2" "$rc"
rc=0; PATH="$BIN:$PATH" bash "$SCRIPT" --repo "$REPO" >/dev/null 2>&1 || rc=$?
check "case 7: a missing PR number exits 2" "2" "$rc"

# --- case 8: cross-file coupling on the marker shape -----------------------
# The marker exists in three places now — the bridge writes it, pr-ready.sh reads
# it, and this script reads it. A silent drift restores the duplicate-filing this
# script exists to stop, with nothing anywhere to report it.
MARKER_PREFIX='<!-- dependabot-pr:'
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
for peer in ".github/workflows/dependabot-to-ralph-issue.yml" "scripts/ralph/pr-ready.sh"; do
  if grep -qF "$MARKER_PREFIX" "$ROOT/$peer"; then
    ok "case 8: $peer still uses the same marker shape"
  else
    bad "case 8: $peer no longer carries $MARKER_PREFIX — the dedup link has drifted"
  fi
done
if grep -qF "$MARKER_PREFIX" "$SCRIPT"; then
  ok "case 8: bridge-issue-exists.sh still uses that marker shape"
else
  bad "case 8: bridge-issue-exists.sh no longer carries $MARKER_PREFIX"
fi

# --- case 9: the bridge workflow actually calls this script ----------------
# Extracting the check is only a fix if the workflow stops running the old
# pipeline. Assert both halves.
BRIDGE="$ROOT/.github/workflows/dependabot-to-ralph-issue.yml"
if grep -qF "bridge-issue-exists.sh" "$BRIDGE"; then
  ok "case 9: the bridge invokes bridge-issue-exists.sh"
else
  bad "case 9: the bridge does not invoke bridge-issue-exists.sh"
fi
if grep -qE 'jq .\.\[\]\.body.\s*2>/dev/null\s*\|\s*grep' "$BRIDGE"; then
  bad "case 9: the bridge still pipes gh into grep -q — the SIGPIPE loss is back"
else
  ok "case 9: the bridge no longer pipes gh into an early-exiting reader"
fi

# --- case 10: one PR's bridge failure must not abort the whole batch -------
# bridge_pr returns non-zero when a dedup lookup is UNKNOWN -- the outcome this
# script's three-way exit code exists to express. The reconciler loop runs under
# `set -euo pipefail`, so calling it bare means the first transport blip ends the
# run and every later Dependabot PR is silently skipped. That is strictly worse
# than the SIGPIPE bug it replaced: that one mis-answered one PR, this one drops
# the rest of the batch. The event-driven single-PR path is deliberately NOT
# guarded -- failing loud and immediate is correct when there is only one PR.
if grep -qE '^[[:space:]]*bridge_pr "\$num" "\$ttl"[[:space:]]*$' "$BRIDGE"; then
  bad "case 10: the reconciler calls bridge_pr unguarded -- set -e ends the batch on one PR's transport failure"
else
  ok "case 10: the reconciler guards bridge_pr so one PR's failure does not skip the rest"
fi
if grep -qE 'bridge_pr "\$num" "\$ttl" \|\| bridge_ec=' "$BRIDGE" \
   && grep -qF 'reconcile_failures+=("bridge_pr exited' "$BRIDGE"; then
  ok "case 10: the failure is recorded into reconcile_failures, so the run still fails at the end"
else
  bad "case 10: a guarded bridge_pr that records nothing would swallow the failure instead"
fi

echo "bridge-issue-exists tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
