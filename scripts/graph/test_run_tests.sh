#!/usr/bin/env bash
# scripts/graph/test_run_tests.sh
#
# Guard for the gate that runs every other guard.
#
# Six of the eight scripts/graph/test_*.sh suites were invoked by nothing:
# graph-tests.yml named two of them by hand, so the other six existed, passed
# locally, and nothing ever found out when they stopped. The fix is a runner
# that globs the directory, so a suite is gated the moment it lands rather than
# when someone remembers to edit a workflow.
#
# The assertions below are behavioural on purpose. Grepping the workflow for a
# glob would prove the text says "*.sh" and nothing about whether a new suite
# actually runs, whether a failure is reported, or whether an empty directory
# reads as success -- and a guard that matches prose instead of behaviour is
# the exact defect this repo keeps re-finding. So the runner is pointed at
# fixture directories and its real exit code and output are checked.
#
# Run:  bash scripts/graph/test_run_tests.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER="$ROOT/scripts/graph/run_tests.sh"
WORKFLOW="$ROOT/.github/workflows/graph-tests.yml"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok  - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  - %s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# make_suite <dir> <name> <exit-code> [mode]
# Writes a fake suite that announces itself, so output assertions can prove it
# was actually executed rather than merely listed.
make_suite() {
  local dir="$1" name="$2" code="$3" mode="${4:-0755}"
  mkdir -p "$dir"
  printf '#!/usr/bin/env bash\necho "ran %s"\nexit %s\n' "$name" "$code" >"$dir/$name"
  chmod "$mode" "$dir/$name"
}

if [[ ! -f "$RUNNER" ]]; then
  bad "scripts/graph/run_tests.sh exists"
  printf '\nrun_tests tests: %s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi
ok "scripts/graph/run_tests.sh exists"

# --- a directory of passing suites succeeds, and runs all of them -------------
green="$TMP/green"
make_suite "$green" "test_alpha.sh" 0
make_suite "$green" "test_beta.sh" 0
if out="$(bash "$RUNNER" "$green" 2>&1)"; then
  ok "a directory of passing suites exits 0"
else
  bad "a directory of passing suites exits 0 (got rc=$?)"
fi
grep -q "ran test_alpha.sh" <<<"$out" && ok "runs the first suite" \
  || bad "runs the first suite (output: $out)"
grep -q "ran test_beta.sh" <<<"$out" && ok "runs the second suite" \
  || bad "runs the second suite (output: $out)"

# --- a new suite is picked up with no edit anywhere ---------------------------
# The acceptance criterion "adding a new test_*.sh requires no workflow edit"
# is exactly this: drop one in and it runs.
make_suite "$green" "test_newly_added.sh" 0
out="$(bash "$RUNNER" "$green" 2>&1 || true)"
grep -q "ran test_newly_added.sh" <<<"$out" \
  && ok "a newly added suite is gated without editing anything" \
  || bad "a newly added suite is gated without editing anything (output: $out)"

# --- a failure fails the run, but does not hide its siblings ------------------
# Fail-fast here would report one broken suite and leave the rest unknown, so
# the next push would surface a second failure that was present all along.
mixed="$TMP/mixed"
make_suite "$mixed" "test_first_ok.sh" 0
make_suite "$mixed" "test_broken.sh" 1
make_suite "$mixed" "test_last_ok.sh" 0
set +e
out="$(bash "$RUNNER" "$mixed" 2>&1)"
rc=$?
set -e
[[ "$rc" -ne 0 ]] && ok "a failing suite fails the run" \
  || bad "a failing suite fails the run (got rc=0)"
grep -q "ran test_last_ok.sh" <<<"$out" \
  && ok "suites after a failure still run (no fail-fast)" \
  || bad "suites after a failure still run (output: $out)"
grep -q "test_broken.sh" <<<"$out" \
  && ok "the failing suite is named in the output" \
  || bad "the failing suite is named in the output (output: $out)"

