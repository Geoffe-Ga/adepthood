# phase-6-03: Frontend onboarding flow — redirect to Gumroad and redeem license

**Labels:** `phase-6`, `frontend`, `monetization`, `priority-high`
**Epic:** Phase 6 — Gumroad-gated access and monetization
**Depends on:** phase-6-02
**Estimated LoC:** ~300–400 (including tests)

## Problem

After phase-6-02, the backend requires a `license_key` to create an
account. The frontend signup form currently only collects email and
password, so signup will fail for every new user once the gate is
turned on.

This issue builds the user-facing onboarding flow: a welcome screen
explaining the Gumroad-first model, a deep link to the Gumroad product
page, and a license-key redemption step in the signup form. The copy
frames the free tier as "pay what feels right, starting at zero" so
users understand that they're not being upsold.

## UX shape

```
[Welcome screen] ── "Get Adepthood"
      │                    │
      ▼                    ▼
[Open Gumroad]      [I already have a key]
      │                    │
      └────────┬───────────┘
               ▼
       [Signup form]
       ─ Email
       ─ Password
       ─ Gumroad license key   ← required
       ─ "Where's my key?" helper link
               │
               ▼
         [Create account]
```

- The welcome screen is the default landing for unauthenticated users.
- "Open Gumroad" uses `Linking.openURL` with the Gumroad product URL
  (configurable via `EXPO_PUBLIC_GUMROAD_PRODUCT_URL`). After purchase,
  the user returns to the app manually; we do not attempt OAuth-style
  return callbacks.
- The help link opens a short `WebView` / external link to the Gumroad
  page that explains where license keys live in a user's Gumroad
  library.
- The form's error display must handle the backend's `invalid_license`
  error specifically, surfacing it as "We couldn't verify that key —
  double-check it matches the email and product." rather than the
  generic "Request failed".

## Scope

### 1. Config (`frontend/src/config.ts`)

- Add `GUMROAD_PRODUCT_URL` and `GUMROAD_HELP_URL`, read from
  `EXPO_PUBLIC_*` env vars with sensible defaults for local dev.
- Document both in `frontend/README.md`.

### 2. Welcome screen
   (`frontend/src/features/Auth/screens/WelcomeScreen.tsx`)

- New screen, added as the first screen in the unauthenticated stack.
- Two primary CTAs: "Get Adepthood on Gumroad" (opens URL) and "I have
  a license key" (navigates to signup).
- Short copy explaining the gift-economy framing. Copy lives in the
  component for now (no i18n yet in the codebase).

### 3. Signup screen update
   (`frontend/src/features/Auth/screens/SignupScreen.tsx`)

- Add a `licenseKey` field to the form state.
- Client-side validation: required, trimmed, minimum length of 8
  (defensive — real format validation happens server-side).
- Submit `{ email, password, license_key }` to `authApi.signup`.
- Add an inline "Where's my key?" link that opens `GUMROAD_HELP_URL`.
- Map backend error details:
  - `invalid_license` → surfaced inline on the license field.
  - `password_too_short` → inline on password field.
  - Other errors → the existing generic error banner.

### 4. API types and client (`frontend/src/api/index.ts`)

- Extend `AuthRequest` with optional `license_key?: string`.
- Leave the login endpoint unaffected (the backend makes license_key
  optional, required-at-handler for signup).

### 5. AuthContext
   (`frontend/src/context/AuthContext.tsx`)

- `signup(email, password, licenseKey)` — adds a third argument.
- Pass through to `authApi.signup({ email, password, license_key:
  licenseKey })`.

### 6. Better error extraction (`frontend/src/api/index.ts`)

Small quality-of-life fix that belongs with this work: the current
`extractErrorDetail` (lines 98–108) only handles string `detail`
fields. FastAPI's 422 validation errors come back as an array. Extend
to:
- If `detail` is a string, return it.
- If `detail` is an array of `{ loc, msg, type }`, join the `msg`
  values or return the first one. This lets the signup screen show a
  real message when the body shape is wrong.

### 7. Tests

- Unit: signup form rejects empty license key without a network call.
- Unit: signup form submits `license_key` in the payload.
- Unit: `invalid_license` error from the API is rendered inline on the
  license field, not in the generic banner.
- Unit: Welcome screen's "Get Adepthood" CTA calls
  `Linking.openURL(GUMROAD_PRODUCT_URL)`.
- Snapshot: welcome screen layout stable.

## Acceptance criteria

- Fresh install → welcome screen is the first thing the user sees.
- "Get Adepthood" opens Gumroad in the external browser.
- Signup fails client-side without a license key and shows a helpful
  error.
- Signup succeeds end-to-end when a valid key is entered (manual test
  against a local backend with a seeded Gumroad sale).
- Backend validation errors are surfaced on the correct fields.
- ESLint, TypeScript, Jest all green.

## Files to create / modify

| File | Action |
|------|--------|
| `frontend/src/features/Auth/screens/WelcomeScreen.tsx` | Create |
| `frontend/src/features/Auth/screens/SignupScreen.tsx` | Modify |
| `frontend/src/navigation/AuthStack.tsx` | Modify (add WelcomeScreen) |
| `frontend/src/context/AuthContext.tsx` | Modify (licenseKey arg) |
| `frontend/src/api/index.ts` | Modify (AuthRequest, error extraction) |
| `frontend/src/config.ts` | Modify (2 new URL config entries) |
| `frontend/src/features/Auth/__tests__/SignupScreen.test.tsx` | Modify |
| `frontend/src/features/Auth/__tests__/WelcomeScreen.test.tsx` | Create |
| `frontend/src/context/__tests__/AuthContext.test.tsx` | Modify |
| `frontend/__tests__/api.test.ts` | Modify |
| `frontend/README.md` | Modify |

## Notes for implementer

- `Linking.openURL` returns a promise — await it and log (not throw)
  if it rejects, since on simulator/emulator it can fail silently.
- Do not log the license key anywhere, even on error. Treat it as a
  credential.
- Keep the welcome screen copy short — this is an onboarding speed
  bump, not a landing page. Link-out to the Gumroad product page
  for the real marketing copy.
