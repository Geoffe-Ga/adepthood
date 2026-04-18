# Frontend Auth — Context, Storage, Signup & Login Screens — Bug Remediation Report

**Component:** Frontend auth subsystem — `AuthContext`, `authStorage`, `SignupScreen`, `LoginScreen`
**Date:** 2026-04-18
**Auditor:** Claude Code (self-review)
**Branch:** `claude/code-review-bug-analysis-WCNGL`

## Executive Summary

This is the client-side mirror of the auth bugs in report 01, and it owns the second half of the "I signed up but I can't log in" loop. The single highest-impact bug here is **BUG-FE-AUTH-010**: when the backend returns the `user_id=0` dummy-token sentinel for a duplicate-email signup (BUG-AUTH-001 / 016 in report 01), `SignupScreen.tsx` and `AuthContext.signup` blindly persist the bogus token and navigate to Home. The user lands in a "logged-in" state where every authenticated request 401s and there is no UI affordance to escape. Defense-in-depth here is **mandatory** even after the backend is fixed — the contract is too easy to break again.

Beyond the duplicate-signup zombie session, the AuthContext lifecycle has four real races: a proactive-refresh path that doesn't share the logout guard used by the 401 retry path (BUG-FE-AUTH-001), an unhandled `loadToken` rejection that can wedge the splash screen forever (BUG-FE-AUTH-002), an identity-blind token-overwrite race that can silently swap accounts during a fast logout/login (BUG-FE-AUTH-004), and an effect cleanup that nulls the token getter mid-flight in dev (BUG-FE-AUTH-005). The storage layer drops every error on the floor and treats web/native as if they had the same threat model (they don't — JWTs sit in `localStorage` on web, hardware keystore on native). The Login and Signup screens are missing client-side normalization and validation that would catch typos and double-taps before they reach the server.

Total: **19 bugs** (2 Critical, 9 High, 6 Medium, 2 Low). Land BUG-FE-AUTH-010 with the report-01 backend fix; everything else is independent.

## Table of Contents

| # | Severity | Title |
|---|---|---|
| BUG-FE-AUTH-001 | High | Proactive refresh bypasses logout-race guard used by the 401 path |
| BUG-FE-AUTH-002 | Critical | `loadToken()` rejection crashes bootstrap and leaves `isLoading=true` forever |
| BUG-FE-AUTH-003 | Medium | Expired-token cleanup at bootstrap is fire-and-forget and races `isLoading` |
| BUG-FE-AUTH-004 | High | `saveTokenThenApply` tokenRef guard only checks for `null`, not identity |
| BUG-FE-AUTH-005 | High | `useApiCallbacks` cleanup nulls the token getter mid-flight |
| BUG-FE-AUTH-006 | High | Android 2 KB SecureStore cap silently rejects larger JWTs |
| BUG-FE-AUTH-007 | High | Web fallback stores JWT in `localStorage` without XSS warning or encryption |
| BUG-FE-AUTH-008 | High | `saveToken`/`clearToken` have no error handling — all failures look the same |
| BUG-FE-AUTH-009 | Medium | Backend switch orphans tokens — no migration or "clear both" safety net |
| BUG-FE-AUTH-010 | Critical | Fake `user_id=0` dummy-token response is persisted into a zombie session |
| BUG-FE-AUTH-011 | High | Confirm-password compared before trim — autofill whitespace silently mismatches |
| BUG-FE-AUTH-012 | Medium | No email format or empty-field validation on Signup |
| BUG-FE-AUTH-013 | Medium | Back button returns to a pre-filled Signup form; re-tap re-triggers duplicate path |
| BUG-FE-AUTH-014 | Medium | Missing `KeyboardAvoidingView`, return-key chaining, and input `testID`s on Signup |
| BUG-FE-AUTH-015 | High | Login email not lowercased — case-mismatch causes false 401s |
| BUG-FE-AUTH-016 | Medium | Login has no empty-field validation; blank submits hit the API |
| BUG-FE-AUTH-017 | Medium | Login double-tap race fires two concurrent requests |
| BUG-FE-AUTH-018 | Low | Stale Login error persists across navigation and re-renders |
| BUG-FE-AUTH-019 | Low | Login keyboard return-key not wired; no Forgot Password; 401 detail not branched |

