#!/usr/bin/env bash
# scripts/frontend/require-node-modules.sh - Assert the frontend deps are usable
# Usage: ./scripts/frontend/require-node-modules.sh [--verify-lockfile] [--help]
#
# Every frontend gate -- the pre-commit hooks and the scripts/frontend/*.sh
# runners -- calls its tool as ./node_modules/.bin/<tool> so the version that
# runs is the version the lockfile pins, resolved from disk with no network.
# That form fails as a bare `command not found` when the tree has no deps, which
# is a true statement and a useless one: it names the binary rather than the
# missing install, and it is what a Ralph fleet lane saw on every commit.
#
# The alternative the gates used to take is worse than an unhelpful message.
# `npx <tool>` answers a missing binary by FETCHING one: in a tree without
# node_modules it downloads and executes whatever package on the public registry
# answers to that name, so a hook can run a stranger's code and still report a
# verdict. `npx --no-install` does not close that: it still resolves out of the
# shared ~/.npm/_npx cache, and still queries the registry for an uncached name.
#
# So the gates stay hermetic and this one helper supplies the legible failure,
# once, for all of them. It answers two different questions, and the second is
# opt-in because it is not always the right one to ask:
#
#   default            Are the deps PRESENT? Exit 0 if node_modules/.bin exists,
#                      1 with the remedy if it does not.
#   --verify-lockfile  Are they also FRESH -- built from the committed lockfile?
#                      Exit 0 when they match, 1 when the install has drifted,
#                      2 when the question could not be answered.
#
# Presence is not freshness. A tree installed weeks ago passes the default
# check, and the staleness then surfaces two stages later as an Expo SDK
# alignment failure whose text sends the reader at the committed pins. That cost
# a full false-bug cycle: an issue was filed reporting ten SDK packages behind on
# `main` with the gate output as evidence, when the manifests had been correct
# all along and only the installed tree was stale.
#
# The freshness half stays opt-in rather than becoming the default because this
# helper runs on EVERY commit in the repo via the commitlint hook, which carries
# no `files:` filter. A stale frontend install must not block a backend-only or
# a docs-only commit, so only the gates that actually read the installed tree
# pass the flag.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"

VERIFY_LOCKFILE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --verify-lockfile)
            VERIFY_LOCKFILE=true
            shift
            ;;
        --help)
            cat << EOF
Usage: $(basename "$0") [OPTIONS]

Assert the frontend dependencies are usable before a gate reaches for them.

By default this asks only whether they are installed. With --verify-lockfile it
also proves the install was built from the committed lockfile, by comparing
npm's own install receipt (node_modules/.package-lock.json) against
frontend/package-lock.json. That comparison is hermetic: no network, no
registry query, no installer.

Inside a Ralph fleet lane, frontend/node_modules is a symlink into the main
checkout. The link is resolved and the receipt compared against the OWNING
checkout's lockfile, so a lane whose branch bumps a dependency does not read as
stale on every gate at once.

OPTIONS:
    --verify-lockfile   Also verify the install matches the lockfile
    --help              Display this help message

EXIT CODES:
    0           The dependencies are present (and fresh, if verified)
    1           They are absent, or the install has drifted from the lockfile
    2           The freshness check could not reach a verdict
EOF
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 2
            ;;
    esac
done

# .bin rather than node_modules itself: a half-finished or interrupted install
# leaves the directory present and the executables absent, and it is the
# executables every caller is about to reach for.
if [[ -d "$FRONTEND_DIR/node_modules/.bin" ]]; then
    if ! $VERIFY_LOCKFILE; then
        exit 0
    fi

    # No "node is missing, skip the check" fallback: an interpreter that cannot
    # run the comparator is a result we failed to obtain, not a pass.
    if ! command -v node > /dev/null 2>&1; then
        echo "✗ node is not on PATH; cannot verify the frontend install." >&2
        exit 2
    fi

    DRIFT_EXIT=0
    node "$SCRIPT_DIR/lockfile-drift.mjs" "$FRONTEND_DIR" || DRIFT_EXIT=$?
    case "$DRIFT_EXIT" in
        0)
            exit 0
            ;;
        1)
            exit 1
            ;;
        *)
            # Anything that is not a clean verdict or a clean failure is a
            # failure to verify. Never collapsed into a pass.
            exit 2
            ;;
    esac
fi

cat >&2 <<MSG
✗ Frontend dependencies are not installed: $FRONTEND_DIR/node_modules/.bin is missing.
  Install them from the lockfile, then re-run:

      cd "$FRONTEND_DIR" && npm ci

  In a Ralph fleet lane this normally means the worktree was created before
  scripts/ralph/fleet.sh provisioned node_modules; re-running assign links it.
MSG
exit 1
