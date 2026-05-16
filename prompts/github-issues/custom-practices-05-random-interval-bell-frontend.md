# custom-practices-05: Build `RandomIntervalBellView` + configurator form

**Labels:** `enhancement`, `ritual-practice`, `frontend`
**Epic:** [Customizable practices](custom-practices-epic.md)
**Depends on:** [custom-practices-01](custom-practices-01-random-interval-bell-backend.md)
**Estimated LoC:** ~250

## Role

You are a React Native engineer extending the ritual session engine with a new view for a non-deterministic timer, plus the configurator form so users can author the mode.

## Goal

Build `RandomIntervalBellView` (the session UI) and `RandomIntervalBellForm` (the configurator form). The view runs a meditation timer that schedules bells at random offsets within the configured bounds. The form lets a user set `min_interval_seconds`, `max_interval_seconds`, `duration_minutes`, `max_bells`, and `bell_tone`.

## Context

Reference view: `frontend/src/features/Practice/views/IntervalBellView.tsx` (existing deterministic version). Reference form: `frontend/src/features/Practice/configurator/forms/IntervalBellForm.tsx`. Reference for soft-progressive disclosure: any existing form's "Advanced" toggle pattern.

Engine state has `status: idle | running | paused | complete` and a `startedAt` timestamp; the view derives elapsed seconds via a local interval and schedules its own random bells off that clock.

## Tasks

1. **Add frontend types** to `frontend/src/features/Practice/engine/types.ts`:
   - `RandomIntervalBellConfig`: matches the backend Pydantic shape (see sub-issue 01)
   - `RandomIntervalBellMetadata`
   - Extend the `RitualConfig` and `RitualMetadata` unions

2. **Build the view** at `frontend/src/features/Practice/views/RandomIntervalBellView.tsx`:
   - Props: `{ config: RandomIntervalBellConfig; state: RitualState; controls: RitualControls; onSave?: () => void }`
   - Schedule generation: when `status` transitions `idle → running`, pre-compute a random schedule of `[t1, t2, …]` offsets (seconds from start) such that consecutive deltas are uniform in `[min_interval_seconds, max_interval_seconds]` and the cumulative sum stays under `duration_minutes * 60`. Stop generating after `max_bells` if set.
   - Trigger a bell tone (reuse the existing bell-playback util used by `IntervalBellView`) at each scheduled offset
   - Display: current elapsed time, current/total bells count, "Next bell in ~Xs" hint (but **only if** the user has not enabled a hide-hints toggle), and `RitualControlsBar`
   - On completion (timer elapsed or user stops), emit `RandomIntervalBellMetadata`:
     ```ts
     {
       mode: "random_interval_bell",
       bells_struck: scheduledSoFar.length,
       interval_seconds: deltasArray,
     }
     ```

3. **Build the form** at `frontend/src/features/Practice/configurator/forms/RandomIntervalBellForm.tsx`:
   - Follows the existing form pattern (validates against the Pydantic shape via zod or whatever the existing forms use)
   - Core fields (always visible): `duration_minutes`, `min_interval_seconds`, `max_interval_seconds`, `bell_tone`
   - Advanced (collapsible): `max_bells`, `start_bell`, `end_bell`
   - Sensible defaults: 20 min duration, 30 s min / 180 s max, bowl tone, no `max_bells` cap, start + end bells on
   - Client-side validation matches backend: `max >= min`, `min ≤ duration * 60`

4. **Wire the dispatcher** in `ActiveRitualSession.tsx` for `mode === "random_interval_bell"`.

5. **Wire the configurator** in `RitualConfiguratorSheet.tsx` to route `mode === "random_interval_bell"` to the new form.

6. **Tests**:
   - `__tests__/RandomIntervalBellView.test.tsx`: renders timer, schedules bells inside the interval bounds (use fake timers + a seeded RNG mock), emits correct metadata on completion
   - `__tests__/RandomIntervalBellForm.test.tsx`: renders core fields, "Advanced" toggle reveals additional fields, validation rejects `max < min`

## Acceptance Criteria

- [ ] `npm test` green, including new test files
- [ ] `npx tsc --noEmit` passes
- [ ] `ActiveRitualSession` dispatches `random_interval_bell` to the new view
- [ ] `RitualConfiguratorSheet` routes the mode to the new form
- [ ] Manual smoke: start a session with `min=10s, max=20s, duration=2min` → hear several bells at variable intervals → save → session row carries `mode_metadata.mode = "random_interval_bell"` with a populated `interval_seconds` list
- [ ] No regression on `IntervalBellView` / `IntervalBellForm`

## Files

| File | Action |
|------|--------|
| `frontend/src/features/Practice/engine/types.ts` | Modify |
| `frontend/src/features/Practice/views/RandomIntervalBellView.tsx` | **Create** |
| `frontend/src/features/Practice/views/__tests__/RandomIntervalBellView.test.tsx` | **Create** |
| `frontend/src/features/Practice/configurator/forms/RandomIntervalBellForm.tsx` | **Create** |
| `frontend/src/features/Practice/configurator/forms/__tests__/RandomIntervalBellForm.test.tsx` | **Create** |
| `frontend/src/features/Practice/components/ActiveRitualSession.tsx` | Modify |
| `frontend/src/features/Practice/configurator/RitualConfiguratorSheet.tsx` | Modify |

## Constraints

- Reuse the existing bell-playback util; do not fork audio handling
- Mode dispatch happens in `ActiveRitualSession.tsx` only
- Progressive disclosure for the form ("Advanced" toggle) — this prevents bloat as the mode count grows
- Match `@/design/tokens` styling
- RNG: seed-aware in tests (via injected `random()` fn), `Math.random` at runtime is fine
