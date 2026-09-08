#!/usr/bin/env bash
# scripts/backend/with-venv.sh - Run a backend gate against the pinned toolchain
# Usage: ./scripts/backend/with-venv.sh <command> [args...]
#
# A quality gate that cannot say which interpreter it measured is not a gate.
# Three pre-commit hooks -- bandit, backend-complexity, backend-tests-coverage --
# used to open with
#
#     bash -c '[ -f .venv/bin/activate ] && source .venv/bin/activate; ./scripts/...'
#
# and the `;` is the whole defect: it ends the guard rather than chaining it, so
# the gate after it runs unconditionally. Measured in a checkout with no .venv
# and the pinned tools merely on PATH, that entry printed "✓ Bandit checks
# passed" and exited 0 having activated nothing and verified nothing. A pass
# nobody earned is worse than a missing check, because the pass gets quoted.
#
# This is the sibling of scripts/frontend/require-node-modules.sh, and for the
# same reason: the failure mode is a PRECONDITION, and a precondition that
# surfaces as a bare `command not found` names the binary instead of the missing
# install. One helper supplies the legible refusal, once, for every gate that
# needs it -- so the hook entries carry zero shell logic and there is nothing
# left for a fourth hook to copy incorrectly.
#
# WHY THE NO-VENV BRANCH DOES NOT SIMPLY DEMAND A .venv
# -----------------------------------------------------
# The invariant worth enforcing is "this gate is running against the pinned
# toolchain", not "a .venv directory exists". .github/workflows/backend-ci.yml
# installs the pins with `uv pip install --system` and then runs these very
# hooks; it has no .venv anywhere. A literal .venv-existence check would fail
# the required backend-quality job on every pull request -- stricter in
# appearance and simply wrong. So the no-venv branch asks deps.sh, which
# compares the versions installed in whatever environment is active against the
# exact pins in backend/requirements*.txt, and accepts only a match.
#
# There is deliberately NO environment-variable escape hatch (nothing of the
# ADEPTHOOD_PYTHON_ENV shape). deps.sh is the verifier; a config flag layered on
# top of a working verifier is a second decorative guard, and it would give
# `scripts/pre-deploy-check.sh`'s `pre-commit run --all-files` a way to report a
# verdict it did not earn.
#
# .venv is probed relative to the current directory, because pre-commit runs
# hooks with the repository root as cwd -- the same assumption every frontend
# hook already relies on.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Exit codes, documented in --help below.
readonly USAGE_EXIT_CODE=2
# Distinct from the wrapped gate's own codes only in intent: "the environment
# was never proven" and "the gate found something" call for opposite responses,
# and the message below is what carries that difference.
readonly UNVERIFIED_ENVIRONMENT_EXIT_CODE=1

usage() {
    cat << EOF
Usage: $(basename "$0") <command> [args...]

Run a backend quality gate only after proving it will run against the pinned
toolchain, then exec it so its own exit code is the one the caller sees.

Resolution order:
    1. ./.venv/bin/activate exists  ->  activate it and run the command.
    2. Otherwise                    ->  scripts/backend/deps.sh must confirm the
                                        active interpreter matches the pins in
                                        backend/requirements.txt and
                                        backend/requirements-dev.txt.
    3. Neither                      ->  refuse, and name the remedy.

EXIT CODES:
    0           Whatever the wrapped command returned (the command is exec'd)
    1           The environment was never proven, so no gate was run
    2           Usage error: no command given

EXAMPLES:
    $(basename "$0") ./scripts/backend/security.sh --bandit-only
    $(basename "$0") ./scripts/backend/complexity.sh
EOF
}

if [[ $# -eq 0 ]]; then
    usage >&2
    exit "$USAGE_EXIT_CODE"
fi

if [[ "$1" == "--help" ]]; then
    usage
    exit 0
fi

# 1. A project virtualenv (developer checkout, Ralph fleet lane): activate it,
#    then hand the process over so the gate's exit code is the caller's.
if [[ -f .venv/bin/activate ]]; then
    source .venv/bin/activate
    exec "$@"
fi

# 2. No virtualenv: the ambient interpreter has to be PROVEN to be at the pins.
#    Any non-zero from deps.sh -- drift, unreadable pins, or no `python` at all
#    -- falls through to the refusal below, so a 127 can never masquerade as a
#    verdict. Its report goes to stderr because the gate's own stdout is the
#    output a caller parses.
if "$SCRIPT_DIR/deps.sh" >&2; then
    exec "$@"
fi

# 3. Neither. Refuse: name the precondition, and give the one remedy that
#    actually establishes it. Never suggest installing into the ambient
#    interpreter -- that is the environment we just failed to verify.
echo "✗ No project virtualenv is active and the ambient interpreter does not match the pins." >&2
echo "  Refusing to run: $*" >&2
echo "  A verdict from an unverified environment cannot predict CI, so none is reported." >&2
echo "  Fix: python -m venv .venv && pip install -r backend/requirements.txt -r backend/requirements-dev.txt" >&2
exit "$UNVERIFIED_ENVIRONMENT_EXIT_CODE"
