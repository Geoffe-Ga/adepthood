# map-legibility-04: Corner-hug the Aspect labels, attach the unlock estimate, rename Self-Love

**Labels:** `frontend`, `ux`, `design`, `priority-critical`
**Epic:** [Map screen legibility](map-legibility-epic.md)
**Depends on:** nothing (touches `mapLayout.ts` + center cells — rebase after 01/02 if run in parallel)
**Estimated LoC:** ~150

## Problem (RCA)

The Aspect words in the center column (Agency, Receptivity, Self-Interest,
Community, Intellectual, Embodied, Systems, Nondual) are horizontally
**centered** in their cells — exactly where the helix strands converge — so
the helix draws through the words. Their "Unlocks in N days" estimate
renders as a separate centered line under the lock glyph, visually detached
from the word it describes.

**Root cause:**

- `CenterContent` (`MapScreen.tsx:149-162`) renders `display.arrowLabel`
  inside `centerLabelRow` (`Map.styles.ts:147`), which centers it in the
  cell; `centerStageCell` centers all children.
- `UnlockTimeline` is mounted as a *sibling* after the lock glyph
  (`MapScreen.tsx:193-196`), not grouped with the label.
- Stage 3's label is `'Self-Interest'` (`mapLayout.ts:132`) — the founder
  wants the Aspect named **Self-Love**.

**Founder's spec:** the words should hug **alternating corners of the center
panel** — Agency on the left, Receptivity on the right, Self-Love on the
left, Community on the right, and so on all the way up — with the unlock
estimate pulled along with its title word.

**Reproduce (Red):** new alignment unit test (below) fails against the
centered layout; `mapLayout.test.ts` currently pins stage 3 to
`'Self-Interest'`.

## Scope

Corner-anchor each Aspect word + its unlock estimate as one block, on the
side **opposite** the stage's wave pole. Stage parity gives the sides
mechanically: `isLeftReturning` (`stageData.ts:38`) says even stages swing
the wave left, odd stages right — so the label block goes **left for odd
stages** (Agency 1, Self-Love 3, Intellectual 5, Systems 7) and **right for
even stages** (Receptivity 2, Community 4, Embodied 6, Nondual 8), which
matches the founder's list exactly and keeps every word off the strand.
Stages 9/10 have no `arrowLabel` (title rows) and are untouched.

## Tasks — tests first (Red)

1. `mapLayout.ts` gains a pure helper `labelCorner(stageNumber): 'left' | 'right'`
   (odd → left, even → right, derived from `isLeftReturning`).
   `mapLayout.test.ts`: assert the full expected mapping for stages 1–8 and
   that stage 3's `arrowLabel === 'Self-Love'`.
2. `MapScreen.test.tsx`: assert the label block for a left stage (Agency)
   and a right stage (Receptivity) renders with the corresponding
   corner-alignment style (flatten and check `alignSelf`/alignment), and
   that for a **locked** stage the unlock estimate (`stage-unlock-<n>`)
   renders **inside the same block as** the Aspect word (e.g. both under one
   `aspect-label-<n>` testID), not as a detached sibling.
3. Keep existing contracts green: `stage-hotspot-<n>-1` tap targets, a11y
   labels, `you-are-here`, completed badge, connector.

## Tasks — implementation (Green, then Refactor)

1. `mapLayout.ts`: rename stage 3's `arrowLabel` to `'Self-Love'`; add
   `labelCorner` with a docstring explaining the opposite-of-the-pole rule.
   Check all fixtures/copy tests for the old string (repo-wide grep for
   `Self-Interest`).
2. `MapScreen.tsx`: restructure the center cell so `arrowLabel` +
   `UnlockTimeline` (when locked) render inside a single corner-anchored
   block (`aspect-label-<n>`), aligned per `labelCorner`; the lock glyph,
   YOU ARE HERE marker, badge, and connector keep their current centered
   behavior.
3. `Map.styles.ts`: replace `centerLabelRow` centering with corner-anchored
   variants (`labelBlockLeft` / `labelBlockRight`) hugging the cell's
   bottom-left / bottom-right corner; group the unlock estimate tight under
   the word (shared block, small gap, left/right text alignment matching
   the corner).
4. Refactor: `CenterContent` likely splits into title vs. label-block
   rendering; keep it a pure presentational function.

## Acceptance Criteria

- Aspect words hug alternating corners: Agency bottom-left, Receptivity
  right, Self-Love left, Community right, Intellectual left, Embodied right,
  Systems left, Nondual right — none of them under the helix strand.
- Stage 3 reads **Self-Love** everywhere on the Map (including the YOU ARE
  HERE cell when stage 3 is current).
- Each locked stage's "Unlocks in N days" sits directly with its Aspect
  word as one visual block, same corner, same alignment.
- Tap targets, a11y labels, and all center-cell testIDs keep working; touch
  targets stay ≥ 44 dp.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` pass.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Map/mapLayout.ts` | Modify — `Self-Love`, `labelCorner` |
| `frontend/src/features/Map/MapScreen.tsx` | Modify — corner-anchored label block |
| `frontend/src/features/Map/Map.styles.ts` | Modify — corner alignment styles |
| `frontend/src/features/Map/__tests__/mapLayout.test.ts` | Modify — corner + rename contracts |
| `frontend/src/features/Map/__tests__/MapScreen.test.tsx` | Modify — block/alignment contracts |
