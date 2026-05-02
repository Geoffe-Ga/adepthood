# SPEC — Password Recovery for Adepthood

> A self-contained, prompt-engineered specification for the engineer (human or
> agent) who will implement password recovery end-to-end. Authored against
> Adepthood's existing FastAPI + React Native auth stack and the codebase
> conventions in `CLAUDE.md` and `AGENTS.md`. Reading order: **Role → Goal →
> Context → Output Format → Examples → Requirements**.

---

## Role

You are a **senior full-stack security engineer** with deep expertise in:

- OWASP ASVS v4.0 §2 (Authentication) and §3 (Session Management).
- NIST SP 800-63B identity-proofing and credential-recovery guidance.
- Production password-reset flows on FastAPI + SQLModel (async, Alembic).
- React Native + Expo deep-linking (`expo-linking`) and accessible UX.
- Anti-enumeration, anti-abuse, and constant-time response patterns.

You write code that respects Adepthood's conventions: TDD-first, small atomic
commits, conventional-commit messages, pre-commit gates green before push, and
no suppressions of the linter, type-checker, or coverage thresholds.

---

## Goal

Design and ship a **password recovery feature** that is *better than
world-class* and **integrates seamlessly** with the existing auth flow
(`backend/src/routers/auth.py`, `frontend/src/features/Auth/*`,
`frontend/src/context/AuthContext.tsx`).

A user who has forgotten their password must be able to:

1. Request a reset by email from the Login screen.
2. Receive a single-use, time-limited link.
3. Set a new password by following that link inside the Adepthood app.
4. Be logged in on the device that completed the reset, with **all other
   sessions invalidated** (every outstanding JWT for that user revoked).
5. Receive an out-of-band notification of the change with a one-click
   "this wasn't me" lockout, regardless of which path was used.

**Success criteria — definition of done:**

- Backend: 3 new endpoints, 1 new SQLModel table, 1 Alembic migration,
  pluggable email-sender service, ≥ 90 % line / 80 % branch coverage on
  changed files, ruff `select=ALL` green, mypy strict green, bandit clean,
  zero `# noqa` / `# type: ignore` introduced.
- Frontend: 2 new screens, 1 deep-link handler, AuthContext extension,
  jest coverage ≥ 90 % on changed files, `npx tsc --noEmit` clean,
  ESLint clean (sonarjs + unicorn).
- Security: anti-enumeration verified by timing test; tokens never stored
  in plaintext; reset completion revokes all sessions; rate-limit shown to
  reject the documented abuse cases.
- UX: a user who taps "Forgot password" on Login can complete the flow on
  a single device in ≤ 3 screens with one email round-trip; the same
  email link cannot be replayed; expired links surface a clear retry path.

---

## Context

### Current auth surface (read these before designing)

| Concern                | File / symbol                                                      | Notes                                                                                     |
| ---------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Login + signup + refresh | `backend/src/routers/auth.py`                                    | Anti-enumeration, lockout, jti revocation, bcrypt-12, EmailStr normalization.             |
| User model             | `backend/src/models/user.py`                                       | `email_verified`, `is_active`, `deleted_at`, `timezone`, `password_hash` (no default).    |
| Token revocation       | `backend/src/models/revoked_token.py`                              | `jti`-keyed; reused by `/auth/refresh` and required by this spec for "log out everywhere". |
| Login attempts audit   | `backend/src/models/login_attempt.py`                              | Pattern to mirror for reset-attempt audit.                                                |
| Rate limiter           | `backend/src/rate_limit.py` (slowapi, IP keyed)                    | Used by `/auth/*`. Reset endpoints must declare per-route limits.                         |
| Frontend auth state    | `frontend/src/context/AuthContext.tsx`                             | Explicit `loading | authenticated | reauth-required | anonymous` state machine.           |
| Login UI               | `frontend/src/features/Auth/LoginScreen.tsx`                       | Plain RN; design tokens via `@/design/tokens`. "Forgot password?" link goes here.         |
| Auth stack             | `frontend/src/App.tsx` (`AuthStack`)                               | `Login` and `Signup` screens; we will add `ForgotPassword` and `ResetPassword`.           |
| API client             | `frontend/src/api/index.ts` (`auth = { login, signup, refresh }`)  | Extend with `requestReset`, `confirmReset`, `cancelReset`.                                |
| Token storage          | `frontend/src/storage/authStorage.ts`                              | `expo-secure-store`. Reset must NOT touch storage until success.                          |

