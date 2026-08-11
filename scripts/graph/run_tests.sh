#!/usr/bin/env bash
# scripts/graph/run_tests.sh
#
# Runs every scripts/graph/test_*.sh suite and fails if any of them fail.
#
# This exists so the gate cannot drift from the suites it gates. graph-tests.yml
# used to name suites by hand and had fallen six behind: six suites were
# invoked by nothing, so they passed locally and no one would have found out
# when they stopped. Globbing the directory means a suite is gated the moment
# it lands.
#
# Every suite is invoked through `bash`, matching the `Run:` header each of
# them documents. Their recorded git modes are mixed (0644 and 0755), so
# executing them directly would exit 126 on some -- unlike scripts/ralph/,
# where direct invocation is documented and the mode is itself guarded.
#
# Usage:  bash scripts/graph/run_tests.sh [directory]
#
# `directory` defaults to this script's own; it exists so the suite guarding
# this runner can point it at fixtures.
#
# Note: deliberately no `set -e`. A failing suite must not stop the run, or one
# broken suite would mask every suite after it and the next push would surface
# a failure that was present all along.
set -uo pipefail

DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"

if [[ ! -d "$DIR" ]]; then
  printf 'run_tests: no such directory: %s\n' "$DIR" >&2
  exit 1
fi

# while-read instead of mapfile so macOS system bash 3.2 can run this too.
suites=()
while IFS= read -r suite; do suites+=("$suite"); done \
  < <(find "$DIR" -maxdepth 1 -name 'test_*.sh' | sort)

# A run that executed nothing is not a pass. If the glob ever breaks, this is
# what turns a silent green into a visible failure.
if [[ "${#suites[@]}" -eq 0 ]]; then
  printf 'run_tests: no test_*.sh suites found in %s\n' "$DIR" >&2
  exit 1
fi

failed=()
for suite in "${suites[@]}"; do
  name="$(basename "$suite")"
  printf '\n=== %s ===\n' "$name"
  if bash "$suite"; then
    printf -- '--- %s: PASS\n' "$name"
  else
    printf -- '--- %s: FAIL (exit %s)\n' "$name" "$?"
    failed+=("$name")
  fi
done

printf '\n=== summary: %s suite(s), %s failed ===\n' "${#suites[@]}" "${#failed[@]}"
if [[ "${#failed[@]}" -gt 0 ]]; then
  for name in "${failed[@]}"; do printf 'FAILED: %s\n' "$name"; done
  exit 1
fi
