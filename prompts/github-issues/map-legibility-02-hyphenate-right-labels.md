# map-legibility-02: Hyphenate the right-column Aspect labels instead of truncating

**Labels:** `frontend`, `ux`, `bug`, `priority-critical`
**Epic:** [Map screen legibility](map-legibility-epic.md)
**Depends on:** nothing (touches `mapLayout.ts` — rebase after 01 if run in parallel)
**Estimated LoC:** ~60

## Problem (RCA)

The right column renders "Understan…" and "Yes-And-…" on a real phone.

**Root cause:** `MapScreen.tsx:316-325` renders each `row.rightLabel` with
`numberOfLines={1}`, `adjustsFontSizeToFit`, and
`minimumFontScale={RIGHT_LABEL_MIN_FONT_SCALE}` (0.55, `mapLayout.ts:27`).
The scale floor was tuned for a ~48 pt band ("Understanding" at 0.55,
per the constant's own docstring), but the real rendered band is narrower
than that model, so RN hits the floor and falls back to ellipsis —
mid-word truncation. Shrink-to-fit is the wrong tool: it degrades to
truncation whenever the width model is off, and RN has no reliable
cross-platform auto-hyphenation.

**Reproduce (Red):** a unit test on the new layout data (below) fails
against today's `MAP_ROWS`; at component level, rendering the
"Understanding" row inside a narrow right cell shows the font-scale floor +
single-line config that produces the ellipsis.

## Scope

Replace shrink-to-fit with **explicit, correctly-placed hyphenation**: long
labels declare their own two-line break; short labels stay on one line at
full size. The break points, chosen at correct syllable boundaries:

- `Understanding` → `Under-` / `standing`
- `Yes-And-Ness` → `Yes-And-` / `Ness` (breaks at its existing hyphen — no
  doubled hyphen)
- `Awareness`, `Being`, `Wisdom`, `Love` → unchanged, single line

## Tasks — tests first (Red)

1. `mapLayout.test.ts`: assert every `MAP_ROWS` entry exposes
   `rightLabelLines` (non-empty, ≤ 2 lines, ≤ 9 chars per line so the
   longest line fits the band at full font size); assert
   `rightLabelLines.join('')` equals the label with any trailing `-`
   removed per line (i.e., lines rejoin to the original word); assert the
   exact lines for Understanding and Yes-And-Ness above.
2. `MapScreen.test.tsx`: assert the rendered right-label Text no longer sets
   `adjustsFontSizeToFit`/`minimumFontScale`, renders both lines, and that
   `map-row-Understanding` keeps its testID (rows are keyed by
   `rightLabel`, which does not change).

## Tasks — implementation (Green, then Refactor)

1. `mapLayout.ts`: add `rightLabelLines: readonly string[]` to `MapRow`
   (derived data next to `rightLabel`, which remains the row key/testID).
   Delete `RIGHT_LABEL_MIN_FONT_SCALE` and its docstring.
2. `MapScreen.tsx`: render `row.rightLabelLines.join('\n')` (or map to
   nested `<Text>` lines) with `numberOfLines={2}`; drop
   `adjustsFontSizeToFit` + `minimumFontScale`.
3. `Map.styles.ts`: set a line height on `rightLabelText` so the two-line
   labels stay vertically centered in their row band without pushing
   neighbors.

## Acceptance Criteria

- No right-column label ever shows an ellipsis or a shrunken font; the two
  long labels break exactly as specified, hyphen visible on the first line.
- Row testIDs (`map-row-<rightLabel>`) are unchanged.
- `RIGHT_LABEL_MIN_FONT_SCALE` no longer exists anywhere in the codebase.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` pass.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Map/mapLayout.ts` | Modify — `rightLabelLines`, drop min-font-scale |
| `frontend/src/features/Map/MapScreen.tsx` | Modify — two-line render |
| `frontend/src/features/Map/Map.styles.ts` | Modify — line height |
| `frontend/src/features/Map/__tests__/mapLayout.test.ts` | Modify — line-data contract |
| `frontend/src/features/Map/__tests__/MapScreen.test.tsx` | Modify — render contract |