### Known constraints & gotchas

- **bcrypt 72-byte cap** is enforced at signup (`_BCRYPT_MAX_PASSWORD_BYTES`)
  — reuse the same `_hash_password` helper, do not duplicate it.
- **EmailStr normalization** (lower-case + strip) lives in
  `AuthRequest._normalize_email`. The reset request schema must apply the
  same validator.
- **No email-sending infrastructure exists today.** `grep -r "smtp\|sendgrid"`
  returns nothing. You must introduce a small `EmailSender` port with a
  `console` adapter for dev/test and an SMTP adapter behind a feature flag.
- **SECRET_KEY environment variable** is mandatory in prod (see
  `_get_secret_key`); the reset-token signing reuses it via HMAC, not a new
  secret, so deploys do not need a second key rotation.
- **SQLite is the test DB**, PostgreSQL is prod (see `_acquire_email_lock_pg`).
  Any reset-flow concurrency primitives must be no-ops on SQLite.
- **`_login_locks` per-email asyncio lock** (`auth.py:349`) is the model to
  follow if reset-confirm needs serialization.
- **Branch:** all work goes on `claude/add-password-recovery-Y3TEW`.
  Conventional-commit messages, atomic commits.

### Out of scope (call them out, don't implement)

- TOTP / WebAuthn passkey recovery (future epic).
- Account-recovery via security questions (rejected — NIST deprecates them).
- Admin-initiated forced reset UI (covered separately by admin epic).
- Localization of email copy beyond US-English (i18n is its own epic).

---

## Output Format

Produce the implementation in this order, each step its own commit. The
commit message prefix appears in parentheses.

1. **Plan ratification** *(no commit)* — open the spec, confirm scope, list
   any deviations as inline TODO comments in the PR description.
2. **Data model** *(`feat(backend)`)* — `PasswordResetToken` SQLModel +
   Alembic migration. Columns enumerated below in §Examples.
3. **Email port + adapter** *(`feat(backend)`)* — `services/email.py` with
   `EmailSender` Protocol, `ConsoleEmailSender`, and an `SmtpEmailSender`
   gated by `EMAIL_BACKEND` env. Factory bound via FastAPI dependency.
4. **Reset endpoints** *(`feat(backend)`)* — `POST /auth/password-reset/request`,
   `POST /auth/password-reset/confirm`, `POST /auth/password-reset/cancel`.
   Schemas + tests + audit logging.
5. **Session revocation on reset** *(`feat(backend)`)* — extend `RevokedToken`
   write path so confirm revokes every active jti for the user (introduce
   a `User.password_changed_at` column or a `users_jti_floor` table —
   pick one and document the choice in the migration message).
6. **Rate limit + anti-enumeration tests** *(`test(backend)`)* — timing
   parity, identical-shape responses, per-IP + per-email caps.
7. **Frontend API client** *(`feat(frontend)`)* — extend `auth` in
   `frontend/src/api/index.ts` with the three new methods + zod schemas in
   `frontend/src/api/schemas.ts`.
8. **ForgotPasswordScreen** *(`feat(frontend)`)* — email field, submit,
   "check your inbox" success state, generic error copy.
9. **ResetPasswordScreen + deep link** *(`feat(frontend)`)* — handles
   `adepthood://reset-password?token=...`, validates the token shape
   client-side, posts to confirm, on success calls `AuthContext.login`'s
   internal token-apply path (extract a `applyAuthResponse` helper) so the
   user lands authenticated.
