# social-auth-01: Backend — AuthIdentity model + Google sign-in endpoint

**Labels:** `feature`, `backend`, `epic:social-auth`, `priority-high`
**Epic:** [Social auth](social-auth-epic.md)
**Depends on:** phase-6-02 (license-gated signup) for the create-account
path's gate
**Estimated LoC:** ~400–500 (including tests)

## Problem

`backend/src/routers/auth.py` supports only email/password. Users want
one-tap Google sign-in; the backend needs an endpoint that accepts a
Google-issued ID token, verifies it cryptographically, and resolves it
to an Adepthood account + JWT — respecting the Gumroad license gate for
first-time accounts.

## Scope

### 1. `AuthIdentity` model (`backend/src/models/auth_identity.py`)

- Fields: `id`, `user_id` (FK → `user.id`, indexed), `provider` (enum
  string: `google`, `apple`), `subject` (provider's stable user ID —
  Google `sub` claim), `email_at_link_time` (informational), `created_at`.
- Unique constraint on `(provider, subject)`.
- Alembic migration.

### 2. Google token verification (`backend/src/services/oauth_google.py`)

- Verify the incoming ID token: signature against Google's JWKS
  (cache keys with sane TTL), `iss` in
  `{"https://accounts.google.com", "accounts.google.com"}`, `aud` in
  the `GOOGLE_OAUTH_CLIENT_IDS` env allowlist (comma-separated — Expo
  apps have distinct iOS / Android / web client IDs), `exp` in future.
- Use `PyJWT` with `PyJWKClient` (already a dependency for our own JWTs)
  — no new heavyweight deps.
- Return a typed result: `subject`, `email`, `email_verified`, `name?`.
- Never log the raw token.

### 3. Endpoint `POST /auth/oauth/google` (`backend/src/routers/auth.py`)

Request: `{ "id_token": str, "license_key": str | None }`. Resolution
order:

1. Verify token (step 2). Invalid → 401 `invalid_oauth_token` (generic).
2. `AuthIdentity(provider="google", subject)` exists → issue JWT via the
   existing `_create_token` path. Done.
3. Else, if `email_verified` and a `User` with that email (case-
   insensitive) exists → create the `AuthIdentity` linking to that user,
   issue JWT. (Provider-verified email is the linking proof; mirrors the
   trust model of password reset by email.)
4. Else (no account): require the Gumroad license gate exactly as
   phase-6-02's signup does — if `license_key` absent or invalid →
   409 `needs_license` (a distinct, non-enumerating error the frontend
   maps to the Gumroad onboarding step). If valid → create `User` (email
   from token; `password_hash` set to a random unusable bcrypt hash;
   timezone from optional `timezone` field mirroring signup), create
   `Entitlement` + `AuthIdentity`, issue JWT.
- Rate limit: same `slowapi` tier as login (`5/minute` or existing
  convention in the file).
- Structured logging with `reason_code` on every path
  (`oauth_login`, `oauth_linked`, `oauth_needs_license`,
  `oauth_signup`), matching the file's existing conventions.

### 4. Config

- `GOOGLE_OAUTH_CLIENT_IDS` env var; document in `backend/.env.example`
  and `README.md`. Fail fast at startup if unset in production only when
  the endpoint is enabled (follow the pattern used for other optional
  integrations).

### 5. Tests (`backend/tests/routers/test_oauth_google.py`)

All with mocked JWKS/tokens (generate an RSA keypair in the test,
serve its JWKS via a stub — never hit Google):

- Valid token, existing identity → 200 + JWT.
- Valid token, no identity, existing verified-email user → identity row
  created, same `user_id`, JWT issued.
- Valid token, unverified email, existing same-email user → NOT linked
  (409 `needs_license` path), no identity row.
- Valid token, no account, no license → 409 `needs_license`.
- Valid token, no account, valid license (mocked Gumroad) → 201-style
  success, user + entitlement + identity rows.
- Wrong audience / expired / bad signature → 401, no rows written.
- Replay of the same token after account creation → resolves via
  identity (idempotent).

## Acceptance criteria

- All resolution paths above behave and are covered ≥ 90%.
- Password login for a social-only account fails exactly like a wrong
  password (no oracle that the account is passwordless).
- No new dependency beyond what `PyJWT` already provides (if `PyJWKClient`
  needs the `cryptography` extra, it is already present for HS256/bcrypt
  stack — verify, don't assume).

## Files to create / modify

| File | Action |
|------|--------|
| `backend/src/models/auth_identity.py` | Create |
| `backend/src/services/oauth_google.py` | Create |
| `backend/src/routers/auth.py` | Modify (new endpoint) |
| `backend/alembic/versions/xxxx_auth_identity.py` | Create |
| `backend/.env.example` | Modify |
| `backend/tests/routers/test_oauth_google.py` | Create |

## Notes for implementer

- Keep the anti-enumeration discipline of this file: the 409
  `needs_license` response must be identical whether the email is new or
  belongs to an unverified-email collision.
- Reuse phase-6-02's license-verification domain helper — do not
  reimplement Gumroad calls here.
- Design `oauth_google.py` so social-auth-02 can share the JWKS-verify
  core with an Apple-specific issuer/audience config.
