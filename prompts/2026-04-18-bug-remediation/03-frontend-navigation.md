# Frontend Navigation Bug Report — 2026-04-18

**Scope:** `frontend/src/App.tsx`, `frontend/src/navigation/RootStack.tsx`, `frontend/src/navigation/BottomTabs.tsx`, `frontend/src/navigation/hooks.ts` and the linking config wired into `NavigationContainer`.

**Total bugs:** 14 — **3 Critical / 6 High / 5 Medium / 0 Low**.

## Executive summary

This audit was triggered by a user-reported regression: **tapping a bottom tab boots the user back to Signup.** The smoking gun is BUG-NAV-001 — `RootNavigator` uses the raw `token` value as the only discriminator between the authed tree and the auth tree, while `AuthProvider`'s `onUnauthorized` interceptor sets `token` to `null` on **any** 401 response. Any tab-focus request that 401s (clock skew, refresh race, backend restart) therefore unmounts the entire navigator and lands the user on Signup. Three other bugs amplify the failure mode:

- **BUG-NAV-002 (Critical)** — `isLoading` flipping back to `true` mid-session collapses the navigator to a spinner branch, losing all React Navigation state on the bounce.
- **BUG-NAV-007 (High)** — `ApiKeySettings` is not declared `presentation: 'modal'`; on iOS native-stack dismissal, `react-native-screens` swaps the view host and remounts `BottomTabs` at the default tab.
- **BUG-NAV-011 (Critical)** — `BottomTabs` calls `useAuth()` at the top of its render, so every auth-context churn re-renders all five tabs, and combined with BUG-NAV-010's inline `screenOptions` triggers a full unmount/remount cycle.

Together these four bugs explain every variant of the reported behaviour. The remaining ten cover navigation correctness (deep-link configs, type drift, modal presentation, a11y labels) and provider ordering (BUG-NAV-005) that lets unrelated UI events trigger auth-state evaluation.

## Table of contents

| ID | Severity | Component | Title |
|----|----------|-----------|-------|
| BUG-NAV-001 | Critical | `App.tsx:90-110` | Any transient 401 during tab switch clears `token` and boots the user to signup (ROOT CAUSE) |
| BUG-NAV-002 | Critical | `App.tsx:93-99` | `isLoading` flipping back to `true` mid-session collapses the navigator to a spinner and loses nav state |
| BUG-NAV-003 | High | `App.tsx:49-65, 153-159` | `NavigationContainer` stays mounted while its child navigator is swapped — `linking` references missing routes |
| BUG-NAV-004 | Medium | `App.tsx:153-159` | `SafeAreaView` wrapping the navigator clips modals and full-screen routes to safe-area insets |
| BUG-NAV-005 | High | `App.tsx:147-166` | Provider order places `ApiKeyProvider`/`ToastProvider` outside `NavigationContainer` but inside `AuthProvider` |
| BUG-NAV-006 | High | `navigation/hooks.ts:39-53` | `useRouteParams` memoises on a fresh `defaults` object, causing stale merges and re-render churn |
| BUG-NAV-007 | High | `navigation/RootStack.tsx:20-28` | `RootStack` has no `screenOptions`, so `ApiKeySettings` modal renders as a card and re-keys Tabs on dismiss (iOS) |
| BUG-NAV-008 | Medium | `App.tsx:51-64` | Deep-link `api-key-settings` lands users on the modal with no underlying `Tabs` to return to |
| BUG-NAV-009 | Medium | `navigation/hooks.ts:12-14` | Type drift — `useAppNavigation` typed against `RootTabParamList` hides root-stack navigation calls |
| BUG-NAV-010 | High | `navigation/BottomTabs.tsx:80-103` | `headerRight` closure captures stale `logout`, forcing header remount every render |
| BUG-NAV-011 | Critical | `navigation/BottomTabs.tsx:46-63` | Inline `withBoundary` + `useAuth()` couples tab remounts to auth churn — boots users to signup |
| BUG-NAV-012 | High | `navigation/BottomTabs.tsx:46-57` | `FeatureErrorBoundary` silently swallows tab mount crashes, letting the root navigator fall back to auth |
| BUG-NAV-013 | Medium | `navigation/BottomTabs.tsx:105-109` | `tabBarIcon`, `tabBarLabel`, and `accessibilityLabel` missing on tab screens |
| BUG-NAV-014 | Medium | `navigation/BottomTabs.tsx:73-75` | `openSettings` navigates to a parent-stack route from a nested tab without validating the route exists |