10. **Auth stack wiring** *(`feat(frontend)`)* — register the screens,
    add the "Forgot password?" link to `LoginScreen`, expose the deep-link
    intent via `expo-linking`.
11. **End-to-end test suite** *(`test`)* — backend pytest E2E + frontend
    jest integration test driving Login → Forgot → Reset → Authenticated.
12. **Docs** *(`docs`)* — append a "Password recovery" section to
    `DEPLOYMENT.md` (env vars, SMTP setup) and a runbook stub at
    `plans/RECOVERY-RUNBOOK.md`.

Each commit must pass `pre-commit run --all-files` and `pytest` + `npm test`
locally before push. PR description links to this SPEC and the spawning
issue (to be filed as `prompts/github-issues/phase-2-08-password-recovery.md`).

---

## Examples

### Example A — Reset token table (SQLModel)

```python
# backend/src/models/password_reset_token.py
class PasswordResetToken(SQLModel, table=True):
    """Single-use, time-limited credential-recovery token.

    The plaintext token is emailed to the user and NEVER stored. We persist
    a bcrypt digest (cost 10 — these are 256-bit randoms, not human input,
    so cost-12 is wasted). On confirm the digest is recomputed and matched
    in constant time. Rows live for the TTL window plus a 7-day audit tail
    so abuse investigation can replay the trail; a periodic cleanup job
    (out of scope here, mirror the RevokedToken cleanup) prunes old rows.
    """

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True, nullable=False)
    token_hash: str = Field(nullable=False)        # bcrypt(token), never the raw value
    requested_ip: str = Field(max_length=64)       # X-Forwarded-For aware, ::1 fallback
    requested_user_agent: str = Field(max_length=256, default="")
    expires_at: datetime                           # UTC, TTL = 30 min
    used_at: datetime | None = Field(default=None) # null until confirm
    cancelled_at: datetime | None = Field(default=None)  # set by cancel link
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
```

### Example B — Request endpoint (anti-enumeration shape)

```python
@router.post("/password-reset/request", status_code=status.HTTP_202_ACCEPTED)
@limiter.limit("3/hour")  # per-IP; per-email cap enforced inside the handler
async def request_password_reset(
    request: Request,
    payload: PasswordResetRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
    sender: Annotated[EmailSender, Depends(get_email_sender)],
) -> PasswordResetAccepted:
    """Always returns 202 with the same body shape, regardless of whether
    the email is registered. The work — token mint + email send — happens
    only when a matching active user is found. Timing is held constant by
    a fixed-cost dummy bcrypt hash on the no-user branch."""
    ...
    return PasswordResetAccepted(
        message="If an account exists for that address, a reset link has been sent.",
    )
```

### Example C — Frontend deep link

```ts
// frontend/src/navigation/linking.ts
export const linking: LinkingOptions<AuthStackParamList> = {
  prefixes: ['adepthood://', 'https://app.adepthood.example/'],
  config: {
    screens: {
      Login: 'login',
      Signup: 'signup',
      ForgotPassword: 'forgot-password', // pragma: allowlist secret
      ResetPassword: 'reset-password', // pragma: allowlist secret  (expects ?token=...)
    },
  },
};
```

### Example D — "This wasn't me" cancel link

The reset email contains two URLs:

```
Reset your password:  adepthood://reset-password?token=<plaintext-token>
This wasn't me:       adepthood://cancel-reset?token=<plaintext-token>
```

Tapping the second URL hits `POST /auth/password-reset/cancel`, which marks
the row `cancelled_at = now()`, refuses any subsequent confirm, and writes
an `auth_reset_cancelled` audit log line. No login required — possessing
the token is sufficient because that's the same trust model as confirm.

---

## Requirements

### Security (non-negotiable)

