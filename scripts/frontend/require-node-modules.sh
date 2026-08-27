#!/usr/bin/env bash
# scripts/frontend/require-node-modules.sh - Assert the frontend deps are installed
# Usage: ./scripts/frontend/require-node-modules.sh
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
# once, for all of them. Exit 0 when the deps are present, 1 with the remedy
# when they are not.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"

# .bin rather than node_modules itself: a half-finished or interrupted install
# leaves the directory present and the executables absent, and it is the
# executables every caller is about to reach for.
if [[ -d "$FRONTEND_DIR/node_modules/.bin" ]]; then
    exit 0
fi

cat >&2 <<MSG
✗ Frontend dependencies are not installed: $FRONTEND_DIR/node_modules/.bin is missing.
  Install them from the lockfile, then re-run:

      cd "$FRONTEND_DIR" && npm ci

  In a Ralph fleet lane this normally means the worktree was created before
  scripts/ralph/fleet.sh provisioned node_modules; re-running assign links it.
MSG
exit 1
