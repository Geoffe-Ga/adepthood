# practice-redesign-04: Retire the redundant selector + switcher sheet; minimal empty state

**Labels:** `enhancement`, `frontend`, `ritual-practice`
**Epic:** [Practice frontend redesign](practice-redesign-epic.md)
**Depends on:** #03 (catalog is now the single switch surface).
**Estimated LoC:** ~200 (net negative — two components are deleted)

## Problem

With the catalog now the single place to choose/switch (after #01–#03), two
choose-surfaces are dead weight: the inline `PracticeSelector` (the full-screen
"Choose a Practice" list shown when nothing is active) and `PracticeSwitcherSheet`
(only ever opened by the old banner). Keeping them is exactly the "many ways in,
none chosen on purpose" clutter the redesign targets.

Current state:
- `PracticeScreen.tsx` `SelectionView` (lines 194-224) renders the inline
  `PracticeSelector` when there is no active practice.
- `PracticeSwitcherSheet.tsx` is no longer mounted after #03.
- `PracticeSelector.tsx` is used only by `SelectionView`.

## Scope

Delete both components and their tests, and replace the no-active-practice branch
with a calm, minimal empty state whose single CTA opens the catalog. No other
behaviour changes.

## Tasks

1. **Minimal empty state**
   - Replace `SelectionView` (`PracticeScreen.tsx:184-224`) with a short empty
     state: a one-line message (e.g. "No practice set for this stage yet.") and a
     single primary button "Browse practices" that navigates to the `Catalog`
     route seeded with the current stage. Keep the `WeeklyProgress` footer if it
     still reads well, or drop it from the empty state — keep it minimal.

2. **Delete the dead components**
   - Remove `frontend/src/features/Practice/PracticeSelector.tsx` and
     `frontend/src/features/Practice/__tests__/PracticeSelector.test.tsx`.
   - Remove `frontend/src/features/Practice/components/PracticeSwitcherSheet.tsx`
     and `components/__tests__/PracticeSwitcherSheet.test.tsx`.
   - Remove every remaining import/reference (`PracticeScreen.tsx` imports both;
     grep the repo to be sure nothing else references them).

3. **Tests**
   - Update `__tests__/PracticeScreen.test.tsx`: the no-active branch renders the
     empty state with a working "Browse practices" CTA; no `PracticeSelector` /
     switcher is referenced.

## Acceptance Criteria

- [ ] `PracticeSelector.tsx` and `PracticeSwitcherSheet.tsx` (and their tests) are deleted.
- [ ] No file imports either component.
- [ ] The no-active-practice state is a minimal message + "Browse practices" CTA that opens the catalog.
- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint` green; coverage threshold still met.
- [ ] Net line count drops (deletions exceed additions).

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/PracticeScreen.tsx` | Modify |
| `frontend/src/features/Practice/PracticeSelector.tsx` | **Delete** |
| `frontend/src/features/Practice/__tests__/PracticeSelector.test.tsx` | **Delete** |
| `frontend/src/features/Practice/components/PracticeSwitcherSheet.tsx` | **Delete** |
| `frontend/src/features/Practice/components/__tests__/PracticeSwitcherSheet.test.tsx` | **Delete** |
| `frontend/src/features/Practice/__tests__/PracticeScreen.test.tsx` | Modify |

## Constraints

- Frontend only.
- Confirm with a repo-wide grep that nothing else (e.g. a story, an index
  barrel) imports the deleted components before removing them.
- Removing tests for deleted code is allowed and expected — this is not a
  coverage dodge. Do not delete tests for code that still exists.
