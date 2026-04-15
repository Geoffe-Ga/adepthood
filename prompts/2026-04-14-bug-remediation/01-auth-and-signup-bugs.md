# Authentication & Signup — Bug Remediation Report

**Component:** Signup, Login, Token refresh, Account lockout, JWT handling
**Date:** 2026-04-14
**Auditor:** Claude Code (self-review)
**Branch:** `claude/code-review-bug-analysis-BvOHp`

## Executive Summary

This is the component that is currently blocking you from even reaching the app. The audit found **14 bugs**, and the most likely suspects for the five you hit on the way in are:

1. **Email case sensitivity** — signing up with `Alice@Example.com` then attempting to log in with `alice@example.com` fails with `invalid_credentials`.
2. **Whitespace not stripped from email** — a trailing space from a paste/auto-fill produces 422 and a generic error toast.
3. **No client-side email validation** — a malformed address sends a raw 422 to the user without a useful message.
4. **`user_id` optional in frontend type but required in backend schema** — any code path assuming it exists can break the post-login navigation.
5. **Unawaited `saveToken` in the 401/refresh callback** — the first login can succeed, state updates, but the token isn't actually persisted by the time you close the app — next launch dumps you back at the login screen.

Plus: account-lockout attempts aren't recorded, silent refresh failures are swallowed, `X-Forwarded-For` is trusted blindly, and there are multiple accessibility / empty-field gaps.

---

## Table of Contents

| # | Severity | Title |
|---|---|---|
| BUG-AUTH-001 | Critical | Token save not awaited in 401 refresh callback |
| BUG-AUTH-002 | Critical | `AuthResponse.user_id` optional in TS, required in backend |
| BUG-AUTH-003 | High | Email lookups are case-sensitive |
| BUG-AUTH-005 | High | `clearToken` not awaited in `onUnauthorized` callback |
| BUG-AUTH-004 | Medium | No client-side email format validation |
| BUG-AUTH-006 | Medium | Account-lockout path doesn't record the attempt |
| BUG-AUTH-007 | Medium | Silent token-refresh failure not logged |
| BUG-AUTH-009 | Medium | No empty-field check before auth requests |
| BUG-AUTH-010 | Medium | Whitespace not stripped from email input |
| BUG-AUTH-008 | Low | Missing a11y labels / testIDs on auth inputs |
| BUG-AUTH-011 | Low | Proactive-refresh timer continues after signature rotation |
| BUG-AUTH-012 | Low | `X-Forwarded-For` trusted without proxy allow-list |
| BUG-AUTH-013 | Low | No password-strength feedback |
| BUG-AUTH-014 | Low | Login error persists across navigation |

---

### BUG-AUTH-001: Token save not awaited in 401 refresh callback
**Severity:** Critical
**Component:** `frontend/src/context/AuthContext.tsx:75`, `frontend/src/api/index.ts:135`
**Symptom:** After a mid-session token refresh, `saveToken` is fire-and-forget. If the app is closed or crashes before the async write completes, the new token never reaches secure storage and the user is logged out on next launch.
**Root cause:**
```ts
// AuthContext.tsx:75
setOnTokenRefreshed((t: string) => { saveToken(t); setToken(t); });
// api/index.ts:135
onTokenRefreshedCallback?.(data.token);
```
Callback signature is sync; callers don't await.
**Fix:** Make the callback async-aware — wrap `saveToken` + `setToken` in one async function, await it on the call site, and add a `.catch` that logs and triggers logout.

---

### BUG-AUTH-002: `AuthResponse.user_id` optional in TS, required on the server
**Severity:** Critical
**Component:** `frontend/src/api/index.ts:907-909` vs `backend/src/routers/auth.py:56-58`
**Symptom:** TS declares `user_id?: number` while the backend guarantees it. Every downstream consumer either loses type safety or has to check for undefined that can't actually occur.
**Fix:** Remove the `?`. Regenerate/realign types from a single source (OpenAPI schema or shared package).

---

### BUG-AUTH-003: Email lookups are case-sensitive
**Severity:** High
**Component:** `backend/src/routers/auth.py:168, 215`; `backend/src/models/user.py`
**Symptom:** Sign up as `Alice@Example.com`, log in as `alice@example.com` → 401.
**Fix:**
- Normalize at input: `email = payload.email.strip().lower()` in both signup and login.
- Store the normalized form.
- Add a migration for a unique index on `lower(email)` to prevent duplicates slipping through.
- Also normalize in `_is_account_locked` and `_record_attempt`.

---

