# EPIC: Social auth — Google and Apple sign-in alongside email/password

**Labels:** `epic`, `epic:social-auth`, `feature`, `priority-high`

## Summary

Adepthood owns its auth (JWT HS256, bcrypt, anti-enumeration defenses in
`backend/src/routers/auth.py`). Gumroad cannot act as an OAuth identity
provider for end users — its OAuth is creator-account API access only —
so "sign in with Google / Apple" is our own implementation, layered on
the same JWT session machinery and on Phase 6's Gumroad license gate.

After this epic, the Login and Signup screens offer three ways in:
email/password (unchanged), **Continue with Google**, and — on iOS —
**Continue with Apple**. All three converge on the same `User` row, the
same JWT, and the same rule from Phase 6: *a first-time account still
requires a verified Gumroad license* (free $0 tier counts). Social login
changes how you prove who you are, never who is allowed in.

## Architecture at a glance

```
Expo app
  ├─ expo-auth-session (Google) ──▶ Google ID token
  └─ expo-apple-authentication ──▶ Apple identity token
                │
                ▼
POST /auth/oauth/{google|apple}   { id_token, license_key? }
                │
    verify signature vs provider JWKS, audience check
                │
  AuthIdentity lookup (provider, subject) ──▶ existing user → JWT
                │ none
  verified-email match to existing User ──▶ link identity → JWT
                │ none
  license_key present? ──▶ phase-6-02 redemption → create User
                │ absent  └▶ create AuthIdentity → JWT
                ▼
  409 needs_license → frontend routes to Gumroad onboarding step
```

- New table `AuthIdentity` (`user_id`, `provider`, `subject`, unique on
  `(provider, subject)`) — a user can hold many identities.
- Social-only accounts store an unusable random bcrypt hash in
  `User.password_hash` (no nullable-column migration; password login for
  them simply always fails verification).
- Email linking only when the provider asserts the email is verified.

## Sub-issues

1. [`social-auth-01`](social-auth-01-backend-google.md) — Backend:
   `AuthIdentity` model + `POST /auth/oauth/google` (ID-token
   verification via Google JWKS, link-or-create, license gate)
2. [`social-auth-02`](social-auth-02-backend-apple.md) — Backend:
   `POST /auth/oauth/apple` (Apple JWKS, private-relay emails,
   name-only-on-first-auth)
3. [`social-auth-03`](social-auth-03-frontend-google.md) — Frontend:
   Continue-with-Google button + flow via `expo-auth-session`
4. [`social-auth-04`](social-auth-04-frontend-apple.md) — Frontend:
   Continue-with-Apple button (iOS only) via
   `expo-apple-authentication`

## Dependencies

- `phase-6-02` (license-gated signup) must merge before social-auth-01's
  create-account path can enforce the license gate. social-auth-01 lands
  the gate behind the same domain helper so ordering is enforced by the
  issue dependency, not duplicated logic.
- Apple's App Store guideline 4.8: an iOS app offering third-party
  social login (Google) **must** also offer Sign in with Apple —
  social-auth-04 is not optional if 03 ships on iOS.

## Success criteria

- A returning user taps Continue with Google/Apple and lands in the app
  with a normal Adepthood JWT — no password ever created.
- A first-time social user without a Gumroad license is routed to the
  Gumroad onboarding step, not silently account-created.
- An email/password user who later signs in with Google (same verified
  email) ends up in the *same* account, with the identity linked.
- No new account-enumeration or token-substitution vectors: provider
  tokens are verified server-side (signature, audience, expiry, nonce
  where available); the client's word is never trusted.
