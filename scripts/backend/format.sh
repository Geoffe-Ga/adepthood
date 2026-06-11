#!/usr/bin/env bash
# scripts/format.sh - Format code with ruff format (the repo's formatting authority)
# Usage: ./scripts/format.sh [--fix] [--check] [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../backend" && pwd)"

CHECK=false
VERBOSE=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --fix)
            # Fix is the default mode; flag accepted for explicitness.
            shift
            ;;
        --check)
            CHECK=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Format code using ruff format.

OPTIONS:
    --fix       Apply formatting changes (default)
    --check     Check only, fail if changes needed
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           Code is properly formatted
    1           Formatting issues found
    2           Error running checks

EXAMPLES:
    $(basename "$0") --fix         # Apply formatting
    $(basename "$0") --check       # Check only
    $(basename "$0") --verbose     # Show detailed output
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

echo "=== Formatting (ruff format) ==="

# Determine mode
if $CHECK; then
    MODE="--check"
else
    MODE=""
fi

# Run ruff format (plus isort-via-ruff for import order)
if $VERBOSE; then
    echo "Running ruff format..."
fi
ruff format $MODE . || { echo "✗ ruff format failed" >&2; exit 1; }

if [ -n "$MODE" ]; then
    echo "✓ Code formatting check passed"
else
    echo "✓ Code formatted successfully"
fi
exit 0
