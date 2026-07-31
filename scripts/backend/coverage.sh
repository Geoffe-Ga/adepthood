#!/usr/bin/env bash
# scripts/coverage.sh - Run tests with coverage report
# Usage: ./scripts/coverage.sh [--report-only] [--html] [--xml] [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../backend" && pwd)"

# The gate itself, named once so the measured run and the report-only run can
# never drift into enforcing two different percentages.
COVERAGE_THRESHOLD=90

# coverage.py's own exit status for a percentage that missed --fail-under (see
# its `coverage.cmdline`). Every other non-zero status it returns means the
# report could not be produced at all, which says nothing about how much code
# the suite covered -- so the two must not be reported as the same failure.
COVERAGE_PY_FAIL_UNDER_STATUS=2

HTML_REPORT=false
XML_REPORT=false
REPORT_ONLY=false
VERBOSE=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --html)
            HTML_REPORT=true
            shift
            ;;
        --xml)
            XML_REPORT=true
            shift
            ;;
        --report-only)
            REPORT_ONLY=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Run tests with coverage report, or report on an earlier run's coverage data.

OPTIONS:
    --report-only   Report from the coverage data an earlier run left on disk;
                    does not run the tests. Reads \${COVERAGE_FILE:-.coverage}
                    under backend/ and fails when that file is absent.
    --html          Generate HTML coverage report
    --xml           Generate XML coverage report (for CI)
    --verbose       Show detailed output
    --help          Display this help message

EXIT CODES:
    0           Coverage threshold met
    1           Coverage below threshold
    2           Coverage could not be reported: missing coverage data, or the
                report itself failed (unreadable data, bad configuration)

EXAMPLES:
    $(basename "$0")                     # Run coverage with terminal report
    $(basename "$0") --html              # Generate HTML report
    $(basename "$0") --xml               # Generate XML report for CI
    $(basename "$0") --report-only --xml # Report on the previous run's data
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

echo "=== Coverage Report ==="

# --report-only renders the data an earlier pytest run already wrote, so a
# caller that has just run the suite (check-all.sh) does not pay for a second
# one. COVERAGE_FILE is coverage.py's own convention for locating that data.
if $REPORT_ONLY; then
    COVERAGE_DATA_FILE="${COVERAGE_FILE:-.coverage}"

    # With nothing on disk there is no honest report to print, and running the
    # suite here would silently restore the duplicated run this flag exists to
    # avoid. Refuse loudly instead, naming the file that was looked for.
    if [ ! -f "$COVERAGE_DATA_FILE" ]; then
        echo "✗ No coverage data at $COVERAGE_DATA_FILE" >&2
        echo "  Run the suite first; --report-only never runs it." >&2
        exit 2
    fi

    echo "Reporting from existing coverage data: $COVERAGE_DATA_FILE"

    # A shortfall and a broken reporter are different verdicts for the operator:
    # one means write more tests, the other means the coverage data or config is
    # unusable. The status is captured with `||` rather than inside an
    # `if ! ...` body, where `$?` would already have been reset to 0 by the
    # negation.
    REPORT_STATUS=0
    coverage report "--fail-under=$COVERAGE_THRESHOLD" || REPORT_STATUS=$?

    if [ "$REPORT_STATUS" -eq "$COVERAGE_PY_FAIL_UNDER_STATUS" ]; then
        echo "✗ Coverage below threshold" >&2
        exit 1
    fi

    if [ "$REPORT_STATUS" -ne 0 ]; then
        echo "✗ Coverage report failed (coverage exited $REPORT_STATUS)" >&2
        echo "  The coverage data or configuration is unusable, not undercovered." >&2
        exit 2
    fi

    if $XML_REPORT; then
        coverage xml
        echo "XML report generated as coverage.xml"
    fi

    if $HTML_REPORT; then
        coverage html
        echo "HTML report generated in htmlcov/"
    fi

    echo "✓ Coverage threshold met"

    exit 0
fi

# Build pytest arguments
PYTEST_ARGS=(
    -v
    --cov=src
    --cov-branch
    --cov-report=term-missing
    "--cov-fail-under=$COVERAGE_THRESHOLD"
)

# Add HTML report if requested
if $HTML_REPORT; then
    PYTEST_ARGS+=(--cov-report=html)
    echo "HTML report will be generated in htmlcov/"
fi

# Add XML report if requested
if $XML_REPORT; then
    PYTEST_ARGS+=(--cov-report=xml)
    echo "XML report will be generated as coverage.xml"
fi

# Run tests with coverage
pytest "${PYTEST_ARGS[@]}" tests/ || {
    echo "✗ Coverage below threshold" >&2
    exit 1
}

echo "✓ Coverage threshold met"

exit 0
