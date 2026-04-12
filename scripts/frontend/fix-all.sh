#!/usr/bin/env bash
# scripts/fix-all.sh - Auto-fix all issues
# Usage: ./scripts/fix-all.sh [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../frontend" && pwd)"

VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Auto-fix all auto-fixable issues in sequence.

Fixes:
  1. Linting issues (ESLint)
  2. Formatting (Prettier)

OPTIONS:
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           Fixes applied successfully
    1           Some fixes failed
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

VERBOSE_FLAG=""
if $VERBOSE; then
    VERBOSE_FLAG="--verbose"
fi

echo "=== Auto-fixing Issues ==="
echo ""

FAILED_FIXES=()

run_fix() {
    local fix_name=$1
    local script=$2
    shift 2

    echo "Running: $fix_name"
    if "$SCRIPT_DIR/$script" --fix $VERBOSE_FLAG; then
        echo "✓ $fix_name completed"
    else
        FAILED_FIXES+=("$fix_name")
        echo "✗ $fix_name failed" >&2
    fi
    echo ""
}

run_fix "Linting" "lint.sh"
run_fix "Formatting" "format.sh"

echo "=== Auto-fix Summary ==="
if [ ${#FAILED_FIXES[@]} -gt 0 ]; then
    echo "Failed fixes: ${#FAILED_FIXES[@]}"
    exit 1
else
    echo "✓ All auto-fixes completed successfully!"
    exit 0
fi
