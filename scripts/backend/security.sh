#!/usr/bin/env bash
# scripts/security.sh - Run security checks with Bandit and Safety
# Usage: ./scripts/security.sh [--full] [--verbose] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../backend" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

FULL=false
VERBOSE=false
BANDIT_ONLY=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --full)
            FULL=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --bandit-only)
            BANDIT_ONLY=true
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Run security checks using Bandit and Safety.

OPTIONS:
    --full          Run comprehensive security scan
    --verbose       Show detailed output
    --bandit-only   Run Bandit and stop, skipping the pip-audit stage
    --help          Display this help message

EXIT CODES:
    0           No security issues found
    1           Security issues found
    2           Error running checks

EXAMPLES:
    $(basename "$0")                 # Run basic security checks
    $(basename "$0") --full          # Run comprehensive scan
    $(basename "$0") --verbose       # Show detailed output
    $(basename "$0") --bandit-only   # Bandit only (the pre-commit hook)
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

echo "=== Security Checks (Bandit) ==="

# Run Bandit from the repository root, with the repository's own config.
#
# Both halves are load-bearing, and this line used to have neither. It read
# `bandit -r src/` with no `-c`, so backend/.bandit was never loaded here: its
# `skips: [B101]` did not apply, its `exclude_dirs` did not apply, and only
# src/ was scanned. The pre-commit hook meanwhile ran `-c backend/.bandit -r
# backend`. That is two different bandit gates -- different scope, different
# skips -- each calling itself "the security check", and unifying only their
# versions would have left them disagreeing with no visible cause.
#
# The subshell is required because backend/.bandit spells `targets` and
# `exclude_dirs` relative to the repository root, while this script runs with
# cwd=backend/ so that pip-audit's `-r requirements.txt` below keeps resolving.
if $VERBOSE; then
    echo "Running Bandit security scanner..."
fi
( cd "$REPO_ROOT" && bandit -c backend/.bandit -r backend ) \
    || { echo "✗ Bandit found issues" >&2; exit 1; }

# The pre-commit `bandit` hook delegates here rather than restating the config
# path and target, so the hook and check-all.sh can never scan different trees
# again. It wants Bandit alone: pip-audit reaches the network and has its own
# hook.
if $BANDIT_ONLY; then
    echo "✓ Bandit checks passed"
    exit 0
fi

echo "=== Security Checks (pip-audit) ==="

# Audit the project's declared dependencies (same surface as the
# pre-commit hook), NOT whatever interpreter happens to own the first
# `pip-audit` on PATH — a homebrew install was auditing homebrew's own
# site-packages and failing this gate with findings unrelated to the repo.
if $VERBOSE; then
    echo "Running pip-audit dependency checker..."
fi
pip-audit -r requirements.txt --ignore-vuln PYSEC-2025-183 \
    || { echo "✗ pip-audit found issues" >&2; exit 1; }

if $FULL; then
    echo "=== Comprehensive Security Scan ==="

    # Check for hardcoded secrets
    if command -v detect-secrets &> /dev/null; then
        if $VERBOSE; then
            echo "Running detect-secrets scan..."
        fi
        detect-secrets scan . || true
    fi
fi

echo "✓ Security checks passed"
exit 0
