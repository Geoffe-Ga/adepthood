# Auth, Signup, Login — Bug Remediation Report

**Component:** Backend auth subsystem — signup, login, refresh, JWT, lockout, schemas
**Date:** 2026-04-18
**Auditor:** Claude Code (self-review)
**Branch:** `claude/code-review-bug-analysis-WCNGL`

## Executive Summary

You can sign up but cannot log in, and you've hit ~10 bugs. The single most likely cause of the "I signed up but can't log in" symptom lives in this report: **BUG-AUTH-001 / BUG-AUTH-002 / BUG-AUTH-016** — the duplicate-email signup path returns a successful-looking 200 with a dummy JWT and `user_id=0`. If you accidentally re-submit signup with the same email (a double-tap, a navigation back-and-resubmit, or a retry after a network blip), the frontend stores a token that will fail every subsequent request. From the user's POV: signup "worked", they're on the home screen for a moment, and then everything 401s. There is no UI affordance to escape this state because the response is shaped exactly like success.

Beyond that, the auth subsystem has accumulated debt across four bands: (1) a duplicate-handling design flaw that simultaneously fails to prevent enumeration (`user_id=0` is a literal oracle) and breaks the user (no recovery path) — see BUG-AUTH-001, 002, 016; (2) brute-force protection that's load-bearing on a TOCTOU race and a header-spoofable IP source, with audit gaps once lockout fires — BUG-AUTH-006, 007, 008; (3) JWT lifecycle holes — no startup validation of `SECRET_KEY`, no token revocation, no `jti`, malformed `sub` claims crash to 500 — BUG-AUTH-011, 012, 013; (4) schema/contract weaknesses where validation lives in handler bodies instead of on the Pydantic model, opening DoS vectors and silent bcrypt truncation surprises — BUG-AUTH-004, 005, 017, 018.

Total: **19 bugs** (4 Critical, 8 High, 6 Medium, 1 Low). Fix the duplicate-signup contract first; that's the door blocking you.

## Table of Contents

| # | Severity | Title |
|---|---|---|
| BUG-AUTH-001 | Critical | Duplicate-email signup returns fake 200 with unusable dummy token |
| BUG-AUTH-002 | High | Account enumeration via `user_id=0` sentinel |
| BUG-AUTH-003 | High | Race condition allows two accounts with the same email |
| BUG-AUTH-004 | High | bcrypt silently truncates passwords longer than 72 bytes |
| BUG-AUTH-005 | Medium | Password length validation lives in the handler, not on the schema |
| BUG-AUTH-006 | High | Locked-account path skips `_record_attempt`, blinding the audit trail |
| BUG-AUTH-007 | High | TOCTOU race in `_is_account_locked` bypasses the lockout threshold |
| BUG-AUTH-008 | Critical | `_get_client_ip` blindly trusts `X-Forwarded-For` (spoof / frame) |
| BUG-AUTH-009 | Medium | `LoginAttempt` lacks composite `(email, created_at)` index and retention |
| BUG-AUTH-010 | Medium | `_record_attempt` commits mid-request, fragmenting the login transaction |
| BUG-AUTH-011 | Critical | `SECRET_KEY` misconfiguration only detected on first auth request |
| BUG-AUTH-012 | High | `get_current_user` raises 500 on malformed `sub` claim instead of 401 |
| BUG-AUTH-013 | High | Refresh issues a new token without invalidating the old (no jti, no revocation) |
| BUG-AUTH-014 | Medium | Refresh rate limit `1/minute` keyed by IP starves NAT'd mobile users |
| BUG-AUTH-015 | Medium | Hardcoded TTL, bcrypt rounds, and lockout — no operational tuning |
| BUG-AUTH-016 | Critical | Dummy `user_id=0` accepted by client and Zod schema, indistinguishable from a real account |
| BUG-AUTH-017 | High | `AuthRequest.password` has no length bounds at the schema layer |
| BUG-AUTH-018 | High | `User.password_hash` defaults to empty string, allowing password-less accounts |
| BUG-AUTH-019 | Medium | `_normalize_email` strips whitespace-only input to `""`, producing a confusing 422 |