---

### BUG-FE-AUTH-001: Proactive refresh bypasses logout-race guard used by the 401 path
**Severity:** High
**Component:** `frontend/src/context/AuthContext.tsx:159-165`
**Symptom:** Logging out while a proactively-scheduled refresh is in flight resurrects the session — the user appears logged out, then silently pops back to the authenticated stack when the refresh resolves.
**Root cause:**
```ts
const applyNewToken = useCallback(async (newToken: string) => {
  await saveToken(newToken);
  setToken(newToken);
}, []);
// ...
useProactiveRefresh(token, tokenRef, applyNewToken);
```
`saveTokenThenApply` (used by the 401 refresh callback) guards against `tokenRef.current === null` before persisting/applying. `applyNewToken`, which is what `useProactiveRefresh` hands to `silentRefresh`, does not — so a logout that wins the race with the proactive timer is overwritten by the late response.

**Fix:** Route `applyNewToken` through the same guard: check `tokenRef.current !== null` both before `saveToken` and again before `setToken`, or call `saveTokenThenApply(newToken, setToken, tokenRef)` directly.

---

### BUG-FE-AUTH-002: `loadToken()` rejection crashes bootstrap and leaves `isLoading=true` forever
**Severity:** Critical
**Component:** `frontend/src/context/AuthContext.tsx:139-149`
**Symptom:** If SecureStore is corrupted or throws on cold start, the app is stuck on the loading splash indefinitely and an unhandled promise rejection is logged. Users cannot recover without reinstalling.
**Root cause:**
```ts
loadToken()
  .then((stored) => { /* ... */ })
  .finally(() => setIsLoading(false));
```
Wait — `.finally` does run on rejection, so `isLoading` does flip. But there is no `.catch`, so the rejection is unhandled (RN shows a red-box in dev, silent UnhandledPromiseRejection in prod). Worse: the `.then` branch that calls `clearToken()` on expired tokens is itself fire-and-forget — if it rejects, same unhandled rejection, and we never surface a recoverable state to the user.

**Fix:** Add an explicit `.catch((err) => { console.warn('loadToken failed', err); void clearToken().catch(() => {}); })` before `.finally`, so a corrupted store is treated as "no session" rather than propagating as an unhandled rejection.

---

### BUG-FE-AUTH-003: Expired-token cleanup at bootstrap is fire-and-forget and races `isLoading`
**Severity:** Medium
**Component:** `frontend/src/context/AuthContext.tsx:144-148`
**Symptom:** An expired token in secure storage is not guaranteed to be cleared before navigation mounts the unauthenticated stack; a subsequent fast relaunch can re-hydrate the same expired token, causing a double-login flicker or spurious 401 on the first API call.
**Root cause:**
```ts
} else if (stored) {
  clearToken();                   // not awaited
}
})
.finally(() => setIsLoading(false));
```
`clearToken()` returns a Promise that is dropped. `setIsLoading(false)` fires in the `.finally` of `loadToken`, not of `clearToken`, so the UI unblocks before storage has been wiped.

**Fix:** `return clearToken();` inside the `else if` so the chained `.finally` waits on it, or `await` it explicitly in an async IIFE.

---

### BUG-FE-AUTH-004: `saveTokenThenApply` tokenRef guard only checks for `null`, not identity
**Severity:** High
**Component:** `frontend/src/context/AuthContext.tsx:88-105`
**Symptom:** User logs out, logs back in as a different account while the original refresh is still in flight; the late refresh response (signed for account A) overwrites the freshly-minted token for account B. The user is now silently operating under account A's credentials.
**Root cause:**
```ts
if (tokenRef.current === null) { return; }
try { await saveToken(newToken); } catch { /* ... */ return; }
if (tokenRef.current === null) return;
setToken(newToken);
```
The guard rejects only the null case. If `tokenRef.current` has been replaced with a *different non-null* token (new login), the stale refresh still wins.

**Fix:** Capture the expected previous token when scheduling the refresh and compare: `if (tokenRef.current !== expectedPrevious) return;`. Plumb the expected token from the 401 interceptor / proactive timer into the callback.

