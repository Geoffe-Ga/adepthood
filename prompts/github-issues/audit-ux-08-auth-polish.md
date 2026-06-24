# audit-ux-08: Shared auth styles, keyboard handling, and consistent email canonicalization

**Labels:** `audit-ux`, `frontend`, `ux`, `priority-low`
**Epic:** UX States, Accessibility & Error Copy
**Estimated LoC:** ~280  (hard cap 700)

## Problem

The six Auth screens (`LoginScreen.tsx`, `SignupScreen.tsx`, `ForgotPasswordScreen.tsx`, `ResetPasswordScreen.tsx`, `CancelResetScreen.tsx`, `ReauthSheet.tsx`) each define their own near-identical container/input/button `StyleSheet`, so the same styles are copy-pasted ~6× and drift independently. None of the full-screen auth screens wrap in `KeyboardAvoidingView`/`SafeAreaView`, so the on-screen keyboard can cover the submit button on small devices. And email canonicalization is inconsistent: `SignupScreen.tsx:121` submits `email.trim()` only, while `LoginScreen.tsx:118` submits `email.trim().toLowerCase()` — so a user who signs up as `Foo@bar.com` and logs in as `foo@bar.com` can look like two different accounts client-side. Current state: this is a **UX correctness** plus maintainability gap (duplicated styles, keyboard occlusion, asymmetric canonicalization); the asymmetry is the user-visible part (audit §8 Auth screens).

## Scope

**Covers:** (a) Extracting a shared `auth.styles.ts` consumed by all six screens; (b) adding `KeyboardAvoidingView` (and `SafeAreaView`) to the full-screen auth screens; (c) making signup's email canonicalization match login's `trim().toLowerCase()`, ideally via one shared `canonicalizeEmail` helper used by both.

**Does NOT:** Change auth API contracts, validation rules beyond canonicalization, error-copy wording (already handled via `formatApiError`), or backend email normalization. `ReauthSheet` is a sheet, not full-screen — apply keyboard handling but not full-screen safe-area if it already sits inside a safe parent.

## Tasks

1. **Extract shared styles** — Create `features/Auth/auth.styles.ts` holding the common container/input/button/error styles; replace the per-screen duplicates across all six screens. TDD: a smoke render of each screen still resolves its key inputs/buttons (`getByTestId`/`getByLabelText`) after the swap.
2. **Add keyboard + safe-area handling** — Wrap the full-screen auth screens (`Login`, `Signup`, `ForgotPassword`, `ResetPassword`, `CancelReset`) in `KeyboardAvoidingView` (`behavior={Platform.OS === 'ios' ? 'padding' : undefined}`) and `SafeAreaView`, mirroring the pattern `CreatePracticeWizard.tsx:134` already uses. TDD: each screen renders a `KeyboardAvoidingView` (assert presence via testID/role) without breaking existing flow tests.
3. **Unify email canonicalization** — Add a `canonicalizeEmail(raw): string` helper (`trim().toLowerCase()`) and use it at both submit sites: `SignupScreen.tsx:121` (currently `email.trim()`) and `LoginScreen.tsx:118`. TDD: `canonicalizeEmail('  Foo@Bar.COM ')` returns `'foo@bar.com'`; signup's submit handler passes the lowercased value to `signup` (assert via a mocked `signup`).
4. **Regression-guard the existing auth tests** — Run `LoginScreen.test.tsx` / `SignupScreen.test.tsx` / `AppAuthFlow.test.tsx` and ensure the refactor keeps them green.

## Acceptance Criteria

- [ ] All six auth screens import their common styles from a single `auth.styles.ts`; no duplicated container/input/button blocks remain.
- [ ] Full-screen auth screens wrap in `KeyboardAvoidingView` + `SafeAreaView`.
- [ ] Signup and login both submit `trim().toLowerCase()` email via the shared `canonicalizeEmail` helper.
- [ ] No user-facing copy leaks internals.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Auth/auth.styles.ts` | **Create** |
| `frontend/src/features/Auth/canonicalizeEmail.ts` | **Create** |
| `frontend/src/features/Auth/LoginScreen.tsx` | Modify (shared styles, keyboard, helper) |
| `frontend/src/features/Auth/SignupScreen.tsx` | Modify (shared styles, keyboard, canonicalize email) |
| `frontend/src/features/Auth/ForgotPasswordScreen.tsx` | Modify (shared styles, keyboard) |
| `frontend/src/features/Auth/ResetPasswordScreen.tsx` | Modify (shared styles, keyboard) |
| `frontend/src/features/Auth/CancelResetScreen.tsx` | Modify (shared styles, keyboard) |
| `frontend/src/features/Auth/ReauthSheet.tsx` | Modify (shared styles, keyboard) |
| `frontend/src/features/Auth/__tests__/canonicalizeEmail.test.ts` | **Create** |
