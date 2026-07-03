# map-legibility-05: Darken the left column; lighten UNITY/EMPTINESS and stop their overflow

**Labels:** `frontend`, `ux`, `design`, `priority-critical`
**Epic:** [Map screen legibility](map-legibility-epic.md)
**Depends on:** nothing (touches `mapLayout.ts` — rebase after 02/04 if run in parallel)
**Estimated LoC:** ~90

## Problem (RCA)

Three related contrast/overflow defects, in the founder's words: "the left
hand of the graph [should] be a slightly darker color, up to the box saying
UNITY (which doesn't need to move except not to overflow) and EMPTINESS
(same) which should be a lighter color."

1. **Left column too light:** the stage text (persona/descriptor/practice)
   renders directly in each stage's `textColor` (`MapScreen.tsx:139-141`,
   palette at `mapLayout.ts:69-150`). Several hues (`#cdb079`, `#dc9a5b`,
   `#7cb273`) are too light on the parchment ground — thin-Aspect rows drop
   to 0.55 opacity on top of that (`wheelBalance.emphasisStyle`), pushing
   them below comfortable legibility.
2. **Watermarks too heavy:** the UNITY / EMPTINESS serif titles
   (`TITLE_BY_STAGE`, `mapLayout.ts:59-62`; `titleText`,
   `Map.styles.ts:162`) should read as a *lighter* backdrop than the stage
   text, not compete with it.
3. **EMPTINESS overflows:** at its fixed font size the word runs past the
   right edge of the screen (visible in the screenshot). The titles must
   not move — just fit.

**Root cause:** one shared `textColor` serves three jobs (left text, wave
stroke, arrowheads), so the palette was tuned for the artwork, not for text
legibility; and `titleText` uses a fixed size with letter-spacing that
exceeds narrow screens.

**Reproduce (Red):** a contrast unit test on today's `textColor` values
against the parchment ground fails 4.5:1 for the light hues; a render test
on the EMPTINESS row shows no width constraint/fit behavior on `titleText`.

## Scope

Split "text color" from "artwork color" so the left column can darken
without touching the helix; lighten the two watermark titles; make both
titles fit any supported width without moving.

## Tasks — tests first (Red)

1. `mapLayout.test.ts`: assert every `STAGE_DISPLAY` entry exposes a new
   `leftTextColor` that (a) is a darkened variant of `textColor` (strictly
   lower relative luminance) and (b) meets WCAG AA 4.5:1 against the Map's
   parchment background token for stages 1–8 (reuse the contrast helper the
   design-token tests already use).
2. `MapScreen.test.tsx`: assert the left-column texts render
   `leftTextColor` (not `textColor`), and that the wave overlay + arrowheads
   still receive the original `textColor` (geometry tests stay untouched).
3. `MapScreen.test.tsx`: assert the title rows (UNITY, EMPTINESS) render
   with the new lighter watermark color token and a fit strategy
   (`adjustsFontSizeToFit` + `numberOfLines={1}`) so they cannot overflow.

## Tasks — implementation (Green, then Refactor)

1. `mapLayout.ts`: add `leftTextColor` per stage — precomputed darkened hex
   values (documented derivation, e.g. same hue ~15% lower lightness; no
   runtime color math needed) with a docstring stating the AA contract.
   The wave keeps `textColor` untouched.
2. `MapScreen.tsx`: `StageTextBlock` uses `display.leftTextColor` for all
   three lines.
3. `Map.styles.ts`: `titleText` moves to a lighter ink (a soft watermark
   tone consistent with Candle & Ink tokens — lighter than today's value)
   and gains the fit constraints; verify UNITY/EMPTINESS keep their current
   vertical positions (no layout moves — same rows, same order).
4. Refactor: if the darkened palette duplicates values, name them once;
   keep zero magic numbers (every hex documented next to its base hue).

## Acceptance Criteria

- Left-column stage text is visibly darker than today and passes AA (4.5:1)
  on the parchment ground at full (alive) opacity for stages 1–8.
- The helix strands and arrowheads are pixel-identical to before (same
  `textColor` inputs — existing geometry/overlay tests unchanged).
- UNITY and EMPTINESS render lighter than the stage text, in their current
  positions, fully on-screen at 320–430 pt widths — no overflow, no
  wrapping.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` pass.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Map/mapLayout.ts` | Modify — `leftTextColor` palette |
| `frontend/src/features/Map/MapScreen.tsx` | Modify — left column uses it |
| `frontend/src/features/Map/Map.styles.ts` | Modify — lighter, fitted `titleText` |
| `frontend/src/features/Map/__tests__/mapLayout.test.ts` | Modify — contrast contracts |
| `frontend/src/features/Map/__tests__/MapScreen.test.tsx` | Modify — color/fit contracts |
