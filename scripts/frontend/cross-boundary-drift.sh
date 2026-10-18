#!/usr/bin/env bash
# scripts/frontend/cross-boundary-drift.sh - Run the Jest guards that read backend source
#
# A few frontend tests derive their expectations from Python: the ten APTITUDE
# colours and their schedule, the upload cap, which consent sources something
# actually writes, what the e2e launcher is allowed to stub. Each exists to fail
# when the backend moves and the frontend does not.
#
# frontend-ci.yml is scoped to frontend/** on purpose -- nobody wants ~450 Jest
# suites and the audit gate on a one-line backend change -- so those guards
# never ran on the change they watch. One such change merged green and turned
# main red afterwards. This runs JUST those guards, from backend-ci.yml, where
# the breaking change is: seconds, no audit gate, no bundler, no coverage.
#
# The set is discovered, never listed. Every cross-boundary test reads through
# the shared frontend/src/testing/backendSource.ts helper, so importing it is
# the declaration -- a guard written tomorrow is covered the day it is written,
# with no edit here or in any workflow. Reading backend/ another way is not a
# quiet gap either: frontend/jest.setup.crossBoundary.js watches the filesystem
# during every suite and fails one that crossed the boundary undeclared.
#
# Usage: cross-boundary-drift.sh [--list] [--help]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"

# The marker. Identical to the module specifier the guards import, so there is
# no second place for the declaration to drift from the code.
MARKER='@/testing/backendSource'

LIST_ONLY=false

case "${1:-}" in
    --list)
        LIST_ONLY=true
        ;;
    --help)
        cat << EOF
Usage: $(basename "$0") [OPTIONS]

Run the frontend Jest tests that read backend source, discovered by their
import of '$MARKER'.

OPTIONS:
    --list      Print the discovered test files and exit
    --help      Display this help message

EXIT CODES:
    0           All cross-boundary guards passed
    1           A guard failed, or none could be discovered
    2           Error running the guards
EOF
        exit 0
        ;;
    '')
        ;;
    *)
        echo "Error: Unknown option: $1" >&2
        exit 2
        ;;
esac

DISCOVERED=()
declares_marker() {
    awk -v marker="$MARKER" '
        BEGIN { state = "code"; escaped = 0; capture_string = 0; found = 0 }
        {
            visible = ""
            for (position = 1; position <= length($0); position++) {
                char = substr($0, position, 1)
                following = substr($0, position + 1, 1)
                if (state == "block-comment") {
                    if (char == "*" && following == "/") {
                        state = "code"
                        position++
                    }
                    continue
                }
                if (state != "code") {
                    if (capture_string) visible = visible char
                    if (escaped) {
                        escaped = 0
                    } else if (char == "\\") {
                        escaped = 1
                    } else if ((state == "single" && char == "\047") ||
                               (state == "double" && char == "\042") ||
                               (state == "template" && char == "`")) {
                        state = "code"
                        capture_string = 0
                    }
                    continue
                }
                if (char == "/" && following == "/") break
                if (char == "/" && following == "*") {
                    state = "block-comment"
                    position++
                    continue
                }
                if (char == "\047") {
                    state = "single"
                    capture_string = visible ~ /^[[:space:]]*(import[[:space:]].*[[:space:]]from|}[[:space:]]from)[[:space:]]*$/
                    visible = visible char
                    continue
                }
                if (char == "\042") {
                    state = "double"
                    capture_string = visible ~ /^[[:space:]]*(import[[:space:]].*[[:space:]]from|}[[:space:]]from)[[:space:]]*$/
                    visible = visible char
                    continue
                }
                if (char == "`") {
                    state = "template"
                    continue
                }
                visible = visible char
            }
            pattern = "^[[:space:]]*(import[[:space:]].*[[:space:]]from|}[[:space:]]from)[[:space:]]+[\047\042]" marker "[\047\042];?[[:space:]]*$"
            if (visible ~ pattern) found = 1
            if (state == "single" || state == "double") {
                if (!escaped) state = "code"
                escaped = 0
            }
        }
        END { exit(found ? 0 : 1) }
    ' "$1"
}

while IFS= read -r -d '' file; do
    if declares_marker "$file"; then
        DISCOVERED+=("$file")
    fi
done < <(
    find "$FRONTEND_DIR" \
        -type d \( -name node_modules -o -name e2e \) -prune -o \
        -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -print0
)

if [ ${#DISCOVERED[@]} -gt 0 ]; then
    mapfile -t DISCOVERED < <(printf '%s\n' "${DISCOVERED[@]}" | LC_ALL=C sort)
fi

# An empty sweep is the failure this lane exists to prevent, one level up: a
# gate that reports it did nothing looks exactly like a gate that passed.
if [ ${#DISCOVERED[@]} -eq 0 ]; then
    echo "Error: no test imports '$MARKER', so no cross-boundary guard could be run." >&2
    echo "Either the helper was renamed and the guards no longer declare themselves," >&2
    echo "or every drift guard was deleted. Both are worth a human look." >&2
    exit 1
fi

# The header goes to stderr so --list emits paths and nothing else, and can be
# consumed by another program without parsing around decoration.
echo "=== Cross-boundary drift guards (${#DISCOVERED[@]} discovered) ===" >&2
for file in "${DISCOVERED[@]}"; do
    printf '%s\n' "${file#"$REPO_ROOT"/}"
done

if $LIST_ONLY; then
    exit 0
fi

cd "$FRONTEND_DIR"
# The tools below are called as ./node_modules/.bin/<tool> so the pinned version
# runs, resolved from disk with no network. This turns the resulting bare
# `command not found` into a message that names the install. See the helper.
"$SCRIPT_DIR/require-node-modules.sh" --verify-lockfile

# --runTestsByPath: these exact files, not a name pattern that could silently
# match none of them.
./node_modules/.bin/jest --runTestsByPath "${DISCOVERED[@]}" || {
    echo "✗ The frontend and the backend disagree" >&2
    exit 1
}

echo "✓ Cross-boundary guards passed"
exit 0
