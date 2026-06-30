# design-act2-13: Re-architect the Map onto a single responsive row grid

**Labels:** `frontend`, `ux`, `design`, `bug`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** — (structural foundation; **#833 / 09 builds on this**)
**Estimated LoC:** ~420 (the larger end — see the phasing note; split only along the
two phases below, never shipping a half-migrated Map)

## Problem

On a real phone (`app.aptitude.guru`, ~390 pt wide) the Map's three-column
"spiral of becoming" renders **garbled** (screenshot `IMG_3973`): the "EMPTINESS
UNITY" title overlaps the top stage rows, the right-column aspect labels clip
off-screen mid-word ("Awarenes / s", "Understan / ding"), and the center
aspect-labels collide with their lock icons. These are **not independent style
bugs — they are symptoms of one architectural choice**, so we fix the
architecture rather than patch the symptoms (the original framing of this issue).

### Root cause: two coordinate systems forced to agree

The Map computes the *same* 10-stage vertical grid **twice, with two different
layout engines that cannot stay in sync**:

- **Left + right columns** are a flexbox table of 6 `MAP_ROWS`, each cell
  weighted `flex: row.stageNumbers.length` (`MapScreen.tsx:114-118`,
  `LeftTextColumn` `:144-157`, `RightLabelColumn` `:161-169`). Vertical position
  is **content/flex-driven** and intrinsically sized to the text.
- **Center column** is a stack of **absolute, percentage-positioned overlays**:
  hotspots at `top: index*10%` (`stageData.ts:64-74`, `ArrowHotspot`
  `MapScreen.tsx:178-210`), grey bands pinned at `top: 20%`
  (`Map.styles.ts:156-171`), arrow labels keyed to each hotspot band
  (`bandPosition` `MapScreen.tsx:173-176`, `ArrowLabel` `:212-220`), and the
  title at a fixed `top:0; height:20%` (`SpiralTitle` `:222-229`,
  `titleOverlay`/`titleText` `Map.styles.ts:185-200`).

Nothing makes "row *i*'s vertical position" a single value the columns share —
they merely *coincide* on the design device and drift on any other size or text
length. The visible defects fall straight out of this:

| Symptom | Architectural cause |
|---|---|
| Title overlaps the top stage rows | `titleText` is a **fixed `fontSize: 40`** (`Map.styles.ts:197`) in a ~40 %-width column → it overflows its box and bleeds across rows; the overlay's 20 % band is unrelated to where the left rows actually fall. |
| Right labels clip / break mid-word | `rightColumn` is a hardcoded `width: '20%'` (`Map.styles.ts:108`) with `fontSize: 16` — too narrow for "Understanding" / "Receptivity". |
| Center label overlaps its lock | `arrowLabelWrap` (full-width, centered) and the `LockOverlay` (filling the 46 %-wide side-band hotspot) are **independent absolute layers** with no shared layout (`Map.styles.ts:72-85, 172-178`). |
| "Self-" looks truncated | It is **incomplete data** — `arrowLabel: 'Self-'` (`mapLayout.ts:111`), not a render bug. |
| Stray faint box near it | The current-stage marker is a barely-visible `hotspotCurrent` 2 px `glowLight` border (`Map.styles.ts:60-64`). |

Compounding all of this: the geometry keys off a hosted spiral **PNG
(`MAP_BACKGROUND_URI`) that is frequently not configured** — there is a branded
blank fallback (#766) — so in production the absolute-% bands often float over an
empty center with no artwork to justify them.

## Scope

Replace the dual-layout system with **one responsive row grid that is the single
source of truth for every row's vertical position**, then hang all three columns
off it as flex siblings so they can no longer drift. Retire the absolute-%
center overlays and the layout dependency on the hosted PNG. **Layout +
structure**; preserve every tap target, testID, modal, lock/complete state, and
accessibility label. The journey-narrative redesign (#833 / 09) then builds its
showcase modal + "you are here" read on this stable grid.

This is deliberately **not** a redesign of the Map's *meaning* (the spiral, the
personas, the aspects, the feminine/masculine polarity all stay) — only its
*layout architecture*.

## The target architecture

A single `MapGrid` whose rows are the authoritative grid. Each **stage** is one
grid row rendered as a flex triplet so the three columns are structurally locked
together:

```
<MapGrid>                       // one source of truth: the row list
  for each stage (10..1):
    <MapRow>                    // flex row; height intrinsic but SHARED by all 3 cells
      <LeftCell>  persona / descriptor / practice (tap → modal)   </LeftCell>
      <CenterCell> arrow glyph · arrow label · lock · ✓ badge (tap → modal) </CenterCell>
      <RightCell> aspect label (spans its 1–2 stage rows via rowSpan/flex) </RightCell>
    </MapRow>
```

Because the left text, the center arrow/label/lock/badge, and the right aspect
for a stage are **children of the same row**, they cannot misalign — alignment
becomes structural, not coincidental.

## Tasks

### Phase 1 — the shared grid skeleton

1. **One grid model.** Derive the grid from a single structure (reuse/extend
   `MAP_ROWS` + `STAGE_DISPLAY`); render `MapGrid` → per-stage `MapRow` →
   `[LeftCell | CenterCell | RightCell]` flex siblings. The right aspect label
   spans its 1–2 stage rows (a tall right cell beside the row group, via a nested
   flex group — mirroring today's `flex: stageNumbers.length`, but now in the
   **same** row container as the center cells).
2. **Move the center off absolute-%.** The hotspot tap target, arrow label, lock
   overlay, and completed badge become **children of `CenterCell`** laid out by
   flexbox (label and lock in a row with a gap → no overlap). Delete the
   percentage band geometry: `HOTSPOTS`/`bandPosition`/`ARROW_*` constants
   (`stageData.ts:39-74`, `MapScreen.tsx:173-176`) and the `arrowLabelWrap` /
   `hotspot` absolute styles.
3. **Preserve contracts.** Keep both tap targets per stage — `stage-hotspot-{n}-0`
   (left) and `stage-hotspot-{n}-1` (center) — the `stage-complete-{n}` badge,
   tap → detail modal, lock/unlock + completed visuals, and the existing
   `accessibilityLabel`s. No backend/data-shape change beyond task 7.

### Phase 2 — the visual layer on the grid

4. **Artwork becomes non-authoritative.** Stop driving geometry from the hosted
   PNG. Render a per-stage directional **arrow glyph** inside `CenterCell` (a
   simple SVG/`View` chevron in the stage's own `textColor`, pointing left vs
   right by the existing parity rule `isLeftReturning`), so the spiral reads even
   with no PNG configured (the common case, #766). If `MAP_BACKGROUND_URI` *is*
   set, keep it only as an optional **decorative** backdrop behind the grid —
   never as a layout/alignment driver.
5. **Responsive title.** Render "EMPTINESS / UNITY" from the type ramp
   (`type(width).display` / scaled `editorialType`) placed in its **own grid
   area** (the top rows' center gutter, or a faint `pointerEvents:'none'`
   watermark behind the rows) — capped to width so it never overflows or overlaps
   the rows. No fixed `40 px`.
6. **Responsive aspect labels + grey bands.** Size the right aspect label from
   the ramp (`type().label`) with a column width that fits the longest label
   ("Understanding") and no mid-word break. Re-express the feminine/masculine
   grey bands as **per-cell backgrounds** on the center cells of their rows
   (`mapLayout`-driven), not an absolute `top:20%` overlay.
7. **Data + state polish.** Complete the `'Self-'` arrow label
   (`mapLayout.ts:111`) to its full aspect term; replace the barely-visible
   `hotspotCurrent` glow border with a legible current-stage marker on the cell
   (coordinate the visual with #833, which owns "you are here" emphasis).

## Tasks — tests

- `MapScreen.test.tsx`: rebuild around the grid. Assert there is **no**
  absolute-`top: '%'` band geometry left (the grid is the source of truth); each
  stage row contains its left text, center arrow/label/lock, and right aspect as
  co-located nodes; both `stage-hotspot-{n}-0/-1` testIDs, `stage-complete-{n}`,
  tap → modal, and lock/complete states still work; the title renders without
  sharing the top rows' space; right labels render in full (no empty/duplicated
  fragments); the full "Self-…" term renders.
- A narrow-width render (small `useWindowDimensions`) asserts no label clips and
  the grid stays single-screen-legible; a **no-`MAP_BACKGROUND_URI`** render
  asserts the arrows/labels still read.

## Acceptance Criteria

- The Map is laid out by a **single responsive row grid**; no second
  (absolute-percentage) coordinate system remains, so columns cannot drift.
- The title, aspect labels, and center labels are responsive and never overlap
  the rows or the lock icons; the "Self-…" term is complete; the current-stage
  marker is legible (no stray faint box).
- The Map renders cleanly **with or without** a configured spiral PNG and across
  phone widths; the spiral artwork’s *meaning* (personas, aspects, polarity,
  per-stage colors) and all tap/lock/complete behaviour + testIDs are preserved.
- Token-only, AA-clearing, 44 dp targets, no magic numbers;
  `cd frontend && npm test && npm run lint && npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Map/MapGrid.tsx` | **Create** — the row-grid + cells |
| `frontend/src/features/Map/MapScreen.tsx` | Modify — render via `MapGrid`; drop the dual layout |
| `frontend/src/features/Map/Map.styles.ts` | Modify — grid/cell styles; delete absolute band/overlay styles |
| `frontend/src/features/Map/mapLayout.ts` | Modify — single grid model; complete `'Self-'` |
| `frontend/src/features/Map/stageData.ts` | Modify — delete `HOTSPOTS`/`ARROW_*` %-geometry |
| `frontend/src/features/Map/__tests__/MapScreen.test.tsx` | Modify — grid-based assertions |
