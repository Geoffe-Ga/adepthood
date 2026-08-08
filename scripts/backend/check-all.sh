#!/usr/bin/env bash
# scripts/check-all.sh - Run all quality checks
# Usage: ./scripts/check-all.sh [--verbose] [--force] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../backend" && pwd)"

readonly GATE_NAME="backend"
readonly VERIFIED_SCRIPT="$SCRIPT_DIR/../quality/verified.sh"
# The one exit code from the receipt primitive that licenses reusing a verdict.
# "Not verified" and "cannot evaluate" both mean: do the work.
readonly RECEIPT_HIT_EXIT_CODE=0

# Checks a receipt may never excuse, named rather than positional so the
# asymmetry survives a reordering of the stages.
#
# Lint, format, mypy, complexity, the suite and the coverage report are a pure
# function of the fingerprinted inputs, so re-deriving them from a byte-identical
# tree buys nothing. The security stage is not: security.sh runs pip-audit
# against the PyPI advisory database over the network, so an advisory published
# after the receipt was written makes yesterday's green false today, and no
# content hash of this tree can see that. A network-dated check is never
# cacheable. The dependency-drift preflight below is exempt for the mirror-image
# reason - it measures the installed packages, which are not part of the tree
# at all.
ALWAYS_RUN_CHECKS=("Security checks")

VERBOSE=false
FORCE=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose)
            VERBOSE=true
            shift
            ;;
        --force)
            FORCE=true
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

When a gate receipt proves the previous green run still describes this tree,
steps 1-3 and 5-7 are reused instead of re-run. Step 0 and step 4 always run:
they measure the installed packages and a network advisory database, neither
of which is part of the tree being fingerprinted.

OPTIONS:
    --verbose   Show detailed output
    --force     Re-derive every check from scratch, ignoring any receipt
    --help      Display this help message

EXIT CODES:
    0           All checks passed
    1           One or more checks failed
    2           Error running checks

EXAMPLES:
    $(basename "$0")          # Run all checks
    $(basename "$0") --verbose # Show detailed output
    $(basename "$0") --force   # Ignore the receipt and prove the tree again
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

# Consult the gate receipt. Only a hit may license reuse: a miss and an
# unevaluable gate both fall through to the full run, and neither turns an
# otherwise-green run red, because an unusable cache is not a quality finding.
SHORT_CIRCUIT=false
RECEIPT_DETAIL=""
if ! $FORCE; then
    RECEIPT_STATUS=0
    RECEIPT_DETAIL="$("$VERIFIED_SCRIPT" check "$GATE_NAME" 2> /dev/null)" || RECEIPT_STATUS=$?
    if [ "$RECEIPT_STATUS" -eq "$RECEIPT_HIT_EXIT_CODE" ]; then
        SHORT_CIRCUIT=true
    fi
fi

if $SHORT_CIRCUIT; then
    echo "Reusing the verified verdict for the $GATE_NAME gate ($RECEIPT_DETAIL)."
    echo "Nothing this gate measures has changed since that run."
    echo "The security checks still run: pip-audit consults an advisory database"
    echo "that changes without this tree changing, so it is never reused."
    echo ""
fi

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

# The fingerprint the checks below are about to be run against. Captured before
# the first check and compared against the tree's fingerprint at the end, so a
# file edited while the gate was in flight cannot bank a verdict for a tree that
# was never checked as a whole. Empty means the gate could not be fingerprinted
# at all, which withholds the receipt rather than failing the run.
START_FINGERPRINT=""
if ! $SHORT_CIRCUIT; then
    START_FINGERPRINT="$("$VERIFIED_SCRIPT" fingerprint "$GATE_NAME" 2> /dev/null)" || true
fi

FAILED_CHECKS=()
PASSED_CHECKS=()
SKIPPED_CHECKS=()

# Whether a receipt may excuse this check. See ALWAYS_RUN_CHECKS above for why
# the answer is no for anything measuring the network or the environment.
is_always_run() {
    local candidate=$1
    local always_run
    for always_run in "${ALWAYS_RUN_CHECKS[@]}"; do
        if [ "$candidate" = "$always_run" ]; then
            return 0
        fi
    done
    return 1
}

# Helper function to run a check
#
# The receipt short-circuit lives here rather than at the call sites: the seven
# `run_check "<Name>" ...` lines are parsed as text by other suites to discover
# the stage names and flags, so conditioning or reordering them would break
# those suites from a distance.
run_check() {
    local check_name=$1
    local script=$2
    shift 2
    local args=("$@")

    if $SHORT_CIRCUIT && ! is_always_run "$check_name"; then
        SKIPPED_CHECKS+=("$check_name")
        return 0
    fi

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
# described this run. A short-circuited run writes no new data, so it must not
# delete the artifacts produced by the verified run it is standing on.
if ! $SHORT_CIRCUIT; then
    rm -f .coverage .coverage.* coverage.xml
fi

run_check "Unit tests" "test.sh" --unit --coverage-data
run_check "Coverage report" "coverage.sh" --report-only --xml

# Bank the verdict only when this run actually earned it: a full run, every
# check green, and a tree that did not move underneath it. A run that measured
# the old bytes in some stages and the new bytes in others proved nothing about
# either tree, so it stays green and says why it recorded nothing.
record_receipt_if_earned() {
    if $SHORT_CIRCUIT || [ ${#FAILED_CHECKS[@]} -gt 0 ]; then
        return 0
    fi
    if [ -z "$START_FINGERPRINT" ]; then
        return 0
    fi
    local end_fingerprint=""
    end_fingerprint="$("$VERIFIED_SCRIPT" fingerprint "$GATE_NAME" 2> /dev/null)" || true
    if [ "$end_fingerprint" != "$START_FINGERPRINT" ]; then
        echo ""
        echo "No receipt recorded: the tree changed during the run, so these results"
        echo "describe a mixture of two trees rather than the one on disk now."
        return 0
    fi
    "$VERIFIED_SCRIPT" record "$GATE_NAME" > /dev/null 2>&1 || true
}

record_receipt_if_earned

echo "=== Quality Checks Summary ==="
echo "Passed: ${#PASSED_CHECKS[@]}"
echo "Failed: ${#FAILED_CHECKS[@]}"
if [ ${#SKIPPED_CHECKS[@]} -gt 0 ]; then
    echo "Reused from the receipt (not re-run): ${SKIPPED_CHECKS[*]}"
fi

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
