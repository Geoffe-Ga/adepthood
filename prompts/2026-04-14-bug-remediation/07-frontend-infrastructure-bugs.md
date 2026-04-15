# Frontend Infrastructure & Cross-Cutting — Bug Remediation Report

**Component:** API client, navigation, auth context, stores, AsyncStorage, design tokens, accessibility, error boundaries
**Date:** 2026-04-14
**Auditor:** Claude Code (self-review)
**Branch:** `claude/code-review-bug-analysis-BvOHp`

## Executive Summary

25 frontend bugs covering the seams between API, navigation, state, and storage. The most consequential:

- **No fetch timeout anywhere.** A wedged backend freezes screens forever.
- **Logout doesn't reset navigation state.** Back button/deep link can return users to authenticated screens after logout; on re-login the tab navigator reuses the previous user's tab state.
- **Retry only on 401.** Transient 5xx and 429 surface as hard errors even though a backoff would recover.
- **Design-token drift.** ~15 files hardcode colors that should come from `design/tokens.ts`.
- **No offline detection.** Users see timeouts instead of a banner.
- **Unsafe casts at the API boundary** (`tier as ...`, `parseResponse<T>`) with no runtime validation.

---

## Table of Contents

| # | Severity | Title |
|---|---|---|
| BUG-FRONTEND-INFRA-001 | Critical | Fetch calls have no timeout |
| BUG-FRONTEND-INFRA-002 | Critical | Logout doesn't reset navigation stack |
| BUG-FRONTEND-INFRA-003 | High | Tab navigator state persists across logout |
| BUG-FRONTEND-INFRA-004 | Medium | `ToastProvider` context value not memoized |
| BUG-FRONTEND-INFRA-005 | Medium | No offline detection |
| BUG-FRONTEND-INFRA-006 | Medium | Hardcoded colors instead of design tokens |
| BUG-FRONTEND-INFRA-007 | Medium | Retry logic covers only 401 |
| BUG-FRONTEND-INFRA-008 | Medium | Deep links don't cover root stack (e.g., `ApiKeySettings`) |
| BUG-FRONTEND-INFRA-009 | Medium | Missing `accessibilityLabel` on ~80% of touchables |
| BUG-FRONTEND-INFRA-010 | Medium | Unsafe cast on `goal.tier` |
| BUG-FRONTEND-INFRA-013 | Medium | Token getter can read stale ref during logout race |
| BUG-FRONTEND-INFRA-015 | Medium | Journal `FlatList` missing `getItemLayout` |
| BUG-FRONTEND-INFRA-016 | Medium | Login error message too generic for timeout |
| BUG-FRONTEND-INFRA-017 | Medium | `ApiKeyContext` swallows SecureStore exceptions |
| BUG-FRONTEND-INFRA-019 | Medium | Single top-level error boundary |
| BUG-FRONTEND-INFRA-021 | Medium | StatusBar hardcoded light style |
| BUG-FRONTEND-INFRA-022 | Medium | Course/Practice don't reset route params after logout |
| BUG-FRONTEND-INFRA-023 | Medium | Route params inconsistent optional chaining |
| BUG-FRONTEND-INFRA-024 | Medium | No runtime validation of API response shapes |
| BUG-FRONTEND-INFRA-025 | Medium | Token contrast below WCAG AA in some combos |
| BUG-FRONTEND-INFRA-011 | Low | Storage JSON parse errors silently return null |
| BUG-FRONTEND-INFRA-012 | Low | Logout flow lacks end-to-end tests |
| BUG-FRONTEND-INFRA-014 | Low | `keyExtractor` without explicit typing |
| BUG-FRONTEND-INFRA-018 | Low | Config-error hint mentions Railway specifically |
| BUG-FRONTEND-INFRA-020 | Low | No test for `REFRESH_BUFFER_SECONDS` integration |

> IDs keep the agent's original numbers but are scoped with the `FRONTEND-INFRA-` prefix to avoid collision with the `BUG-FRONTEND-*` IDs used in the Course/Stages/Goals report.

---

