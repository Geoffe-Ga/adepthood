# grounding-techniques-05: Build `TalliedGroundingView` (frontend)

**Labels:** `frontend`, `feature`, `practice`
**Epic:** [Generalize grounding techniques](grounding-techniques-epic.md)
**Depends on:** [grounding-techniques-01](grounding-techniques-01-tallied-mode-backend.md)
**Estimated LoC:** ~250

## Role

You are a React Native engineer extending Adepthood's ritual session
engine. You add a new view component, wire it into the engine
dispatcher, and ship a comprehensive test file.

## Goal

Build `TalliedGroundingView` to drive the **Find Shapes** and **Find
Colors** ritual UX off a `TalliedGroundingConfig`. The view should:

- Show "Round R of N — Find a {label} ({count} of {target})"
- Advance one tap at a time through `rounds × categories × target_count`
- Show a Complete card on the final tap and surface `onSave`
- Emit `TalliedGroundingMetadata` to the parent on completion

## Context

The reference view is
`frontend/src/features/Practice/views/SenseGroundingView.tsx`. It uses:

- `RitualState`, `RitualControls`, and the discriminated config type
  from `frontend/src/features/Practice/engine/types.ts`
- `controls.tap()` to advance steps
- A `CompleteCard` rendered when `state.status === 'complete' ||
  state.currentStepIndex >= total`

The dispatcher lives at
`frontend/src/features/Practice/components/ActiveRitualSession.tsx` —
it picks a view based on `effectiveConfig.mode` and threads
state/controls/onSave through.

Today the engine state is step-indexed (`currentStepIndex`). For
tallied grounding, total steps = `rounds × sum(category.target_count)`.
The view derives the current `(round, category, item_in_category)` from
the linear `currentStepIndex` without changing the engine's state shape.

## Tasks

1. **Add types to `frontend/src/features/Practice/engine/types.ts`**
   - `TalliedCategory`: `{ key: string; label: string; target_count: number }`
   - `TalliedGroundingConfig`: `{ mode: 'tallied_grounding'; rounds:
     number; categories: readonly TalliedCategory[] }`
   - Extend the `RitualConfig` union to include `TalliedGroundingConfig`.
   - Mirror in any `RitualMetadata`-style discriminated union:
     `TalliedGroundingMetadata`: `{ mode: 'tallied_grounding';
     rounds_completed: number; total_rounds: number; items_completed:
     number }`.

2. **Build `frontend/src/features/Practice/views/TalliedGroundingView.tsx`**
   - Props: `{ config: TalliedGroundingConfig; state: RitualState;
     controls: RitualControls; onSave?: () => void }`
   - Helpers:
     - `totalStepsPerRound(config) = sum(c.target_count for c in
       categories)`
     - `totalSteps(config) = config.rounds * totalStepsPerRound(config)`
     - `decompose(stepIndex, config) → { roundIndex, category,
       itemInCategory }` (1-based for display, 0-based internally)
   - Header reads: e.g. `Round 2 of 3` + `Find a square (1 of 3)`.
     Pull badge text from a `BADGE_BY_MODE` map for now — for tallied
     grounding the badge is dynamic, e.g. computed from the categories
     ("3×3×3" or "Rainbow"). Keep it simple: derive a short badge from
     `config.categories.length` and `config.rounds`.
   - Render the same `Begin grounding` / `Pause` / `Reset` controls
     bar (`RitualControlsBar`) — reuse, don't duplicate.
   - On the final tap, transition to the complete card (same pattern as
     `SenseGroundingView`).

3. **Wire dispatcher**
   - In
     `frontend/src/features/Practice/components/ActiveRitualSession.tsx`,
     add a case for `mode === 'tallied_grounding'` that renders
     `TalliedGroundingView` and translates engine state into
     `TalliedGroundingMetadata` on completion. Use the same pattern as
     the existing `sense_grounding` branch.

4. **API client types**
   - Update `frontend/src/api/` types if practice config / metadata is
     mirrored there. Match the backend Pydantic shapes precisely.

5. **Tests** — `frontend/src/features/Practice/views/__tests__/TalliedGroundingView.test.tsx`
   - Renders header "Round 1 of 3" on initial state
   - Renders the first category's label on initial state
   - Tapping `tap()` 9 times (for 3×3 Find Shapes config) advances
     into Round 2
   - Tapping through all steps shows the Complete card
   - Pressing Save fires `onSave`
   - Snapshot for the complete card (optional)

## Acceptance Criteria

- [ ] `npm run lint` clean
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` green; new tests are isolated and don't leak fixtures
- [ ] `ActiveRitualSession` dispatches `tallied_grounding` to
      `TalliedGroundingView`
- [ ] Manual smoke: start a Find Shapes session in dev → tap through →
      save → session row appears with `mode_metadata.mode =
      "tallied_grounding"`
- [ ] No changes to `SenseGroundingView` behavior or tests

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/engine/types.ts` | Modify |
| `frontend/src/features/Practice/views/TalliedGroundingView.tsx` | **Create** |
| `frontend/src/features/Practice/views/__tests__/TalliedGroundingView.test.tsx` | **Create** |
| `frontend/src/features/Practice/components/ActiveRitualSession.tsx` | Modify |
| `frontend/src/api/` (types module) | Possibly modify |

## Constraints

- Do not alter the engine's state shape — derive `(round, category,
  item)` from `currentStepIndex`. The engine remains mode-agnostic.
- Reuse `RitualControlsBar` and existing complete-card patterns; don't
  fork them.
- Mode dispatch happens in **one** place
  (`ActiveRitualSession.tsx`). Do not introduce additional branching on
  mode anywhere else.
- Match design tokens (`@/design/tokens`) used by `SenseGroundingView`.

## Example state decomposition

```
config = { rounds: 3, categories: [
  { key: "squares",   target_count: 3 },
  { key: "triangles", target_count: 3 },
  { key: "circles",   target_count: 3 },
]}
totalStepsPerRound = 9
totalSteps = 27

currentStepIndex = 0  → Round 1, "squares",   item 1 of 3
currentStepIndex = 4  → Round 1, "triangles", item 2 of 3
currentStepIndex = 9  → Round 2, "squares",   item 1 of 3
currentStepIndex = 27 → complete
```
