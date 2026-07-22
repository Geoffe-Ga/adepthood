# social-auth-03: Frontend — Continue with Google

**Labels:** `feature`, `frontend`, `epic:social-auth`, `priority-high`,
`parallelizable`
**Epic:** [Social auth](social-auth-epic.md)
**Depends on:** social-auth-01 (backend endpoint). Parallelizable with
social-auth-02 (backend, disjoint files).
**Estimated LoC:** ~300–400 (including tests)

## Problem

`frontend/src/features/Auth/LoginScreen.tsx` and `SignupScreen.tsx`
offer only email/password. This issue adds a "Continue with Google"
button to both, driving the native Google flow via `expo-auth-session`
and exchanging the resulting ID token at `POST /auth/oauth/google`.

## Scope

### 1. Dependency + config

- Add `expo-auth-session` + `expo-web-browser` (via
  `npx expo install`, committed to `package.json` — install with
  `npm ci` semantics afterwards).
- Env config: `EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS`,
  `EXPO_PUBLIC_GOOGLE_CLIENT_ID_ANDROID`,
  `EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB` read in a new
  `frontend/src/features/Auth/oauthConfig.ts`; document in
  `frontend/README.md`. Feature-flag: if the platform's client ID is
  unset, the Google button does not render (safe rollout).

### 2. `useGoogleAuth` hook (`frontend/src/features/Auth/useGoogleAuth.ts`)

- Wraps `Google.useAuthRequest` from `expo-auth-session/providers/google`
  requesting an ID token.
- On success: call a new `authApi.oauthGoogle({ id_token, license_key?,
  timezone })` (device timezone attached exactly like
  `signupWithDeviceTimezone` in `AuthContext.tsx`).
- Maps backend responses:
  - 200/201 → apply auth response via the existing `applyAuthResponse`
    path in `AuthContext`.
  - 409 `needs_license` → surface a typed result the screens use to
    route the user to the Gumroad onboarding step (phase-6-03's welcome
    /license entry), carrying the pending `id_token` so the user isn't
    asked to re-authenticate after entering their key.
  - Other errors → existing error-banner path.

### 3. UI

- `SocialAuthButtons` component rendered on both `LoginScreen` and
  `SignupScreen` below the primary form, following Candle & Ink tokens
  (`frontend/src/design/`) and the existing `auth.styles.ts` patterns —
  a quiet divider ("or") plus the provider button. Follow Google's
  branding guidelines (official mark, correct label) within the design
  system's restraint.
- Accessible: labeled for screen readers, minimum touch target per
  existing conventions.

### 4. AuthContext / API client

- `frontend/src/api` gains `oauthGoogle` (and the endpoint types) —
  keep in lockstep with the backend schema.
- `AuthContext` gains `loginWithGoogle(licenseKey?: string)` following
  the existing `login`/`signup` callback patterns (race-guard rules in
  that file apply — read its comments first).

### 5. Tests

- Hook: success path applies auth response; `needs_license` returns the
  routing result without mutating auth state; failure hits the error
  path. Mock `expo-auth-session` (jest module mock — no real browser).
- Component: button hidden when client ID unset; press triggers the
  request; a11y label present.
- AuthContext: `loginWithGoogle` follows the same stale-response guard
  as `login` (see BUG-AUTH-005 comments in the file).

## Acceptance criteria

- Google button renders on Login + Signup when configured, launches the
  native flow, and lands an authenticated session end-to-end against a
  local backend.
- `needs_license` routes into the Gumroad onboarding step and completes
  signup without a second Google prompt.
- ESLint, TypeScript strict, Jest ≥ 90% on new files.

## Files to create / modify

| File | Action |
|------|--------|
| `frontend/src/features/Auth/useGoogleAuth.ts` | Create |
| `frontend/src/features/Auth/SocialAuthButtons.tsx` | Create |
| `frontend/src/features/Auth/oauthConfig.ts` | Create |
| `frontend/src/features/Auth/LoginScreen.tsx` | Modify |
| `frontend/src/features/Auth/SignupScreen.tsx` | Modify |
| `frontend/src/context/AuthContext.tsx` | Modify |
| `frontend/src/api/*` | Modify (client + types) |
| `frontend/package.json` | Modify (expo-auth-session, expo-web-browser) |
| `frontend/README.md` | Modify |

## Notes for implementer

- Never store or log the Google ID token beyond the in-flight exchange.
- The pending-token handoff to the license step should live in
  navigation params or a short-lived ref — not AsyncStorage.
