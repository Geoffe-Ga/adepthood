# audit-ux-02: Add safe-area handling across Practice full-screen surfaces

**Labels:** `audit-ux`, `frontend`, `ux`, `priority-high`
**Epic:** UX States, Accessibility & Error Copy
**Estimated LoC:** ~150  (hard cap 700)

## Problem

The Practice feature renders full-screen surfaces with no safe-area handling. `PracticeScreen.tsx:62` returns a bare `ScrollView`, `screens/PracticeCatalogScreen.tsx:88` returns a `View` > `ScrollView`, and `screens/CreatePracticeWizard.tsx:134` returns a `KeyboardAvoidingView` — none of them wrap in `SafeAreaView` or apply `useSafeAreaInsets`. A grep for `SafeAreaView`/`useSafeAreaInsets` across `features/Practice/` returns zero hits. On notched devices the header text and the wizard's first step collide with the status-bar cutout, and the bottom content sits under the home indicator. Current state: this is a **UX correctness** defect — the screens render, but chrome is clipped/overlapped on real hardware (audit §8, §2 lists this among the top user-facing hurts).

## Scope

**Covers:** Wrapping the three named full-screen Practice surfaces so top and bottom content respects device insets, using `react-native-safe-area-context` (already a transitive Expo dependency; confirm it is a direct dependency and add it if not).

**Does NOT:** Touch nested modals/sheets that render over an already-safe parent, change scroll behavior or styling beyond inset padding, or address the catalog list virtualization (that is the `audit-render` epic). No copy changes.

## Tasks

1. **Confirm the safe-area provider is mounted** — Verify `SafeAreaProvider` wraps the navigation tree in `App.tsx`; add it if missing (it is required for `useSafeAreaInsets`/`SafeAreaView` to resolve real insets). TDD: a smoke render of each target screen inside `SafeAreaProvider` with a mocked inset frame does not throw.
2. **PracticeScreen** — In `Practice/PracticeScreen.tsx`, wrap the returned `ScrollView` (`:62`) in `SafeAreaView` (or apply `useSafeAreaInsets` padding to `contentContainerStyle`), preserving `testID="practice-screen"`. Apply the same to the `LoadingView`/`ErrorView` early returns so error/loading respect insets too. TDD: mocking `useSafeAreaInsets` to return `{ top: 47, bottom: 34 }`, assert the rendered container style includes the top/bottom inset (via `toHaveStyle` on the safe-area node, or that `SafeAreaView` is present).
3. **PracticeCatalogScreen** — In `screens/PracticeCatalogScreen.tsx`, make the outer `View` (`:88`) a `SafeAreaView` (or inset-padded), keeping `testID="practice-catalog-screen"`. TDD: asserts the safe-area wrapper is present.
4. **CreatePracticeWizard** — In `screens/CreatePracticeWizard.tsx`, compose `SafeAreaView` with the existing `KeyboardAvoidingView` (`:134`) so the wizard respects both keyboard and insets, keeping `testID="create-practice-wizard"`. TDD: asserts the safe-area wrapper is present and the `KeyboardAvoidingView` still renders.

## Acceptance Criteria

- [ ] Each of the three Practice surfaces renders inside a safe-area-aware container that applies non-zero top/bottom insets when provided.
- [ ] Existing `testID`s are preserved so current Practice tests keep passing.
- [ ] No user-facing copy leaks internals.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/PracticeScreen.tsx` | Modify (safe-area wrap) |
| `frontend/src/features/Practice/screens/PracticeCatalogScreen.tsx` | Modify (safe-area wrap) |
| `frontend/src/features/Practice/screens/CreatePracticeWizard.tsx` | Modify (safe-area + keyboard) |
| `frontend/src/App.tsx` | Modify if `SafeAreaProvider` is not already mounted |
| `frontend/src/features/Practice/__tests__/PracticeSafeArea.test.tsx` | **Create** |