---

### BUG-AUTH-001: Duplicate-email signup returns fake 200 with unusable dummy token
**Severity:** Critical
**Component:** `backend/src/routers/auth.py:200-208`
**Symptom:** When a user tries to sign up with an email that already exists, the API returns HTTP 200 with `user_id=0` and a dummy token. The frontend treats this as a successful signup, persists the bogus JWT in `AuthContext`/AsyncStorage, and then every subsequent authenticated request 401s with no clear way for the user to recover. The user thinks they have an account but cannot log in.
**Root cause:**
```python
if result.scalars().first() is not None:
    _hash_password(payload.password)
    # Return an identical response shape to prevent account enumeration.
    # The dummy token is signed with a random key and will fail validation,
    # so it cannot be used to access the existing account.
    return AuthResponse(token=_create_dummy_token(), user_id=0)
```
The response shape is indistinguishable from success, so the client has no signal to branch on. "Returning a token that fails every later request" is worse than a clean error — it silently breaks the entire authenticated session.

**Fix:** Return HTTP 409 Conflict (or 400 with a generic `email_unavailable` code) for duplicates. To preserve timing parity, still call `_hash_password(payload.password)` before raising. The frontend already knows how to render a "this email is taken / try logging in" state for non-2xx responses — give it the chance.

---

### BUG-AUTH-002: Account enumeration via `user_id=0` sentinel
**Severity:** High
**Component:** `backend/src/routers/auth.py:208`
**Symptom:** The duplicate-email branch returns `user_id=0` while a real signup returns the actual primary key (always >= 1). An attacker can send `POST /auth/signup` with a candidate email and trivially distinguish "email exists" (user_id == 0) from "email is new" (user_id > 0), defeating the entire purpose of the timing-equalization and dummy-token machinery directly above it.
**Root cause:**
```python
return AuthResponse(token=_create_dummy_token(), user_id=0)
# vs. for a real signup a few lines below:
return AuthResponse(token=token, user_id=user.id)
```
The code comment claims "identical response shape to prevent account enumeration," but the literal `0` sentinel is the enumeration oracle.

**Fix:** Stop overloading `AuthResponse` for the duplicate case. Combined with BUG-AUTH-001, raise a 409 instead. If a 200 must be returned for some compatibility reason, return a randomized fake `user_id` from a large space (e.g. `secrets.randbelow(10**9) + 10**9`) that is disjoint from real ids — but raising 409 is the correct fix.

---

