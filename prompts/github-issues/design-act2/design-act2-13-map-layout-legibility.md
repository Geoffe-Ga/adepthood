# design-act2-13: Fix the garbled Map layout — title overlap, clipped labels, overlap & truncation

**Labels:** `frontend`, `ux`, `design`, `bug`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** — (legibility foundation; **#833 / 09 builds on this**)
**Estimated LoC:** ~220

## Problem

On a real phone (`app.aptitude.guru`, ~390 pt wide) the Map's three-column
"spiral of becoming" renders **garbled** — this is a legibility/layout bug, not
a styling preference. From the captured screenshot (`IMG_3973`):

1. **The "EMPTINESS UNITY" title collides with the top stage rows.** The large
   serif title is absolutely overlaid across the center and lands on top of the
   first two rows — *Whole Adept / Pure Awareness / Cultivate Vipassana* and
   *Blissy Adept* — making both the title and those rows unreadable. The title is
   a fixed ~40 px serif (`Map.styles.ts` title block, ~`:179-200`,
   `editorialType.serif`) positioned over content (`MapScreen.tsx` CenterColumn,
   ~`:239-273`) with no clear channel of its own.
2. **Right-column "aspect" labels clip off the screen edge and break mid-word** —
   "Awareness" renders as "Awarenes / s", "Understanding" as "Understan / ding".
   The right column (~20 % width per the layout survey) is too narrow for its
   longest labels (Awareness, Understanding, Receptivity, Yes-And-Ness) and they
   run past the right edge.
3. **Center aspect-labels overlap the lock icons and one is truncated.**
   "Systems 🔒", "Intellectual🔒", "Community 🔒" sit on top of their locks; the
   "Self-…" aspect is cut to a bare "**Self-**"; and a stray empty box artifact
   renders next to it (likely an un-sized/!empty overlay node).

## Scope

Make the Map render cleanly and legibly on phone widths: give the title its own
non-colliding treatment, stop the right-column labels clipping/breaking, and
separate the center labels from the lock icons (and fix the "Self-" truncation +
stray box). **Layout/legibility only** — do not redraw the spiral artwork, change
hotspot geometry (`stageData.ts`), or alter tap/lock/badge behaviour. This lands
the legible layout that #833 (Map narrative) then builds its showcase modal +
journey read on top of.

## Tasks

### 1. Give the title a non-colliding treatment

In `MapScreen.tsx` (CenterColumn) + `Map.styles.ts` (title block):
- Move "EMPTINESS UNITY" into the genuinely empty **central vertical channel**
  (between the connection line and the columns) rather than overlaying the top
  stage rows, **or** render it as a true faint watermark *behind* content
  (`zIndex` below the rows, low opacity, `pointerEvents: 'none'`). Prefer the
  contained-in-the-center-channel option.
- Size it **responsively** from the type ramp (`type(width).display` /
  `editorialType` scaled by `useWindowDimensions`), not a fixed 40 px, and cap by
  available width so it never spills over the side columns or the top rows.

### 2. Stop the right-column labels clipping

- Widen the right column enough for its longest label, or reduce its font
  responsively, and add `flexShrink`/horizontal padding so text never runs off
  the right edge. Allow a clean wrap (no mid-word break) — e.g. `numberOfLines`
  with `adjustsFontSizeToFit`, or a width that fits "Understanding" on one line.
- Verify all eight aspect labels (Awareness, Being, Wisdom, Understanding, Love,
  Yes-And-Ness, plus the two short ones) fit without clipping at narrow width.

### 3. Separate center labels from locks; fix truncation + stray box

- Space the center aspect-label and its lock icon so they never overlap (gap /
  row layout instead of an absolutely-positioned lock over the text).
- Fix the truncated "Self-…" aspect so its full term renders (no mid-word cut),
  and remove the stray empty box node rendering beside it.

### 4. Responsive verification

- Confirm the three columns fit within the content width on a narrow phone
  (~360–414 pt): cap to a max content width and scale type by the existing
  breakpoints so nothing clips horizontally on small or large devices.

## Tasks — tests

- `MapScreen.test.tsx`: the title node no longer shares vertical space with the
  top stage rows (assert it sits in the center channel / behind, e.g. via its
  style or a `pointerEvents: 'none'` watermark); right-column labels render their
  full strings (no truncated/duplicated fragments); center labels and locks are
  distinct nodes with non-overlapping layout; the "Self-" aspect renders its full
  term. Hotspot geometry / tap targets unchanged.
- A narrow-width render test (small `useWindowDimensions`) asserts no label is
  empty/clipped.

## Acceptance Criteria

- The "EMPTINESS UNITY" title no longer overlaps or garbles the top stage rows
  and is legible at every phone width.
- Right-column aspect labels render in full with no mid-word break or off-edge
  clipping.
- Center labels don't overlap their lock icons; the "Self-…" aspect shows its
  full term; the stray empty box is gone.
- The Map renders cleanly across phone widths; spiral artwork, hotspot geometry,
  and all tap/lock/badge behaviour are unchanged.
- Token-only, AA-clearing, no magic numbers; `cd frontend && npm test &&
  npm run lint && npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Map/MapScreen.tsx` | Modify — title placement, center-label/lock layout |
| `frontend/src/features/Map/Map.styles.ts` | Modify — responsive title, right-column width/wrap, label/lock spacing |
| `frontend/src/features/Map/mapLayout.ts` | Modify (if needed) — column width metrics |
| `frontend/src/features/Map/__tests__/MapScreen.test.tsx` | Modify — legibility assertions |