---

## Critical & High — App root (`App.tsx`)

### BUG-NAV-001: Any transient 401 during tab switch clears `token` and boots the user to signup (ROOT CAUSE of reported bug)
**Severity:** Critical
**Component:** `frontend/src/App.tsx:90-110`
**Symptom:** User taps a bottom tab (Habits → Journal, Course → Map, etc.). The destination screen fires an authenticated request on focus; if the backend answers 401 for any reason (clock skew, stale refresh window, backend restart, missed refresh race), the app instantly unmounts the tab tree and lands on the Signup screen — the user's exact report.
**Root cause:**
```tsx
function RootNavigator() {
  const { token, isLoading } = useAuth();
  if (isLoading) { return <ActivityIndicator .../>; }
  return token ? (
    <FeatureErrorBoundary name="App"><RootStack key="auth" /></FeatureErrorBoundary>
  ) : (
    <FeatureErrorBoundary name="Auth"><AuthNavigator key="anon" /></FeatureErrorBoundary>
  );
}
```
`RootNavigator` uses `token` as the single discriminator between Tabs and Auth. Meanwhile, `AuthProvider` wires `onUnauthorized` (AuthContext.tsx:188) and `useApiCallbacks` to set `token` to `null` on *any* 401 from the API interceptor. A tab switch that triggers a request returning 401 therefore flips `token` → `null` → `RootNavigator` swaps children to `AuthNavigator` → user sees Signup. There is no distinction between "user logged out" and "a request happened to 401" at this boundary.

**Fix:** Introduce an explicit `authStatus` state in the context (`'loading' | 'authenticated' | 'reauth-required' | 'anonymous'`). Route 401s to `'reauth-required'`, which shows a modal re-login sheet *without* unmounting `RootStack`. Only a user-initiated logout or expired-token verification at cold start should transition to `'anonymous'`. `RootNavigator` should gate on `authStatus === 'anonymous'`, not on `!token`.

---

