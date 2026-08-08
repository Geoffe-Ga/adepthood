#!/usr/bin/env bash
# scripts/test.sh - Run tests with Pytest
# Usage: ./scripts/test.sh [--unit|--integration|--e2e|--all] [--coverage]
#                          [--verbose] [--help] [PATH...]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../backend" && pwd)"
# The lock is keyed per tree root, derived from this script's own location and
# never from `git rev-parse`, which inside a linked worktree names a different
# tree. Per tree is the point: the parallel worktree lanes contend over nothing,
# so only an agent racing itself inside one lane is refused.
TREE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

readonly LOCK_DIR="$TREE_ROOT/.gate-state/locks"
readonly LOCK_FILE="$LOCK_DIR/backend-suite.lock"

readonly TEST_FAILURE_EXIT_CODE=1
readonly USAGE_EXIT_CODE=2
# Distinct from a test failure on purpose: "your tests failed" and "this result
# would not have been trustworthy" call for opposite responses.
readonly REFUSED_EXIT_CODE=3

TEST_TYPE="unit"
COVERAGE=false
COVERAGE_DATA=false
VERBOSE=false
TARGETS=()
LOCK_HELD=false

# Whole-suite runs are distributed across cores with pytest-xdist. Measured on
# a 4-core box: 15m58s serial -> 4m07s at -n auto, identical coverage (#2076).
# ``--dist loadfile`` keeps every test in a file on one worker, which is what
# the module-scoped async DB fixtures in backend/conftest.py assume.
# Overridable so a constrained runner can pin a smaller number.
PYTEST_WORKERS="${PYTEST_WORKERS:-auto}"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --unit)
            TEST_TYPE="unit"
            shift
            ;;
        --integration)
            TEST_TYPE="integration"
            shift
            ;;
        --e2e)
            TEST_TYPE="e2e"
            shift
            ;;
        --all)
            TEST_TYPE="all"
            shift
            ;;
        --coverage)
            COVERAGE=true
            shift
            ;;
        --coverage-data)
            COVERAGE_DATA=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Run tests using Pytest.

With no positional argument the whole suite runs, distributed across cores and
filtered by marker. Positional paths (relative to backend/, node ids included)
run exactly those paths instead: unsharded, unfiltered, and without taking the
whole-suite lock.

Only one whole-suite run at a time is allowed per tree. Two of them share the
coverage data file, the fixture databases and the cores that -n auto sized for
one process, so a result observed while another is in flight is unproven until
it is re-run alone.

OPTIONS:
    --unit          Run unit tests only (default)
    --integration   Run integration tests only
    --e2e           Run end-to-end tests only
    --all           Run all test types
    --coverage      Generate coverage report (term + html + xml) and enforce
                    the 90% threshold here
    --coverage-data Collect coverage data only - no report, no threshold. For
                    callers that report and gate separately (check-all.sh runs
                    the suite once under this flag, then coverage.sh
                    --report-only applies the threshold to the data on disk).
    --verbose       Show detailed output
    --help          Display this help message

ENVIRONMENT:
    PYTEST_WORKERS  xdist worker count for whole-suite runs (default: auto)

EXIT CODES:
    0               All tests passed
    1               Test failures
    2               Usage error
    3               Refused: another whole-suite run is in flight in this tree

EXAMPLES:
    $(basename "$0")                     # Run unit tests
    $(basename "$0") --all               # Run all tests
    $(basename "$0") --unit --coverage   # Unit tests with coverage
    $(basename "$0") tests/test_x.py     # Run one file, unsharded
    $(basename "$0") tests/test_x.py::test_y  # Run one test
EOF
            exit 0
            ;;
        -*)
            # A mistyped option must not fall through to the positional list,
            # where pytest would take it for a file name and report a
            # collection error nobody can read.
            echo "Error: Unknown option: $1" >&2
            exit "$USAGE_EXIT_CODE"
            ;;
        *)
            TARGETS+=("$1")
            shift
            ;;
    esac
done

lock_holder() {
    [ -f "$LOCK_FILE" ] || return 0
    head -n 1 "$LOCK_FILE" 2> /dev/null | tr -d '[:space:]'
}

holder_is_live() {
    local holder=$1
    case "$holder" in
        "" | *[!0-9]*) return 1 ;;
        *) kill -0 "$holder" 2> /dev/null ;;
    esac
}

refuse_contended_run() {
    local holder=$1
    echo "Refusing to run: whole-suite run PID $holder is already in flight in this tree." >&2
    echo "Two of them share the coverage data file, the fixture databases and the cores" >&2
    echo "that -n auto sized for one process, so whatever either prints is unproven until" >&2
    echo "it is re-run alone. Wait for PID $holder, or kill it." >&2
    echo "Lock: $LOCK_FILE" >&2
    exit "$REFUSED_EXIT_CODE"
}

