# social-auth-04: Frontend — Continue with Apple (iOS)

**Labels:** `feature`, `frontend`, `epic:social-auth`, `priority-high`
**Epic:** [Social auth](social-auth-epic.md)
**Depends on:** social-auth-02 (backend endpoint), social-auth-03
(SocialAuthButtons component + needs_license routing)
**Estimated LoC:** ~200–300 (including tests)

## Problem

With Google login shipping on iOS, App Store guideline 4.8 requires
Sign in with Apple as a peer option. This issue adds the Apple button
to the `SocialAuthButtons` row from social-auth-03, iOS only.

## Scope

### 1. Dependency + availability

- Add `expo-apple-authentication` (`npx expo install`).
- Render the Apple button only when
  `AppleAuthentication.isAvailableAsync()` resolves true (iOS 13+, real
  capability check — not just `Platform.OS === "ios"`); nothing renders
  on Android/web.
- App config: add `usesAppleSignIn: true` (expo config plugin) so the
  entitlement is present in iOS builds.

### 2. Flow (`frontend/src/features/Auth/useAppleAuth.ts`)

- `AppleAuthentication.signInAsync` requesting `FULL_NAME` and `EMAIL`
  scopes.
- POST `{ id_token: credential.identityToken, full_name: <joined name
  parts, only if provided>, license_key?, timezone }` to
  `authApi.oauthApple`.
- Response mapping identical to `useGoogleAuth` (reuse the shared
  mapping helper from social-auth-03 rather than duplicating):
  success → `applyAuthResponse`; 409 `needs_license` → route to the
  Gumroad onboarding step carrying the pending token; error → banner.
- Handle user-cancel (`ERR_REQUEST_CANCELED`) silently — no error
  banner for a deliberate dismissal.

### 3. UI

- Use `AppleAuthentication.AppleAuthenticationButton` (Apple requires
  their rendered button) sized/spaced to sit coherently in the
  `SocialAuthButtons` row; respect light/dark via the button style
  constants and the Candle & Ink theme context.

### 4. Tests

- Module-mock `expo-apple-authentication`: button renders only when
  available; sign-in success posts the identity token and applies the
  auth response; `full_name` included only when Apple supplies it;
  cancel produces no error state; `needs_license` routes to onboarding.

## Acceptance criteria

- On iOS, Apple button appears beside Google and completes login /
  license-gated signup end-to-end.
- On Android, no Apple button, zero layout shift.
- ESLint, TypeScript strict, Jest ≥ 90% on new files.

## Files to create / modify

| File | Action |
|------|--------|
| `frontend/src/features/Auth/useAppleAuth.ts` | Create |
| `frontend/src/features/Auth/SocialAuthButtons.tsx` | Modify |
| `frontend/src/context/AuthContext.tsx` | Modify (`loginWithApple`) |
| `frontend/src/api/*` | Modify (client + types) |
| `frontend/app.json` / `app.config.*` | Modify (`usesAppleSignIn`) |
| `frontend/package.json` | Modify (expo-apple-authentication) |

## Notes for implementer

- Apple provides the user's name ONLY on the first authorization —
  losing it is unrecoverable without the user revoking access in
  Settings. Send it to the backend immediately when present.
- Never persist the identity token client-side.
