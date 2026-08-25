#!/usr/bin/env bash
# scripts/graph/test_run_with_optional_env.sh
#
# Tests for run_with_optional_env.sh — the wrapper that stops GitHub Actions'
# "an unset repo variable is an empty string" rule from reaching an SDK as a
# real, empty configuration value.
#
# THE BUG THIS PINS: graph-semantic.yml passed `ANTHROPIC_BASE_URL:
# ${{ vars.ANTHROPIC_BASE_URL }}` into the extraction step and commented that
# "empty is fine". It is not. The variable was never set, so the step ran with
# ANTHROPIC_BASE_URL="", and the Anthropic Python SDK only falls back to
# https://api.anthropic.com when the variable is ABSENT — an empty string is a
# value, so every request went to a relative URL and every one of the fourteen
# chunks failed with the same `Connection error.` for over a month.
#
# The preflight in the same job passed throughout, because shell's `${VAR:-x}`
# treats empty and unset alike. That divergence is the whole defect: two
# consumers of one variable disagreed about what empty means, and the one that
# was checked was not the one that mattered.
#
# Run:  bash scripts/graph/test_run_with_optional_env.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$HERE/run_with_optional_env.sh"
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

# The probe prints one line per name: "NAME=<value>" when the variable is set,
# "NAME:unset" when it is not. That distinction is the entire point of the
# wrapper, and an assertion on the value alone could not see it.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PROBE="$WORK/probe.sh"
cat > "$PROBE" <<'PROBESCRIPT'
#!/usr/bin/env bash
for name in "$@"; do
  if [[ -n "${!name+set}" ]]; then printf '%s=%s\n' "$name" "${!name}"
  else printf '%s:unset\n' "$name"; fi
done
PROBESCRIPT
chmod +x "$PROBE"

# --- an empty variable is removed, not forwarded ------------------------------
out="$(ANTHROPIC_BASE_URL="" bash "$RUNNER" ANTHROPIC_BASE_URL -- \
  bash "$PROBE" ANTHROPIC_BASE_URL 2>&1)"
check "empty var is unset for the child" "ANTHROPIC_BASE_URL:unset" "$out"

# --- a set variable is passed through untouched -------------------------------
out="$(ANTHROPIC_BASE_URL="https://proxy.example.com" bash "$RUNNER" ANTHROPIC_BASE_URL -- \
  bash "$PROBE" ANTHROPIC_BASE_URL 2>&1)"
check "non-empty var reaches the child unchanged" \
  "ANTHROPIC_BASE_URL=https://proxy.example.com" "$out"

# --- whitespace is not a configuration value ----------------------------------
# A repo variable saved with a stray space is the same defect wearing a
# disguise: the SDK would take "  " as a base URL just as readily as "".
out="$(ANTHROPIC_BASE_URL="   " bash "$RUNNER" ANTHROPIC_BASE_URL -- \
  bash "$PROBE" ANTHROPIC_BASE_URL 2>&1)"
check "whitespace-only var is unset for the child" "ANTHROPIC_BASE_URL:unset" "$out"

# --- several names at once, mixed ---------------------------------------------
out="$(ANTHROPIC_BASE_URL="" ANTHROPIC_MODEL="a-model" bash "$RUNNER" \
  ANTHROPIC_BASE_URL ANTHROPIC_MODEL -- bash "$PROBE" ANTHROPIC_BASE_URL ANTHROPIC_MODEL 2>&1)"
contains "empty one of a pair is unset" "ANTHROPIC_BASE_URL:unset" "$out"
contains "set one of a pair survives" "ANTHROPIC_MODEL=a-model" "$out"

# --- an absent variable stays absent (no accidental export) -------------------
out="$(env -u ANTHROPIC_BASE_URL bash "$RUNNER" ANTHROPIC_BASE_URL -- \
  bash "$PROBE" ANTHROPIC_BASE_URL 2>&1)"
check "already-unset var is not resurrected" "ANTHROPIC_BASE_URL:unset" "$out"

# --- the child's exit status is the wrapper's exit status ---------------------
# A wrapper that swallowed a non-zero exit would turn every future failure of
# the wrapped command into a silent green, which is the class of bug this
# whole file exists to stop.
bash "$RUNNER" ANTHROPIC_BASE_URL -- bash -c 'exit 7' >/dev/null 2>&1
check "child exit code propagates" "7" "$?"

bash "$RUNNER" ANTHROPIC_BASE_URL -- bash -c 'exit 0' >/dev/null 2>&1
check "success exit code propagates" "0" "$?"

# --- arguments reach the child intact, including spaces -----------------------
out="$(bash "$RUNNER" ANTHROPIC_BASE_URL -- bash -c 'printf "[%s]" "$@"' _ \
  'one two' 'three' 2>&1)"
check "argv is not re-split on spaces" "[one two][three]" "$out"

# --- usage errors are refusals, not silent no-ops -----------------------------
out="$(bash "$RUNNER" ANTHROPIC_BASE_URL 2>&1)"; ec=$?
check "missing -- separator exits non-zero" "1" "$ec"
contains "missing -- separator explains itself" "--" "$out"

out="$(bash "$RUNNER" ANTHROPIC_BASE_URL -- 2>&1)"; ec=$?
check "empty command exits non-zero" "1" "$ec"

# --- the workflow actually uses it --------------------------------------------
# The wrapper being correct buys nothing if graph-semantic.yml stops calling it.
# This is the assertion that would have failed on the broken workflow: every
# step that both takes ANTHROPIC_BASE_URL from a repo variable AND invokes
# graphify must route the invocation through the wrapper.
WF="$HERE/../../.github/workflows/graph-semantic.yml"
if [[ ! -f "$WF" ]]; then
  bad "graph-semantic.yml is readable from the test"
else
  # Count graphify invocations that pass through the wrapper against the total
  # number of steps that hand the SDK an optional repo variable.
  wrapped="$(grep -c 'run_with_optional_env\.sh ANTHROPIC_MODEL ANTHROPIC_BASE_URL --' "$WF" || true)"
  passthrough="$(grep -c 'ANTHROPIC_BASE_URL: \${{ vars\.ANTHROPIC_BASE_URL }}' "$WF" || true)"
  # The preflight step also takes the variable but is a shell reader, and shell
  # cannot tell empty from unset — it is correct as it stands and is the one
  # allowed passthrough, hence wrapped == passthrough - 1.
  check "every SDK step routes through the wrapper" "$((passthrough - 1))" "$wrapped"
  if [[ "$wrapped" -lt 1 ]]; then
    bad "graph-semantic.yml invokes the wrapper at least once"
  else
    ok "graph-semantic.yml invokes the wrapper"
  fi
  # A bare `graphify extract`/`label` with no wrapper in front is the exact
  # regression; catch it by line rather than by count.
  # A `graphify extract|label` whose preceding line does not hand off to the
  # wrapper is unwrapped. Matching the command line alone would also flag the
  # wrapper's own continuation line, which is the wired case, not the bug.
  bare="$(awk '
    /^[[:space:]]*graphify (extract|label) / && prev !~ /run_with_optional_env\.sh/ {
      printf "%d:%s;", NR, $0
    }
    { prev = $0 }
  ' "$WF")"
  if [[ -n "$bare" ]]; then
    bad "no unwrapped graphify invocation remains (found: ${bare//$'\n'/; })"
  else
    ok "no unwrapped graphify invocation remains"
  fi
fi

printf '\n%s: %d passed, %d failed\n' "$(basename "$0")" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
