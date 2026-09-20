#!/usr/bin/env bash
# Render every flyer in src/ to a print-ready PDF (out/*.pdf) and a 2x proofing
# PNG (out/*.png). Uses the Chromium bundled with this environment.
#
# The proof is rendered into a viewport TALLER than the page and then cropped:
# headless Chromium's usable viewport is ~88px shorter than --window-size asks
# for, which silently clips the bottom of an exactly-page-height screenshot.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/out"
CHROME="${CHROME:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}"

PAGE_W=816      # 8.5in @ 96dpi
PAGE_H=1056     # 11in  @ 96dpi
SLACK=200       # extra viewport height, cropped away afterwards
SCALE=2

[[ -x "$CHROME" ]] || { echo "Chromium not found at $CHROME" >&2; exit 1; }
mkdir -p "$OUT"

for html in "$HERE"/src/*.html; do
  name="$(basename "$html" .html)"
  echo "==> $name"

  "$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --run-all-compositor-stages-before-draw --virtual-time-budget=10000 \
    --no-pdf-header-footer --generate-pdf-document-outline=false \
    --print-to-pdf="$OUT/$name.pdf" "file://$html" 2>/dev/null

  "$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --run-all-compositor-stages-before-draw --virtual-time-budget=10000 \
    --window-size="$PAGE_W,$((PAGE_H + SLACK))" --force-device-scale-factor="$SCALE" \
    --screenshot="$OUT/$name.png" "file://$html" 2>/dev/null

  python3 -c "
import sys
sys.path.insert(0, '$HERE')
import pngtool
pngtool.crop('$OUT/$name.png', '$OUT/$name.png', 0, $((PAGE_H * SCALE)))
"
done

echo
ls -la "$OUT"
