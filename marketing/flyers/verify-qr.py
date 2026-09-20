"""Verify that every rendered flyer contains the QR code it is supposed to.

Locates the white QR plate in each `out/*.png`, samples its module grid, and
compares it against the matrix segno produces for that flyer's tracking URL.
A distorted, stale or mis-wired QR fails here rather than on a noticeboard.

Usage:  python3 verify-qr.py
"""

from __future__ import annotations

import json
import pathlib
import sys

import segno

import pngtool

HERE = pathlib.Path(__file__).parent
QUIET_ZONE = 4          # modules of white the SVGs are generated with
PLATE_MIN_RUN = 150     # px; narrower white runs are text, not the QR plate
PLATE_WHITE = 248       # the plate is pure #ffffff; the page ground is #faf6ef
SEARCH_FROM = 0.75      # the QR always sits in the bottom quarter; a white
                        # illustration card higher up must not be mistaken for it
SQUARE_TOL = 0.06       # the plate is square, so reject runs that are not
MIN_MODULE_MM = 0.4     # below this, phone cameras start to struggle


def _luma(px: bytes, w: int, ch: int, x: int, y: int) -> int:
    i = (y * w + x) * ch
    return (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) // 1000


def _longest_white_run(px: bytes, w: int, ch: int, y: int, xlim: int) -> tuple[int, int]:
    best = cur = start = best_start = 0
    for x in range(xlim):
        i = (y * w + x) * ch
        if px[i] >= PLATE_WHITE and px[i + 1] >= PLATE_WHITE and px[i + 2] >= PLATE_WHITE:
            if cur == 0:
                start = x
            cur += 1
            if cur > best:
                best, best_start = cur, start
        else:
            cur = 0
    return best, best_start


def check(png: pathlib.Path, url: str) -> tuple[bool, str]:
    """Return (ok, detail) for one rendered flyer."""
    expected = [list(row) for row in segno.make(url, error="h").matrix]
    n = len(expected)
    full = n + 2 * QUIET_ZONE

    w, h, ch, px = pngtool.read(png)
    top = int(h * SEARCH_FROM)
    rows = [(y, *_longest_white_run(px, w, ch, y, w // 2)) for y in range(top, h)]
    side = max((run for (_, run, _) in rows), default=0)
    if side < PLATE_MIN_RUN:
        return False, "no QR plate found"

    # keep only the rows that are the full width of the plate
    plate = [(y, run, x) for (y, run, x) in rows if run >= side - 2]
    height = plate[-1][0] - plate[0][0] + 1
    if abs(height - side) > SQUARE_TOL * side:
        return False, f"plate not square ({side}x{height}px)"

    x0 = min(x for (_, _, x) in plate)
    y0 = plate[0][0]
    module = side / full

    got = [
        [
            1 if _luma(px, w, ch,
                       int(x0 + (c + QUIET_ZONE + 0.5) * module),
                       int(y0 + (r + QUIET_ZONE + 0.5) * module)) < 128 else 0
            for c in range(n)
        ]
        for r in range(n)
    ]
    wrong = sum(got[r][c] != expected[r][c] for r in range(n) for c in range(n))
    mm = module / 192 * 25.4          # the proofs render at 2x of 96dpi
    detail = f"{n}x{n} modules, {mm:.2f}mm each, {wrong} wrong"
    return wrong == 0 and mm >= MIN_MODULE_MM, detail


def main() -> int:
    targets = json.loads((HERE / "assets" / "qr-targets.json").read_text())
    failures = 0
    for png in sorted((HERE / "out").glob("*.png")):
        kind, _number, venue = png.stem.split("-", 2)
        url = targets[f"qr-{kind}-{venue}"]
        ok, detail = check(png, url)
        print(f"{'PASS' if ok else 'FAIL'}  {png.name:26s} {detail}")
        print(f"      -> {url}")
        failures += not ok
    print(f"\n{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