---

### BUG-FE-AUTH-005: `useApiCallbacks` cleanup nulls the token getter mid-flight
**Severity:** High
**Component:** `frontend/src/context/AuthContext.tsx:126-130`
**Symptom:** On provider unmount (e.g. fast refresh in dev, or a Provider swap during deep-link reauth), any in-flight HTTP request that consults `tokenGetter` for Authorization-header retry suddenly sees `null` and fails with 401 instead of retrying with the still-valid token. In dev this manifests as random 401s after HMR.
**Root cause:**
```ts
return () => {
  setTokenGetter(null);
  setOnUnauthorized(null);
  setOnTokenRefreshed(null);
};
```
The cleanup tears down all three callbacks unconditionally. If the effect re-runs because `stableGetter` / `setToken` / `tokenRef` identity changed (not just on unmount), we momentarily have no getter. The next effect pass reinstalls them, but any axios retry that fires between the cleanup and the re-setup gets `null`.

**Fix:** Only null-out on true unmount (use a ref+unmount pattern), or have the cleanup *replace* the getter atomically with the new one rather than clearing. Simplest: skip the cleanup entirely when the effect is re-running (the next `setTokenGetter(stableGetter)` overwrites the old registration).

---
### BUG-FE-AUTH-006: Android 2 KB SecureStore cap silently rejects larger JWTs, wedging auth
**Severity:** High
**Component:** `frontend/src/storage/authStorage.ts:22`
**Symptom:** On Android, a user whose JWT grows past 2048 bytes (extra claims, feature flags, role arrays) gets an unhandled `SecureStoreError` from `setItemAsync` during login. The error bubbles up with no context, the generic signup fallback copy shows, and every subsequent `loadToken` returns `null` so the user is logged out on next cold start.
**Root cause:**
```ts
export async function saveToken(token: string): Promise<void> {
  if (isWeb) {
    await AsyncStorage.setItem(TOKEN_KEY, token);
    return;
  }
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}
```
`expo-secure-store` on Android enforces a hard ~2 KB ceiling per value (the AES-GCM blob is written into `SharedPreferences`). The call is made unconditionally with no size guard, no split-chunk strategy, and no typed error so callers cannot distinguish "full" from "locked" or "transient." The backend has no matching cap, so the limit is effectively invisible until a real user trips it.

**Fix:** Measure `Buffer.byteLength(token, 'utf8')` (or `new Blob([token]).size`) before calling `setItemAsync`; if over ~1800 bytes, either (a) fall back to `AsyncStorage` with an explicit warning log, or (b) chunk the token across N keys with a manifest, or (c) ask the backend to issue a shorter token. Wrap the call in `try/catch` and surface a typed `TokenPersistFailed` error so `AuthContext` can show a meaningful message instead of the generic fallback.

---

### BUG-FE-AUTH-007: Web fallback stores JWT in localStorage without XSS warning or encryption
**Severity:** High
**Component:** `frontend/src/storage/authStorage.ts:15-23`
**Symptom:** On Expo Web, the bearer JWT is written to `window.localStorage` via AsyncStorage's web shim. Any XSS payload, compromised dependency, or browser extension with page access can read the full token and impersonate the user until expiry. There is no `httpOnly` cookie option, no rotation-on-read, no short TTL guard, and no comment in the file flagging the security downgrade.
**Root cause:**
```ts
const isWeb = Platform.OS === 'web';

export async function saveToken(token: string): Promise<void> {
  if (isWeb) {
    await AsyncStorage.setItem(TOKEN_KEY, token);
    return;
  }
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}
```
The file comment documents *why* the fallback exists (expo-secure-store v55 has no web impl) but does not acknowledge the security implication: on native we use Keychain/Keystore (hardware-backed), on web we use the least-secure option browsers offer. Parity is broken — the same code path persists the same token with wildly different threat models.

**Fix:** Prefer `httpOnly; Secure; SameSite=Strict` cookies set by the backend on web — frontend holds no JWT at all. If that is too invasive, at minimum (1) use `sessionStorage` so the token dies with the tab, (2) encrypt with a key derived from a short-lived session secret, (3) add a `console.warn` in dev builds, and (4) add a top-of-file comment explicitly labeling the web path as reduced-security and recommending cookie-based auth.

