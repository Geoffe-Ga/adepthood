#!/usr/bin/env bash
# scripts/backend/complexity.sh - Code complexity analysis
# Usage: ./scripts/backend/complexity.sh [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../backend" && pwd)"

# The single definition of the project's complexity thresholds: the pre-push
# hook invokes this script rather than restating them, because a second copy is
# exactly how the two drifted apart before.
#
# xenon: A-grade absolute, modules, and average. A-grade means a cyclomatic
# complexity of 5 or less per block.
XENON_MAX_ABSOLUTE="A"
XENON_MAX_MODULES="A"
XENON_MAX_AVERAGE="A"
# radon's maintainability bands are A = 100-20, B = 19-10, C = 9-0, so a floor
# of "rank B or better" makes rank C the violation and `-n C` the filter that
# lists precisely the offenders.
MI_VIOLATION_RANK="C"
# xenon gates cyclomatic complexity at A, so a B-ranked block is already an
# offender and has to stay visible in the report that explains a xenon failure.
# Filtering at C instead would hide the very blocks that caused it.
CC_REPORT_RANK="B"

# Exit codes, documented in --help below.
EXIT_THRESHOLD_EXCEEDED=1
EXIT_ANALYSIS_ERROR=2

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

Analyze code complexity using Radon and Xenon.

Metrics:
  - Cyclomatic complexity, gated by Xenon at A grade (complexity of 5 or less)
  - Maintainability index, gated at rank B or better (index of 10 or more)

OPTIONS:
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           Complexity acceptable
    1           Complexity exceeds thresholds
    2           Error during analysis

EXAMPLES:
    $(basename "$0")          # Analyze complexity
    $(basename "$0") --verbose # Show detailed output
EOF
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit "$EXIT_ANALYSIS_ERROR"
            ;;
    esac
done

cd "$PROJECT_ROOT"

# Set verbosity
if $VERBOSE; then
    set -x
fi

# A missing analyser is an error, not a pass: warning and exiting 0 would make
# a broken toolchain indistinguishable from clean code.
for tool in radon xenon; do
    if ! command -v "$tool" &> /dev/null; then
        echo "Error: $tool is not installed, so complexity cannot be analyzed" >&2
        echo "Install with: pip install -r backend/requirements-dev.txt" >&2
        exit "$EXIT_ANALYSIS_ERROR"
    fi
done

echo "=== Code Complexity Analysis ==="

# Informational only: radon is a reporter and exits 0 whatever it prints, so it
# cannot gate anything. Xenon, below, is the cyclomatic gate; this listing is
# what tells the operator which blocks a xenon failure is about. Thresholds are
# passed explicitly so the gate never depends on the ambient [tool.radon]
# configuration. The `||` branch reports a rejected argv or an unreadable tree
# and still exits non-zero -- it is the opposite of the `|| true` it replaces,
# which discarded exactly that failure.
echo ""
echo "Cyclomatic Complexity (rank $CC_REPORT_RANK or worse; Xenon is the gate):"
radon cc -a -n "$CC_REPORT_RANK" src/ ||
    { echo "Error: radon could not analyze cyclomatic complexity" >&2; exit "$EXIT_ANALYSIS_ERROR"; }

if $VERBOSE; then
    echo "Running Xenon complexity check..."
fi
xenon \
    --max-absolute "$XENON_MAX_ABSOLUTE" \
    --max-modules "$XENON_MAX_MODULES" \
    --max-average "$XENON_MAX_AVERAGE" \
    src/ || { echo "✗ Complexity exceeds thresholds" >&2; exit "$EXIT_THRESHOLD_EXCEEDED"; }

# The maintainability gate. radon exits 0 while printing a rank-C module, so
# its *output* is the signal: any listed module is a violation. It also fails
# closed on a file radon cannot parse, which xenon only warns about.
#
# Keep this a bare assignment at script scope. If it is ever moved into a
# function, do not write `local mi_report=$(...)`: `local` supplies its own exit
# status, so `set -e` would stop seeing radon's and the argv fault this gate
# exists to fix would be silently back.
echo ""
echo "Maintainability Index (must rank better than $MI_VIOLATION_RANK):"
mi_report=$(radon mi -s -n "$MI_VIOLATION_RANK" src/)
if [ -n "$mi_report" ]; then
    echo "$mi_report" >&2
    echo "✗ Maintainability index below threshold" >&2
    exit "$EXIT_THRESHOLD_EXCEEDED"
fi
echo "No modules rank $MI_VIOLATION_RANK."

echo ""
echo "✓ Complexity analysis completed"
exit 0
