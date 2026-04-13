#!/usr/bin/env bash
# scripts/lint.sh - Run linting checks with ESLint
# Usage: ./scripts/lint.sh [--fix] [--check] [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../frontend" && pwd)"

FIX=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --fix)
            FIX=true
            shift
            ;;
        --check)
            # Check is the default mode; flag accepted for explicitness.
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Run linting checks using ESLint.

OPTIONS:
    --fix       Auto-fix linting issues where possible
    --check     Check only, fail if issues found
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           All checks passed
    1           Linting issues found
    2           Error running checks
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

if $VERBOSE; then
    set -x
fi

echo "=== Linting (ESLint) ==="

if $FIX; then
    if $VERBOSE; then
        echo "Fixing linting issues..."
    fi
    npx eslint . --fix || { echo "✗ ESLint fix failed" >&2; exit 1; }
else
    if $VERBOSE; then
        echo "Checking for linting issues..."
    fi
    npx eslint . || { echo "✗ ESLint check failed" >&2; exit 1; }
fi

echo "✓ Linting checks passed"
exit 0
