#!/usr/bin/env bash
# scripts/test.sh - Run tests with Jest
# Usage: ./scripts/test.sh [--coverage] [--watch] [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../frontend" && pwd)"

COVERAGE=false
WATCH=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --coverage)
            COVERAGE=true
            shift
            ;;
        --watch)
            WATCH=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Run tests using Jest.

OPTIONS:
    --coverage  Generate coverage report
    --watch     Watch mode (rerun on file changes)
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           All tests passed
    1           Test failures
    2           Error running tests
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

echo "=== Running Tests (Jest) ==="

JEST_ARGS=()

if $COVERAGE; then
    JEST_ARGS+=(--coverage)
fi

if $WATCH; then
    JEST_ARGS+=(--watch)
fi

./node_modules/.bin/jest ${JEST_ARGS[@]+"${JEST_ARGS[@]}"} || { echo "✗ Tests failed" >&2; exit 1; }

echo "✓ Tests passed"
exit 0
