# Frontend — Design System, State, Storage & Tests Bug Report — 2026-04-18

**Scope:** `frontend/src/design/**` (285 LOC), `frontend/src/components/**` (730 LOC — ErrorBoundary, FeatureErrorBoundary, Toast/Provider, DatePicker, OfflineBanner), `frontend/src/store/**` (213 LOC — Zustand stores), `frontend/src/storage/**` (259 LOC — AsyncStorage + SecureStore), `frontend/jest.config.js`, `frontend/babel.config.js`. Covers cross-cutting design tokens, shared UI primitives, global state, persisted state, and test/bundler configuration.

**Total bugs: 24 — 2 Critical / 10 High / 10 Medium / 2 Low**

## Executive Summary

1. **Multi-user data bleed across logout/login (Critical).** BUG-FE-STATE-001: Zustand `useHabitStore` / `useStageStore` / `useUserStore` have no `reset()` and `AuthContext.logout` only clears the token. User A logs out, User B signs in on the same device, and User B sees User A's habits, stage, and course progress until a manual reload.
2. **BYOK LLM flow crashes on Expo Web (Critical).** BUG-FE-STORAGE-001: `llmKeyStorage.ts` calls `SecureStore.setItemAsync` unconditionally — the web build has no fallback (unlike `authStorage.ts`, which does). First user to save a key on web sees `TypeError: setItemAsync is not a function`.
3. **Contrast + dark-mode gaps across the design system (High).** BUG-FE-UI-001: `colors.neutral` on `background.primary` fails WCAG AA. BUG-FE-UI-002: `colors.mystical.glowLight` / `transparentLight` fail AA on light backgrounds and there is no dark-mode palette at all. BUG-FE-UI-003: no `touchTarget` token; several call sites already fall below 44pt/48dp.
4. **ErrorBoundary + observability gaps (High).** BUG-FE-UI-101: `ErrorBoundary` only `console.error`s — no Sentry/Observability plumbing, no user-visible retry. BUG-FE-UI-102: `FeatureErrorBoundary` never resets on route change, so a single error sticks the whole feature pane. Combined with BUG-OBS-003 (no global exception handler on backend) and BUG-FE-API-* there's no end-to-end error path.
5. **Storage races + validation gaps (High).** BUG-FE-STORAGE-002: `savePendingCheckIn` is a read-modify-write on AsyncStorage with no lock — concurrent offline check-ins drop rows. BUG-FE-STORAGE-004: `saveLlmApiKey` and `saveToken` persist whitespace-only / empty strings as real credentials, tripping every downstream "is authenticated?" check.
6. **Toast/DatePicker polish + a11y (Medium).** BUG-FE-UI-103/-104/-105/-106 (auto-dismiss timer leak, no SR live region, queue race, gap-timer leak), BUG-FE-UI-107/-108 (DatePicker ignores min/max on quick-select, stale visibility state across re-mounts), BUG-FE-UI-109 (OfflineBanner re-renders entire subtree per NetInfo tick).
7. **Selector memoization + contract drift (Medium/High).** BUG-FE-STATE-002: factory selectors (`selectHabitById(id)`) create a fresh function per call → Zustand re-subscribes on every render → re-render storm. BUG-FE-STATE-003: `updateStageProgress` silently drops unknown keys, masking contract drift between client types and backend DTOs.
8. **Test/bundler config (High/Medium/Low).** BUG-FE-TEST-001 (mock state leaks across tests due to missing `clearMocks`/`resetMocks`), BUG-FE-TEST-002 (`testEnvironment: 'node'` breaks DOM-needing component tests), BUG-FE-TEST-003 (`reanimated/plugin` unconditionally included; no `env.production` split → console calls ship to users).

## Table of Contents

| # | ID | Severity | Component | Title |
|---|----|----------|-----------|-------|
| 1 | BUG-FE-UI-001 | High | `design/tokens.ts` | `colors.neutral` fails WCAG AA on primary background |
| 2 | BUG-FE-UI-002 | High | `design/tokens.ts` | Mystical light tones fail AA; no dark-mode palette |
| 3 | BUG-FE-UI-003 | High | `design/tokens.ts` | No minimum touch-target token; <44pt call sites |
| 4 | BUG-FE-UI-004 | Medium | `design/useResponsive.ts` | No Dimensions cleanup; landscape columns from first render |
| 5 | BUG-FE-UI-005 | Medium | `design/DesignSystem.ts` | Stale re-export subset drifts from tokens |
| 6 | BUG-FE-UI-101 | High | `components/ErrorBoundary.tsx` | `console.error` only; no observability, no reset |
| 7 | BUG-FE-UI-102 | High | `components/FeatureErrorBoundary.tsx` | Never resets on route change |
| 8 | BUG-FE-UI-103 | Medium | `components/Toast.tsx` | Auto-dismiss timer leaks on unmount mid-fade |
| 9 | BUG-FE-UI-104 | Medium | `components/Toast.tsx` | No a11y live region; SR users miss messages |
| 10 | BUG-FE-UI-105 | High | `components/ToastProvider.tsx` | Queue race drops initial toast on rapid bursts |
| 11 | BUG-FE-UI-106 | Medium | `components/ToastProvider.tsx` | Gap timer leaks on unmount |
| 12 | BUG-FE-UI-107 | High | `components/DatePicker.tsx` | min/max + disabledDate ignored on quick-select / typed |
| 13 | BUG-FE-UI-108 | Medium | `components/DatePicker.tsx` | Modal visibility leaks across re-mounts |
| 14 | BUG-FE-UI-109 | Low | `components/OfflineBanner.tsx` | Re-renders subtree on every NetInfo tick |
| 15 | BUG-FE-STATE-001 | Critical | `store/use*Store.ts` | Stores never reset on logout — prior-user data leak |
| 16 | BUG-FE-STATE-002 | High | `store/useHabitStore.ts` | Factory selectors defeat Zustand memoization |
| 17 | BUG-FE-STATE-003 | Medium | `store/useStageStore.ts` | `updateStageProgress` silently drops unknown keys |
| 18 | BUG-FE-STORAGE-001 | Critical | `storage/llmKeyStorage.ts` | No web fallback; BYOK crashes on Expo Web |
| 19 | BUG-FE-STORAGE-002 | High | `storage/habitStorage.ts` | `savePendingCheckIn` read-modify-write race |
| 20 | BUG-FE-STORAGE-003 | Medium | `storage/notificationStorage.ts` | Serial iterate + no orphan pruning |
| 21 | BUG-FE-STORAGE-004 | Medium | `storage/authStorage.ts`, `llmKeyStorage.ts` | Empty / whitespace credentials persisted |
| 22 | BUG-FE-TEST-001 | High | `jest.config.js` | Missing `clearMocks` / `resetMocks` |
| 23 | BUG-FE-TEST-002 | Medium | `jest.config.js` | `testEnvironment: 'node'` for RN components |
| 24 | BUG-FE-TEST-003 | Low | `babel.config.js` | Reanimated plugin unconditional; no prod split |

