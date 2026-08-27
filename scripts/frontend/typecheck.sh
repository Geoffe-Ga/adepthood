#!/usr/bin/env bash
# scripts/typecheck.sh - Run type checking with TypeScript compiler
# Usage: ./scripts/typecheck.sh [--verbose] [--help]

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

Run type checking using the TypeScript compiler.

OPTIONS:
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           All type checks passed
    1           Type errors found
    2           Error running type checker
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
# The tools below are called as ./node_modules/.bin/<tool> so the pinned version
# runs, resolved from disk with no network. This turns the resulting bare
# `command not found` into a message that names the install. See the helper.
"$SCRIPT_DIR/require-node-modules.sh"

if $VERBOSE; then
    set -x
fi

echo "=== Type Checking (TypeScript) ==="

./node_modules/.bin/tsc --noEmit || { echo "✗ Type checking failed" >&2; exit 1; }

echo "✓ Type checking passed"
exit 0
