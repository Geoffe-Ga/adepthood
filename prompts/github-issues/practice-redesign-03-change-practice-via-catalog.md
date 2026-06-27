# practice-redesign-03: One explicit "Change practice" action, routed through the catalog

**Labels:** `enhancement`, `frontend`, `ritual-practice`
**Epic:** [Practice frontend redesign](practice-redesign-epic.md)
**Depends on:** #01 (catalog route), #02 (banner no longer switches).
**Estimated LoC:** ~275

## Problem

Switching practices is currently triggered by tapping the disguised frequency
banner, which opens `PracticeSwitcherSheet` — the "message that doesn't look
clickable" the user called out. After #02 the banner no longer switches, so the
screen needs **one obvious, well-labelled control** to change practices, and the
catalog needs to be able to set the active practice directly.

Current state:
- `PracticeScreen.tsx:55-80 usePracticeChrome` builds the banner (with
  `onSwitch`) and mounts `PracticeSwitcherSheet`; the only switch entry is the
  banner tap.
- The catalog (`PracticeCatalogScreen.tsx`) only navigates to detail
  (`onDetail`, line 91); it cannot set a practice active.
- `PracticeDetailScreen.tsx` has "Use for stage…" (line 327) which opens a
  1–10 stage picker — more than needed for the common "use this for where I am
  now" case.

## Scope

Add a single "Change practice" button to the active Practice screen that opens
the catalog (seeded to the current stage), and give the catalog/detail a
one-tap **"Use this practice"** that sets the active `UserPractice` for the
current stage. Remove the banner→switcher wiring. The switcher sheet is left in
place but unused; its deletion is #04.

## Tasks

1. **"Change practice" CTA**
   - In `PracticeScreen.tsx` / `ActiveRitualSession.tsx`, add a clearly-styled,
     button-shaped "Change practice" control in the active view that navigates to
     the `Catalog` route with `{ stageNumber }` from `useResolvedStageNumber`.
   - Remove `usePracticeChrome`'s banner `onSwitch` plumbing and stop mounting
     `PracticeSwitcherSheet` from `PracticeScreen` (do not delete the file yet).

2. **Set-active from the catalog**
   - Pass the seeding `stageNumber` into `PracticeCatalogScreen` (from #01's route
     param) and add a one-tap **"Use this practice"** affordance on each row (or a
     primary action on `PracticeDetailScreen`) that calls
     `userPractices.create({ practice_id, stage_number })` for the current stage,
     then navigates back to the Practice screen. Reuse `useActivePractice`'s
     `selectPractice` pattern; surface errors via `formatApiError`.
   - In `PracticeDetailScreen.tsx`, add a "Use for current stage" primary action
     alongside the existing "Use for stage…" picker so arriving from the Practice
     screen is one tap, not a stage-picker detour.

3. **Tests**
   - `PracticeScreen` test: the "Change practice" button navigates to `Catalog`
     with the current `stageNumber`; the switcher sheet is no longer rendered.
   - `PracticeCatalogScreen` test: "Use this practice" calls `userPractices.create`
     with the seeded stage and the tapped practice id.
   - `PracticeDetailScreen` test: "Use for current stage" sets active without the picker.

## Acceptance Criteria

- [ ] The active Practice screen has one obvious, button-shaped "Change practice" control.
- [ ] Tapping it opens the catalog seeded to the current stage.
- [ ] Picking a practice from the catalog/detail sets it active for the current stage in one tap.
- [ ] The banner no longer triggers switching; `PracticeSwitcherSheet` is not mounted by `PracticeScreen`.
- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint` green; coverage unchanged.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/PracticeScreen.tsx` | Modify |
| `frontend/src/features/Practice/components/ActiveRitualSession.tsx` | Modify |
| `frontend/src/features/Practice/screens/PracticeCatalogScreen.tsx` | Modify |
| `frontend/src/features/Practice/screens/PracticeDetailScreen.tsx` | Modify |
| `frontend/src/features/Practice/__tests__/PracticeScreen.test.tsx` | Modify |
| `frontend/src/features/Practice/screens/__tests__/PracticeCatalogScreen.test.tsx` | Modify |
| `frontend/src/features/Practice/screens/__tests__/PracticeDetailScreen.test.tsx` | Modify |

## Constraints

- Frontend only. Reuse `userPractices.create` / `useActivePractice`; no new endpoint.
- Do not delete `PracticeSwitcherSheet` here — that is #04.
- "Change practice" and "Use this practice" must read as buttons (role + label, 44dp target).
