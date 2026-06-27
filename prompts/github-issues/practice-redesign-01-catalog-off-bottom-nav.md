# practice-redesign-01: Move the catalog off the bottom nav and reach it from the Practice screen

**Labels:** `enhancement`, `frontend`, `ritual-practice`
**Epic:** [Practice frontend redesign](practice-redesign-epic.md)
**Depends on:** nothing (foundational).
**Estimated LoC:** ~250

## Problem

The practice catalog is a permanent bottom-tab slot, making the nav bar a
6-item row and burying the catalog where it competes with the daily-use tabs.
The user wants the catalog **off the bottom nav** and reached **deliberately
from the Practice screen**.

Current state:
- `frontend/src/navigation/BottomTabs.tsx:87-98` lists six tabs; `Catalog`
  (icon `LayoutGrid`, line 94) maps to `PracticeCatalogScreen` (imported line 26,
  wrapped line 72). `RootTabParamList` declares `Catalog: undefined` (line 35).
- Two flows navigate to the tab by name: `CreatePracticeWizard.tsx:157`
  ("Start from a preset" → `Tabs.Catalog`) and `SharePreviewScreen.tsx:263`
  (post-import → `Tabs.Catalog`).

## Scope

Pure navigation move: delete the Catalog tab, register the catalog as a pushed
stack screen in `RootStack`, add one discoverable entry point on the Practice
screen, and repoint the two existing navigations. No change to the catalog
screen's own contents (that comes later). The empty-state and switcher
consolidation are **out of scope** (issues 03–04).

## Tasks

1. **Remove the Catalog bottom tab**
   - In `BottomTabs.tsx`: delete the `Catalog` entry from `TAB_CONFIGS` (line 94),
     remove `CatalogTab` (line 72), the `PracticeCatalogScreen` import (line 26),
     the `LayoutGrid` icon import (line 11), and `Catalog: undefined` from
     `RootTabParamList` (line 35). The nav bar is now 5 tabs.

2. **Register the catalog as a pushed stack screen**
   - In `frontend/src/navigation/RootStack.tsx`: add
     `Catalog: { stageNumber?: number } | undefined` to `RootStackParamList`
     (line 37) and a `<Stack.Screen name="Catalog" ... options={{ title: 'Practices' }} />`.
   - `PracticeCatalogScreen` reads `route.params?.stageNumber` to seed its
     `initialStage` (it already accepts `initialStage`; thread the param through
     a thin wrapper or via `useRoute`).

3. **Add a Practice-screen entry point to the catalog**
   - In `frontend/src/features/Practice/PracticeScreen.tsx`, add an obvious,
     accessible control that navigates to the pushed `Catalog` route seeded with
     the resolved current stage (`useResolvedStageNumber`). Prefer a
     `headerLeft` icon button on the Practice tab (so it does not clobber the
     shared `headerRight` settings/logout actions in `BottomTabs.tsx:107-128`),
     or an in-body "Browse all practices" button — pick one and keep it
     `accessibilityLabel`-led. (The dedicated "Change practice" CTA for the
     *active* state lands in issue 03; this issue just guarantees the catalog is
     reachable.)

4. **Repoint existing navigations**
   - `CreatePracticeWizard.tsx:157` and `SharePreviewScreen.tsx:263`: change
     `navigate('Tabs', { screen: 'Catalog', ... })` to `navigate('Catalog', ...)`.

5. **Tests**
   - `navigation/__tests__/BottomTabs.test.tsx`: assert 5 tabs and no Catalog tab.
   - Update `CreatePracticeWizard.test.tsx` and `SharePreviewScreen.test.tsx`
     for the new route target.
   - Add a Practice-screen test asserting the catalog entry navigates to `Catalog`.

## Acceptance Criteria

- [ ] The bottom nav renders exactly 5 tabs (Habits, Practice, Course, Journal, Map).
- [ ] `PracticeCatalogScreen` is a pushed screen reachable from the Practice screen.
- [ ] "Start from a preset" (wizard) and post-import (share preview) still land on the catalog.
- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint` green.
- [ ] No existing tests break.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/navigation/BottomTabs.tsx` | Modify |
| `frontend/src/navigation/RootStack.tsx` | Modify |
| `frontend/src/features/Practice/PracticeScreen.tsx` | Modify |
| `frontend/src/features/Practice/screens/CreatePracticeWizard.tsx` | Modify |
| `frontend/src/features/Practice/screens/SharePreviewScreen.tsx` | Modify |
| `frontend/src/navigation/__tests__/BottomTabs.test.tsx` | Modify |
| `frontend/src/features/Practice/screens/__tests__/CreatePracticeWizard.test.tsx` | Modify |
| `frontend/src/features/Practice/screens/__tests__/SharePreviewScreen.test.tsx` | Modify |

## Constraints

- Frontend only. No backend, no API change.
- Keep the catalog screen's internals unchanged in this issue.
- The entry point must be `accessibilityRole="button"` with a clear label.