---

## Design — tokens & responsive

### BUG-FE-UI-001 — `colors.neutral` (#8c8c8c) fails WCAG AA as text on `background.primary`
- **Severity:** High
- **Component:** `frontend/src/design/tokens.ts:18-21`
- **Symptom:** Any UI element that renders `colors.neutral` text on top of `colors.background.primary` (#f8f8f8) — a common pairing for disabled states and muted labels — has a contrast ratio of ~3.09:1, which fails WCAG 2.1 AA for normal body text (requires >= 4.5:1). Comparable risk for `text.tertiary` (#999999) whose own doc-comment admits 2.91:1 fails AA.
- **Root cause:**
  ```ts
  neutral: '#8c8c8c',

  background: {
    primary: '#f8f8f8',
  ...
    tertiary: '#999999',
  ```
  The "neutral" swatch and `text.tertiary` were picked for aesthetics without an AA-compliant fallback. Only `tertiaryAccessible` (#707070) satisfies AA, but nothing in the tokens file steers consumers away from the inaccessible values — they're listed first and named as if they were the default.
- **Fix:** Either darken `neutral` to >= #707070 (passes AA on #f8f8f8), or mark `neutral`/`text.tertiary` as "decorative only — do not use for text" via JSDoc and surface lint rules. For body copy, standardize on `text.secondaryAccessible` / `text.tertiaryAccessible` and migrate call sites. Add a contrast unit test that asserts each foreground token hits >= 4.5:1 against each background token advertised for text.

---

### BUG-FE-UI-002 — `colors.mystical.glowLight` / `transparentLight` fail AA on light backgrounds; no dark-mode palette at all
- **Severity:** High
- **Component:** `frontend/src/design/tokens.ts:43-48, 26-41`
- **Symptom:** `glowLight` is `rgba(255,255,255,0.2)` and `transparentLight` is `rgba(255,255,255,0.7)`. Layered on the app's default light `background.primary` (#f8f8f8) these are effectively white-on-white — invisible or sub-1.5:1 contrast if any text lands on them. More structurally: there is no dark-mode palette defined, so every `text.primary` → `background.primary` pair is baked in and the app cannot respond to `useColorScheme()`.
- **Root cause:**
  ```ts
  mystical: {
    glowLight: 'rgba(255, 255, 255, 0.2)',
    ...
    transparentLight: 'rgba(255, 255, 255, 0.7)',
  },
  ...
  text: { primary: '#333333', light: '#ffffff' }
  ```
  The palette assumes one theme. `mystical.*` semi-transparents were designed for a dark overlay but are referenced generically, and there is no `theme` indirection to pick a variant per scheme.
- **Fix:** Introduce a `themes.light` / `themes.dark` object and a `useTheme()` hook; move raw hex values behind role-based keys (e.g., `onSurface`, `surface`, `surfaceVariant`). Restrict `mystical.transparentLight` to dark-surface overlays only and document as such. Add a Jest test that iterates both themes and asserts every `text.*` swatch meets AA against the paired `background.*`.

---

### BUG-FE-UI-003 — No minimum touch-target token; every call site hardcodes and several already fall below 44pt/48dp
- **Severity:** High
- **Component:** `frontend/src/design/tokens.ts:126-133` (and the absence of a `touchTarget` export anywhere in the file)
- **Symptom:** The CLAUDE.md/scope explicitly lists "touch targets" as a token category, but `tokens.ts` exports no `touchTarget`/`minHitSlop` constant. The only size-like values are `SPACING.xl: 20` and `SPACING.xxl: 30`, so buttons composed from these (`padding: SPACING.md` on a 16px icon = 40px total) silently fall under Apple HIG (44pt) and Material (48dp) minimums. This is a documented accessibility failure for users with motor impairments and is routinely flagged by store review.
- **Root cause:**
  ```ts
  export const SPACING = {
    xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 30,
  } as const;
  // no TOUCH_TARGET / MIN_HIT_SLOP export anywhere in tokens.ts
  ```
  Without a named constant, consumers build tap targets ad-hoc and there is no lint-able source of truth.
- **Fix:** Add
  ```ts
  export const TOUCH_TARGET = { minIOS: 44, minAndroid: 48, recommended: 48 } as const;
  export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
  ```
  and refactor `Pressable`/`TouchableOpacity` wrappers to enforce `minWidth: TOUCH_TARGET.recommended` / `minHeight: TOUCH_TARGET.recommended`. Add a Jest snapshot test over shared button components verifying rendered style meets the minimum.

---

### BUG-FE-UI-004 — `useResponsive` has no Dimensions listener cleanup and relies solely on `useWindowDimensions`; landscape `columns` computed from first-render only in tests
- **Severity:** Medium
- **Component:** `frontend/src/design/useResponsive.ts:35-56`
- **Symptom:** `useWindowDimensions` itself subscribes correctly in production, but (a) the hook exposes no memoization, so every ancestor re-render recomputes `scale`/`gridGutter`/`breakpointKey` and produces a fresh object identity — downstream `useMemo`/`memo` on this value invalidate every render. (b) There is no SSR/pre-layout guard: on first paint `width === 0` / `height === 0` is possible on Android early mount, yielding `breakpointKey === 'xs'` and `columns = 1` flicker. (c) In Jest (`react-test-renderer`) `useWindowDimensions` returns a static `{ width: 750, height: 1334 }` and never updates, so orientation-change tests pass but production rotation bugs go undetected.
- **Root cause:**
  ```ts
  export const useResponsive = () => {
    const { width, height } = useWindowDimensions();
    const breakpointKey = getBreakpointKey(width);
    const baseScale = getBaseScale(width);
    const scale = baseScale * getHeightScale(height);
    const columns = width > height ? 2 : 1;
    const gridGutter = spacing(1, scale);
    return { width, height, /* ... */ columns, gridGutter, scale } as const;
  };
  ```
  A new object literal is returned every render, there is no `width === 0` short-circuit, and no `useMemo` wrap.
- **Fix:** Wrap the return in `useMemo(..., [width, height])`; short-circuit when `width === 0 || height === 0` to return a sensible default (`md` breakpoint, `scale: 1`); and add a test that mocks `useWindowDimensions` to emit a rotation transition and asserts `columns` flips 1 → 2. Optionally expose an `isReady` boolean so consumers can defer layout until real dimensions are known.

---

### BUG-FE-UI-005 — `DesignSystem.ts` re-exports a stale subset of tokens, guaranteeing drift
- **Severity:** Medium
- **Component:** `frontend/src/design/DesignSystem.ts:1-7`
- **Symptom:** `DesignSystem.ts` re-exports only `{ breakpoints, spacing, radius, elevation, typography }`. It omits `colors`, `SPACING`, `BORDER_RADIUS`, `shadows`, `STAGE_COLORS`, `VICTORY_COLOR`, `MAP_STAGE_COLORS`, `TOUCH_TARGET` (once added), and anything else added to `tokens.ts`. Consumers who followed the file's own docstring advice ("New code should import directly from `@/design/tokens`") and those who imported from `DesignSystem` now see diverging surfaces; any token added to `tokens.ts` is invisible through `DesignSystem` without a manual edit — a classic barrel-file drift bug.
- **Root cause:**
  ```ts
  /**
   * Design system utilities — re-exports from the canonical tokens module.
   * New code should import directly from `@/design/tokens`.
   */
  export { breakpoints, spacing, radius, elevation, typography } from './tokens';
  ```
  An explicit allow-list that is never updated. Worse, the file both tells readers not to use it and continues to exist as a public import path.
- **Fix:** Either (a) replace the allow-list with `export * from './tokens';` so the two stay in lockstep, or (b) delete `DesignSystem.ts` entirely and migrate the handful of remaining imports to `'./tokens'` with a codemod. Add an ESLint `no-restricted-imports` rule banning new imports from `DesignSystem` if option (b) is chosen.


---

## Shared components

### BUG-FE-UI-101 — ErrorBoundary only logs to console, no observability and no reset path
- **Severity:** High
- **Component:** `frontend/src/components/ErrorBoundary.tsx:26-49`
- **Symptom:** When a crash happens in production, engineers never learn about it: there is no Sentry/Crashlytics report, no API beacon, and nothing but a `console.error` that is invisible on a shipped bundle. Worse, the boundary also has no user-facing recovery — once `state.error` is set, the only way out is a full reload of the app.
- **Root cause:**
  ```tsx
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <View style={styles.container} testID="error-boundary">
        {/* ... message and stack, but no reset button */}
  ```
  The handler never forwards the error to an observability sink, and the fallback UI lacks a "Try again" affordance that clears `state.error`. The boundary is also instance-wide — a single render blip on any screen poisons the whole tree until process restart.
- **Fix:** Route `componentDidCatch` through a centralized reporter (e.g., `reportError(error, { componentStack: info.componentStack })` wired to Sentry/Crashlytics) and gate the `console.error` behind `__DEV__`. Add a `handleReset = () => this.setState({ error: null })` method and a retry button in the fallback, and expose an optional `onReset` prop so navigation-aware callers can pair it with a route replace.

### BUG-FE-UI-102 — FeatureErrorBoundary never resets on route change, leaving a stuck error surface
- **Severity:** High
- **Component:** `frontend/src/components/FeatureErrorBoundary.tsx:21-60`
- **Symptom:** A transient failure inside, for example, Journal leaves the boundary in the error state. Navigating away to Habits and back keeps the retry card visible because `state.error` is still set on the same boundary instance — the user has to tap "Try again" manually or force-quit. If the underlying error was due to a stale prop (e.g., an old user token), remounting via route change should have fixed it automatically.
- **Root cause:**
  ```tsx
  private handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    // ...no effect hooks to react to prop/route changes
  ```
  The class component has no `componentDidUpdate` that clears the error when `props.name` (or a caller-provided `resetKeys`) changes, so the boundary is effectively sticky across navigations when the subtree is kept mounted by the tab navigator. It also lacks observability reporting (same root cause as BUG-FE-UI-101).
- **Fix:** Accept a `resetKeys: unknown[]` prop and implement `componentDidUpdate(prevProps)` that calls `this.setState({ error: null })` when any key differs by `Object.is`. Callers can pass the active route name or user id so the boundary auto-clears on navigation. Also forward errors to the same observability sink used by the root boundary.

### BUG-FE-UI-103 — Toast auto-dismiss timer leaks when the component unmounts mid-fade-in
- **Severity:** Medium
- **Component:** `frontend/src/components/Toast.tsx:50-60`
- **Symptom:** If the `Toast` unmounts (e.g., provider resets, navigation unmounts the overlay) after `fadeIn.start` begins but before its completion callback fires, the `timeout` handle is still `undefined` when the cleanup runs. The subsequent `fadeIn.start` callback then creates a `setTimeout` that is *never* cleared because the effect's cleanup has already run. The timer later calls `onDismiss`, which calls `setState` on an unmounted provider and may also dispatch a stale toast.
- **Root cause:**
  ```tsx
  let timeout: ReturnType<typeof setTimeout>;
  fadeIn.start(() => {
    timeout = scheduleExit(fadeOut, onDismiss, duration ?? DEFAULT_DURATION_MS);
  });
  return () => clearTimeout(timeout);
  ```
  `timeout` is captured by closure at cleanup time, so if cleanup runs before the `fadeIn` callback fires, it reads `undefined`. The animation itself is also not stopped — `fadeIn`/`fadeOut` continue to run and invoke their callbacks after unmount.
- **Fix:** Track cancellation with a ref or flag: store the timer in a `useRef<number | null>(null)`, inside the fadeIn callback check `if (cancelledRef.current) return;` before scheduling, and in cleanup set the flag, call `fadeIn.stop()` / `fadeOut.stop()`, and `clearTimeout(timerRef.current ?? undefined)`.

### BUG-FE-UI-104 — Toast has no a11y live-region announcement, so VoiceOver/TalkBack users miss the message
- **Severity:** Medium
- **Component:** `frontend/src/components/Toast.tsx:69-88`
- **Symptom:** Critical success/failure feedback (e.g., "Saved entry", "Upload failed") is invisible to screen-reader users because the toast is rendered inside a `pointerEvents="none"` overlay and never announces itself. The `Animated.View` has no `accessibilityLiveRegion`, no `accessibilityRole="alert"`, and no `accessibilityLabel`, so the assistive tech has no cue to speak the message when it appears.
- **Root cause:**
  ```tsx
  <Animated.View
    testID="toast-container"
    style={[
      styles.container,
      { opacity, transform: [{ translateY }], borderLeftColor: borderColor },
    ]}
  >
  ```
  No accessibility props on the container, and the provider wrapper sets `pointerEvents="none"` which further prevents focus being moved. On Android, only `accessibilityLiveRegion="polite" | "assertive"` triggers announcements; on iOS, `AccessibilityInfo.announceForAccessibility` must be called imperatively.
- **Fix:** Add `accessibilityRole="alert"`, `accessibilityLiveRegion="polite"` (Android), and `accessibilityLabel={message}` to the container. Inside the fade-in `start` callback, call `AccessibilityInfo.announceForAccessibility(message)` for iOS. For urgent/error toasts, upgrade to `"assertive"`.

### BUG-FE-UI-105 — ToastProvider queue races on rapid show() bursts and drops the initial toast
- **Severity:** High
- **Component:** `frontend/src/components/ToastProvider.tsx:19-43`
- **Symptom:** Two toasts fired back-to-back in the same tick — e.g., `showToast({message:'A'}); showToast({message:'B'});` — can both observe `isShowingRef.current === false` because the first call synchronously enqueues and calls `showNext`, which sets `isShowingRef.current = true` *after* the React batch decides render. But within the same tick, the second call then also pushes and, because `showNext` calls `setCurrentToast(next)` synchronously but the ref flip happens above it, the guard works — however, on dismissal the 400 ms delay allows a new `showToast` during the gap to take a different code path (it sees `isShowingRef.current === false` because `handleDismiss` already set state to null but no `showNext` has fired yet) and bypasses the queue, so two toasts can render in sequence without the intended gap, or the queued toast is never shown.
- **Root cause:**
  ```tsx
  const handleDismiss = useCallback(() => {
    setCurrentToast(null);
    setTimeout(showNext, TOAST_GAP_MS);
  }, [showNext]);

  const showToast = useCallback((config: ToastConfig) => {
    queueRef.current.push(config);
    if (!isShowingRef.current) {
      showNext();
    }
  }, [showNext]);
  ```
  `handleDismiss` does not flip `isShowingRef.current` to `false`, so during the 400 ms gap `showToast` still sees `true` and only enqueues — but the `setTimeout(showNext)` will then shift the item correctly. However, there's no protection against the component unmounting during the gap (timer leak) and if `showNext` runs with an empty queue it flips the flag to `false`, *after* which a new enqueue + guard race can cause the same toast to be shown twice if `showNext` is called again during React's batching.
- **Fix:** Flip `isShowingRef.current = false` inside `handleDismiss` before starting the gap timer, and track the gap timer in a ref so the provider can clear it on unmount. Use a single source of truth: replace the ref + state with a reducer, or always schedule `showNext` via `queueMicrotask` to avoid re-entrant calls in the same render pass.

### BUG-FE-UI-106 — ToastProvider leaks the gap timer on unmount
- **Severity:** Medium
- **Component:** `frontend/src/components/ToastProvider.tsx:30-33`
- **Symptom:** If the provider unmounts while a toast is in its 400 ms dismissal gap (e.g., user logs out, navigator unmounts the overlay), the `setTimeout(showNext, TOAST_GAP_MS)` keeps a reference to the now-orphaned `showNext` closure, which then calls `setCurrentToast` on the unmounted provider, producing a "Can't perform a React state update on an unmounted component" warning and potentially a stale closure bug.
- **Root cause:**
  ```tsx
  const handleDismiss = useCallback(() => {
    setCurrentToast(null);
    setTimeout(showNext, TOAST_GAP_MS);
  }, [showNext]);
  ```
  The timer handle is discarded, and there is no `useEffect` cleanup to clear it. The provider has no lifecycle guard at all.
- **Fix:** Store the timer in a `gapTimerRef` and add `useEffect(() => () => { if (gapTimerRef.current) clearTimeout(gapTimerRef.current); }, [])`. Also guard `setCurrentToast` calls with a `mountedRef` that flips to `false` in the same cleanup.

### BUG-FE-UI-107 — DatePicker does not enforce min/max bounds or disabledDate on quick-select and typed input
- **Severity:** High
- **Component:** `frontend/src/components/DatePicker.tsx:134-157, 248-262`
- **Symptom:** The three quick-select buttons ("today", "next monday", "first of next month") all call `commitDate` — which does validate — but users on web can still bypass bounds via `formatDisplayDate`-round-tripped typed input: `parseDateInput` accepts raw strings like `"03/01/50"` that parse to years outside min/max, and the error state is set but `onChange` is still not fired, leaving the parent with a stale value while the input shows the new text. More critically, the native `DateTimePickerModal`'s `minimumDate`/`maximumDate` props are wired, but `disabledDate` is *not* — users can pick disabled days via the native dialog and `onConfirm` will commit if the date passes min/max even when `disabledDate(date)` would reject it. The subsequent `commitDate` call does validate, but by then the modal has dismissed and the UI appears to have accepted the invalid pick (error shows but the picker is gone and the text input is wrong).
- **Root cause:**
  ```tsx
  const NativePicker: React.FC<NativePickerProps> = ({ ... }) => (
    <DateTimePickerModal
      minimumDate={minDate ? parseISODate(minDate) : undefined}
      maximumDate={maxDate ? parseISODate(maxDate) : undefined}
      onConfirm={(date: Date) => {
        setPickerVisible(false);
        commitDate(date);
      }}
    />
  );
  ```
  `disabledDate` is not propagated to the native picker (not all pickers support it, but the app should visually disable these days or re-open the picker on validation failure). Quick-select buttons pre-compute dates that may violate bounds (e.g., `getNextMonday()` could be past `maxDate`) and do not check them before firing — the error shows, but the text input still reflects the stale value because `handleChangeText` writes text state regardless of validity.
- **Fix:** (1) In `QuickDateButtons`, compute bounds and disable each button when the candidate date is out of range or rejected by `disabledDate`. (2) Pass `disabledDate` through to the native picker as `isDayBlocked` where supported, and after `onConfirm` re-open the modal when validation fails instead of silently rejecting. (3) In `makeHandleChangeText`, when parsing succeeds but validation fails, revert `textValue` to `formatDisplayDate(parseISODate(value), locale)` so the text input and the committed value stay in sync.

### BUG-FE-UI-108 — DatePicker native modal leaks visibility state across re-mounts and ignores the dynamic `value` prop while the modal is open
- **Severity:** Medium
- **Component:** `frontend/src/components/DatePicker.tsx:264-311`
- **Symptom:** The `pickerVisible` state lives inside `DatePicker`, but the modal's `date` prop is computed from the current `value`. If a parent changes `value` while the modal is open (e.g., a "suggest a date" action wires through props), the modal's displayed wheel stays at the previous value because `DateTimePickerModal`'s `date` prop is only consulted at open time on iOS. Additionally, the modal is rendered even when `pickerVisible` is `false` — the module stub is fine on web, but on native the module mounts a hidden dialog subtree, which on Android can cause back-button handling to swallow the first press after navigation. There's also no `onDismiss` handler separate from `onCancel`, so swiping the modal away on iOS ≥ 13 (which fires `onDismiss` but not `onCancel`) leaves `pickerVisible === true` and future taps on the input do nothing.
- **Root cause:**
  ```tsx
  <DateTimePickerModal
    isVisible={pickerVisible}
    mode="date"
    date={value ? parseISODate(value) : new Date()}
    onConfirm={(date: Date) => { setPickerVisible(false); commitDate(date); }}
    onCancel={() => setPickerVisible(false)}
  />
  ```
  No `onDismiss`/`onHide` handlers, no cleanup effect that closes the picker when the component unmounts, and the `TextInput`'s `onFocus` sets `pickerVisible` even when the picker is already visible, leading to re-entrancy.
- **Fix:** Add `onDismiss={() => setPickerVisible(false)}` and `onHide={() => setPickerVisible(false)}`. Gate the `onFocus` handler with `if (!pickerVisible) setPickerVisible(true)`. Add `useEffect(() => () => setPickerVisible(false), [])` to ensure cleanup on unmount. On Android, conditionally render the modal only when `pickerVisible` so it does not mount a hidden dialog.

### BUG-FE-UI-109 — OfflineBanner re-renders whole subtree on every NetInfo tick and depends on context shape that can churn
- **Severity:** Low
- **Component:** `frontend/src/components/OfflineBanner.tsx:14-16`
- **Symptom:** `useNetworkStatus()` returns a fresh object on many NetInfo ticks (including ones where `isOnline` did not change), so `OfflineBanner` re-renders every time, and because it's mounted near the root, it drags its parent re-render path with it. When offline, the banner also can flash during quick toggles because there is no debounce — a momentary drop (common on iOS when switching WiFi bands) causes the banner to appear and disappear within a second.
- **Root cause:**
  ```tsx
  export function OfflineBanner(): React.JSX.Element | null {
    const { isOnline } = useNetworkStatus();
    if (isOnline) return null;
  ```
  There is no local state, no memoization, and no hysteresis. Every consumer re-renders whenever the context value changes identity, even if `isOnline` is stable.
- **Fix:** Wrap the component in `React.memo` (trivially helps as props are empty) and, more importantly, gate rendering on a debounced `isOnline` value with a short hysteresis window (e.g., 1-2 s offline before banner appears, 500 ms online before it hides). Audit `NetworkStatusContext` to ensure its `value` is memoized to a stable identity when `isOnline` doesn't change, and expose `isOnline` as a primitive from a selector hook.


---

## State, storage, test & bundler config

### BUG-FE-STATE-001 — Zustand stores are never reset on logout, leaking prior user's habits/stage/progress into the next session
- **Severity:** Critical
- **Component:** `frontend/src/context/AuthContext.tsx:180-183`, `frontend/src/store/useHabitStore.ts:51-75`, `frontend/src/store/useStageStore.ts:55-77`, `frontend/src/store/useUserStore.ts:14-24`
- **Symptom:** User A logs out, User B logs in on the same device: `useHabitStore.habits`, `useStageStore.stagesByNumber`, and `useUserStore.preferences` still hold User A's data until the app is force-killed or an API hydrate overwrites each slice. During the flash between login and the first successful fetch, User B sees User A's habits/stage/theme.
- **Root cause:**
  ```ts
  // AuthContext.tsx
  const logout = useCallback(async () => {
    await clearToken();
    setToken(null);
  }, []);
  ```
  `logout()` only clears the auth token — nothing calls `useHabitStore.setState(initial)` / `useStageStore.setState(initial)` / `useUserStore.setState(initial)` or equivalent reset actions. None of the three stores export a `reset()` action, and Zustand state is module-scoped so it survives until the JS VM is torn down.
- **Fix:** Export a `reset` action on each store (e.g. `reset: () => set({ habitsById: {}, habitOrder: [], habits: [], loading: false, error: null })`) and call all three inside `logout` and inside `clearTokenThenReset` (the 401 path). Also call them on successful login *before* starting hydration, so a cached prior-user state never flashes.

### BUG-FE-STATE-002 — `selectHabitById` / `selectStageByNumber` create a new selector function on every call, defeating Zustand memoization
- **Severity:** High
- **Component:** `frontend/src/store/useHabitStore.ts:93-96`, `frontend/src/store/useStageStore.ts:90-93`
- **Symptom:** Components that do `const habit = useHabitStore(selectHabitById(id))` pass a freshly-constructed selector into Zustand on every render. Zustand compares the selector's returned value via `Object.is` (fine), but the pattern encourages authors to inline the id and re-subscribe — and when the id changes the subscription identity churns. More importantly, callers who *do* memoize with `useMemo(() => selectHabitById(id), [id])` still pay: each new closure means Zustand's internal `currentSliceRef` is cleared, causing one extra forced render on each id change.
- **Root cause:**
  ```ts
  export const selectHabitById =
    (id: number | null | undefined) =>
    (state: HabitStoreState): Habit | undefined =>
      id == null ? undefined : state.habitsById[id];
  ```
  The factory signature invites `useHabitStore(selectHabitById(habitId))` — a new function each render — rather than a hook that captures `id` in a dependency-aware way.
- **Fix:** Replace the factory with a hook: `export function useHabitById(id: number | null | undefined): Habit | undefined { return useHabitStore(useCallback((s) => (id == null ? undefined : s.habitsById[id]), [id])); }`. Same treatment for `selectStageByNumber`. Grep existing callers and migrate.

### BUG-FE-STATE-003 — `updateStageProgress` silently drops unknown stage numbers, masking contract drift
- **Severity:** Medium
- **Component:** `frontend/src/store/useStageStore.ts:67-76`
- **Symptom:** If the backend introduces stage 11 and the frontend hasn't yet loaded stages (or if `setStages` was called with a filtered subset), a progress update for that stage disappears with no error or log. Debugging "why isn't stage 11 progress saving?" requires reading the store source.
- **Root cause:**
  ```ts
  updateStageProgress: (stageNumber, progress) =>
    set((state) => {
      const existing = state.stagesByNumber[stageNumber];
      if (!existing) return state;   // silent no-op
      ...
    }),
  ```
  Returning `state` on a miss is a silent swallow — the action reports success via its void return, so the caller (`stageService`) thinks the update landed.
- **Fix:** Either `console.warn('[stageStore] updateStageProgress: unknown stage', stageNumber)` on the miss and continue to no-op, OR change the action to return a boolean and surface the miss to the caller so service tests catch the mismatch. The existing habit store's `updateHabit` has the same defect (`useHabitStore.ts:63`) and should be fixed together.

### BUG-FE-STORAGE-001 — LLM API key storage has no web fallback; BYOK flow crashes on Expo Web with "setItemAsync is not a function"
- **Severity:** Critical
- **Component:** `frontend/src/storage/llmKeyStorage.ts:1-24`
- **Symptom:** On Expo Web (which the codebase explicitly supports — see `authStorage.ts:13-15`), calling `saveLlmApiKey()` throws `TypeError: SecureStore.setItemAsync is not a function` because `expo-secure-store`'s web module is `export default {}`. The BYOK onboarding screen crashes, `ApiKeyContext.saveApiKey` swallows the error into `loadError`, and the user is stuck with no key, no persistence, no actionable message.
- **Root cause:**
  ```ts
  import * as SecureStore from 'expo-secure-store';
  export async function saveLlmApiKey(apiKey: string): Promise<void> {
    await SecureStore.setItemAsync(LLM_API_KEY_STORAGE_KEY, apiKey);
  }
  ```
  `authStorage.ts` mirrors `SecureStore` onto `AsyncStorage` via a `Platform.OS === 'web'` guard, but `llmKeyStorage.ts` does not. The file header explicitly claims "never uploaded to our backend… storage contract guaranteed by issue #185" — but on web, the contract isn't honored because it throws before it can even store in memory.
- **Fix:** Mirror `authStorage.ts`'s pattern: add `const isWeb = Platform.OS === 'web'`; on web, fall back to `AsyncStorage` with a `// SECURITY: web uses localStorage — keys are readable by any script on origin; document and gate feature behind feature flag` comment. Better: disable the BYOK feature entirely on web until a true web-secure store (e.g., IndexedDB + WebCrypto) lands.

### BUG-FE-STORAGE-002 — `savePendingCheckIn` has a read-modify-write race; concurrent offline check-ins drop rows
- **Severity:** High
- **Component:** `frontend/src/storage/habitStorage.ts:69-73`
- **Symptom:** Two quick check-ins (e.g., the user taps "complete" on two habits within a few ms while offline) can both execute `loadPendingCheckIns()` before either calls `setItem`. The second write overwrites the first with only its own entry, silently losing the first check-in forever.
- **Root cause:**
  ```ts
  export async function savePendingCheckIn(checkIn: PendingCheckIn): Promise<void> {
    const existing = await loadPendingCheckIns();  // A reads []
    existing.push(checkIn);                         // B reads [] too
    await AsyncStorage.setItem(PENDING_CHECKINS_KEY, JSON.stringify(existing));  // both write single-item arrays
  }
  ```
  `AsyncStorage` provides no transactional RMW. Without an in-process queue, the classic lost-update bug applies. Same risk in `notificationStorage.ts:94-100` (`trackHabitId`) and `102-106` (`untrackHabitId`).
- **Fix:** Serialize pending-checkin writes through a module-level promise chain: `let queue: Promise<void> = Promise.resolve(); export async function savePendingCheckIn(c) { queue = queue.then(() => doSave(c)).catch(() => {}); return queue; }`. Do the same for `trackHabitId`/`untrackHabitId`. Consider `AsyncStorage.mergeItem` where the storage layer supports it, but a queue is simpler and works everywhere.

### BUG-FE-STORAGE-003 — `loadAllNotificationMappings` iterates serially and never prunes ids whose habit was deleted in another session
- **Severity:** Medium
- **Component:** `frontend/src/storage/notificationStorage.ts:53-63`, `78-92`
- **Symptom:** (a) The loop awaits one habit at a time — for 30 habits that's 30 serial AsyncStorage round-trips at cold start; on older Android this adds noticeable lag to the notification rehydrate path. (b) If a habit is deleted while the app is killed (e.g., server-side admin delete, or prior session's `clearHabits()` not matched by `clearNotificationIds`), `ALL_HABIT_IDS_KEY` keeps the stale id; every launch reloads an empty array for it, and no code path ever prunes it. The id list grows monotonically until reinstall.
- **Root cause:**
  ```ts
  for (const habitId of habitIds) {
    const ids = await loadNotificationIds(habitId);  // serial
    if (ids.length > 0) mappings[habitId] = ids;
  }
  ```
  Plus: no reconciliation step compares `ALL_HABIT_IDS_KEY` against the live habit set.
- **Fix:** Use `Promise.all(habitIds.map(loadNotificationIds))` for parallelism. Add a `pruneOrphanedNotificationIds(liveHabitIds: number[])` called once at cold start from the habit-hydrate path: drop any tracked id not in `liveHabitIds` and `clearNotificationIds` its key.

### BUG-FE-STORAGE-004 — `saveLlmApiKey` and `saveToken` never validate input, persisting empty or whitespace strings as real credentials
- **Severity:** Medium
- **Component:** `frontend/src/storage/llmKeyStorage.ts:14-16`, `frontend/src/storage/authStorage.ts:17-23`
- **Symptom:** A caller that passes `''` or `'   '` (e.g., a form submit with trimming off) silently writes a non-null, non-empty-by-`getItem` value. `loadLlmApiKey()` returns `''` (truthy-ish but useless), the API request adds `X-LLM-API-Key: ` to the header, and the backend rejects with 401 — the user sees "invalid API key" with no indication it was a client-side fumble.
- **Root cause:**
  ```ts
  export async function saveLlmApiKey(apiKey: string): Promise<void> {
    await SecureStore.setItemAsync(LLM_API_KEY_STORAGE_KEY, apiKey);
  }
  ```
  No `.trim()`, no length check, no reject-empty. Same in `saveToken`.
- **Fix:** `if (!apiKey || apiKey.trim().length === 0) throw new Error('saveLlmApiKey: refusing to persist empty key');` before the call. Same guard in `saveToken`. Unit-test both.

### BUG-FE-TEST-001 — `jest.config.js` has no `clearMocks` / `resetMocks`; mock state leaks between tests
- **Severity:** High
- **Component:** `frontend/jest.config.js:1-35`
- **Symptom:** Tests that mock `@react-native-async-storage/async-storage` or `expo-secure-store` inherit call history and implementation overrides from prior tests in the same file. A mock set up as `mockResolvedValueOnce` in an earlier test can poison later ones; `toHaveBeenCalledTimes(1)` assertions pass or fail depending on test ordering. This is the classic "works in isolation, fails in suite" symptom.
- **Root cause:**
  ```js
  module.exports = {
    preset: 'react-native',
    testEnvironment: 'node',
    setupFilesAfterEnv: ['@testing-library/jest-native/extend-expect'],
    // no clearMocks / resetMocks / restoreMocks
    ...
  };
  ```
  No automatic mock hygiene. Individual test files must manually call `jest.clearAllMocks()` in `beforeEach`, which is inconsistent across the codebase.
- **Fix:** Add `clearMocks: true, resetMocks: true, restoreMocks: true` to the config. Run the full suite once to surface now-visible leaks, then fix the handful of tests that were relying on leaked state.

### BUG-FE-TEST-002 — `testEnvironment: 'node'` is wrong for React Native component tests; DOM APIs are missing
- **Severity:** Medium
- **Component:** `frontend/jest.config.js:5`
- **Symptom:** Tests that render components touching `window`, `document`, `fetch`, or `URL` parsing fail with `ReferenceError: window is not defined` under `testEnvironment: 'node'`. `@testing-library/react-native` works in Node for *most* cases but breaks for any component that brushes DOM globals (e.g., code paths gated on `Platform.OS === 'web'`, or libraries that detect env via `typeof window`).
- **Root cause:**
  ```js
  preset: 'react-native',
  testEnvironment: 'node',
  ```
  The `react-native` preset defaults to `node`, but the app mounts `Platform.OS === 'web'` branches (see `authStorage.ts:15`). Those branches can't be exercised under node without shimming `window`.
- **Fix:** For the main suite, keep `node` but add `/**
 * @jest-environment jsdom
 */` pragmas on specific web-branch tests, or create a second Jest project for web-branch coverage with `testEnvironment: 'jsdom'`. Alternatively, mock `Platform` explicitly in every web-branch test — but a jsdom project is the more durable fix.

### BUG-FE-TEST-003 — `babel.config.js` unconditionally includes `react-native-reanimated/plugin`, bloating Jest transforms and lacking production optimizations
- **Severity:** Low
- **Component:** `frontend/babel.config.js:1-5`
- **Symptom:** (a) Every test file is transformed through the Reanimated plugin even though most tests mock it out — slows CI by a few seconds per run. (b) No `env.production` block strips `console.*` calls or React DevTools hooks from release bundles; every `console.warn` from `storage/*.ts:37` ships to end users. (c) No test-env-only block means any future test-only plugins will leak into the release bundle.
- **Root cause:**
  ```js
  module.exports = {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-reanimated/plugin'],
  };
  ```
  No `env` split. Reanimated's plugin docs explicitly state it must be *last* (it is, by default) but also that it's only needed at the transform point where worklets are declared — for test files that never import `react-native-reanimated`, it's overhead.
- **Fix:** Split by env: `env: { production: { plugins: [['transform-remove-console', { exclude: ['error', 'warn'] }]] } }` to strip debug logs in release. Keep Reanimated plugin outside `env` (it must remain last globally). Verify the resulting bundle size drop and confirm tests still pass.

---

## Suggested Remediation Order

1. **BUG-FE-STATE-001 (Critical)** — Add a `reset()` action to every Zustand store; call them from `AuthContext.logout`. Add a regression test that mounts a screen after logout and asserts the store is empty.
2. **BUG-FE-STORAGE-001 (Critical)** — Mirror `authStorage.ts`'s `Platform.OS === 'web'` fallback in `llmKeyStorage.ts` (use AsyncStorage or a `__keys` in `localStorage` under a namespaced key). Add a web-platform test.
3. **BUG-FE-STORAGE-004 (Medium, but pair with 001)** — Reject whitespace-only / empty credentials at the storage layer; throw rather than persist.
4. **BUG-FE-UI-101 / -102 (High)** — Wire `ErrorBoundary` to the observability client (Sentry / PostHog); expose a `resetKey` prop that `FeatureErrorBoundary` resets on route change.
5. **BUG-FE-UI-001 / -002 / -003 (High)** — Fix contrast on `neutral` and `text.tertiary`; introduce a dark-mode palette token tree; add a `touchTarget` token (44pt iOS, 48dp Android) and migrate every hit target.
6. **BUG-FE-STATE-002 (High)** — Replace factory selectors with inlined selectors (`s.habits[id]`) at call sites, or wrap in `useShallow` / memoize the factory.
7. **BUG-FE-UI-107 (High)** — Enforce `disabledDate` + min/max on every DatePicker path (quick-select, typed, modal). Add an automated test that asserts a disabled date cannot be selected via any entry point.
8. **BUG-FE-UI-105 (High)** — Serialize the toast queue on a ref-stored array; move `show()` to enqueue + process-next rather than racing state.
9. **BUG-FE-STORAGE-002 (High)** — Wrap `savePendingCheckIn` in an async mutex (`p-limit` with `concurrency: 1`) or switch to an append-only log in AsyncStorage (one key per check-in).
10. **BUG-FE-TEST-001 (High)** — Add `clearMocks: true`, `resetMocks: true` to jest.config.js. Re-run the suite to surface hidden cross-test coupling.
11. **BUG-FE-UI-103 / -106 / -108 / -109 (Medium)** — Clear timers on unmount; memoize `OfflineBanner` via `React.memo(Component, (prev, next) => prev.online === next.online)`.
12. **BUG-FE-UI-104 (Medium)** — Add `accessibilityLiveRegion="polite"` + `accessibilityRole="alert"` to Toast.
13. **BUG-FE-STATE-003 / BUG-FE-STORAGE-003 (Medium)** — Log unknown-key drops to observability; prune orphaned notification ids on a scheduled pass.
14. **BUG-FE-UI-004 / -005 (Medium)** — Add Dimensions listener cleanup; audit the `DesignSystem.ts` re-export against `tokens.ts` and regenerate via a codegen or delete the file entirely.
15. **BUG-FE-TEST-002 / -003 (Medium/Low)** — Switch RN component tests to `jsdom` or `jest-environment-react-native`; split `babel.config.js` via `env.production` with `transform-remove-console`.

## Cross-References

- **BUG-FE-STATE-001 ↔ BUG-FE-AUTH-* / BUG-AUTH-***  — Logout leak + stores-never-reset + token-only-clear is a triple-miss on session hygiene. The auth-context fix must also dispatch store resets.
- **BUG-FE-STORAGE-001 / -004 ↔ BUG-BM-***  — BYOK key storage is the LLM credit path; empty/whitespace keys accepted here turn into 401s at the BotMason router and confuse the wallet path.
- **BUG-FE-UI-101 / -102 ↔ BUG-OBS-003 / BUG-FE-API-***  — No observability on frontend errors compounds the backend's missing global exception handler. Wire both to the same Sentry project so unhandled errors surface end-to-end.
- **BUG-FE-UI-001 / -002 / -003 ↔ Reports 16 / 17 a11y bullets** — Every report documented a11y gaps; root cause is a shared design system without a touch-target or contrast contract. Fix here unblocks fixes there.
- **BUG-FE-STATE-002 ↔ BUG-FE-JOURNAL-005 / BUG-FE-HABIT-004** — The "fresh identity per render" pattern is ubiquitous. Consolidate on `useShallow` / memoized selectors across features.
- **BUG-FE-STORAGE-002 ↔ BUG-FE-HABIT-001 / -205** — Offline check-in replay + optimistic-write rollback + AsyncStorage race all terminate in "a failed habit log is silently lost." Fix the storage primitive first, then habit manager, then rollback closure.
