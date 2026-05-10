# ritual-11: PracticeScreen integration

**Labels:** `ritual-practice`, `frontend`, `feature`, `priority-high`
**Epic:** Ritual Practice Screen
**Depends on:** ritual-06, ritual-07, ritual-08, ritual-09, ritual-10
**Estimated LoC:** ~500

## Problem

Glue everything from this epic into a single screen that replaces the
current `PracticeScreen.tsx` (729 LoC monolith). Only one practice is shown
at a time — banner + active practice + a small footer with the configure /
switch / start affordances.

## Scope

Rewrite `PracticeScreen.tsx` to compose the new pieces. Move the existing
selection-only / weekly-progress logic into hooks so the screen stays under
~250 LoC of JSX.

## Tasks

1. **Decompose existing `PracticeScreen.tsx`**
   - Extract `useActivePractice` hook from the current
     `usePracticeListState` + `usePracticeSelect` blob:
     `frontend/src/features/Practice/hooks/useActivePractice.ts`.
     Returns `{ activeUserPractice, effectiveConfig, effectiveName,
     practice, isLoading, error, refresh }`.
   - Extract `useWeeklyProgress` hook (already partially there) into its
     own file for reuse with the new analytics endpoint from ritual-04.

2. **`PracticeScreen.tsx` (rewrite)** — composition only
   - Layout (top to bottom):
     1. `<FrequencyBanner onReplace={openSwitcher} />` (ritual-10)
     2. Active practice card:
        - Header: effective name + small "configure" gear (opens
          `RitualConfiguratorSheet`).
        - Body: switches on `effectiveConfig.mode` to render one of:
          `MeditationTimerView` / `CountUpTimerView` / `MetronomeView` /
          `RepCounterView` / `IntervalBellView` /
          `SenseGroundingView` / `TarotMeditationView`.
          - The Tarot view receives the day-index card via
            `cardForDayIndex(daysSinceStart)` computed from
            `activeUserPractice.start_date` + the user's TZ.
        - Footer: `<RitualControlsBar />` (already inside each view, but
          some compositions hoist it — pick one and document).
     3. `<WeeklyProgress />` (existing, refactored to read from the new
        insights endpoint; falls back to the old `week-count` if the new
        endpoint isn't available — purely additive).
   - Modal mounts:
     - `<RitualConfiguratorSheet>` (ritual-09)
     - `<PracticeSwitcherSheet>` (ritual-10)
     - Insight capture modal (ritual-12 — wired here, content lives there)

3. **Wire up the engine**
   - One `useRitualEngine(effectiveConfig)` per active practice.
   - On `status` transition to `'complete'`, open the insight capture
     modal (ritual-12) prefilled with mode, duration, and any
     mode-specific metadata harvested from `state` (e.g. `repCount`,
     `cuesStruck`, `currentStepIndex`).
   - On `cancel`, no insight modal; just reset to idle.

4. **Keep-awake**
   - `useKeepAwake()` from `expo-keep-awake` while `status === 'running'`.
   - Disable on cancel / complete / unmount.

5. **Tests** — `__tests__/PracticeScreen.test.tsx`
   - Renders banner + active practice + weekly progress.
   - Mode dispatch: each of the 7 modes mounts the right view (parameterized
     test fed with fabricated `effectiveConfig`).
   - On engine `complete`, the insight capture modal is mounted (assert via
     test-id; modal contents tested in ritual-12).
   - Configure gear opens the configurator sheet.
   - Banner replace tap opens the switcher sheet.
   - Existing hook-level tests (`usePracticeListState`,
     `usePracticeSelect`) keep passing after extraction.

## Acceptance Criteria

- Screen renders only one practice at a time.
- All 7 modes mount their correct view.
- Configure / Switch / Insight modals open at the right triggers.
- Existing weekly-count display still works during the rollover from
  `week-count` to the insights endpoint.
- No file in the rewritten module exceeds 250 LoC of JSX (hooks may be
  longer); the previous 729-LoC monolith is gone.
- Coverage targets met.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/PracticeScreen.tsx` | Rewrite |
| `frontend/src/features/Practice/hooks/useActivePractice.ts` | **Create** (extract) |
| `frontend/src/features/Practice/hooks/useWeeklyProgress.ts` | **Create** (extract) |
| `frontend/src/features/Practice/__tests__/PracticeScreen.test.tsx` | Modify |

## If you blow the budget

This issue is the most likely overflow because the rewrite touches lots of
small wiring. If the PR creeps past 700 LoC, land the hook extractions
first as `11a` (no behavior change, pure refactor — easy review), then ship
the screen composition + mode-dispatch + tests as `11b`.