# --- exec bits are irrelevant -------------------------------------------------
# These suites are recorded in git with mixed modes (0644 and 0755) and every
# one documents `bash scripts/graph/<name>.sh` in its header, so the runner
# must invoke through bash. Executing directly would exit 126 on the 0644 ones
# -- which is two of the eight today.
nonexec="$TMP/nonexec"
make_suite "$nonexec" "test_not_executable.sh" 0 0644
if out="$(bash "$RUNNER" "$nonexec" 2>&1)"; then
  ok "a non-executable suite still runs (invoked via bash, not directly)"
else
  bad "a non-executable suite still runs (got rc=$?, output: $out)"
fi

# --- an empty directory must not read as success ------------------------------
# A gate that passes when it ran nothing is worse than no gate: it reports
# green while covering zero suites. If the glob ever breaks, this is the only
# assertion that notices.
empty="$TMP/empty"
mkdir -p "$empty"
set +e
bash "$RUNNER" "$empty" >/dev/null 2>&1
rc=$?
set -e
[[ "$rc" -ne 0 ]] && ok "an empty directory fails rather than passing vacuously" \
  || bad "an empty directory fails rather than passing vacuously (got rc=0)"

# --- the workflow delegates to the runner ------------------------------------
if [[ ! -f "$WORKFLOW" ]]; then
  bad "graph-tests.yml exists"
else
  grep -q "scripts/graph/run_tests.sh" "$WORKFLOW" \
    && ok "graph-tests.yml invokes the runner" \
    || bad "graph-tests.yml invokes the runner"
  # Hand-enumerated suites are what drifted in the first place.
  if grep -qE '^[[:space:]]+bash scripts/graph/test_[a-z_]+\.sh' "$WORKFLOW"; then
    bad "graph-tests.yml still names individual suites by hand"
  else
    ok "graph-tests.yml names no individual suite by hand"
  fi
fi

# --- the workflow triggers on what the suites actually read -------------------
# A gate only fires on paths its filter names. These suites assert over files
# well outside scripts/graph/, and none of them was in the filter -- so editing
# a scanned prompt or an agent instruction could not trigger this workflow at
# all. The gate existed; the event never reached it.
#
# Each entry below is a file some suite reads:
#   prompts/scans/**       test_scan_graph_preamble.sh (every scan prompt)
#   .claude/**             the graph SKILL, agent instructions, hooks, settings
#   scripts/ralph/PROMPT.md, .github/workflows/weekly-playbook.yml
#                          test_memory_loop.sh groups 5 and 6
#   .github/workflows/graph-semantic.yml
#                          test_anthropic_preflight.sh and
#                          test_report_workflow_failure.sh, which pin that the
#                          workflow actually INVOKES the preflight and calls the
#                          shared failure reporter. Both couplings are exactly
#                          the kind that fails silently: a diagnostic nothing
#                          calls is the same silent gap as the failures it exists
#                          to explain.
#   .github/workflows/_report-failure.yml
#                          the other end of that same chain, where the reporter
#                          is actually invoked now that all six scheduled
#                          workflows share one failure path. Breaking the call
#                          here silences every one of them at once, so it must be
#                          able to fire this workflow.
REQUIRED_PATHS=(
  "prompts/scans/**"
  ".claude/**"
  "scripts/ralph/PROMPT.md"
  ".github/workflows/weekly-playbook.yml"
  ".github/workflows/graph-semantic.yml"
  ".github/workflows/_report-failure.yml"
)
paths_under() { # paths_under <push|pull_request>
  awk -v key="  $1:" '
    $0 == key { found = 1; next }
    found && /^  [a-z_]+:/ { exit }
    found { print }
  ' "$WORKFLOW"
}
for trigger in push pull_request; do
  block="$(paths_under "$trigger")"
  for needed in "${REQUIRED_PATHS[@]}"; do
    grep -qF -- "$needed" <<<"$block" \
      && ok "$trigger triggers on $needed" \
      || bad "$trigger triggers on $needed (absent from the $trigger paths filter)"
  done
done

printf '\nrun_tests tests: %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