### BUG-FRONTEND-INFRA-001: No fetch timeout
**Severity:** Critical
**Component:** `frontend/src/api/index.ts:142-143`
**Symptom:** A stalled backend or DNS hiccup hangs the UI indefinitely.
**Fix:** Wrap every `fetch` in an `AbortController` with a configurable timeout (default 30s). Bubble `AbortError` as a retryable `ApiError`. Respect BotMason streaming's own keepalive.

---

### BUG-FRONTEND-INFRA-002: Logout doesn't reset navigation
**Severity:** Critical
**Component:** `frontend/src/navigation/BottomTabs.tsx:66`, `App.tsx:50-62`
**Symptom:** Deep-link or back button after logout can surface a cached authenticated screen.
**Fix:** Key the root navigator by auth state (`<RootStack key="auth" />` vs `<AuthStack key="anon" />`) or dispatch a `CommonActions.reset` on logout.

---

### BUG-FRONTEND-INFRA-003: Tab state persists across logout
**Severity:** High
**Component:** `App.tsx:50-62`
**Fix:** Same mount-key approach as 002. Covers scroll positions, pending screens, and tab selection.

---

### BUG-FRONTEND-INFRA-004: `ToastProvider` context not memoized
**Severity:** Medium
**Component:** `frontend/src/components/ToastProvider.tsx:46`
**Fix:** Wrap provider value in `useMemo(() => ({ showToast }), [showToast])`.

---

### BUG-FRONTEND-INFRA-005: No offline detection
**Severity:** Medium
**Component:** App-wide
**Fix:** Add `@react-native-community/netinfo`. Global banner on offline. Queue mutations (habits check-ins, journal sends) until reconnect.

---

### BUG-FRONTEND-INFRA-006: Design-token drift
**Severity:** Medium
**Component:** `features/Auth/LoginScreen.tsx:80,88`; `features/Auth/SignupScreen.tsx:147,155`; `features/Habits/HabitTile.tsx:66,136,161,505,622`; `features/Habits/components/GoalModal.tsx:52,66,76,657`; `features/Habits/components/OnboardingModal.tsx:191` (and more — grep for `#[0-9a-fA-F]{3,6}` in the styles).
**Fix:** Replace hex strings with imports from `design/tokens.ts`. Add an ESLint rule banning hex literals in StyleSheets.

---

### BUG-FRONTEND-INFRA-007: Retry only on 401
**Severity:** Medium
**Component:** `frontend/src/api/index.ts:191-216`
**Fix:** Add an `isTransient(err)` helper, retry with exponential backoff + jitter (max 2 attempts) for 408/429/500/502/503/504/network errors. Never retry non-idempotent methods unless the server sets `Idempotency-Key`.

---

### BUG-FRONTEND-INFRA-008: Deep-link config incomplete
**Severity:** Medium
**Component:** `frontend/src/App.tsx:26-37`
**Fix:** Add the `ApiKeySettings` route (mapped to a path like `/api-key-settings`) and any other top-level stack screens to the linking config. <!-- pragma: allowlist secret -->

---

### BUG-FRONTEND-INFRA-009: Accessibility labels missing
**Severity:** Medium
**Component:** Across `features/*`
**Fix:** Sweep every `TouchableOpacity`/`Pressable`/`Touchable*` and add `accessibilityLabel` + `accessibilityRole`. Add an ESLint a11y rule for React Native.

---

### BUG-FRONTEND-INFRA-010: Unsafe `tier` cast
**Severity:** Medium
**Component:** `frontend/src/api/index.ts:324`
**Fix:** Narrow with a type guard + runtime default. Combine with BUG-GOAL-006 (server-side enum).

---

### BUG-FRONTEND-INFRA-013: Stale token-ref race
**Severity:** Medium
**Component:** `frontend/src/context/AuthContext.tsx:107-108`
**Fix:** Register a stable callback getter `useCallback(() => tokenRef.current, [])`. Clear the getter on unmount.

---

### BUG-FRONTEND-INFRA-015: Missing `getItemLayout`
**Severity:** Medium
**Component:** `frontend/src/features/Journal/JournalScreen.tsx:668-700`
**Fix:** If heights are variable, at least enable `removeClippedSubviews` and measure with `onLayout`. If heights are bounded, implement `getItemLayout` with a constant + bubble header height.

---