- **R1.** Plaintext reset tokens are 256-bit `secrets.token_urlsafe(32)`
  values. Stored only as bcrypt digest. Never logged, never returned by
  any endpoint after issuance.
- **R2.** Token TTL = **30 minutes**. Configured via constant
  `_PASSWORD_RESET_TTL` next to `_TOKEN_TTL` in `auth.py` for visual
  parity. Document the choice (long enough for slow inboxes, short enough
  to bound exposure if the link leaks via screenshot or shoulder surf).
- **R3.** **Single-use.** `used_at IS NOT NULL` ⇒ confirm rejects with
  generic 400. Cancellation (`cancelled_at`) likewise.
- **R4.** **Anti-enumeration.** `request` returns 202 with identical body
  on hit and miss. Add a constant-time bcrypt computation on miss to
  match hit-path latency within ±50 ms (verified by a timing test using
  `pytest-benchmark` or a hand-rolled paired-sample assertion).
- **R5.** **Rate limits.** Per-IP: 3/hour on request, 5/hour on confirm.
  Per-email: 3 active outstanding tokens max — exceeding it causes the
  oldest to be auto-cancelled; the response is still 202 to preserve R4.
- **R6.** **Lockout interaction.** A successful reset clears the
  `LoginAttempt` lockout window for that email — the user is presumed to
  have proven identity via email possession.
- **R7.** **Session invalidation on confirm.** Pick one mechanism and
  document it in the Alembic migration:
  - **Option α (preferred):** add `User.password_changed_at: datetime`,
    update on confirm, and add a check in `_decode_token_payload` that
    rejects tokens whose `iat` < `password_changed_at`.
  - **Option β:** insert a `RevokedToken` row for every outstanding jti
    via a join against `LoginAttempt`. Heavier but no schema change.
  Use α unless you have a specific reason. Justify in the PR.
- **R8.** **Out-of-band notification.** On *every* successful confirm,
  send a "Your Adepthood password was changed" email to the registered
  address with a "this wasn't me" link that re-runs the reset flow and
  freezes the account (`is_active = False`). This is the "better than
  world-class" delta — most flows skip it.
- **R9.** **No PII in logs.** Reuse `_email_log_fingerprint`. Reset-token
  log lines carry the fingerprint, IP, action, and a `request_id`
  correlation hash — never the raw email or token.
- **R10.** **Password rules** unchanged. Min 8 / max 64 chars / ≤ 72 bytes,
  enforced via the existing pydantic field on `PasswordResetConfirm`.
  Reject reuse of the *current* password (compare via `_verify_password`
  on the stored hash before re-hashing) — surface as 422 with detail
  `password_unchanged`. We do not store password history beyond that.

### API contract

| Method | Path                              | Auth | Rate     | Body                                               | 2xx                                       |
| ------ | --------------------------------- | ---- | -------- | -------------------------------------------------- | ----------------------------------------- |
| POST   | `/auth/password-reset/request`    | none | 3/hour   | `{ email }`                                        | 202 `{ message }`                         |
| POST   | `/auth/password-reset/confirm`    | none | 5/hour   | `{ token, new_password }`                          | 200 `AuthResponse` (logged in on this device) |
| POST   | `/auth/password-reset/cancel`     | none | 10/hour  | `{ token }`                                        | 204                                       |

All failures: 400 / 422 with the existing `errors.bad_request` envelope.
401 is reserved for token-bound auth and not used here.

### Backend code organization

- New router module **NOT** required — extend `backend/src/routers/auth.py`.
  Use private `_` helpers; keep public surface minimal. Watch the xenon A-rank
  cap: split into `_request_reset_internal`, `_confirm_reset_internal`, etc.,
  matching the style around `_verify_login_or_raise`.
- Email port lives in `backend/src/services/email.py`. Inject via
  `Depends(get_email_sender)` so tests can substitute a recording fake.