### BUG-AUTH-005: `clearToken` not awaited in `onUnauthorized`
**Severity:** High
**Component:** `frontend/src/context/AuthContext.tsx:71, 137`
**Symptom:** `setToken(null)` runs immediately while the storage delete is in-flight. An app crash in that window leaves a stale token in secure storage, which is rehydrated on next launch.
**Fix:** `await clearToken()` before `setToken(null)`, or chain as a promise with a logged-out sentinel in storage as a defensive marker.

---

### BUG-AUTH-004: No client-side email format validation
**Severity:** Medium
**Component:** `frontend/src/features/Auth/SignupScreen.tsx:89-111`, `LoginScreen.tsx:21-34`
**Symptom:** `"notanemail"` sends a 422 that the user sees as a generic "That didn't go through."
**Fix:** Add `isValidEmail` regex (RFC-simple) and gate submission. Show "Please enter a valid email address."

---

### BUG-AUTH-006: Lockout path doesn't record the attempt
**Severity:** Medium
**Component:** `backend/src/routers/auth.py:202-213`
**Symptom:** While an account is locked, subsequent attempts log to the application logger but aren't inserted into `LoginAttempt`. Forensic trail is incomplete.
**Fix:** Call `await _record_attempt(..., success=False)` before raising the 401.

---

### BUG-AUTH-007: Silent token-refresh failure not logged
**Severity:** Medium
**Component:** `frontend/src/context/AuthContext.tsx:25-32`
**Symptom:** `silentRefresh` swallows errors with an empty arrow. Users have no signal; operators can't debug.
**Fix:** `console.warn` + report to analytics. On `ApiError` 401, immediately trigger `onUnauthorized` rather than waiting for the next 401.

---

### BUG-AUTH-009: No empty-field check before auth requests
**Severity:** Medium
**Component:** `SignupScreen.tsx`, `LoginScreen.tsx`
**Symptom:** Submit with blank email / blank password → backend 422 → generic UI error.
**Fix:** Field-level validation with specific messages ("Email is required", "Password is required") before calling the API.

---

### BUG-AUTH-010: Whitespace not stripped from email input
**Severity:** Medium
**Component:** `SignupScreen.tsx:103`, `LoginScreen.tsx:25`, `backend/src/routers/auth.py`
**Symptom:** A leading or trailing space from paste/autofill → 422.
**Fix:** `email.trim()` on the client; `.strip().lower()` on the server. Tighten `EmailStr` with Pydantic validator if desired.

---

### BUG-AUTH-008: Missing a11y labels / testIDs on auth inputs
**Severity:** Low
**Component:** `SignupScreen.tsx:34-55`, `LoginScreen.tsx:39-52`
**Symptom:** Screen readers announce "text input"; Detox/E2E has no stable hooks.
**Fix:** Add `accessibilityLabel`, `accessibilityHint`, and `testID` (`signup-email-input`, etc.).

---

### BUG-AUTH-011: Proactive-refresh timer after signature rotation
**Severity:** Low
**Component:** `frontend/src/context/AuthContext.tsx:40-61`
**Symptom:** If `SECRET_KEY` rotates, the scheduled refresh fires with a now-invalid token; refresh fails silently (see AUTH-007).
**Fix:** On refresh failure with 401, dispatch the unauthorized callback immediately instead of waiting for the next request.

---

### BUG-AUTH-012: `X-Forwarded-For` trusted without proxy allow-list
**Severity:** Low
**Component:** `backend/src/routers/auth.py:97-106`
**Symptom:** If the service is ever exposed without a TLS-terminating proxy, an attacker can spoof the client IP and either bypass rate limits or frame a victim for lockout.
**Fix:** Only honor `X-Forwarded-For` when `request.client.host` is in a `TRUSTED_PROXIES` list from env. Document the deployment contract in `DEPLOYMENT.md`.

---

### BUG-AUTH-013: No password-strength feedback
**Severity:** Low
**Component:** `SignupScreen.tsx`
**Symptom:** `password123` is accepted silently.
**Fix:** Add a small strength meter (length + classes of chars) in the UI. Consider enforcing a minimum entropy on the server; don't rely solely on the frontend.

---

### BUG-AUTH-014: Login error persists across navigation
**Severity:** Low
**Component:** `LoginScreen.tsx:18` and lifecycle
**Symptom:** Error banner from a previous attempt remains visible after navigating away and back.
**Fix:** `useFocusEffect(() => setError(null), [])`.

---

## Suggested remediation order

1. **001 + 005** (async token lifecycle) — land together with tests that kill the app between `setToken` and `saveToken`.
2. **003 + 010** (email normalization) — migration + backend + frontend trim.
3. **002** (schema contract) — regenerate types, fix call sites.
4. **004 + 009 + 014** (UX cleanup on auth screens).
5. **006 + 007 + 012** (observability + abuse hardening).
6. **008, 011, 013**.