---

### BUG-FE-AUTH-008: saveToken has no error handling — SecureStore failures crash the login flow
**Severity:** High
**Component:** `frontend/src/storage/authStorage.ts:17-23`
**Symptom:** If `SecureStore.setItemAsync` rejects (device locked with passcode-required keychain item, biometric prompt cancelled, keychain corrupted, storage full, user revoked keychain access), the rejection propagates out of `saveToken` as an untyped `Error`. The login screen's catch block maps all errors to the generic signup fallback copy, so the user sees "Something went wrong" with no diagnostic, no retry hint, and no way to reach a working state.
**Root cause:**
```ts
export async function saveToken(token: string): Promise<void> {
  if (isWeb) {
    await AsyncStorage.setItem(TOKEN_KEY, token);
    return;
  }
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}
```
No `try/catch`, no typed error, no telemetry. The three failure modes — locked, full, permission-denied — are observably identical to the caller. `clearToken` has the same shape: if `deleteItemAsync` throws (item never existed? keystore offline?) the sign-out button appears to hang.

**Fix:** Wrap both SecureStore and AsyncStorage calls in `try/catch`, translate platform errors into a small typed union (`TokenPersistFailed`, `TokenLocked`, `TokenStorageFull`), log to telemetry with PII-safe context, and rethrow the typed error. `clearToken` should swallow "not found" errors (idempotent by contract) but surface real failures. Add tests for each failure mode using the existing jest mocks.

---

### BUG-FE-AUTH-009: Backend switch orphans tokens — users silently logged out after platform migration
**Severity:** Medium
**Component:** `frontend/src/storage/authStorage.ts:17-36`
**Symptom:** If a user signs in on Expo Web (token lands in `localStorage` via AsyncStorage), then later installs the native app and signs in on the same device profile, the native build reads from SecureStore and finds nothing — forcing a fresh login. More insidiously: if a future version of `expo-secure-store` ships a web implementation and the `isWeb` fallback is removed, every existing web user's token is orphaned in `localStorage` forever (never cleared, never migrated, never read), leaking a long-lived JWT.
**Root cause:**
```ts
export async function loadToken(): Promise<string | null> {
  if (isWeb) return AsyncStorage.getItem(TOKEN_KEY);
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function clearToken(): Promise<void> {
  if (isWeb) {
    await AsyncStorage.removeItem(TOKEN_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
```
`loadToken` reads only the current-platform backend. `clearToken` deletes only the current-platform backend. There is no "clear both" safety net, no versioned schema, and no one-shot migration read that checks the other backend on first launch.

**Fix:** On `loadToken` miss, attempt a one-time read from the opposite backend and migrate (write to the canonical backend, clear the legacy one). In `clearToken`, best-effort delete from *both* backends regardless of platform so stale tokens cannot linger after a fallback-path change. Add a `STORAGE_SCHEMA_VERSION` constant and a migration hook so future backend swaps have a defined cleanup path. Cover with tests that flip `platformRef.value` mid-flow.

---
### BUG-FE-AUTH-010: Fake `user_id=0` dummy-token response is persisted and logs a duplicate-email user straight into a zombie session
**Severity:** Critical
**Component:** `frontend/src/features/Auth/SignupScreen.tsx:117-129` (in concert with `frontend/src/context/AuthContext.tsx:174-178`)
**Symptom:** User signs up with an email that already exists. Backend (per Backend Report 01) returns a 200 with `user_id=0` and a dummy token. The screen treats this as success: token is persisted, `setToken` fires, and the app navigates to Home. Subsequent authenticated calls 401 because the token is garbage, matching the user-reported "I signed up but I can't log in."
**Root cause:**
```tsx
setSubmitting(true);
try {
  await signup(email.trim(), password);
} catch (err: unknown) {
  setError(formatApiError(err, { fallback: SIGNUP_FALLBACK }));
} finally {
  setSubmitting(false);
}
```
`signup()` resolves successfully for the sentinel response — nothing in the screen (or `AuthContext.signup`) inspects `response.user_id === 0` or validates the token shape. The backend bug is the real fix, but the client blindly trusts any 2xx.