- Schemas in `backend/src/schemas/password_reset.py`. EmailStr,
  password constraints, token format `Annotated[str, Field(min_length=32, max_length=128)]`.
- Migration filename: `<rev>_add_password_reset_token_and_password_changed_at.py`,
  one revision adding both objects. Down-migration must drop both cleanly.

### Frontend code organization

- New screens at `frontend/src/features/Auth/ForgotPasswordScreen.tsx` and
  `ResetPasswordScreen.tsx`. Mirror `LoginScreen` styling/tokens; do not
  introduce new design primitives.
- Extract `applyAuthResponse(response)` from `useAuthActions` so the reset
  success path can re-use the persistence-then-state ordering without
  duplicating the BUG-AUTH-005 contract. Add a unit test for the helper.
- Deep-link config at `frontend/src/navigation/linking.ts`; wire into
  `NavigationContainer` in `App.tsx`.
- Zod schemas live in `frontend/src/api/schemas.ts` next to
  `authResponseSchema`. Reuse `authResponseSchema` for confirm's response.

### Testing

- Backend: pytest async, table-driven for the request endpoint covering
  (registered active, registered inactive, deleted, unknown, malformed).
  Confirm endpoint: (valid, expired, used, cancelled, wrong-token,
  reused-password). Plus the timing-parity test (R4) and the
  session-invalidation test (R7).
- Frontend: jest + RTL for both screens. Mock `auth.requestReset` etc.
  Cover happy path, expired-token error, network failure, accessibility
  labels (every interactive element gets `accessibilityLabel`).
- E2E: a single integration test that drives Login → tap Forgot →
  submit email → simulate deep link → submit new password → assert
  authenticated state and stored token.

### Operational

- `EMAIL_BACKEND` env: `console` (default in dev/test), `smtp` (prod).
  SMTP adapter reads `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`,
  `SMTP_PASSWORD`, `EMAIL_FROM`. All mandatory in prod via
  `_get_*` accessors that raise on missing.
- The console adapter logs the rendered email at INFO level **with the
  raw token redacted to its first 8 chars** so a developer can copy the
  link from terminal output without committing a real-world disclosure
  pattern. Tests record full payload via the recording fake, never via
  log scraping.
- Alembic migration: write the down-migration, write the test that
  round-trips up→down→up against SQLite, and dry-run on Postgres
  per `DEPLOYMENT.md`.

### Forbidden

- Do **not** add a "security questions" fallback.
- Do **not** add SMS or magic-link login under cover of this work.
- Do **not** weaken the bcrypt cost, password length bounds, or the
  EmailStr normalization rules.
- Do **not** introduce a second JWT secret or separate signing key.
- Do **not** suppress lint, type, coverage, or complexity gates with
  `# noqa`, `# type: ignore`, `// eslint-disable`, `// @ts-ignore`,
  `--cov-fail-under` overrides, or xenon `--exclude` flags.
- Do **not** `git push --force` or `--no-verify` for any reason.

---

## Open questions for review before implementation

1. **Schema choice for "log out everywhere":** option α (`password_changed_at`)
   vs. option β (bulk `RevokedToken` insert). Spec recommends α; confirm.
2. **Email provider:** the SMTP adapter is the MVP. Do we want a
   `SendGridEmailSender` adapter in the same PR, or land that as a
   follow-up once an account exists?
3. **Cancel endpoint UX:** should tapping "this wasn't me" also force
   `is_active = False` (account freeze, recoverable by admin) or just
   cancel that one token? Spec proposes the freeze for the
   *post-confirm* notification (R8) but only token cancellation for the
   *pre-confirm* notification (Example D) — confirm.
4. **Universal links vs. custom scheme:** `adepthood://` is fine for
   internal testing but does not survive being copy-pasted into a desktop
   browser. Do we register `https://app.adepthood.example/...` now or
   defer until a public domain exists?

Resolve these in the issue thread, link the resolutions back into this
spec via PR description, and proceed.
