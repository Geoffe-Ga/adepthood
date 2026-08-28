#!/usr/bin/env bash
# scripts/frontend/sdk-align.sh - Prove the installed tree matches the pinned Expo SDK
# Usage: ./scripts/frontend/sdk-align.sh [--verbose] [--help]
#
# The frontend pins an Expo SDK, and that SDK publishes a compatibility table
# naming the version of every package it ships alongside: the React version,
# the React Native version, each expo-* module, and the community packages the
# SDK builds against. Every other frontend gate is blind to that table. ESLint
# reads syntax, tsc reads types, prettier reads formatting, the bundler
# resolves an import graph, and Jest reads modules through its own
# moduleNameMapper -- none of them can tell you a dependency is a full minor
# ahead of, or behind, what the SDK expects.
#
# The sharper version of that, because "Jest would catch it" is the intuition
# this stage exists to correct: react-native-svg and react-native-screens are
# NOT mocked here, so the suites do render them for real -- and that covers
# their JavaScript surface and nothing below it. The packages that ARE mocked,
# like @react-native-async-storage/async-storage, can sit arbitrarily far from
# the expected version with all suites green, because the suites never touch
# the real module at all.
#
# `expo install --check` is the one command that reads the compatibility table
# and compares it against what is installed. It exits 1 when the tree has
# drifted and 0 when it is aligned; both outcomes were measured on this repo
# before this runner was written, so the gate is known to have a failing mode
# rather than assumed to.
#
# This is NOT a native build and does not pretend to be one: there is no
# frontend/ios or frontend/android directory, so a version the SDK expects for
# native reasons is checked here as a number, never as compiled behaviour.
#
# The broader `expo-doctor` stays ungated on purpose. It runs 21
# network-dependent checks, exactly one of which -- the SDK version match -- is
# the question that actually regresses here; adopting the other 20 would mean
# taking on merge blockers outside this repo's control, which in practice means
# shipping the tool suppressed. This stage answers one question instead.

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

Compare the installed frontend dependencies against the pinned Expo SDK's
compatibility table, via 'expo install --check'.

This is the only frontend gate that reads that table. It is not a native
build: a version the SDK expects for native reasons is checked as a number,
never as compiled behaviour.

OPTIONS:
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           Dependencies match the pinned Expo SDK
    1           Dependencies have drifted from the pinned Expo SDK
    2           Error running the check
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
# The tool below is called as ./node_modules/.bin/<tool> so the pinned version
# runs, resolved from disk with no network. This turns the resulting bare
# `command not found` into a message that names the install. See the helper.
#
# That sentence is about resolving the *binary*, and the distinction matters
# here more than it does in the other runners: `expo install --check` itself
# consults Expo's published compatibility data, so unlike lint or typecheck
# this stage does need the network to reach a verdict. An offline run fails
# rather than reporting a false clean, which is the right direction to fail,
# but it means a failure here is worth reading before it is believed.
"$SCRIPT_DIR/require-node-modules.sh"

if $VERBOSE; then
    set -x
fi

echo "=== Expo SDK alignment (expo install --check) ==="

# The remedy is spelled with the local bin for the same reason the check is.
FIX_COMMAND="cd frontend && ./node_modules/.bin/expo install --fix"

./node_modules/.bin/expo install --check || { echo "✗ Dependencies drifted from the pinned Expo SDK; realign with: $FIX_COMMAND" >&2; exit 1; }

echo "✓ Dependencies match the pinned Expo SDK"
exit 0
