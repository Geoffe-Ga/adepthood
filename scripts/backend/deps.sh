#!/usr/bin/env bash
# scripts/deps.sh - Verify the active virtualenv matches the pinned requirements
# Usage: ./scripts/deps.sh [--verbose] [--help]

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

Compare the versions installed in the active environment against the exact
pins in backend/requirements.txt and backend/requirements-dev.txt.

Every other quality gate measures the packages that are installed, so a
drifted environment makes their verdicts unable to predict CI. This check
reports drift and fails; it never installs or upgrades anything, because the
environment may be shared by concurrent work.

OPTIONS:
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           Every pin matches the active environment
    1           At least one package is missing or at the wrong version
    2           Could not verify the pins (unreadable line, missing file, or
                conflicting pins across the two requirements files)

EXAMPLES:
    $(basename "$0")           # Check the backend pins
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
if $VERBOSE; then
    set -x
fi

echo "=== Dependency Drift (pinned vs installed) ==="

# No "tool missing, skip the check" fallback on purpose: an interpreter that
# cannot run the checker is a result we failed to obtain, not a pass.
DRIFT_EXIT=0
python -m scripts.check_dependency_drift || DRIFT_EXIT=$?

case "$DRIFT_EXIT" in
    0)
        echo "✓ Dependency pins match the active environment"
        ;;
    1)
        echo "✗ The active environment has drifted from the pinned requirements" >&2
        ;;
    *)
        echo "✗ Could not verify the pinned requirements" >&2
        ;;
esac

exit "$DRIFT_EXIT"
