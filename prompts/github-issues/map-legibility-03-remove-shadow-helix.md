# map-legibility-03: Remove the greyed-out shadow helix (far-side coil paths)

**Labels:** `frontend`, `ux`, `priority-critical`
**Epic:** [Map screen legibility](map-legibility-epic.md)
**Depends on:** nothing (06 depends on **this**)
**Estimated LoC:** ~60 (net deletion)

## Problem (RCA)

Behind the colored helix there is a second, partially-transparent, greyed-out
helix — the founder wants it gone.

**Root cause:** every wave segment deliberately carries a mirrored "far side"
path to fake a 3-D coil: `waveGeometry.ts` builds `farD` by reflecting the
near bezier across the column midline (`mirrorAcrossCenter:204`,
`segmentPaths:233-248`), and `WaveOverlay.tsx:67-76` renders all nine `farD`
paths first at `FAR_SIDE_OPACITY = 0.35` (`:26`). On the parchment ground the
faded mirror doesn't read as depth — it reads as a ghost/shadow duplicate
that doubles the visual noise exactly where the Aspect words sit (see issue
04).

**Reproduce (Red):** `WaveOverlay.test.tsx` — the overlay currently renders
18 `Path` elements for 10 stages (9 near + 9 far, testIDs `far-<n>`); the
desired contract is 9.

## Scope

Delete the far-side system entirely: geometry, render, constants, tests. One
helix, full opacity, nothing else.

## Tasks — tests first (Red)

1. `WaveOverlay.test.tsx`: assert no `far-*` testIDs render and the segment
   `Path` count equals `STAGE_COUNT - 1`; drop/replace the far-side opacity
   assertions.
2. `waveGeometry.test.ts`: update the `WaveSegment` contract tests — the
   type no longer has `farD`; keep all near-path (`d`) geometry assertions
   green and untouched.

## Tasks — implementation (Green, then Refactor)

1. `waveGeometry.ts`: remove `farD` from `WaveSegment`, collapse
   `segmentPaths` into the single near-path build, delete
   `mirrorAcrossCenter` and its docstring; update the module docstring
   (no more "three-dimensional coil" / far-side language).
2. `WaveOverlay.tsx`: delete the far-side `segments.map(...)` block and
   `FAR_SIDE_OPACITY`; update the component docstring likewise.
3. Refactor pass: no other caller references `farD` (verify with a repo-wide
   grep); docstrings and tests tell the single-helix story consistently.

## Acceptance Criteria

- Exactly one helix renders: 9 full-opacity colored segments + 10
  arrowheads; no faded/greyed strand anywhere.
- `farD`, `mirrorAcrossCenter`, and `FAR_SIDE_OPACITY` no longer exist in
  the codebase.
- All remaining geometry tests pass unchanged (near-path math is untouched).
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` pass.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Map/waveGeometry.ts` | Modify — delete far-side geometry |
| `frontend/src/features/Map/WaveOverlay.tsx` | Modify — delete far-side render |
| `frontend/src/features/Map/__tests__/waveGeometry.test.ts` | Modify — contract update |
| `frontend/src/features/Map/__tests__/WaveOverlay.test.tsx` | Modify — path-count contract |
