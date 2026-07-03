# map-legibility-06: Start/end each helix color at the center line

**Labels:** `frontend`, `ux`, `design`, `priority-critical`
**Epic:** [Map screen legibility](map-legibility-epic.md)
**Depends on:** [map-legibility-03](map-legibility-03-remove-shadow-helix.md) (rewrites the same segment builder; land 03 first)
**Estimated LoC:** ~130

## Problem (RCA)

Each helix color currently starts and ends at the **outside edges** of the
wave — the founder wants each color to start and end **on the center line**,
so a stage's hue owns the full swing it makes around its own anchor.

**Root cause:** `waveSegments` (`waveGeometry.ts:256-277`) draws one bezier
per stage *pair*, from stage *i*'s anchor to stage *i+1*'s anchor, colored
with stage *i*'s `textColor`. Anchors sit at the **pole extremes**
(`stageWavePoint:162-167`: `x = CENTER_X ± amplitude`), so every color
boundary lands at an outside edge. The center-line crossing happens *inside*
each segment: `bezierPath` (`:215-230`) places both control points at the
pair's vertical midpoint `midY`, so the curve crosses `x = (x1+x2)/2` — the
midline between the two poles — exactly at `t = 0.5`.

**Reproduce (Red):** a geometry test asserting "the two paths that meet at
stage *i*'s anchor share stage *i*'s color, and color boundaries sit at the
midline crossings" fails against today's anchor-to-anchor segments.

## Scope

Pure geometry change in `waveGeometry.ts` + trivially updated render map in
`WaveOverlay.tsx`. Split every stage-pair bezier at `t = 0.5` (de Casteljau)
into a lower and an upper half:

- the **lower half** (from stage *i*'s anchor out to the midline crossing)
  keeps stage *i*'s color;
- the **upper half** (from the midline crossing up to stage *i+1*'s anchor)
  takes stage *i+1*'s color.

Result: stage *i*'s color band runs midline-crossing → around its pole
extreme → midline-crossing; the first and last colors taper into the wave's
existing endpoints. The drawn shape is **identical** (a bezier split at t
reproduces the same curve) — only the coloring phase shifts.

## Tasks — tests first (Red)

1. `waveGeometry.test.ts`:
   - Split correctness: for a known width/height, the two halves' endpoints
     meet at `((x1+x2)/2, midY)` (computed from the de Casteljau midpoint),
     and the halves' joined geometry matches the original single-bezier
     path's t=0.5 subdivision (assert the control points numerically at
     `COORD_PRECISION`).
   - Color phase: for each stage 2–9, the segment *ending* at its anchor and
     the segment *starting* at its anchor both carry that stage's
     `textColor`; segment count is `2 × (STAGE_COUNT - 1)`.
   - Continuity: consecutive pieces share endpoint coordinates exactly (no
     gaps at the seams).
2. `WaveOverlay.test.tsx`: path count contract updates to 18 colored
   segments + 10 arrowheads; arrowhead colors unchanged.

## Tasks — implementation (Green, then Refactor)

1. `waveGeometry.ts`: add a documented cubic-bezier midpoint split (pure
   helper, named constants, no magic numbers — the t=0.5 de Casteljau
   points are simple averages). Rework `waveSegments` to emit
   lower/upper halves with the color rule above; extend `WaveSegment` with
   a stable identity for React keys/testIDs (e.g. `stageNumber` + a
   `'lower' | 'upper'` half tag).
2. `WaveOverlay.tsx`: key/testID off the new identity; rendering otherwise
   unchanged.
3. Refactor: update module + function docstrings to tell the
   colors-resolve-at-the-centerline story; confirm `arrowheadAt` and
   anchors are untouched.

## Acceptance Criteria

- Every color transition on the helix happens at a center-line crossing;
  each stage's hue wraps symmetrically around its own pole extreme and
  arrowhead.
- The helix's drawn geometry is unchanged (same curve, same anchors, same
  arrowheads) — only stroke coloring shifts phase.
- Geometry assertions are numeric (unit-space/pixel math), not snapshots.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` pass;
  coverage thresholds hold.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Map/waveGeometry.ts` | Modify — t=0.5 split, color phase |
| `frontend/src/features/Map/WaveOverlay.tsx` | Modify — keys/testIDs for halves |
| `frontend/src/features/Map/__tests__/waveGeometry.test.ts` | Modify — split/color/continuity contracts |
| `frontend/src/features/Map/__tests__/WaveOverlay.test.tsx` | Modify — count contract |
