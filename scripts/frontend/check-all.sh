#!/usr/bin/env bash
# scripts/check-all.sh - Run all quality checks
# Usage: ./scripts/check-all.sh [--verbose] [--help]

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

Run all quality checks in sequence.

Runs:
  1. Security audit (npm audit, high+, via audit-gate.mjs)
  2. Linting (ESLint)
  3. Formatting (Prettier)
  4. Type checking (TypeScript)
  5. Web bundle (expo export -- the only stage that runs the bundler)
  6. Tests (Jest)

OPTIONS:
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           All checks passed
    1           One or more checks failed
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

VERBOSE_FLAG=""
if $VERBOSE; then
    VERBOSE_FLAG="--verbose"
fi

echo "=== Running All Quality Checks ==="
echo ""

FAILED_CHECKS=()
PASSED_CHECKS=()

run_check() {
    local check_name=$1
    local script=$2
    shift 2
    local args=("$@")

    echo "Running: $check_name"
    if "$SCRIPT_DIR/$script" "${args[@]+"${args[@]}"}" $VERBOSE_FLAG; then
        PASSED_CHECKS+=("$check_name")
        echo "✓ $check_name passed"
    else
        FAILED_CHECKS+=("$check_name")
        echo "✗ $check_name failed" >&2
    fi
    echo ""
}

# Mirrors the CI job's first step. Without it, check-all.sh could report green
# while CI's audit gate failed on the same commit — which is exactly what
# happened on the Gumroad onboarding PR.
run_check "Security audit" "audit-gate.mjs"
run_check "Linting" "lint.sh" --check
run_check "Formatting" "format.sh" --check
run_check "Type checking" "typecheck.sh"
# The only stage that runs the bundler, and so the only one that can catch an
# import or metro.config.js change the file-reading gates above are blind to.
# Mirrors CI's "Web bundle builds" step so local Gate 2 predicts CI.
run_check "Web bundle" "bundle.sh"
run_check "Tests" "test.sh"

echo "=== Quality Checks Summary ==="
echo "Passed: ${#PASSED_CHECKS[@]}"
echo "Failed: ${#FAILED_CHECKS[@]}"

if [ ${#FAILED_CHECKS[@]} -gt 0 ]; then
    echo ""
    for check in "${FAILED_CHECKS[@]}"; do
        echo "  ✗ $check"
    done
    exit 1
else
    echo ""
    echo "✓ All quality checks passed!"
    exit 0
fi
