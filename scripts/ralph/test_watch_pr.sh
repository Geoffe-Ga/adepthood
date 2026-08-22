#!/usr/bin/env bash
# scripts/ralph/test_watch_pr.sh
#
# Offline tests for watch-pr.sh — the per-lane hot watcher local (webhook-less)
# Ralph sessions arm as a background task so a lane's state-change becomes a
# wake instead of waiting out the 1200–1800s ScheduleWakeup fallback. The
# watcher is copied into a temp dir next to a sequence-driven fake pr-ready.sh
# (so its dirname-relative lookup resolves to the stub), with fake `gh`/`git`
# on PATH; the fake `git` yields a per-run repo slug so pidfiles never collide
# with a real watcher on this machine.
#
# Pinned here: the already-watching pidfile short-circuit (blind re-launch
# every wake must be free), stale-pidfile takeover and cleanup, the
# pending/awaiting-review→terminal-token exit, the `gone` exit when pr-ready
# errors because the PR merged/closed, API-error tolerance (a burst of
# pr-ready failures must NOT kill the watch — a dead watcher is a silent
# latency regression), and the timeout exit. Every wait outcome exits 0.
#
# Run:  bash scripts/ralph/test_watch_pr.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/watch-pr.sh"
PASS=0
FAIL=0

ok() {
  PASS=$((PASS + 1))
  printf '  ok  - %s\n' "$1"
}
bad() {
  FAIL=$((FAIL + 1))
  printf 'FAIL  - %s\n' "$1"
}
check() { # check <desc> <expected> <actual>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (expected '$2', got '$3')"; fi
}

# Per-run slug keeps these pidfiles apart from any real watcher's (and from a
# concurrent test run's).
SLUG="wptest-$$"
export WATCH_SLUG="$SLUG"

WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  rm -f "/tmp/ralph-watch-${SLUG}-"*.pid
}
trap cleanup EXIT

BIN="$WORK/bin"
mkdir -p "$BIN"

# The watcher resolves pr-ready.sh relative to its own dirname, so copying it
# next to the stub is what routes its polls to the fake.
WATCH="$WORK/watch-pr.sh"
cp "$SRC" "$WATCH"
chmod +x "$WATCH"

