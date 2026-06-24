# EPIC: UX States, Accessibility & Error Copy

**Labels:** `epic`, `frontend`, `priority-high`
**Slug:** `audit-ux`
**Source:** `prompts/github-issues/2026-06-24_ADEPTHOOD_FULL_AUDIT.md` §8 (UX states, accessibility & error copy), with supporting context from §2 (top-10 user-facing hurts).

## Summary

The audit found that Adepthood's async surfaces and interactive chrome are inconsistently finished. The Journal feature is the frontend gold standard — it ships full loading/empty/error/retry states and labels every interactive element for screen readers (§10). The rest of the app has not caught up:

- **Error masking.** Course and Map mask real fetch failures as empty or perpetual-loading states. A user cannot tell "broken" from "empty," and there is no retry affordance (§2.8, §8 `Course/CourseScreen.tsx:53-143`, `Map/MapScreen.tsx:482,304-320`).
- **Accessibility gaps.** The Habits screen chrome — overflow menu, mode bar, pagination, energy CTA — carries zero `accessibilityLabel`/`accessibilityRole`, so screen-reader users cannot operate it (§2.9, §8 `Habits/HabitsScreen.tsx:654-700`).
- **Safe-area / keyboard handling.** The entire Practice feature renders full-screen surfaces with no `SafeAreaView`/`useSafeAreaInsets`; content collides with the notch and home indicator. The toast overlay hardcodes `top: 60`, ignoring insets. Auth screens lack `KeyboardAvoidingView` (§8 `Practice/*`, `ToastProvider.tsx:115-122`, Auth screens).
- **Leaked internals.** `FeatureErrorBoundary` renders raw `error.message` in production, where the sibling top-level `ErrorBoundary` gates the same disclosure behind `__DEV__` (§8 `FeatureErrorBoundary.tsx:108`).
- **Missing empty states.** A zero-habit user sees a blank Habits screen with no guidance (§8 `HabitsScreen.tsx:567-590`).

The fix theme is uniform: **every async surface needs loading / empty / error+retry; all interactive chrome needs a11y labels; safe-area and keyboard handling on full-screen surfaces; and no leaked internals in user-facing copy.** Most issues are "do what Journal already does." The `.claude/skills/user-facing-error-messages` lens governs all error-copy changes (what / why / next / escape; never leak internals).

## Success Criteria

- [ ] Every interactive control on `HabitsScreen` (overflow menu + items, mode bar, pagination Prev/Next, energy CTA) exposes an `accessibilityLabel` and `accessibilityRole`, matching Journal's coverage.
- [ ] All full-screen Practice surfaces respect safe-area insets; no content sits under the notch or home indicator.
- [ ] Map and Course distinguish fetch **error** from **empty**, and both expose a working retry affordance.
- [ ] `FeatureErrorBoundary` never renders raw `error.message` in a production build.
- [ ] The toast overlay positions itself using safe-area insets, never under the status bar.
- [ ] A zero-habit user sees an actionable empty state, not a blank screen.
- [ ] Auth screens share a single `auth.styles.ts`, handle the keyboard, and canonicalize email identically across signup and login.
- [ ] No user-facing copy leaks internals (stack traces, `error.message`, snake_case codes).
- [ ] No existing tests break; frontend coverage stays ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Sub-Issues

| # | Issue | Class | Priority |
|---|-------|-------|----------|
| 01 | [Habits screen chrome accessibility labels](audit-ux-01-habits-a11y.md) | a11y | high |
| 02 | [Safe-area handling across Practice surfaces](audit-ux-02-practice-safe-area.md) | ux | high |
| 03 | [Map retry + error-vs-empty distinction](audit-ux-03-map-retry.md) | ux | high |
| 04 | [Course real error + retry states](audit-ux-04-course-error-states.md) | ux | medium |
| 05 | [Gate FeatureErrorBoundary message behind `__DEV__`](audit-ux-05-errorboundary-dev-gate.md) | ux | medium |
| 06 | [Toast overlay respects safe-area insets](audit-ux-06-toast-safe-area.md) | ux | medium |
| 07 | [Habits empty state with guidance](audit-ux-07-habits-empty-state.md) | ux | medium |
| 08 | [Shared auth styles, keyboard handling, email canonicalization](audit-ux-08-auth-polish.md) | ux | low |

**Dependency notes:** All issues are independent and can land in any order. 06 and 02 both adopt `react-native-safe-area-context`; whichever lands first establishes the import pattern. 01 and 07 both touch `Habits/HabitsScreen.tsx` and should be rebased onto each other to avoid conflicts in the render tree.
