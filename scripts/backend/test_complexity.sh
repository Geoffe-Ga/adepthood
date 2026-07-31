#!/usr/bin/env bash
# Regression test for the Radon maintainability gate (Issue #2024).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN"' EXIT

cat >"$FAKE_BIN/radon" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "mi" ]]; then
    echo "src/bad_fixture.py: grade C" >&2
    exit 1
fi
exit 0
EOF

cat >"$FAKE_BIN/xenon" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

chmod +x "$FAKE_BIN/radon" "$FAKE_BIN/xenon"

if PATH="$FAKE_BIN:$PATH" "$SCRIPT_DIR/complexity.sh" >"$FAKE_BIN/output.log" 2>&1; then
    echo "complexity.sh swallowed a failing Radon MI check" >&2
    cat "$FAKE_BIN/output.log" >&2
    exit 1
fi

grep -q "Maintainability Index" "$FAKE_BIN/output.log"
echo "Radon MI failure propagates"
