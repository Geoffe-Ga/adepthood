# social-auth-02: Backend — Apple sign-in endpoint

**Labels:** `feature`, `backend`, `epic:social-auth`, `priority-high`,
`parallelizable`
**Epic:** [Social auth](social-auth-epic.md)
**Depends on:** social-auth-01 (AuthIdentity model + shared JWKS verify
core). Parallelizable with social-auth-03 (frontend, disjoint files).
**Estimated LoC:** ~250–350 (including tests)

## Problem

social-auth-01 lands Google. Apple's App Store guideline 4.8 makes Sign
in with Apple mandatory once any third-party social login ships on iOS,
and Apple users expect it anyway. The backend needs
`POST /auth/oauth/apple` with Apple-specific verification quirks
handled.

## Scope

### 1. Apple token verification (`backend/src/services/oauth_apple.py`)

- Reuse the JWKS-verification core from `oauth_google.py`
  (social-auth-01 was built to share it) with Apple parameters:
  JWKS from `https://appleid.apple.com/auth/keys`, `iss ==
  "https://appleid.apple.com"`, `aud` in `APPLE_OAUTH_CLIENT_IDS`
  (comma-separated: the iOS bundle ID, plus a Services ID if web login
  is ever added).
- Apple quirks to handle explicitly:
  - `email` may be a **private relay** address
    (`@privaterelay.appleid.com`) — treat it as a normal verified email
    (it receives forwarded mail); never special-case it away.
  - `email_verified` may arrive as the string `"true"` rather than a
    boolean — normalize.
  - The user's **name is never in the identity token** — it is provided
    by the client only on first authorization. Accept an optional
    `full_name` field in the request body and store it only when
    creating a new `User`; ignore it on subsequent logins (never let the
    client rename an existing account).

### 2. Endpoint `POST /auth/oauth/apple` (`backend/src/routers/auth.py`)

- Request: `{ "id_token": str, "license_key": str | None,
  "full_name": str | None, "timezone": str | None }`.
- Identical resolution ladder to `POST /auth/oauth/google`
  (identity → verified-email link → license-gated create → 409
  `needs_license`), sharing the same handler internals — extract a
  common `_resolve_oauth_user(...)` helper rather than copy-pasting.
- Same rate limiting and `reason_code` structured logging.

### 3. Config

- `APPLE_OAUTH_CLIENT_IDS` env var; document in `backend/.env.example`
  and `README.md`.

### 4. Tests (`backend/tests/routers/test_oauth_apple.py`)

Mocked JWKS (same stub pattern as social-auth-01's tests):

- Existing identity → JWT.
- Private-relay email, no account, valid license → account created with
  the relay email.
- `email_verified: "true"` (string) → treated as verified.
- `full_name` honored on create, ignored on an existing account.
- Wrong audience / expired → 401.
- No account, no license → 409 `needs_license`.

## Acceptance criteria

- Apple and Google endpoints share the resolution helper — one ladder,
  two thin provider adapters.
- All Apple quirks above are covered by tests; coverage ≥ 90% on new
  files.

## Files to create / modify

| File | Action |
|------|--------|
| `backend/src/services/oauth_apple.py` | Create |
| `backend/src/services/oauth_google.py` | Modify (extract shared core if not already) |
| `backend/src/routers/auth.py` | Modify (endpoint + shared resolver) |
| `backend/.env.example` | Modify |
| `backend/tests/routers/test_oauth_apple.py` | Create |

## Notes for implementer

- Do not add an Apple client-secret / token-exchange flow — the app
  sends the identity token directly; no server-to-Apple round trip is
  needed for verification beyond fetching JWKS.
- A user may hold both a Google and an Apple identity for one account —
  the `(provider, subject)` uniqueness already allows this; add a test.