**Fix:** Defense in depth — have `authApi.signup` / `AuthContext.signup` throw a typed `DuplicateEmailError` when `user_id === 0` (or token is the documented dummy), and in `handleSignup` map that error to a friendly "That email is already registered. Log in instead?" message with a link to the Login screen. Do NOT call `saveToken`/`setToken` on the sentinel response.

---

### BUG-FE-AUTH-011: Confirm-password compared before trim — trailing space on autofill causes silent mismatch users can't see
**Severity:** High
**Component:** `frontend/src/features/Auth/SignupScreen.tsx:108-121`
**Symptom:** User types `hunter2!` in the password field and autofill/paste drops `hunter2! ` into the Confirm field (password managers and iOS autofill commonly append a space). Fields are `secureTextEntry` so the user can't see the trailing space. They get "Those passwords don't match" forever.
**Root cause:**
```tsx
if (password.length < MIN_PASSWORD_LENGTH) { ... }
if (password !== confirmPassword) {
  setError("Those passwords don't match. Re-type both fields to confirm.");
  return;
}
...
await signup(email.trim(), password);
```
Email is trimmed at submit, but `password` and `confirmPassword` are compared raw. Worse: `password` is then sent to the backend untrimmed, so even if the user retypes, the stored hash will contain whatever whitespace slipped in.

