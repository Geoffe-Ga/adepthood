# sec-04: JWT error messages leak token state

**Labels:** `security`, `backend`, `priority-medium`
**Severity:** MEDIUM
**OWASP:** A07:2021 — Identification and Authentication Failures
**Estimated LoC:** ~15

## Problem

The `get_current_user` dependency at `backend/src/routers/auth.py:207-222`
returns three distinct error codes for different token failure modes:

```python
detail="missing_token"   # line 209 — no Authorization header
detail="expired_token"   # line 215 — token signature valid but expired
detail="invalid_token"   # line 219 — signature invalid or malformed
```

This information leakage allows an attacker to:

1. **Distinguish expired from invalid tokens** — confirms a token was once
   valid, which reveals that the user account exists and the secret key
   hasn't rotated since issuance.
2. **Time token expiration precisely** — by replaying a captured token and
   watching for the transition from `expired_token` to `invalid_token` after
   a key rotation.
3. **Fingerprint the auth implementation** — the distinct codes reveal the
   exact JWT library error hierarchy being used.

The login endpoint correctly uses a single `invalid_credentials` message
(line 190, 197), but the token validation does not follow the same pattern.

## Tasks

1. **Unify all token errors to a single detail code**
   ```python
   _UNAUTHORIZED = HTTPException(
       status_code=status.HTTP_401_UNAUTHORIZED,
       detail="unauthorized",
   )
   ```

2. **Return the same error for missing, expired, and invalid tokens**
   ```python
   def get_current_user(authorization: str | None = Header(default=None)) -> int:
       if not authorization or not authorization.startswith("Bearer "):
           raise _UNAUTHORIZED
       token = authorization.split(" ", 1)[1]
       try:
           payload = jwt.decode(token, _get_secret_key(), algorithms=[_JWT_ALGORITHM])
       except jwt.PyJWTError as exc:
           raise _UNAUTHORIZED from exc
       return int(payload["sub"])
   ```

3. **Log the specific error server-side for debugging**
   - Use `logger.info("token_rejected", extra={"reason": "expired"})` so ops
     can still diagnose issues without exposing details to clients.

4. **Update tests**
   - Change assertions from `detail == "expired_token"` to `detail == "unauthorized"`

## Acceptance Criteria

- All token rejection scenarios return identical 401 with `"unauthorized"`
- Server-side logs still distinguish error types for debugging
- Frontend `onUnauthorized` handler continues to work (it checks status code,
  not detail)

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/routers/auth.py` | Unify error details in get_current_user |
| `backend/tests/test_auth.py` | Update detail assertions |