take_lock_file() {
    # `set -o noclobber` makes create-and-write a single atomic step, so two
    # runs racing here cannot both come away believing they own the suite.
    if (
        set -o noclobber
        printf '%s\n' "$$" > "$LOCK_FILE"
    ) 2> /dev/null; then
        LOCK_HELD=true
        return 0
    fi
    return 1
}

acquire_suite_lock() {
    mkdir -p "$LOCK_DIR"
    take_lock_file && return 0
    local holder
    holder="$(lock_holder)"
    if holder_is_live "$holder"; then
        refuse_contended_run "$holder"
    fi
    # A lock naming a process that no longer exists is the residue of a run
    # killed mid-suite. Obeying it would wedge the tree until somebody deleted
    # a file they have never heard of, and the step after that is a bypass.
    rm -f "$LOCK_FILE"
    take_lock_file && return 0
    refuse_contended_run "$(lock_holder)"
}

release_suite_lock() {
    # Release by ownership, never by path: if this run overran and another
    # stole the lock, deleting the file would strip the new owner's protection
    # and let a third run start against a suite already in flight.
    [ "$LOCK_HELD" = true ] || return 0
    if [ "$(lock_holder)" = "$$" ]; then
        rm -f "$LOCK_FILE"
    fi
}

warn_if_suite_lock_is_held() {
    # A targeted run neither takes nor waits for the lock, but the machine
    # really is busy, so a surprising result deserves a reason.
    local holder
    holder="$(lock_holder)"
    if holder_is_live "$holder"; then
        echo "Note: whole-suite run PID $holder is in flight here; a contended result may mislead." >&2
    fi
}

trap release_suite_lock EXIT INT TERM

if [ ${#TARGETS[@]} -gt 0 ] && { $COVERAGE || $COVERAGE_DATA; }; then
    echo "Error: coverage cannot be combined with a positional path." >&2
    echo "A partial run measures a fraction of the codebase against a whole-repo" >&2
    echo "threshold, so it fails for a reason that has nothing to do with the test being" >&2
    echo "written. Run the named path without coverage, or the whole suite with it." >&2
    exit "$USAGE_EXIT_CODE"
fi

cd "$PROJECT_ROOT"

# Set verbosity
if $VERBOSE; then
    set -x
fi

# Build pytest arguments. A targeted run inherits none of the whole-suite argv:
# xdist would shard one file across workers whose module-scoped database
# fixtures assume a single worker per file, the marker expression would silently
# drop a test named explicitly, and appending tests/ would quietly restore the
# full run the caller was avoiding.
PYTEST_ARGS=(-v)

if [ ${#TARGETS[@]} -gt 0 ]; then
    echo "=== Running Targeted Tests ==="
    warn_if_suite_lock_is_held
    PYTEST_TARGETS=("${TARGETS[@]}")
else
    acquire_suite_lock
    PYTEST_TARGETS=("tests/")
    PYTEST_ARGS+=(-n "$PYTEST_WORKERS" --dist loadfile)
    case "$TEST_TYPE" in
        unit)
            echo "=== Running Unit Tests ==="
            PYTEST_ARGS+=(-m "not integration and not e2e")
            ;;
        integration)
            echo "=== Running Integration Tests ==="
            PYTEST_ARGS+=(-m "integration")
            ;;
        e2e)
            echo "=== Running End-to-End Tests ==="
            PYTEST_ARGS+=(-m "e2e")
            ;;
        all)
            echo "=== Running All Tests ==="
            ;;
    esac
fi

# Add coverage if requested.
#
# Both modes pass a bare ``--cov`` so the measured set comes from the single
# declaration in [tool.coverage.run] source (= {src, scripts}) rather than
# being restated here. Naming a source explicitly (``--cov=src``) would
# OVERRIDE that config and silently drop scripts/ from the measurement that
# backend-ci.yml's branch-coverage step asserts over {src, scripts}.
if $COVERAGE; then
    echo "Coverage enabled"
    PYTEST_ARGS+=(
        --cov
        --cov-branch
        --cov-report=term-missing
        --cov-report=html
        --cov-report=xml
        --cov-fail-under=90
    )
elif $COVERAGE_DATA; then
    # Data only: ``--cov-report=`` disables every report, and no threshold is
    # applied, because the caller gates on the data afterwards. Reporting here
    # too would render the same numbers twice per check-all run.
    echo "Coverage data collection enabled (no report, no threshold)"
    PYTEST_ARGS+=(
        --cov
        --cov-branch
        --cov-report=
    )
fi

# Run tests
if $VERBOSE; then
    echo "Running pytest with args: ${PYTEST_ARGS[*]}"
fi

pytest "${PYTEST_ARGS[@]}" "${PYTEST_TARGETS[@]}" || {
    echo "✗ Tests failed" >&2
    exit "$TEST_FAILURE_EXIT_CODE"
}

echo "✓ Tests passed"

exit 0
