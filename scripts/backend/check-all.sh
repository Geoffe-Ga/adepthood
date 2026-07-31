#!/usr/bin/env bash
# scripts/check-all.sh - Run all quality checks
# Usage: ./scripts/check-all.sh [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../backend" && pwd)"

VERBOSE=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Run all quality checks in sequence.

A dependency-drift preflight runs first and aborts the whole run when it
fails, because every check below measures the installed packages.

Runs:
  0. Dependency drift preflight (deps.sh) - aborts on failure
  1. Linting (Ruff)
  2. Formatting (ruff format)
  3. Type checking (MyPy)
  4. Security checks (Bandit + Safety)
  5. Complexity analysis (Radon)
  6. Unit tests (measured under coverage)
  7. Coverage report (reports on the data step 6 wrote; no second test run)

OPTIONS:
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           All checks passed
    1           One or more checks failed
    2           Error running checks

EXAMPLES:
    $(basename "$0")          # Run all checks
    $(basename "$0") --verbose # Show detailed output
EOF
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 2
            ;;
    esac
done

cd "$PROJECT_ROOT"

# Set verbosity
VERBOSE_FLAG=""
if $VERBOSE; then
    VERBOSE_FLAG="--verbose"
fi

echo "=== Running All Quality Checks ==="
echo ""

# Fail-fast preflight, not a collected run_check: every check below measures
# the *installed* packages, so a verdict produced from a drifted virtualenv
# does not predict CI. Carrying on would hand back seven meaningless results
# instead of the one that matters. The frontend suite sets the precedent by
# putting its audit gate first for the same reason.
#
# The exit code is captured with `||` rather than inside an `if ! ...` body,
# where `$?` would already have been reset to 0 by the negation.
DRIFT_EXIT=0
"$SCRIPT_DIR/deps.sh" $VERBOSE_FLAG || DRIFT_EXIT=$?
if [ "$DRIFT_EXIT" -ne 0 ]; then
    echo "" >&2
    echo "Aborting: the active environment does not match the pinned requirements." >&2
    echo "Every remaining check would measure packages CI never installs." >&2
    echo "Fix with: pip install -r backend/requirements.txt -r backend/requirements-dev.txt" >&2
    exit "$DRIFT_EXIT"
fi
echo ""

FAILED_CHECKS=()
PASSED_CHECKS=()

# Helper function to run a check
run_check() {
    local check_name=$1
    local script=$2
    shift 2
    local args=("$@")

    echo "Running: $check_name"
    if "$SCRIPT_DIR/$script" "${args[@]+"${args[@]}"}" $VERBOSE_FLAG; then
        PASSED_CHECKS+=("$check_name")
        echo "✓ $check_name passed"
    else
        FAILED_CHECKS+=("$check_name")
        echo "✗ $check_name failed" >&2
    fi
    echo ""
}

# Run all checks
run_check "Linting" "lint.sh" --check
run_check "Formatting" "format.sh" --check
run_check "Type checking" "typecheck.sh"
run_check "Security checks" "security.sh"
run_check "Complexity analysis" "complexity.sh"
# The coverage stage reports on whatever data is on disk, so the disk has to
# be cleared first: coverage.py appends parallel data files, and a leftover
# .coverage or coverage.xml would be reported - and handed to CI - as if it
# described this run.
rm -f .coverage .coverage.* coverage.xml

run_check "Unit tests" "test.sh" --unit
run_check "Coverage report" "coverage.sh" --report-only --xml

echo "=== Quality Checks Summary ==="
echo "Passed: ${#PASSED_CHECKS[@]}"
echo "Failed: ${#FAILED_CHECKS[@]}"

if [ ${#FAILED_CHECKS[@]} -gt 0 ]; then
    echo ""
    echo "Failed checks:"
    for check in "${FAILED_CHECKS[@]}"; do
        echo "  ✗ $check"
    done
    exit 1
else
    echo ""
    echo "✓ All quality checks passed!"
    exit 0
fi
