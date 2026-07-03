# map-legibility-01: Remove the explainer trigger + balance summary (the two overlapping elements)

**Labels:** `frontend`, `ux`, `bug`, `priority-critical`
**Epic:** [Map screen legibility](map-legibility-epic.md)
**Depends on:** nothing
**Estimated LoC:** ~90 (mostly deletions)

## Problem (RCA)

Two pieces of Map chrome overlap the spiral grid at phone heights (both
circled in the founder's screenshot):

1. **"How the Wavelength works"** — the explainer trigger rendered inside
   `JourneyHeader` (`MapScreen.tsx:748-756`, label constant at `:731`, style
   `explainerTrigger` at `Map.styles.ts:252`). It sits directly under the
   "Stage N of 10 · Week W" line and collides with the EMPTINESS watermark
   and the top grid rows.
2. **The balance summary** — `BalanceSummary` (`MapScreen.tsx:835-843`,
   mounted at `:969`, style `balanceSummary` at `Map.styles.ts:297`) renders
   `BALANCE_COPY[summaryFor(...)]` ("Your balance right now: some Aspects are
   alive, others are still thin.") beneath the grid, crowding the stage-1 row
   and overflowing its band.

**Root cause:** the Map column stacks header + grid + summary + banners into
a fixed viewport; the grid flexes, but the two text blocks claim vertical
space the spiral needs, so at phone heights they visually collide instead of
compressing. The founder's call: **remove both elements** rather than
squeeze the spiral further.

**Reproduce:** render `MapScreen` at a 390×844 viewport (existing
`MapScreen.test.tsx` harness) — `wavelength-explainer-trigger` and
`balance-summary` testIDs are both present; on device they overlap the grid.

## Scope

Remove both elements and every piece of code that exists only to serve them.
The wheel-balance *emphasis* system (left-column opacity + a11y labels) stays
— only the summary sentence goes.

## Tasks — tests first (Red)

1. In `MapScreen.test.tsx`: assert `wavelength-explainer-trigger` and
   `balance-summary` are **absent** (`queryByTestId(...) toBeNull`). Update or
   delete tests that currently assert their presence
   (`WavelengthExplainerTrigger.test.tsx`, balance-summary assertions).
2. Keep the assertions that `journey-read` ("Stage N of 10 · Week W") and the
   left-column fullness emphasis / a11y suffixes still render.

## Tasks — implementation (Green, then Refactor)

1. `MapScreen.tsx`: delete the trigger `TouchableOpacity` from
   `JourneyHeader` and the `onOpenExplainer` plumbing
   (`EXPLAINER_TRIGGER_LABEL:731`, props at `:727`, handlers
   `handleOpenExplainer`/`handleCloseExplainer:1019-1020`, `explainerVisible`
   state `:1002`, the `<WavelengthExplainer>` mount `:984`).
2. Delete the now-unreachable explainer feature: `WavelengthExplainer.tsx`,
   `TorusSpiralVisual.tsx`, `torusGeometry.ts` and their tests
   (`WavelengthExplainer.test.tsx`, `WavelengthExplainerTrigger.test.tsx`,
   `TorusSpiralVisual.test.tsx`, `torusGeometry.test.ts`). Git history keeps
   the art if a future surface (e.g. Settings or Course) re-homes it — note
   that in the PR description.
3. `MapScreen.tsx`: delete `BalanceSummary` and its mount; in
   `wheelBalance.ts` delete `BALANCE_COPY`, `BalanceState`, and `summaryFor`
   (keep `FULLNESS_ALIVE_THRESHOLD` + `emphasisStyle` — the left column and
   a11y labels use them).
4. `Map.styles.ts`: delete `explainerTrigger`, `explainerTriggerText`,
   `balanceSummary`, and any explainer-sheet styles (`explainerVisual`, …)
   that ESLint/`tsc` now flag as unused.
5. Refactor pass: run the repo dead-code checks; nothing orphaned remains
   (no unused imports, copy, or test harness helpers).

## Acceptance Criteria

- Neither circled element renders; the grid gains their vertical space and
  nothing overlaps at 320–430 pt widths.
- `wheelBalance.ts` still exports exactly what the emphasis system needs;
  wheel-fullness opacity and a11y suffixes are unchanged.
- No orphaned components, styles, copy, or tests remain.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` pass;
  coverage thresholds hold.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Map/MapScreen.tsx` | Modify — remove trigger, explainer wiring, BalanceSummary |
| `frontend/src/features/Map/wheelBalance.ts` | Modify — drop `BALANCE_COPY`/`summaryFor`, keep emphasis |
| `frontend/src/features/Map/Map.styles.ts` | Modify — delete orphaned styles |
| `frontend/src/features/Map/WavelengthExplainer.tsx` | Delete |
| `frontend/src/features/Map/TorusSpiralVisual.tsx` | Delete |
| `frontend/src/features/Map/torusGeometry.ts` | Delete |
| `frontend/src/features/Map/__tests__/…` | Modify/Delete — matching test updates |