### BUG-FRONTEND-INFRA-016: Login error too generic for timeouts
**Severity:** Medium
**Component:** `frontend/src/features/Auth/LoginScreen.tsx:7-30`
**Fix:** Branch on `err.name === 'AbortError'` or `isTransient(err)` and show a timeout-specific message.

---

### BUG-FRONTEND-INFRA-017: `ApiKeyContext` swallows SecureStore exceptions
**Severity:** Medium
**Component:** `frontend/src/context/ApiKeyContext.tsx:55`
**Fix:** Add `loadError` state and surface a message. Fall back to in-memory key without persisting if SecureStore is broken.

---

### BUG-FRONTEND-INFRA-019: Single top-level error boundary
**Severity:** Medium
**Component:** `frontend/src/App.tsx:86`
**Fix:** Wrap each tab/feature in its own boundary so a crash in Journal doesn't nuke Habits.

---

### BUG-FRONTEND-INFRA-021: Hardcoded StatusBar style
**Severity:** Medium
**Component:** `frontend/src/App.tsx:93`
**Fix:** Read from user preferences / system theme. Ship now with the current `dark-content` default, make it reactive when dark mode lands.

---

### BUG-FRONTEND-INFRA-022: Course/Practice don't reset params on auth change
**Severity:** Medium
**Component:** `features/Course/CourseScreen.tsx`, `features/Practice/PracticeScreen.tsx`
**Fix:** Reset via the nav-key remount in BUG-FRONTEND-INFRA-002/003, or add `useEffect(() => resetIfStale(), [isAuthenticated])`.

---

### BUG-FRONTEND-INFRA-023: Inconsistent optional chaining for route params
**Severity:** Medium
**Component:** `features/Course/CourseScreen.tsx:26,38` (and similar)
**Fix:** Centralize through a `useRouteParams<T>()` helper that always returns a narrowed object with required fields defaulted.

---

### BUG-FRONTEND-INFRA-024: No runtime response validation
**Severity:** Medium
**Component:** `frontend/src/api/index.ts:117`
**Fix:** Zod schemas per response type; parse before return. Start with auth + habits (highest-blast-radius mismatches).

---

### BUG-FRONTEND-INFRA-025: Contrast gaps
**Severity:** Medium
**Component:** `frontend/src/design/tokens.ts:26-31`
**Fix:** Audit pairs against `background.primary`; introduce `textSecondaryAccessible` and migrate low-contrast uses.

---

### BUG-FRONTEND-INFRA-011: Silent storage parse errors
**Severity:** Low
**Component:** `frontend/src/storage/habitStorage.ts:32`, `storage/notificationStorage.ts:24,62`
**Fix:** Log the error, clear the corrupt key, bubble a toast if user-visible.

---

### BUG-FRONTEND-INFRA-012: Logout flow lacks E2E test
**Severity:** Low
**Component:** `frontend/src/context/__tests__/AuthContext.test.tsx`
**Fix:** Add tests for double-logout, logout during in-flight refresh, and logout→login cycles.

---

### BUG-FRONTEND-INFRA-014: `keyExtractor` untyped
**Severity:** Low
**Component:** `frontend/src/features/Journal/JournalScreen.tsx:678`
**Fix:** Typed `useCallback` extractor.

---

### BUG-FRONTEND-INFRA-018: Railway-specific config hint
**Severity:** Low
**Component:** `frontend/src/App.tsx:72`
**Fix:** Make it provider-agnostic; put Railway specifics in `DEPLOYMENT.md`.

---

### BUG-FRONTEND-INFRA-020: Missing integration test for refresh buffer
**Severity:** Low
**Component:** `frontend/src/utils/__tests__/token.test.ts`
**Fix:** Add a test that advances fake timers past `exp - REFRESH_BUFFER_SECONDS` and asserts `silentRefresh` is invoked exactly once.

---

## Suggested remediation order

1. **001, 002, 003** (network + nav lifecycle) — land together; this is the foundation everything else depends on.
2. **024, 010** (runtime validation) — pair with the TS fix in BUG-AUTH-002.
3. **007** (retry policy) + offline detection (**005**).
4. **006, 009, 025** (design system + a11y sweep).
5. **004, 013, 015, 017, 019, 021, 022, 023** (polish).
6. **Low-severity backlog**.
