#!/usr/bin/env bash
# scripts/bundle.sh - Prove the app actually bundles
# Usage: ./scripts/bundle.sh [--verbose] [--help]
#
# Every other frontend gate reads a *file* in isolation: eslint reads syntax,
# tsc reads types, prettier reads formatting, and Jest reads modules behind its
# own moduleNameMapper. None of them resolves the real import graph, and none of
# them reads metro.config.js at all. Without this stage, a green frontend run
# certifies only that Jest ran.
#
# That gap is demonstrable, not theoretical. Flipping
# `config.resolver.unstable_enablePackageExports` off in metro.config.js -- the
# line that lets Metro resolve react-native-web's subpath imports -- leaves
# eslint, tsc, and 782 Habits tests all green while the app cannot bundle at
# all. This stage fails on it, which is the whole reason it exists.
#
# Web is the cheapest platform that exercises the whole graph: no Xcode, no
# Gradle, no simulator. It is NOT a substitute for a native build -- there is no
# frontend/ios or frontend/android directory, so `newArchEnabled: true` has
# still never been compiled here -- but it catches the failure this repo can
# actually have today, which is an import or bundler-config change that breaks
# the bundle. A gate that overstates its coverage is worse than none.
#
# `expo-doctor` is still not run here, but the reason has narrowed, because the
# old one is no longer true. Dependency drift from the pinned SDK is now gated
# -- by scripts/frontend/sdk-align.sh, which runs `expo install --check`, the
# one probe that reads the SDK's compatibility table. That was the single
# failing check in the last expo-doctor run (`npx expo-doctor`, measured
# 2026-08-28: 21 checks, 20 passed, 1 failed -- the SDK version match), and it
# passes now that the tree is realigned; the
# Dependabot floors on react-native-screens and react-native-svg keep a bot
# bump from knocking it red again, which is what makes it enforceable rather
# than aspirational. What stays ungated is the other 20 checks: a broad,
# network-dependent probe whose future failures are outside this repo's control
# would have to ship suppressed to be adopted at all. And neither probe is a
# native build -- there is still no frontend/ios or frontend/android, so
# newArchEnabled remains uncompiled either way. This stage answers one
# question: does the app bundle.
#
# Output goes to frontend/dist, gitignored at the repo root and in
# frontend/.gitignore.

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

Build a real web bundle with Metro, resolving the entire import graph.

This is the only frontend gate that runs the bundler. It is not a native
build: newArchEnabled is still uncompiled, and a web export cannot tell you
an iOS or Android build works.

OPTIONS:
    --verbose   Show detailed output
    --help      Display this help message

EXIT CODES:
    0           Bundle built
    1           Bundle failed to build
    2           Error running the bundler
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
"$SCRIPT_DIR/require-node-modules.sh" --verify-lockfile

if $VERBOSE; then
    set -x
fi

echo "=== Web bundle (expo export) ==="

./node_modules/.bin/expo export --platform web || { echo "✗ Web bundle failed" >&2; exit 1; }

echo "✓ Web bundle built"
exit 0
