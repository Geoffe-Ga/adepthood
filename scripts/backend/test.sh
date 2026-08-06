#!/usr/bin/env bash
# scripts/test.sh - Run tests with Pytest
# Usage: ./scripts/test.sh [--unit|--integration|--e2e|--all] [--coverage]
#                          [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../backend" && pwd)"

TEST_TYPE="unit"
COVERAGE=false
COVERAGE_DATA=false
VERBOSE=false

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
    2               Error running tests

EXAMPLES:
    $(basename "$0")                     # Run unit tests
    $(basename "$0") --all               # Run all tests
    $(basename "$0") --unit --coverage   # Unit tests with coverage
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
if $VERBOSE; then
    set -x
fi

# Build pytest arguments
PYTEST_ARGS=(-v -n "$PYTEST_WORKERS" --dist loadfile)

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

pytest "${PYTEST_ARGS[@]}" tests/ || { echo "✗ Tests failed" >&2; exit 1; }

echo "✓ Tests passed"

exit 0