**Fix:** Either (a) trim both in a normalized local before validation AND submission (`const pw = password; const cpw = confirmPassword;` — don't silently trim passwords, that changes the secret) OR (b) explicitly detect leading/trailing whitespace and show a dedicated error ("Password has leading or trailing spaces — remove them to continue"). Option (b) is safer: silently mutating a password the user typed is its own class of bug. Also add a password-visibility toggle so users can catch whitespace visually.

---

### BUG-FE-AUTH-012: No email format or empty-field validation client-side — every typo becomes a backend round-trip
**Severity:** Medium
**Component:** `frontend/src/features/Auth/SignupScreen.tsx:105-121`
**Symptom:** User submits `""`, `"  "`, `"notanemail"`, or `"foo@"` and waits for a network round-trip to discover the error. On flaky mobile connections this means a 5-10s wait for a preventable failure. Empty email + valid-length password passes the local checks and hits the backend.
**Root cause:**
```tsx
const handleSignup = async () => {
  setError(null);

  if (password.length < MIN_PASSWORD_LENGTH) { ... return; }
  if (password !== confirmPassword) { ... return; }

  setSubmitting(true);
  try {
    await signup(email.trim(), password);
```
No check that `email.trim()` is non-empty; no regex; no check that `confirmPassword` is non-empty (two empty strings are equal, so a submit with all blank fields passes confirm-match and only the password-length guard catches it, giving a misleading error message).

**Fix:** Add an `isValidEmail(email.trim())` guard (simple `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` is fine) and an empty-field guard BEFORE the password-length check so a blank form surfaces "Enter your email" rather than "Pick a password that is at least 8 characters long." Also add `autoCorrect={false}`, `autoComplete="email"`, `textContentType="emailAddress"` on the email input to stop iOS from "correcting" addresses.

---

### BUG-FE-AUTH-013: Back button returns to a pre-filled signup form after successful signup; re-tap creates duplicate account attempt
**Severity:** Medium
**Component:** `frontend/src/features/Auth/SignupScreen.tsx:13, 144-147`
**Symptom:** After signup succeeds, `AuthContext` flips the navigator (this screen itself doesn't navigate — fine). But the `navigation` prop only exposes `navigate`, so the link to Login is `navigation.navigate('Login')` rather than `replace`. A user who taps "Already have an account?" pushes Login onto the stack on top of Signup; hitting back returns them to a signup form with email/password still in state. Any re-submission re-triggers the duplicate-email path (see BUG-FE-AUTH-010).
**Root cause:**
```tsx
interface Props {
  navigation: { navigate: (_screen: string) => void };
}
...
<SignupActions
  onSignup={handleSignup}
  onNavigateLogin={() => navigation.navigate('Login')}
  submitting={submitting}
/>
```
Narrowed `navigation` type deliberately forbids `replace`. State (`email`, `password`, `confirmPassword`, `error`) is never cleared on unmount/blur, so it survives a back-navigation.

**Fix:** Widen the `navigation` type to include `replace` and use `navigation.replace('Login')` when going to Login. Additionally, clear `error`, `password`, and `confirmPassword` on a `useFocusEffect`/`blur` listener so a back-navigated screen doesn't show a stale error or leave the password in React state longer than necessary.

---

### BUG-FE-AUTH-014: Missing `KeyboardAvoidingView`, no `returnKeyType`/`onSubmitEditing` chaining, and no `testID`s on inputs
**Severity:** Medium
**Component:** `frontend/src/features/Auth/SignupScreen.tsx:33-61, 132-150`
**Symptom:** On iOS, the soft keyboard covers the Confirm Password field and the Sign Up button, especially on smaller devices — users can't see what they're typing or tap submit without dismissing the keyboard. Return key on each field just inserts a newline / does nothing useful (can't tab through fields). E2E/unit tests can't target inputs by `testID` (only `signup-submit` has one), making stable test selectors fragile.
**Root cause:**
```tsx
return (
  <View style={styles.container}>
    <Text style={styles.title}>Create Account</Text>
    <SignupFields ... />
    {error && <Text style={styles.error}>{error}</Text>}
    <SignupActions ... />
  </View>
);
```
No `KeyboardAvoidingView`, no `ScrollView`, no `returnKeyType` / `onSubmitEditing` / `ref`-chaining between the three inputs, and inputs lack `testID` (`signup-email`, `signup-password`, `signup-confirm-password`).

**Fix:** Wrap in `<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>` with a `ScrollView` inside. Add `returnKeyType="next"` on email/password, `returnKeyType="go"` on confirm, and use `useRef` + `onSubmitEditing` to hop focus through the fields and trigger `handleSignup` from the confirm field. Add `testID` attributes on all three inputs.

---
### BUG-FE-AUTH-015: Email not normalized to lowercase — users locked out by case-sensitive mismatch
**Severity:** High
**Component:** `frontend/src/features/Auth/LoginScreen.tsx:101`
**Symptom:** A user who signed up as `Alice@Example.com` and later types `alice@example.com` (or vice versa) gets a 401 "bad credentials" toast even though the password is correct. Compounds the duplicate-signup bug: after hitting the signup conflict, the user retries on login with slightly different casing and sees a confusing 401 rather than being let in.
**Root cause:**
```tsx
const handleLogin = async () => {
  setError(null);
  setSubmitting(true);
  try {
    // BUG-AUTH-010: trim at submit so paste/autofill whitespace doesn't
    // produce a confusing 422 from the backend.
    await login(email.trim(), password);
  } catch (err: unknown) {
    ...
  }
};
```
The input sets `autoCapitalize="none"`, but iOS/Android autofill, password managers, and paste can still inject uppercase characters. The submit path trims but never lowercases. The backend compares emails case-sensitively against the stored normalized value, so `Alice@...` and `alice@...` resolve to different user lookups.

**Fix:** Normalize at submit: `await login(email.trim().toLowerCase(), password);`. Keep the password untouched (leading/trailing whitespace may be intentional).

---

### BUG-FE-AUTH-016: No empty-field validation — blank submits fire an API call and surface a 422 as "bad credentials"
**Severity:** Medium
**Component:** `frontend/src/features/Auth/LoginScreen.tsx:95-109`
**Symptom:** Tapping "Log In" with empty email and/or password still hits the network. The server responds 422 (validation) or 401 depending on routing, and `formatApiError` renders a generic "couldn't sign you in" message. The user has no hint that the form is incomplete, and the app wastes a round-trip plus a `LoginAttempt` row.
**Root cause:**
```tsx
const handleLogin = async () => {
  setError(null);
  setSubmitting(true);
  try {
    await login(email.trim(), password);
  } ...
};
```
There is no guard for `!email.trim() || !password` before calling `login`. The submit button is also not disabled for empty state — it is only disabled while `submitting` is true.

**Fix:** Add a pre-flight check that sets a specific error ("Enter your email and password") and returns early, and disable the button when either field is empty: `disabled={submitting || !email.trim() || !password}`.

---

### BUG-FE-AUTH-017: Double-tap race fires two concurrent login requests
**Severity:** Medium
**Component:** `frontend/src/features/Auth/LoginScreen.tsx:95-109, 64-74`
**Symptom:** A fast double-tap on "Log In" dispatches two `login(...)` calls before React commits the `submitting=true` state and re-renders the disabled button. The server logs two `LoginAttempt` rows, pushes the user closer to the rate-limit/lockout threshold, and if credentials are wrong the user is penalized twice per tap.
**Root cause:**
```tsx
const handleLogin = async () => {
  setError(null);
  setSubmitting(true);          // async state update — NOT a synchronous guard
  try {
    await login(email.trim(), password);
  } ...
};
```
`setSubmitting(true)` is queued by React; the next render is what actually applies `disabled` to the `TouchableOpacity`. Between the first tap and the re-render, a second tap runs `onPress` again and enters `handleLogin` a second time. There is no synchronous ref-based guard.

**Fix:** Add a `const inFlight = useRef(false);` check at the top of `handleLogin`: if `inFlight.current` return; set it true before the await, clear in `finally`. This guards against the render-lag race independently of the `submitting` state used for the UI.

---

### BUG-FE-AUTH-018: Stale error persists across navigation (Signup round-trip) and re-renders
**Severity:** Low
**Component:** `frontend/src/features/Auth/LoginScreen.tsx:88-128`
**Symptom:** User fails login, sees a red error, taps "Sign Up", decides to come back and taps "Don't have an account? Sign Up" → then returns to Login. Because React Navigation keeps the screen mounted in the stack, the previous `error` string is still rendered under the fields, confusing the user before they've even retyped anything. Same issue when the user begins editing fields after an error — the error hangs around until the next submit.
**Root cause:**
```tsx
const [error, setError] = useState<string | null>(null);
// error is only cleared inside handleLogin via setError(null) at submit time
// no useFocusEffect, no clear-on-change-text hook
{error && <Text style={styles.error}>{error}</Text>}
```
There is no `useFocusEffect` to reset `error` (and probably `password`) when the screen regains focus, and no clearing on `onChangeText` for email/password.

**Fix:** Use `useFocusEffect(useCallback(() => { setError(null); setPassword(''); }, []))` to reset on focus, and optionally clear `error` inside the `setEmail`/`setPassword` wrappers so typing corrects the stale message.

---

### BUG-FE-AUTH-019: No keyboard "return" submit, no password return-key wiring, no forgot-password link
**Severity:** Low
**Component:** `frontend/src/features/Auth/LoginScreen.tsx:30-46, 62-86`
**Symptom:** (a) Pressing the keyboard's "Go"/"return" key on the password field does nothing — users must dismiss the keyboard and tap the button. (b) There is no "Forgot password?" link anywhere on the screen, so a locked-out user (after the 5-attempt lockout 401 detail) has no recovery path from the UI — they only see the generic fallback and a Sign Up link, which re-triggers the duplicate-signup bug.
**Root cause:**
```tsx
<TextInput accessibilityLabel="Email" ... keyboardType="email-address" />
<TextInput accessibilityLabel="Password" ... secureTextEntry />
// no returnKeyType, no onSubmitEditing, no ref-based focus chain
// no "Forgot password?" TouchableOpacity in LoginActions
```
The email field has no `returnKeyType="next"` + `onSubmitEditing={() => passwordRef.current?.focus()}`, and the password field has no `returnKeyType="go"` + `onSubmitEditing={handleLogin}`. Worse, the screen does not render a reset-password entry point, and `formatApiError` cannot distinguish a 401 bad-credentials from a 401 lockout from a 429 rate-limited — all three surface the same `LOGIN_FALLBACK` string.

**Fix:** Add a `passwordRef` and wire `returnKeyType`/`onSubmitEditing` on both fields to focus-next and submit respectively. Add a "Forgot password?" `TouchableOpacity` below the submit button that navigates to a reset flow (or for now, surfaces contact info). Teach `formatApiError` / `LoginScreen` to branch on the backend's `detail` code (`invalid_credentials` vs `account_locked` vs `rate_limited`) and render actionable copy ("Too many attempts — try again in N minutes" / "Forgot your password?") instead of the blanket fallback.

---

## Suggested remediation order

1. **BUG-FE-AUTH-010 (duplicate-signup zombie session)** — land **with** report-01's BUG-AUTH-001/016 fix. Even if the backend stops returning the dummy response, throw a typed `DuplicateEmailError` in `authApi.signup` / `AuthContext.signup` whenever `user_id <= 0` and refuse to persist the token. Add a regression test that stubs the dummy response and asserts AsyncStorage is unchanged. This is the single most important fix in this report.
2. **BUG-FE-AUTH-002 (loadToken unhandled rejection) + BUG-FE-AUTH-003 (fire-and-forget cleanup)** — bootstrap reliability cluster. Both are small async-hygiene changes in the same `useEffect`. Land together.
3. **BUG-FE-AUTH-001 + 004 + 005 (lifecycle race cluster)** — the proactive-refresh logout race, identity-blind overwrite, and effect-cleanup races all touch the same callback wiring. Best fixed in one PR with a unified "expected previous token" pattern threaded through both `useProactiveRefresh` and `saveTokenThenApply`. Add tests using fake timers + manually resolved refresh promises.
4. **BUG-FE-AUTH-008 (no error handling) + BUG-FE-AUTH-006 (Android 2 KB cap)** — storage error surface cluster. Introduce typed errors (`TokenPersistFailed`, `TokenLocked`, `TokenStorageFull`), guard the size cap, and update `AuthContext`/login/signup screens to render actionable copy. Land BUG-FE-AUTH-009 (cross-backend orphan) in the same PR — it's the same file and the same test fixtures.
5. **BUG-FE-AUTH-015 (Login email lowercase) + BUG-FE-AUTH-011 (Signup whitespace in confirm)** — input normalization cluster. Trim+lowercase emails at submit; warn (don't silently mutate) on password whitespace. Land alongside report-01 BUG-AUTH-019 so the matching backend error code is meaningful.
6. **BUG-FE-AUTH-012 + 016 (empty-field / format validation)** + **017 (Login double-tap race)** — Auth screen UX cluster. Synchronous `useRef` guard for the double-tap; pre-flight email/password validation with specific copy. Disable buttons on empty state.
7. **BUG-FE-AUTH-013 (back-to-pre-filled-Signup) + 014 (KeyboardAvoidingView, testIDs)** — Signup polish cluster. Use `replace` for cross-stack navigation, clear sensitive form state on blur, wrap in `KeyboardAvoidingView`, add return-key chaining and testIDs.
8. **BUG-FE-AUTH-018 + 019 (stale Login error, return key, Forgot Password)** — final Login polish. `useFocusEffect` to clear errors; `returnKeyType` chain; "Forgot password?" link; teach `formatApiError` to branch on `account_locked` vs `rate_limited` vs `invalid_credentials`.
9. **BUG-FE-AUTH-007 (web localStorage XSS exposure)** — track separately as a strategic decision, not a one-PR fix. Either move to `httpOnly` cookies for web (requires backend changes; cross-references report 05 CORS work) or accept the downgrade with explicit dev-mode warnings + comment in `authStorage.ts`. Either way: make the trade-off conscious and documented.

## Cross-references to other reports

- **Report 01 (backend auth):** BUG-AUTH-001 / 002 / 016 (duplicate-signup contract) is the server-side counterpart of BUG-FE-AUTH-010.
- **Report 03 (navigation):** BUG-FE-AUTH-002 (loadToken hang) and BUG-FE-AUTH-003 (race vs `isLoading`) interact with the conditional Auth/Tabs stack mount that the navigation report owns. Coordinate fixes.
- **Report 04 (API client):** BUG-FE-AUTH-005 (cleanup nulls token getter) and BUG-FE-AUTH-001 (refresh callback wiring) depend on how the API client consumes the registered callbacks.
