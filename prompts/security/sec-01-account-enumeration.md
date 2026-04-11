# sec-01: Account enumeration via distinct signup error messages

**Labels:** `security`, `backend`, `priority-high`
**Severity:** HIGH
**OWASP:** A07:2021 — Identification and Authentication Failures
**Estimated LoC:** ~40

## Problem

The signup endpoint at `backend/src/routers/auth.py:153-154` returns a distinct
error code when an email is already registered:

```python
if result.scalars().first() is not None:
    raise bad_request("user_already_exists")
```

An attacker can enumerate valid email addresses by attempting signups with
different emails and observing whether the response is `user_already_exists`
(registered) or a successful 201 (new account). Combined with the 3/minute
rate limit, an attacker could still verify ~180 emails per hour.

The login endpoint is **not** vulnerable — it correctly returns a generic
`invalid_credentials` for both wrong passwords and nonexistent users (line 197).

## Tasks

1. **Return a generic success for all signup attempts**
   - Always return 201 with a token-shaped response
   - If the email already exists, return the same response structure but do not
     create a duplicate account or issue a valid token
   - Alternatively: always return 201 and send a confirmation email (if email
     is taken, send a "someone tried to register with your email" notice)

2. **Add a confirmation email flow (recommended)**
   - Accounts should not be active until email is verified
   - This eliminates enumeration entirely — the response is always the same

3. **Update tests**
   - Verify that signup with an existing email returns the same status code and
     response shape as a new signup
   - Verify that the duplicate attempt does not create a second user

## Acceptance Criteria

- Signup returns identical response shape for new and existing emails
- No information leakage about which emails are registered
- Existing tests continue to pass

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/routers/auth.py` | Modify signup to return generic response |
| `backend/tests/test_auth.py` | Add enumeration-resistance tests |
