# design-act2-10: Auth as a branded editorial first impression

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** 01 (scaffold), 02 (showcase/callout)
**Estimated LoC:** ~230

## Problem

Auth is the app's first impression and it is a plain grey-on-white centred form.
The `SafeAreaView` is warm `surface.canvas`, but the inner container reverts to
legacy `colors.background.card` (`#ffffff`) and the title is plain bold sans
(`auth.styles.ts:14-72`) — no logo moment, no serif voice, no illustration, no
sense of the contemplative 36-week program a new user is joining (`a7d95417`
survey). The warm `TextField`/`Button` primitives (#801) are used, but the shell
around them is utilitarian, so the very first screen undersells the product.

Current state: `LoginScreen.tsx`, `SignupScreen.tsx`, `ForgotPasswordScreen.tsx`,
`ResetPasswordScreen.tsx`, `CancelResetScreen.tsx` all centre a `FORM_MAX_WIDTH`
form on the grey container via `AuthScreenContainer.tsx`.

## Scope

Re-imagine the auth shell as a branded editorial **cover** — the program's tone
in the first three seconds — while keeping every auth flow, field, validation,
anti-enumeration behaviour, and the `ReauthSheet` exactly as they are. Layout +
surface only; no auth logic changes.

## Tasks

### 1. An editorial cover for the auth shell

- Restyle `AuthScreenContainer.tsx` onto the warm ground end-to-end (drop the
  grey `colors.background.card` container) and give it a **brand band**: a serif
  wordmark "Adepthood" (`type().display`) over a short line of program voice
  (e.g. "A 36-week path of inner development."), set on a `ShowcaseCard` or warm
  canvas hero. This band is shared by Login/Signup so the entrance is consistent.
- Forms sit below the band on the warm canvas, using the existing `TextField`/
  `Button` primitives; links use `accent` (already partly true at `:57-58`).

### 2. Per-screen voice

- `LoginScreen` / `SignupScreen`: a serif `ScreenHeader`-style title ("Welcome
  back" / "Begin") + a one-line lead, replacing the plain bold title.
- `ForgotPassword` / `Reset` / `CancelReset`: same warm shell; keep the success
  states + anti-enumeration copy verbatim.

### 3. Keep the polished re-auth consistent

- Align `ReauthSheet.tsx` (already the most refined auth surface) to the same
  warm tokens so it matches the new cover.

## Tasks — tests

- `LoginScreen.test.tsx` / `SignupScreen.test.tsx`: the brand band + serif title
  render; the email/password fields, submit, and the forgot/signup links still
  work and navigate as before; warm tokens only (no `colors.background.card`
  container).
- Forgot/reset tests: success + anti-enumeration behaviour unchanged.
- `AuthScreenContainer.test.tsx` (or equivalent): root is warm; keyboard-avoiding
  behaviour preserved.

## Acceptance Criteria

- The first screen reads as a branded, editorial cover (serif wordmark + program
  voice) on the warm ground, not a grey form; Login/Signup share the entrance.
- Every auth flow — login, signup, forgot, reset, cancel-reset, re-auth — works
  exactly as before, including validation + anti-enumeration; keyboard avoidance
  intact.
- No legacy grey container; no magic numbers. `cd frontend && npm test &&
  npm run lint && npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Auth/AuthScreenContainer.tsx` | Modify — warm cover + brand band |
| `frontend/src/features/Auth/auth.styles.ts` | Modify — drop grey, warm tokens |
| `frontend/src/features/Auth/LoginScreen.tsx` | Modify — serif title + lead |
| `frontend/src/features/Auth/SignupScreen.tsx` | Modify — serif title + lead |
| `frontend/src/features/Auth/ReauthSheet.tsx` | Modify — token alignment |
| `frontend/src/features/Auth/__tests__/*.test.tsx` | Modify |
