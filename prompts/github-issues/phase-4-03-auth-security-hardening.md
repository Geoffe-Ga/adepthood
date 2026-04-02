# phase-4-03: Add rate limiting and security hardening to auth endpoints

**Labels:** `phase-4`, `backend`, `security`, `priority-medium`
**Epic:** Phase 4 — Polish & Harden
**Depends on:** phase-1-03
**Estimated LoC:** ~150–200

## Problem

The auth endpoints have no protection against brute force attacks:

- **No rate limiting**: An attacker can try unlimited password combinations against `/auth/login`
- **No account lockout**: Failed login attempts are not tracked or limited
- **No password strength validation beyond minimum length** (added in phase-1-03)
- **CORS allows empty production domain**: `os.getenv("PROD_DOMAIN", "")` defaults to empty string, which could allow requests from any origin
- **No HTTPS enforcement in production**

## Scope

Add rate limiting, account lockout, and production security checks.

## Tasks

1. **Add rate limiting with `slowapi`**
   - Install `slowapi` (built on `limits` library, integrates with FastAPI)
   - Rate limit `/auth/login` to 5 attempts per minute per IP
   - Rate limit `/auth/signup` to 3 attempts per minute per IP
   - Return `429 Too Many Requests` when exceeded

2. **Add account lockout**
   - Track failed login attempts per username in the database
   - After 5 consecutive failed attempts, lock the account for 15 minutes
   - Return a generic "invalid credentials" message (don't reveal whether the account is locked or the password is wrong — prevents enumeration)
   - Reset failed attempts on successful login

3. **Add login attempt audit logging**
   - Log all login attempts (success and failure) with timestamp and IP
   - Use structured logging (`logging.info("auth_attempt", extra={...})`)
   - This follows the `reason_code` pattern already used in the energy router

4. **Validate CORS production domain**
   - In production: fail fast if `PROD_DOMAIN` is not set or empty
   - Add validation at startup in `main.py`

5. **Add security headers middleware**
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: DENY`
   - `Strict-Transport-Security` (in production)
   - Use `starlette.middleware` or a custom middleware

6. **Write tests**
   - Test rate limiting returns 429 after threshold
   - Test account lockout after 5 failures
   - Test lockout expires after 15 minutes
   - Test CORS validation fails with empty PROD_DOMAIN in production mode

## Acceptance Criteria

- Login endpoint rate-limited to 5 attempts/minute/IP
- Account locked after 5 consecutive failures
- All auth events logged with structured data
- CORS validated at startup in production
- Security headers present on all responses

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/main.py` | Modify (add rate limiter, security middleware, CORS validation) |
| `backend/src/routers/auth.py` | Modify (add lockout logic, audit logging) |
| `backend/requirements.txt` | Modify (add slowapi) |
| `backend/tests/test_auth.py` | Modify (add rate limit and lockout tests) |
