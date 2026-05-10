# ritual-10: Frequency banner + practice switcher

**Labels:** `ritual-practice`, `frontend`, `feature`, `priority-medium`
**Epic:** Ritual Practice Screen
**Depends on:** ritual-05 (frequency endpoint)
**Estimated LoC:** ~400

## Problem

Two pieces of UI sit above the active practice:

1. The **frequency banner** that tells the user what colour / aspect they're
   in and names their current practice with the spec-mandated wording.
2. The **practice switcher** — a "Replace this practice" entry point that
   lets the user pick another approved practice for the current stage (or
   navigate to the existing user-submission flow).

Only one practice is displayed at a time, per the spec.

## Scope

Two components: `FrequencyBanner` (display-only) and `PracticeSwitcherSheet`
(modal list of replacement options). Wire both via a small `useFrequency`
hook.

## Tasks

1. **`useFrequency` hook** —
   `frontend/src/features/Practice/hooks/useFrequency.ts`
   - Fetches `GET /user-practices/current/frequency` on mount and on
     refresh-trigger changes.
   - Returns `{ data, isLoading, error, refetch }`.
   - Uses the existing `useOptimisticMutation` / fetcher patterns in the
     codebase — do not introduce React Query if the codebase doesn't
     already use it (check first).

2. **`FrequencyBanner.tsx`**
   - Reads from `useFrequency` (or accepts `data` as a prop for
     storybook/testing — same pattern as the existing components).
   - Renders the server-formatted `banner_text` exactly as returned. The
     view does **no** string assembly — that's the whole point of the
     server endpoint from ritual-05.
   - Visual: aspect chip + colour swatch (mapped from
     `spiral_dynamics_color`; map lives in
     `frontend/src/features/Practice/data/colorPalette.ts` — Beige, Purple,
     Red, Blue, Orange, Green, Yellow, Turquoise, Ultraviolet, Clear Light
     → hex codes for both backgrounds and accessible-contrast text).
   - Skeleton state while loading; inline error (with retry) on failure.
   - Tap target: opens `PracticeSwitcherSheet` (callback prop).

3. **`PracticeSwitcherSheet.tsx`**
   - Bottom-sheet listing all approved practices for the current stage
     (`practices.list(stageNumber)`).
   - Currently selected one shown with a check; tap on a different one
     calls `userPractices.create({ practice_id, stage_number })`. The
     existing partial-unique-index handling on the backend will close the
     prior selection (see `ritual-03` model docs).
   - "Submit my own" CTA navigates to the existing practice-submission
     flow (already implemented in `phase-3-09`); reuse its route / nav
     name.
   - On selection, calls `onReplaced(newUserPractice)` so the parent can
     refresh the banner + the active-practice view.

4. **Colour palette accessibility**
   - Each colour has a `bg` and `text` value chosen for ≥ 4.5:1 contrast
     (WCAG AA for body text). Test the contrast in
     `__tests__/colorPalette.test.ts` using a small `relativeLuminance`
     helper — keeps the brand palette honest as designers tweak it.

5. **Tests**
   - `useFrequency.test.tsx` — fetch success / failure / refetch.
   - `FrequencyBanner.test.tsx`:
     - Loading state shows skeleton.
     - Error state shows retry button; pressing it calls `refetch`.
     - Success state renders `banner_text` verbatim (snapshot).
     - Tapping the banner invokes the switcher callback.
   - `PracticeSwitcherSheet.test.tsx`:
     - Lists all returned practices; current one is checked.
     - Tap on another practice posts to `userPractices.create` with the
       right payload and fires `onReplaced`.
     - "Submit my own" navigates to the submission route.
   - `colorPalette.test.ts` — contrast assertions, all 10 colours mapped.

## Acceptance Criteria

- Banner copy matches the spec verbatim (server-controlled).
- Colour swatches are accessible.
- Switcher posts a new selection and the banner updates.
- Coverage targets met.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/hooks/useFrequency.ts` | **Create** |
| `frontend/src/features/Practice/components/FrequencyBanner.tsx` | **Create** |
| `frontend/src/features/Practice/components/PracticeSwitcherSheet.tsx` | **Create** |
| `frontend/src/features/Practice/data/colorPalette.ts` | **Create** |
| `frontend/src/api/index.ts` | Modify (already has `practices.list` + `userPractices.create`; add `frequency.current` if missing) |
| `frontend/src/features/Practice/__tests__/*.test.tsx` | **Create** |

## If you blow the budget

The colour palette + contrast tests can ship as their own micro-PR (`10a`)
ahead of the banner. Otherwise everything fits.