### BUG-NAV-002: `isLoading` flipping back to `true` mid-session collapses the navigator to a spinner and loses nav state
**Severity:** Critical
**Component:** `frontend/src/App.tsx:93-99`
**Symptom:** Any path that re-runs the stored-token bootstrap (StrictMode double-invoke in dev, hot reload, or a future refactor that re-mounts `AuthProvider`) causes `RootNavigator` to render the `ActivityIndicator` branch — replacing the entire navigator subtree. When `isLoading` returns to `false`, both `NavigationContainer`'s child and the tab navigator are remounted at their initial routes, putting the user back on tab 0 or (if `token` is still resolving) on the signup screen.
**Root cause:**
```tsx
if (isLoading) {
  return (
    <View style={styles.loading} testID="auth-loading">
      <ActivityIndicator size="large" />
    </View>
  );
}
return token ? <RootStack key="auth" /> : <AuthNavigator key="anon" />;
```
Because the spinner branch is a sibling, not an overlay, any transition through `isLoading=true` tears down and rebuilds the navigator tree. `useLoadStoredToken` (AuthContext.tsx:139) calls `setIsLoading(false)` only in `.finally()` — any future use of that setter elsewhere (or StrictMode's dev double-mount) will whiplash the navigator.

**Fix:** Only show the loading branch on *cold start* (track `hasBootstrapped` once, then never revert). For mid-session loads, render the spinner as an absolutely-positioned overlay on top of the existing navigator so React Navigation state is preserved.

---

### BUG-NAV-003: `NavigationContainer` stays mounted while its child navigator is swapped — `linking` config references routes that don't exist in the rendered tree
**Severity:** High
**Component:** `frontend/src/App.tsx:49-65, 153-159`
**Symptom:** When `RootNavigator` renders `AuthNavigator` (unauthenticated), the already-mounted `NavigationContainer` still holds a `linking` config that declares `Tabs`, `ApiKeySettings`, `habits`, `journal`, etc. A deep link that arrives while auth-gated (e.g. `adepthood://journal` opened from a notification tap before bootstrap completes) will try to resolve routes that are not in the currently-mounted `AuthNavigator`, producing either a warning log plus no-op navigation or — depending on RN Navigation version — a crash inside the linking reducer.
**Root cause:**
```tsx
const linking: LinkingOptions<LinkedRootParamList> = {
  prefixes: ['adepthood://'],
  config: { screens: { Tabs: { screens: { Habits: 'habits', ... } }, ApiKeySettings: 'api-key-settings' } }, // pragma: allowlist secret
};
// ...
<NavigationContainer linking={linking}>
  ...
  <RootNavigator />   {/* child alternates between RootStack and AuthNavigator */}
</NavigationContainer>
```
`linking` is static and describes the authed tree only; there is no `Login`/`Signup` entry. When the child is `AuthNavigator`, the container's linking machinery has no valid target for any configured URL.

**Fix:** Build two linking configs (authed and anon) and pass the one that matches the current subtree, or move `NavigationContainer` *inside* the conditional so each variant ships its own linking config. At minimum, add `Login` / `Signup` entries to `linking.config.screens` so anonymous deep-links resolve gracefully.

---

### BUG-NAV-004: `SafeAreaView` wrapping the entire navigator clips modals and full-screen routes (e.g. Signup) to the safe-area insets
**Severity:** Medium
**Component:** `frontend/src/App.tsx:153-159`
**Symptom:** Any screen or modal rendered by the navigator is constrained to the safe area. On notched devices, full-bleed screens (splash-style Signup, onboarding modals, keyboard-avoiding forms) render with a visible inset bar on top and bottom; transparent modal presentations show the SafeAreaView background behind them.
**Root cause:**
```tsx
<NavigationContainer linking={linking}>
  <SafeAreaView style={styles.safeArea}>
    <ThemedStatusBar />
    <OfflineBanner />
    <RootNavigator />
  </SafeAreaView>
</NavigationContainer>
```
Best practice is to keep `SafeAreaProvider` at the root and apply `SafeAreaView` per-screen (or use `useSafeAreaInsets` inside headers/tab bars). Wrapping the whole navigator with a single `SafeAreaView` couples every route to the outermost insets and prevents screens from opting out.

**Fix:** Remove the outer `SafeAreaView`; keep `SafeAreaProvider` at the root and push `SafeAreaView` down into individual screens that need it (AuthNavigator screens, tab contents). Move `OfflineBanner` and `ThemedStatusBar` to siblings of `NavigationContainer` or into a small header component.

---

### BUG-NAV-005: Provider order places `ApiKeyProvider` and `ToastProvider` *outside* `NavigationContainer` but *inside* `AuthProvider`, letting an ApiKey re-render re-run the auth bootstrap indirectly
**Severity:** High
**Component:** `frontend/src/App.tsx:147-166`
**Symptom:** `ApiKeyProvider` and `ToastProvider` sit between `AuthProvider` and `NavigationContainer`. Any state change inside these providers (a toast fires, an API key is edited via the deep-link `api-key-settings` screen) re-renders everything below — including `NavigationContainer` and `RootNavigator`. Combined with BUG-NAV-001, if such a render coincides with an in-flight 401, the reset-to-signup behavior triggers on seemingly unrelated UI actions (dismissing a toast, saving a key).
**Root cause:**
```tsx
<AuthProvider>
  <ApiKeyProvider>
    <ToastProvider>
      <NavigationContainer linking={linking}>
        ...
        <RootNavigator />
```
Re-renders don't remount by themselves, but when `ApiKeyProvider`/`ToastProvider` produce a new context value each render (no `useMemo` guard visible from this audit), every descendant — including `useAuth()` consumers — re-reads auth state and can race with interceptor-triggered `setToken(null)` calls. `ApiKeyProvider` should live *below* `NavigationContainer` so navigation state is insulated from its renders; `ToastProvider` often needs to live at the root but should memoize its value.

**Fix:** Reorder to: `ErrorBoundary > SafeAreaProvider > NetworkStatusProvider > AuthProvider > NavigationContainer > ApiKeyProvider > ToastProvider > RootNavigator`. Providers that do not need to be above the navigator belong below it, so their state churn never invalidates navigation state. Verify each provider memoizes its context value.

---

## High & Medium — RootStack & navigation hooks

### BUG-NAV-006: `useRouteParams` memoises on a fresh `defaults` object, causing stale merges and re-render churn
**Severity:** High
**Component:** `frontend/src/navigation/hooks.ts:39-53`
**Symptom:** Screens using `useRouteParams` either see stale values after `route.params` changes, or thrash render cycles — feeds the "booted to signup" report because tab-screen effects re-fire on every render, and any error boundary upstream will swap trees.
**Root cause:**
```tsx
export function useRouteParams<T, Defaults extends object>(
  screen: T, defaults: Defaults,
): Defaults & NonNullable<RootTabParamList[T]> {
  const route = useAppRoute<T>();
  return useMemo(() => {
    const params = (route.params ?? {}) as Record<string, unknown>;
    const merged = { ...defaults } as Record<string, unknown>;
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) merged[k] = v;
    }
    return merged as Defaults & NonNullable<RootTabParamList[T]>;
  }, [route.params, defaults]);
}
```
Callers almost always pass an object literal (`useRouteParams('Course', { stageNumber: 1 })`). The literal has a new identity on every render, so the `useMemo` dependency array invalidates on every render — the memo is useless and returns a new object every time. Any downstream `useEffect(..., [params])` re-runs indefinitely, and consumers that hold the previous reference in a ref see tearing between renders.

**Fix:** Either (a) serialise `defaults` via `JSON.stringify` for the dep, (b) accept a stable key + callback, or more simply drop `defaults` from the dependency array and document that defaults must be stable — or hoist them into `useRef`. The cleanest fix is `useMemo(..., [route.params])` plus an eslint-disable comment with a rationale, since `defaults` is purely a fallback source.

---

### BUG-NAV-007: `RootStack` has no `screenOptions`, so the `ApiKeySettings` modal renders as a card and re-keys the Tabs parent on dismiss (iOS)
**Severity:** High
**Component:** `frontend/src/navigation/RootStack.tsx:20-28`
**Symptom:** Matches the reported "booted to signup when switching tabs" — opening API Key settings then returning can land the user on an unexpected route. On iOS native-stack, pushing a non-modal screen over `Tabs` causes the tab navigator to unmount on pop when the header-shown state flips, resetting its selected-tab state.
**Root cause:**
```tsx
const RootStack = (): React.JSX.Element => (
  <Stack.Navigator>
    <Stack.Screen name="Tabs" component={BottomTabs} options={{ headerShown: false }} />
    <Stack.Screen
      name="ApiKeySettings"
      component={ApiKeySettingsScreen}
      options={{ title: 'API Key' }}
    />
  </Stack.Navigator>
);
```
Two issues in three lines:
1. `ApiKeySettings` is not declared `presentation: 'modal'` despite the comment calling it modal. It pushes as a card, so on dismissal the native stack re-evaluates `Tabs` options (header shown transitions).
2. `Stack.Screen` for `Tabs` toggles `headerShown` only for itself; combined with the default `headerShown: true` on the sibling, `react-native-screens` swaps the view host on iOS, unmounting `BottomTabs` and resetting the tab index to the default.

**Fix:** Lift `headerShown: false` to `screenOptions` on the navigator (stable identity — declare it as a `const` outside the component to avoid recomputing) and mark the settings screen `options={{ presentation: 'modal', title: 'API Key' }}`. Example:
```tsx
const screenOptions = { headerShown: false } as const;
// ...
<Stack.Navigator screenOptions={screenOptions}>
  <Stack.Screen name="Tabs" component={BottomTabs} />
  <Stack.Screen name="ApiKeySettings" component={ApiKeySettingsScreen}
    options={{ presentation: 'modal', headerShown: true, title: 'API Key' }} />
</Stack.Navigator>
```

---

### BUG-NAV-008: Deep-link path `api-key-settings` lands users on the modal with no underlying `Tabs` to return to
**Severity:** Medium
**Component:** `frontend/src/App.tsx:51-64` (linking config)
**Symptom:** Following `adepthood://api-key-settings` from a cold launch mounts `ApiKeySettings` as the sole screen in the stack. The back button/gesture has nowhere to go; when the user taps it, the stack pops to an empty navigator — on a logged-in user this can show the auth tree briefly (matches the reported "booted to signup").
**Root cause:**
```ts
config: {
  screens: {
    Tabs: { screens: { Habits: 'habits', /* ... */ } },
    ApiKeySettings: 'api-key-settings', // pragma: allowlist secret
  },
},
```
React Navigation's linking for native-stack only prepopulates the screens explicitly mentioned in the incoming path. Without an `initialRouteName` at the root, opening `api-key-settings` gives a single-entry stack. There is no `initialRouteName: 'Tabs'` on the root config, so the back-stack does not include `Tabs` beneath the modal.

**Fix:** Add `initialRouteName: 'Tabs'` to the root `config` object so the linking builder injects `Tabs` beneath any deep-linked modal:
```ts
config: {
  initialRouteName: 'Tabs',
  screens: { Tabs: { ... }, ApiKeySettings: 'api-key-settings' }, // pragma: allowlist secret
},
```
Also consider gating the deep link behind auth in `getStateFromPath` so an unauthenticated user hitting the URL lands in `AuthStack` rather than a dangling modal.

---

### BUG-NAV-009: Type drift — `RootStackParamList` declares `Tabs: undefined`, but `useAppNavigation` is typed against `RootTabParamList`, hiding root-stack navigation calls from the type checker
**Severity:** Medium
**Component:** `frontend/src/navigation/hooks.ts:12-14`
**Symptom:** Any screen calling `navigation.navigate('ApiKeySettings')` via `useAppNavigation()` type-checks as an error at call sites that silence it, or (worse) is routed through the tab navigator's `navigate`, which no-ops for names outside the tab list — tapping the settings entry does nothing in release builds where the `any` escape hatches are present.
**Root cause:**
```ts
export function useAppNavigation(): BottomTabNavigationProp<RootTabParamList> {
  return useNavigation<BottomTabNavigationProp<RootTabParamList>>();
}
```
`BottomTabNavigationProp<RootTabParamList>` only exposes tab routes. There is no composite navigation prop that merges `RootStackParamList` + `RootTabParamList`, so screens inside a tab cannot type-safely reach `ApiKeySettings`. Callers either cast to `any` (prohibited by CLAUDE.md) or rely on the runtime fallthrough where `navigate` bubbles to the parent — which is what RN does, but it is undocumented in the types here.

**Fix:** Export a composite type and a second hook:
```ts
import type { CompositeNavigationProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from './RootStack';

export type AppNavigation = CompositeNavigationProp<
  BottomTabNavigationProp<RootTabParamList>,
  NativeStackNavigationProp<RootStackParamList>
>;
export const useAppNavigation = (): AppNavigation => useNavigation<AppNavigation>();
```
This keeps tab navigation type-safe while making `navigate('ApiKeySettings')` a first-class, checked call.

---

## Critical, High & Medium — BottomTabs

### BUG-NAV-010: `headerRight` closure captures stale `logout`, forcing header remount every render
**Severity:** High
**Component:** `frontend/src/navigation/BottomTabs.tsx:80-103`
**Symptom:** Every render of `BottomTabs` produces a new `screenOptions` object with a new `headerRight` function. React Navigation detects this as changed options and re-renders/remounts header elements on each tab change, wasting work and causing visible flicker. It also means the logout `TouchableOpacity` re-mounts, which can drop in-flight press gestures.
**Root cause:**
```tsx
const { logout } = useAuth();
// ...
<Tab.Navigator
  screenOptions={{
    headerRight: () => (
      <TouchableOpacity onPress={logout} ... />
    ),
  }}
>
```
`screenOptions` is an inline object literal; `logout` is destructured fresh on every render so the closure identity changes each time `AuthContext` re-renders. Because `BottomTabs` is a sibling of the `AuthProvider` subtree, any auth state flip (e.g. token refresh) re-runs this block.

**Fix:** Memoize `screenOptions` with `React.useMemo`, and wrap `headerRight` (or stabilize `logout` via `useCallback` in `AuthContext`) so its identity is stable across renders. Alternatively use `navigation.setOptions` inside a `useLayoutEffect` in each screen.

---

### BUG-NAV-011 (Critical): Unstable `withBoundary` wrapper components declared inline above `BottomTabs` cause every auth state change to remount all 5 tabs, which re-runs mount-time effects and boots unauthenticated users to signup
**Severity:** Critical
**Component:** `frontend/src/navigation/BottomTabs.tsx:46-63`
**Symptom:** User reports "tabs boot them to signup." When `AuthContext` re-renders (e.g. after a 401 retry), the `useAuth()` call at line 70 re-evaluates, `BottomTabs` re-renders, and because each `Tab.Screen`'s `component` prop is a module-level reference wrapping children via a new boundary child tree on every parent render, React Navigation treats the tab screens as new components when combined with changing `screenOptions` (BUG-NAV-010). The mount-time bootstrap in screens like `HabitsScreen` fires an auth probe; if `logout` was just called elsewhere, the probe 401s and the root `AuthStack` kicks the user to Signup.
**Root cause:**
```tsx
function withBoundary<P>(name, Component) {
  const Wrapped = (props) => (
    <FeatureErrorBoundary name={name}>
      <Component {...props} />
    </FeatureErrorBoundary>
  );
  return Wrapped;
}
const HabitsTab = withBoundary('Habits', HabitsScreen);
// ...
<Tab.Screen name="Habits" component={HabitsTab} />
```
The wrapper itself is module-scoped (good) but the `FeatureErrorBoundary` has no `resetKeys`, so any throw inside a tab is swallowed without surfacing — and because each boundary's `children` is a fresh element tree on every parent render, if the boundary's internal reconciliation resets error state it will remount the child `Screen`. Combined with `screenOptions` churn (BUG-NAV-010), this reliably triggers a full unmount/remount cycle of all 5 tabs at once.

**Fix:** Stabilize `screenOptions` (BUG-NAV-010), ensure `FeatureErrorBoundary` does not remount children on every render, and crucially decouple `BottomTabs` from `useAuth()` — move the logout button into a header component that subscribes to auth in isolation so tab re-mounts cannot be triggered by auth state churn.

---

### BUG-NAV-012: `FeatureErrorBoundary` silently swallows tab mount crashes, letting the root navigator fall back to the auth stack
**Severity:** High
**Component:** `frontend/src/navigation/BottomTabs.tsx:46-57`
**Symptom:** If any tab (e.g. `HabitsScreen` on a null profile) throws during mount, `FeatureErrorBoundary` catches the error. Without seeing its render output here, the wrapper is applied per tab so the tab renders a fallback — but any `useEffect` in `HabitsScreen` that called `logout()` on failure has already fired before the boundary rendered its fallback, so the user is kicked to Signup with no surfaced error.
**Root cause:**
```tsx
const Wrapped: React.ComponentType<P> = (props) => (
  <FeatureErrorBoundary name={name}>
    <Component {...props} />
  </FeatureErrorBoundary>
);
```
Error boundaries catch render errors but not effects; a `useEffect(() => { if (!user) logout() }, [])` inside a tab will still dispatch logout before the boundary's `componentDidCatch` runs. The boundary masks the symptom.

**Fix:** Have `FeatureErrorBoundary` log to telemetry and render an explicit error surface with a retry button. Audit each tab for mount-time `logout()` calls — those belong in a guarded route, not a screen effect. Add integration tests that assert `FeatureErrorBoundary` never silently navigates.

---

### BUG-NAV-013: `tabBarIcon`, `tabBarLabel`, and `accessibilityLabel` missing on tab screens
**Severity:** Medium
**Component:** `frontend/src/navigation/BottomTabs.tsx:105-109`
**Symptom:** The five `Tab.Screen` declarations pass no `options` — no `tabBarIcon`, no `tabBarAccessibilityLabel`, no `tabBarTestID`. Screen readers announce the route name only (e.g. "Habits, tab, 1 of 5") but without a locale-aware label. E2E tests cannot target tabs by stable testID. Users also see no visual icons, only text labels.
**Root cause:**
```tsx
<Tab.Screen name="Habits" component={HabitsTab} />
<Tab.Screen name="Practice" component={PracticeTab} />
<Tab.Screen name="Course" component={CourseTab} />
<Tab.Screen name="Journal" component={JournalTab} />
<Tab.Screen name="Map" component={MapTab} />
```

**Fix:** Add `options={{ tabBarIcon: ..., tabBarAccessibilityLabel: t('tabs.habits.a11y'), tabBarTestID: 'tab-habits' }}` per screen. Consider a config array mapped to `Tab.Screen` to keep declarations DRY.

---

### BUG-NAV-014: `openSettings` navigates to a parent-stack route from a nested tab without validating the route exists
**Severity:** Medium
**Component:** `frontend/src/navigation/BottomTabs.tsx:73-75`
**Symptom:** Pressing the gear icon calls `navigation.navigate('ApiKeySettings')`. `navigation` is typed as the `RootStackParamList`, but the hook at line 71 casts through `useNavigation<NativeStackNavigationProp<RootStackParamList>>()` without guarantee that this component is actually mounted inside that stack. If `BottomTabs` is ever rendered at the root (e.g. a deep-link preview), the navigation action silently fails (or warns "no navigator handled the action") and the user sees nothing happen — they may assume logout worked and interpret later state as "booted to signup."
**Root cause:**
```tsx
const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
const openSettings = React.useCallback(() => {
  navigation.navigate('ApiKeySettings');
}, [navigation]);
```
The generic is a compile-time lie; `useNavigation` returns whatever navigator is closest. There is no runtime assertion that `ApiKeySettings` resolves.

**Fix:** Use `navigation.getParent()?.navigate('ApiKeySettings')` with a null guard, or refactor so Settings is a tab-level modal reachable via `Tab.Screen` options. Add a dev-mode assertion that the expected parent navigator exists.

---

## Suggested remediation order

1. **BUG-NAV-001** — introduce explicit `authStatus` discriminator. This single change neutralises the user-reported "tab boots me to signup" bug and is a precondition for trusting any of the other auth/navigation fixes.
2. **BUG-NAV-011** — decouple `BottomTabs` from `useAuth()` (move the logout control into a header component that subscribes in isolation). With BUG-NAV-001 fixed this stops being user-visible, but the coupling will keep biting on every future auth-state change.
3. **BUG-NAV-002** — gate the loading spinner on a one-shot `hasBootstrapped` flag and render mid-session loads as an overlay. Required to prevent StrictMode/hot-reload regressions of the same symptom.
4. **BUG-NAV-007** — declare `presentation: 'modal'` on `ApiKeySettings` and lift `headerShown: false` to a stable `screenOptions` constant. Removes the iOS native-stack remount path.
5. **BUG-NAV-010** — memoise `screenOptions` and stabilise `logout` via `useCallback` in `AuthContext`. Pairs with BUG-NAV-011.
6. **BUG-NAV-005** — reorder providers so `ApiKeyProvider`/`ToastProvider` live below `NavigationContainer`. Stops unrelated UI events (toast dismissal, key edits) from invalidating navigation state.
7. **BUG-NAV-003 & BUG-NAV-008** — split linking config per-subtree (or move `NavigationContainer` inside the conditional) and add `initialRouteName: 'Tabs'`. Fixes deep-link correctness for both authed and anon routes.
8. **BUG-NAV-006** — fix `useRouteParams` memo dependency or hoist defaults. Stops downstream effect thrash.
9. **BUG-NAV-009** — export composite navigation type and second hook for type-safe root-stack navigation from tab screens.
10. **BUG-NAV-012** — make `FeatureErrorBoundary` log + render an explicit retry surface; audit tabs for mount-time `logout()` calls.
11. **BUG-NAV-004** — drop the outer `SafeAreaView`; push insets per-screen.
12. **BUG-NAV-013** — add `tabBarIcon`/`tabBarAccessibilityLabel`/`tabBarTestID` per `Tab.Screen`.
13. **BUG-NAV-014** — guard `openSettings` via `navigation.getParent()?.navigate(...)` with a null check.

## Cross-references

- **BUG-NAV-001** is the navigation-side mirror of **BUG-FE-AUTH-010** (client persists the dummy-token sentinel) and **BUG-AUTH-001/002/016** (backend returns dummy token on duplicate-email signup). All three together explain the "I signed up but can't log in, then tabs boot me to signup" report.
- **BUG-NAV-005** compounds the **BUG-FE-AUTH-001…004** AuthContext lifecycle races.
- **BUG-NAV-011 / BUG-NAV-010** rely on **BUG-FE-AUTH-007** (logout not memoised) being fixed in the AuthContext layer.
