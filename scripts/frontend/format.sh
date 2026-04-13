#!/usr/bin/env bash
# scripts/format.sh - Format code with Prettier
# Usage: ./scripts/format.sh [--fix] [--check] [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../frontend" && pwd)"

CHECK=false
VERBOSE=false

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

Format code using Prettier.

OPTIONS:
    --fix       Apply formatting changes (default)
    --check     Check only, fail if changes needed
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           Code is properly formatted
    1           Formatting issues found
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

echo "=== Formatting (Prettier) ==="

if $CHECK; then
    if $VERBOSE; then
        echo "Checking formatting..."
    fi
    npx prettier --check "src/**/*.{ts,tsx}" "tests/**/*.{ts,tsx}" "*.{js,json}" || { echo "✗ Formatting check failed" >&2; exit 1; }
    echo "✓ Code formatting check passed"
else
    if $VERBOSE; then
        echo "Formatting code..."
    fi
    npx prettier --write "src/**/*.{ts,tsx}" "tests/**/*.{ts,tsx}" "*.{js,json}" || { echo "✗ Formatting failed" >&2; exit 1; }
    echo "✓ Code formatted successfully"
fi
exit 0