### BUG-AUTH-003: Race condition allows two accounts with the same email
**Severity:** High
**Component:** `backend/src/routers/auth.py:199-216`
**Symptom:** Two concurrent signup requests for the same email both pass the `select` check (neither sees the other's row yet), both proceed to `INSERT`, and one of two things happens: (a) the DB unique constraint on `User.email` raises `IntegrityError` and the second request 500s with an unhandled exception leaking a stack trace, or (b) under a weaker isolation level/missing constraint, two user rows for the same email get committed and subsequent logins become non-deterministic.
**Root cause:**
```python
result = await session.execute(select(User).where(User.email == payload.email))
if result.scalars().first() is not None:
    ...
user = User(email=payload.email, password_hash=_hash_password(payload.password))
session.add(user)
await session.commit()
```
There is a TOCTOU window between the existence check and the commit; nothing serializes the two operations.

**Fix:** Rely on the `unique=True` constraint on `User.email` (already declared in `models/user.py:42`) as the source of truth. Wrap the `session.add` / `session.commit` in `try/except IntegrityError`, roll back the session, and return the same 409 path used for the synchronous duplicate case. Drop the pre-check `select` or keep it only as an optimization — never as the authority.

---

### BUG-AUTH-004: bcrypt silently truncates passwords longer than 72 bytes
**Severity:** High
**Component:** `backend/src/routers/auth.py:92-97, 197`
**Symptom:** A user signs up with a long passphrase (e.g. a 90-character diceware string or a password manager 100-char random string). bcrypt silently truncates the input to the first 72 bytes before hashing. The user believes their full passphrase is protecting the account; in reality only the prefix matters, and any password sharing that 72-byte prefix will authenticate. Multi-byte UTF-8 (emoji, CJK) makes the cut-off point even more surprising.
**Root cause:**
```python
_MIN_PASSWORD_LENGTH = 8
# ...
if len(payload.password) < _MIN_PASSWORD_LENGTH:
    raise bad_request("password_too_short")
# ...
def _hash_password(password: str) -> str:
    hashed: bytes = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12))
    return hashed.decode("utf-8")
```
There is a minimum-length guard but no maximum, and no pre-hash to extend the effective input domain.

**Fix:** Either (a) reject passwords whose UTF-8 encoding exceeds 72 bytes with `password_too_long`, or preferably (b) pre-hash with SHA-256 then base64-encode before bcrypt: `bcrypt.hashpw(base64.b64encode(hashlib.sha256(password.encode()).digest()), bcrypt.gensalt(rounds=12))`. Option (b) preserves entropy for arbitrarily long passphrases. Apply the same change in `_verify_password` so existing hashes verify consistently — pick one and migrate.

---

### BUG-AUTH-005: Password length validation lives in the handler, not on the schema
**Severity:** Medium
**Component:** `backend/src/routers/auth.py:69-71, 197-198`
**Symptom:** The `_MIN_PASSWORD_LENGTH = 8` rule is enforced inside the `signup` function body, not on the `AuthRequest` Pydantic model. Result: (1) the OpenAPI schema advertises no password constraints, so the auto-generated frontend types and any third-party API consumers cannot see the rule; (2) the same rule is not applied at login or any future password-change endpoint, so policy drift is inevitable; (3) the error returned is a custom `bad_request("password_too_short")` instead of the standard 422 validation error shape, breaking client error-handling uniformity.
**Root cause:**
```python
class AuthRequest(BaseModel):
    email: EmailStr
    password: str
# ...
async def signup(...) -> AuthResponse:
    if len(payload.password) < _MIN_PASSWORD_LENGTH:
        raise bad_request("password_too_short")
```
Validation belongs at the boundary, on the DTO, where it is documented and reusable.

**Fix:** Move the constraint onto the model: `password: str = Field(min_length=_MIN_PASSWORD_LENGTH, max_length=128)` (the upper bound also helps with BUG-AUTH-004). Delete the in-handler check. If signup and login should accept different password constraints (e.g. login should not reject a user whose old password is shorter than today's minimum), introduce a separate `SignupRequest` model that subclasses or composes the shared base.

---
### BUG-AUTH-006: Locked-account path skips `_record_attempt`, blinding the audit trail
**Severity:** High
**Component:** `backend/src/routers/auth.py:233-244`
**Symptom:** Once an account is locked, every subsequent brute-force attempt against it is silently dropped from the `LoginAttempt` table. Only an `info`-level log line is emitted. Security operators querying the table to measure attack volume, identify attacker IPs, or extend the lockout window see zero activity for the duration of the attack — exactly when visibility matters most.
**Root cause:**
```python
if await _is_account_locked(session, payload.email):
    logger.info("auth_attempt_blocked", extra={...})
    # Return the same generic message to prevent account enumeration
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid_credentials")
```
The early-return short-circuits before any `_record_attempt(..., success=False)` call, so the database loses the record. Because the lockout window in `_is_account_locked` only inspects `MAX_FAILED_ATTEMPTS` rows, the lockout itself never extends either — an attacker can hammer indefinitely and the window will expire on schedule.

**Fix:** Call `await _record_attempt(session, payload.email, ip_address, success=False)` before raising in the locked branch. Optionally tag the row with a `blocked=True` column (or add a `reason` field) so analysts can distinguish "rejected because locked" from "rejected because bad password."

---

### BUG-AUTH-007: TOCTOU race in `_is_account_locked` — concurrent failures bypass the lockout threshold
**Severity:** High
**Component:** `backend/src/routers/auth.py:167-187`
**Symptom:** With `MAX_FAILED_ATTEMPTS = 5`, an attacker firing N parallel login requests can land more than 5 failures before any single request observes lockout, because every coroutine reads the table before any of them writes its failure row. The lockout becomes a soft cap rather than a hard one, materially weakening brute-force protection.
**Root cause:**
```python
cutoff = datetime.now(UTC) - LOCKOUT_DURATION
result = await session.execute(
    select(LoginAttempt)
    .where(LoginAttempt.email == email, LoginAttempt.created_at >= cutoff)
    .order_by(LoginAttempt.created_at.desc())
    .limit(MAX_FAILED_ATTEMPTS)
)
recent_attempts = result.scalars().all()
if len(recent_attempts) < MAX_FAILED_ATTEMPTS:
    return False
return all(not attempt.success for attempt in recent_attempts)
```
The check-then-act pattern uses no row locking, no advisory lock, and no unique constraint to serialize attempts. Each request reads stale state and proceeds to verify the password.

**Fix:** Serialize per-email lockout decisions. Either (a) acquire a Postgres advisory lock keyed on `hash(email)` for the duration of the login handler, (b) add a `users.failed_login_count` + `users.locked_until` column updated via `UPDATE ... RETURNING` so the increment is atomic, or (c) wrap the read+write in a `SERIALIZABLE` transaction and retry on serialization failure. Option (b) is simplest and removes the need to scan `LoginAttempt` on the hot path.

---

### BUG-AUTH-008: `_get_client_ip` blindly trusts `X-Forwarded-For` — IP spoofing for rate-limit bypass and victim lockout
**Severity:** Critical
**Component:** `backend/src/routers/auth.py:128-137`
**Symptom:** Any client can set `X-Forwarded-For: <anything>` and the value is used verbatim as `ip_address` for rate limiting (via slowapi keying), audit logs, and the `LoginAttempt.ip_address` column. An attacker can (1) rotate the header to defeat the `5/minute` rate limit and brute-force at line speed, and (2) plant a victim's real IP in lockout records to frame them or pollute investigations.
**Root cause:**
```python
def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        # First address in the chain is the original client
        return forwarded.split(",")[0].strip()
    client = request.client
    if client is not None:
        return client.host
    return "unknown"
```
There is no allowlist of trusted proxies, no parsing of the right-most untrusted hop, and no toggle to disable the header in environments without a reverse proxy. The header is honored unconditionally.

**Fix:** Introduce a `TRUSTED_PROXIES` setting (CIDR list). Only consult `X-Forwarded-For` when `request.client.host` is in that list, and then walk the chain right-to-left popping trusted hops to find the first untrusted address. When no proxy is configured, ignore the header entirely and fall back to `request.client.host`. Validate that extracted values parse as `ipaddress.ip_address(...)` before using them.

---

### BUG-AUTH-009: `LoginAttempt` lacks composite `(email, created_at DESC)` index and any retention policy
**Severity:** Medium
**Component:** `backend/src/models/login_attempt.py:17-24`
**Symptom:** The hot lockout query filters on `email` AND `created_at >= cutoff` and sorts by `created_at DESC`. Today only `email` is indexed, so Postgres uses the single-column index then sorts in memory. As traffic grows (and especially under brute-force load — see BUG-AUTH-006), the sort cost grows linearly per login. Worse, no purge job exists, so the table grows unbounded, eventually inflating index size, vacuum cost, and backup time.
**Root cause:**
```python
class LoginAttempt(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    email: str = Field(index=True)
    ip_address: str = Field(default="")
    success: bool = Field(default=False)
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(UTC),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
```
No composite index, no TTL, no partitioning. `email` is also stored in plaintext indefinitely, which is a privacy concern beyond the perf issue.

**Fix:** Add `__table_args__ = (Index("ix_login_attempt_email_created_at", "email", text("created_at DESC")),)` and drop the redundant single-column index on `email`. Ship an Alembic migration. Add a scheduled purge (e.g. APScheduler or a cron-driven script) that deletes rows older than `LOCKOUT_DURATION * 4` — keep enough history for audit, drop the rest. Consider hashing `email` at rest if regulatory scope expands.

---

### BUG-AUTH-010: `_record_attempt` commits mid-request, fragmenting the login transaction
**Severity:** Medium
**Component:** `backend/src/routers/auth.py:140-154`
**Symptom:** `_record_attempt` calls `session.commit()` directly. Because `get_session` yields a single session per request, this commit closes the surrounding transaction. Any subsequent ORM write in the same handler (today: none on the failure path; tomorrow: trivially easy to add — e.g. updating `users.last_failed_login`, bumping a counter, writing a security event) silently runs in its own implicit transaction with no atomicity guarantee relative to the attempt row. It also defeats `get_session`'s outer rollback-on-exception contract for anything after the commit point.
**Root cause:**
```python
async def _record_attempt(session, email, ip_address, *, success: bool) -> None:
    attempt = LoginAttempt(email=email, ip_address=ip_address, success=success)
    session.add(attempt)
    await session.commit()
    logger.info("auth_attempt", extra={...})
```
Helpers shouldn't decide transaction boundaries — that's the caller's job. Today the bug is latent; the moment someone adds a second write to the login handler it becomes a real consistency hole.

**Fix:** Replace `await session.commit()` with `await session.flush()` so the row is visible to subsequent queries within the same transaction but the commit is owned by the request boundary (`get_session`'s context manager or an explicit commit at the end of `login`). Update the two call sites in `login` to commit once, after the success/failure decision is fully recorded.

---
### BUG-AUTH-011: SECRET_KEY misconfiguration only detected on first auth request, not at startup
**Severity:** Critical
**Component:** `backend/src/routers/auth.py:28`
**Symptom:** App boots successfully with an empty or default `SECRET_KEY`. The first user that hits any authenticated endpoint (or `/login`, `/signup`) gets a 500 from an unhandled `RuntimeError`. Misconfigured deploys pass health checks and ship to prod.
**Root cause:**
```python
SECRET_KEY = os.getenv("SECRET_KEY", "")  # module import — never validated

def _get_secret_key() -> str:
    if not SECRET_KEY or SECRET_KEY == "replace-me":  # nosec B105  # pragma: allowlist secret
        msg = "SECRET_KEY environment variable must be set to a secure value"
        raise RuntimeError(msg)
    return SECRET_KEY
```
Validation is lazy. Worse, the rejection list is whitelist-of-one — values like `"test"`, `"secret"`, `"changeme"`, `"password"`, or any short string sail through. A 4-character secret produces signable HS256 tokens that are trivially brute-forceable offline.

**Fix:** Validate at import time (or in a FastAPI startup event) and enforce a minimum entropy/length (e.g. >= 32 chars, reject a hard-coded set of well-known weak values). Fail fast so misconfig surfaces in CI/deploy, not in the first user's session.

---

### BUG-AUTH-012: `get_current_user` raises 500 on malformed `sub` claim instead of 401
**Severity:** High
**Component:** `backend/src/routers/auth.py:280`
**Symptom:** A token with the correct signature but a missing or non-numeric `sub` (e.g. `sub="admin"`, `sub` omitted, `sub=null`) bypasses the 401 path and crashes with `KeyError`/`ValueError`, returning a 500 with a stack trace. Defeats the OWASP A07 uniform-response posture the docstring claims.
**Root cause:**
```python
try:
    payload = jwt.decode(token, _get_secret_key(), algorithms=[_JWT_ALGORITHM])
except jwt.PyJWTError as exc:
    ...
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, ...) from exc
return int(payload["sub"])  # KeyError or ValueError leaks past the try/except
```
The `int()` conversion and dict access happen outside the `try`. Only `jwt.PyJWTError` subclasses are caught; everything else becomes a 500 and leaks token-shape information through differential responses/log noise.

**Fix:** Move the `sub` extraction inside the `try` (or wrap in its own try) and catch `(KeyError, ValueError, TypeError)`, mapping each to the same 401 `unauthorized`. Also assert `payload.get("sub")` is a non-empty string before converting.

---

### BUG-AUTH-013: Refresh issues a new token without invalidating the old one (no jti, no revocation)
**Severity:** High
**Component:** `backend/src/routers/auth.py:283-296`
**Symptom:** Every `/refresh` call doubles the number of valid tokens for the user until the originals expire. A stolen token remains usable for the full TTL even after the legitimate user logs out or rotates. Logout is purely client-side; there is no server-side revocation list.
**Root cause:**
```python
def _create_token(user_id: int) -> str:
    payload = {"sub": str(user_id), "exp": ..., "iat": ...}
    # no "jti" claim — nothing to revoke against
    return str(jwt.encode(payload, _get_secret_key(), algorithm=_JWT_ALGORITHM))

@router.post("/refresh")
async def refresh_token(... user_id: int = Depends(get_current_user)):
    new_token = _create_token(user_id)  # old token still valid until exp
    return AuthResponse(token=new_token, user_id=user_id)
```
With no `jti` and no denylist table, there is no mechanism to invalidate either the previous token or any token after a credential compromise.

**Fix:** Add a `jti` (UUID4) claim on issuance. Maintain a server-side denylist (Redis or a `revoked_tokens` table keyed by `jti` with `exp` for TTL eviction). On `/refresh` and `/logout`, insert the presented token's `jti` into the denylist; `get_current_user` checks the denylist after signature verification.

---

### BUG-AUTH-014: Refresh rate limit `1/minute` keyed by IP starves NAT'd mobile users
**Severity:** Medium
**Component:** `backend/src/routers/auth.py:284`
**Symptom:** Carrier-grade NAT means many mobile clients share a public IP. A single user's proactive refresh + a silent 401 retry can collide with another user's refresh, returning 429 to legitimate users and forcing logouts. Even a single client doing background refresh + a re-login flow can self-DoS.
**Root cause:**
```python
@router.post("/refresh", response_model=AuthResponse)
@limiter.limit("1/minute")
async def refresh_token(
    request: Request,  # slowapi keys on request.client.host by default
    user_id: int = Depends(get_current_user),
) -> AuthResponse:
```
SlowAPI's default key is the remote IP, not the authenticated subject. With a 60s window and a single-shot quota, any concurrent refresh contends for the same bucket per public IP.

**Fix:** Key the limiter on `user_id` (e.g. `key_func=lambda req: str(req.state.user_id)`) once auth has resolved, and loosen the quota (e.g. `5/minute` per user) or use a leaky-bucket. Combine with token rotation (BUG-AUTH-013) so the old token covers the gap.

---

### BUG-AUTH-015: Hardcoded TTL, bcrypt rounds, and lockout — no operational tuning
**Severity:** Medium
**Component:** `backend/src/routers/auth.py:34-42, 96`
**Symptom:** Ops cannot rotate session length, raise bcrypt cost as hardware speeds up, or relax lockout during an incident without a code change + redeploy. Coupling these to the codebase also makes per-environment differentiation (dev vs prod) impossible.
**Root cause:**
```python
_TOKEN_TTL = timedelta(hours=1)
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_DURATION = timedelta(minutes=15)
...
hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12))
```
All four security-sensitive constants are inlined module-level literals with no env override and no central settings object.

**Fix:** Promote to a `Settings` (pydantic-settings) instance with env-backed fields: `JWT_TTL_MINUTES`, `BCRYPT_ROUNDS`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES`. Validate ranges (e.g. `BCRYPT_ROUNDS in 10..15`) at startup alongside the SECRET_KEY check from BUG-AUTH-011.

---
### BUG-AUTH-016: Dummy `user_id=0` is contractually accepted by both client and Zod schema, indistinguishable from a real account
**Severity:** Critical
**Component:** `backend/src/routers/auth.py:208` and `frontend/src/api/schemas.ts:55-62`
**Symptom:** When a user re-signs-up with an already-registered email, the backend returns a syntactically valid `AuthResponse(token=<dummy>, user_id=0)` to prevent enumeration. The frontend Zod schema explicitly allows `0` (`z.number().int().nonnegative()`), so the client persists the dummy `user_id=0` and a non-decodable token; subsequent authenticated calls fail opaquely (token never validates) and any UI keyed on `user.id` will render data for ghost user 0.
**Root cause:**
```python
# backend/src/routers/auth.py:208
return AuthResponse(token=_create_dummy_token(), user_id=0)
```
```ts
// frontend/src/api/schemas.ts:61
user_id: z.number().int().nonnegative(),  // 0 is allowed by design
```
The anti-enumeration response is intentional, but there is no out-of-band signal to the client that the response is a sentinel. The frontend accepts and stores it as if real, leading the user into an authenticated state that will silently fail on every subsequent call.

**Fix:** Either (a) tighten the Zod schema to `z.number().int().positive()` and have the signup screen detect the rejected response by attempting an immediate `/auth/refresh`, surfacing a generic "check your email" message on failure; or (b) keep the wire shape but have the frontend call `/auth/refresh` once after signup before persisting the token, treating a 401 as the duplicate-email case and clearing the stored credentials.

---

### BUG-AUTH-017: `AuthRequest.password` has no length bounds at the schema layer; validation lives only in the signup handler
**Severity:** High
**Component:** `backend/src/routers/auth.py:69-71` and `backend/src/routers/auth.py:197-198`
**Symptom:** `AuthRequest` declares `password: str` with no `min_length` or `max_length`. The 8-character minimum is enforced only inside `signup` via an explicit `if len(payload.password) < _MIN_PASSWORD_LENGTH`. `login` and `refresh` never check at all — meaning a 1 MB password sent to `/auth/login` is hashed with bcrypt (DoS), and there is no upper bound to protect against bcrypt's own 72-byte truncation surprise. The OpenAPI schema also misrepresents the contract to clients.
**Root cause:**
```python
class AuthRequest(BaseModel):
    email: EmailStr
    password: str   # no min_length, no max_length
```
Validation belongs at the schema boundary so it applies uniformly to every endpoint that consumes the model and is reflected in the generated OpenAPI/TypeScript types.

**Fix:** Move the constraint onto the field: `password: str = Field(min_length=8, max_length=72)`. Delete the in-handler `if len(payload.password) < _MIN_PASSWORD_LENGTH` check (Pydantic now returns a 422 with a structured error). The 72-byte cap matches bcrypt's effective input length and prevents DoS from oversized payloads.

---

### BUG-AUTH-018: `User.password_hash` defaults to empty string, allowing accidental creation of password-less accounts
**Severity:** High
**Component:** `backend/src/models/user.py:43`
**Symptom:** The ORM declaration `password_hash: str = Field(default="")` lets any code path that constructs `User(email=...)` without explicitly passing `password_hash` persist a row whose hash is `""`. `_verify_password("anything", "")` raises inside bcrypt, but a future refactor that catches that exception, or an admin/seed script that only sets the email, will silently create an account that can never be logged into — or worse, one that a buggy verifier treats as "matches anything".
**Root cause:**
```python
# backend/src/models/user.py:43
password_hash: str = Field(default="")
```
There is no business reason for a user to exist without a password hash; the default exists only to satisfy SQLModel's instantiation contract. The current signup happens to set it, but the type system does not enforce that invariant.

**Fix:** Drop the default and mark it required: `password_hash: str = Field(nullable=False)`. If SQLModel requires a sentinel for migrations, use a CHECK constraint (`CheckConstraint("length(password_hash) >= 60")`) so the database rejects rows whose hash is not at least the length of a bcrypt digest.

---

### BUG-AUTH-019: `_normalize_email` strips whitespace-only input to `""`, producing a confusing 422 instead of a clear "email required" error
**Severity:** Medium
**Component:** `backend/src/routers/auth.py:73-84`
**Symptom:** A user who submits `{"email": "   ", "password": "hunter2!!"}` <!-- pragma: allowlist secret --> hits the `mode="before"` validator, which lowercases and strips to `""`. EmailStr then rejects with `value is not a valid email address: An email address cannot be empty.`. The frontend `errorMessages.ts` mapping does not have a translation for this raw Pydantic message, so the user sees a developer-facing string. Worse, `email: EmailStr` already has its own "required" error path, so the boundary normalization is hiding the more specific error.
**Root cause:**
```python
@field_validator("email", mode="before")
@classmethod
def _normalize_email(cls, value: object) -> object:
    if isinstance(value, str):
        return value.strip().lower()  # "   " -> ""
    return value
```
Stripping is right; converting whitespace-only input into an empty string and letting EmailStr handle it is what produces the cryptic message.

**Fix:** Detect the empty case explicitly and raise a structured error the frontend can map: after stripping, `if not value: raise ValueError("email_required")`. Add `email_required` to `frontend/src/api/errorMessages.ts` so the user sees "Please enter your email address."

---

## Suggested remediation order

1. **BUG-AUTH-001 + 002 + 016 (duplicate-signup contract)** — land together. Change the backend to raise 409 (with timing-equalizing dummy hash) and update the Zod schema + signup screen to surface "this email is taken — try logging in" without ever persisting credentials. This unblocks the user's reported "I signed up but can't log in" loop. Add a regression test that double-submits signup and asserts the second call returns 409 and leaves AsyncStorage unchanged.
2. **BUG-AUTH-011 (SECRET_KEY at startup) + BUG-AUTH-015 (Settings)** — same change. Introduce a `pydantic-settings` `Settings` instance that validates `SECRET_KEY` (length + weak-value rejection), `JWT_TTL_MINUTES`, `BCRYPT_ROUNDS`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES` at import time. Fail fast in CI/deploy.
3. **BUG-AUTH-008 (X-Forwarded-For trust) + BUG-AUTH-007 (lockout race) + BUG-AUTH-006 (audit gap)** — security cluster. The X-Forwarded-For fix and the lockout-race fix interact (you need a stable IP before you can rate-key on it), and recording the locked attempt is a one-liner that should land with the race fix. Move lockout state onto the `users` row (`failed_login_count`, `locked_until`) with `UPDATE … RETURNING` so increment + read are atomic.
4. **BUG-AUTH-012 (malformed sub → 500) + BUG-AUTH-013 (no jti / revocation)** — JWT correctness cluster. Introduce `jti` claim, a denylist (Redis or table), and tighten `get_current_user` to map all decode/extract errors to a uniform 401.
5. **BUG-AUTH-004 (bcrypt 72-byte truncation) + BUG-AUTH-005 (handler validation) + BUG-AUTH-017 (no schema bounds) + BUG-AUTH-018 (empty hash default)** — schema/crypto cluster. Move all password constraints onto `AuthRequest` (`min_length=8, max_length=72`), drop the in-handler check, drop `password_hash`'s default, add a CHECK constraint via migration. Decide once on bcrypt-only-up-to-72 vs. SHA-256-then-bcrypt and stick with it.
6. **BUG-AUTH-014 (refresh limiter keys on IP)** — re-key on `user_id` and bump quota. Land with the JWT cluster (3) so it can use the new `jti` for token rotation.
7. **BUG-AUTH-003 (concurrent signup race)** — wrap `INSERT` in `try/except IntegrityError`; falls out naturally once duplicate handling is centralized in step 1.
8. **BUG-AUTH-009 (LoginAttempt index + retention) + BUG-AUTH-010 (mid-request commit)** — perf/correctness cleanup. Index migration + flush-instead-of-commit + scheduled purge job. Lower priority once lockout state is moved off this table per step 3.
9. **BUG-AUTH-019 (whitespace email → cryptic 422)** — small UX fix. Add `email_required` to the error map. Lump with frontend Auth screen polish in report 02.