# Sequence-driven fake pr-ready.sh: call N prints line N of $SEQ_FILE (the last
# line repeats once the sequence is exhausted); the literal line `err` exits 2
# with no token, exactly like a real tooling error.
cat >"$WORK/pr-ready.sh" <<'STUB'
#!/usr/bin/env bash
n=$(($(cat "${COUNT_FILE:?}" 2>/dev/null || echo 0) + 1))
echo "$n" >"$COUNT_FILE"
mapfile -t lines <"${SEQ_FILE:?}"
idx=$((n - 1))
((idx >= ${#lines[@]})) && idx=$((${#lines[@]} - 1))
line="${lines[$idx]}"
[[ "$line" == "err" ]] && exit 2
printf '%s\n' "$line"
STUB
chmod +x "$WORK/pr-ready.sh"

# Fake gh: only the `pr view --json state` probe the watcher makes on a
# pr-ready error. Real gh applies --jq, so the stub emits the extracted scalar.
cat >"$BIN/gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *"pr view"*"--json state"*)
    printf '%s\n' "${PR_STATE:-OPEN}"
    exit "${PR_STATE_EC:-0}" ;;
  *) echo '' ;;
esac
STUB
chmod +x "$BIN/gh"

# Fake git: pins the pidfile slug via the origin URL's basename.
cat >"$BIN/git" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "remote get-url origin") printf 'https://github.com/example/%s.git\n' "${WATCH_SLUG:?}" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$BIN/git"

run_watch() { # run_watch <case-slug> <seq lines...> then WATCH args via RW_ARGS
  local case_slug="$1"
  shift
  SEQ_FILE="$WORK/seq-$case_slug"
  COUNT_FILE="$WORK/count-$case_slug"
  printf '%s\n' "$@" >"$SEQ_FILE"
  rm -f "$COUNT_FILE"
  export SEQ_FILE COUNT_FILE
}

watch() { PATH="$BIN:$PATH" "$WATCH" "$@" 2>/dev/null; }

# --- usage: a non-numeric or missing PR exits 2 ------------------------------
rc=0
PATH="$BIN:$PATH" "$WATCH" >/dev/null 2>&1 || rc=$?
check "missing PR number exits 2" "2" "$rc"

rc=0
PATH="$BIN:$PATH" "$WATCH" abc >/dev/null 2>&1 || rc=$?
check "non-numeric PR number exits 2" "2" "$rc"

rc=0
PATH="$BIN:$PATH" "$WATCH" 100 0 >/dev/null 2>&1 || rc=$?
check "zero interval exits 2" "2" "$rc"

# --- in-flight tokens keep the watch alive; the first terminal token exits ---
# pending and awaiting-review are the ONLY in-flight tokens; ready must end the
# watch and be printed for the woken orchestrator to read.
run_watch flight pending awaiting-review ready
rc=0
out="$(watch 102 1 30)" || rc=$?
check "pending → awaiting-review → ready exits with the token" "WATCH 102 ready" "$out"
check "a completed watch exits 0" "0" "$rc"
check "watcher polled exactly three times" "3" "$(cat "$COUNT_FILE")"

# Any non-in-flight token is terminal — behind pins the "anything else" rule.
run_watch behind pending behind
check "behind is a terminal token" "WATCH 103 behind" "$(watch 103 1 30)"

# changes-requested — a fresh non-LGTM verdict (upstream Creek-Vault#1097) —
# must END the watch promptly: Gate 4 has already spoken and the orchestrator
# owes the lane an address-feedback worker, so sleeping out the timeout on it
# is the exact latency the watcher exists to remove. The fix lives entirely in
# pr-ready.sh's vocabulary: the token falls outside IN_FLIGHT_TOKENS, and adding
# it there would silence this wake again — which is what the assertion below
# pins, rather than the exact membership of the set (that has grown once since,
# for `transport-error`, and pinning the literal line made a correct addition
# look like a regression).
run_watch changes pending awaiting-review changes-requested
rc=0
out="$(watch 112 1 30)" || rc=$?
check "a fresh non-LGTM verdict ends the watch with its token" "WATCH 112 changes-requested" "$out"
check "a changes-requested watch exits 0" "0" "$rc"
check "watcher stopped polling the moment the verdict token arrived" "3" "$(cat "$COUNT_FILE")"
check "changes-requested is still OUTSIDE the in-flight set" "" \
  "$(grep -o 'IN_FLIGHT_TOKENS=(.*changes-requested.*)' "$SRC" || true)"

# --- a transport error is not a state of the PR ------------------------------
# `transport-error` means pr-ready.sh could not reach GitHub, so the lane is
# still in whatever state it was in and there is nothing for a woken
# orchestrator to act on. Ending the watch on it would convert a momentary
# network blip into the full 1200–1800s fallback latency this script exists to
# remove — the same failure as a watcher that died on an API error, which the
# error path below already refuses to do.
run_watch transport pending transport-error ready
rc=0
out="$(watch 113 1 30)" || rc=$?
check "a transport error does NOT end the watch" "WATCH 113 ready" "$out"
check "a watch that rode out a transport error exits 0" "0" "$rc"
check "the watcher kept polling through the transport error" "3" "$(cat "$COUNT_FILE")"

# --- pidfile idempotence: blind re-launch every wake must be free ------------
sleep 60 &
HOLDER=$!
echo "$HOLDER" >"/tmp/ralph-watch-${SLUG}-104.pid"
run_watch already ready
rc=0
out="$(watch 104 1 30)" || rc=$?
kill "$HOLDER" 2>/dev/null || true
check "a live pidfile short-circuits" "WATCH 104 already-watching" "$out"
check "already-watching exits 0" "0" "$rc"
check "already-watching never polls pr-ready" "no" "$([[ -f "$COUNT_FILE" ]] && echo yes || echo no)"

# A stale pidfile (dead pid) is taken over, not honoured forever.
sleep 0.1 &
DEAD=$!
wait "$DEAD" 2>/dev/null || true
echo "$DEAD" >"/tmp/ralph-watch-${SLUG}-105.pid"
run_watch stale ready
check "a stale pidfile is taken over" "WATCH 105 ready" "$(watch 105 1 30)"
check "the pidfile is removed on exit" "no" "$([[ -f "/tmp/ralph-watch-${SLUG}-105.pid" ]] && echo yes || echo no)"

# --- gone: a merged/closed PR ends the watch even though pr-ready errors -----
run_watch gone err
export PR_STATE="MERGED"
check "pr-ready error + MERGED PR → gone" "WATCH 106 gone" "$(watch 106 1 30)"
export PR_STATE="CLOSED"
run_watch gone2 err
check "pr-ready error + CLOSED PR → gone" "WATCH 107 gone" "$(watch 107 1 30)"
unset PR_STATE

# --- API-error tolerance: a burst of failures must never kill the watch ------
# Four consecutive errors exceed the quiet threshold (3); with the PR still
# OPEN the watcher keeps looping and still delivers the eventual token.
run_watch burst err err err err ready
rc=0
out="$(watch 108 1 60)" || rc=$?
check "four consecutive pr-ready errors do not kill the watch" "WATCH 108 ready" "$out"
check "the error-burst watch exits 0" "0" "$rc"

# Even an unreachable state probe (gh also failing) keeps the watch alive.
run_watch ghdown err ready
export PR_STATE_EC=1
check "gh state probe failure keeps the watch alive" "WATCH 109 ready" "$(watch 109 1 60)"
unset PR_STATE_EC

# --- timeout: still-in-flight at the deadline reports the last token ---------
run_watch timeout pending
rc=0
out="$(watch 110 1 2)" || rc=$?
check "timeout reports the last in-flight token" "WATCH 110 timeout pending" "$out"
check "a timed-out watch exits 0" "0" "$rc"

# A timeout before any successful poll still names a token ("unknown").
run_watch timeout2 err
rc=0
out="$(watch 111 1 2)" || rc=$?
check "timeout with no classification reports unknown" "WATCH 111 timeout unknown" "$out"
check "that watch also exits 0" "0" "$rc"

# --- summary -----------------------------------------------------------------
echo
echo "watch-pr tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
