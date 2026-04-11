# sec-02: Missing email format validation on auth endpoints

**Labels:** `security`, `backend`, `priority-high`
**Severity:** HIGH
**OWASP:** A03:2021 — Injection
**Estimated LoC:** ~15

## Problem

The `AuthRequest` schema at `backend/src/routers/auth.py:50-52` accepts email
as a plain `str` with no format validation:

```python
class AuthRequest(BaseModel):
    email: str
    password: str
```

This allows arbitrary strings to be stored as email addresses — including
strings containing SQL-like patterns, extremely long values, or control
characters. While SQLAlchemy parameterized queries prevent SQL injection, the
lack of validation means:

- Invalid emails pollute the database (`"not-an-email"`, `"   "`, `""`)
- Extremely long strings (>10KB) can waste storage and slow queries
- Downstream email sending will fail on malformed addresses
- The `User.email` column has a `unique` constraint but no `max_length`

## Tasks

1. **Use Pydantic `EmailStr` for email validation**
   ```python
   from pydantic import BaseModel, EmailStr

   class AuthRequest(BaseModel):
       email: EmailStr
       password: str
   ```
   This validates RFC 5321 format, normalizes case, and rejects empty strings.

2. **Add `email-validator` to requirements**
   - `email-validator` is the backing library for `EmailStr`
   - Add to `backend/requirements.txt`

3. **Add `max_length` to the User model email field**
   ```python
   email: str = Field(unique=True, index=True, max_length=254)
   ```
   254 is the RFC 5321 maximum for an email address.

4. **Update tests**
   - Test that malformed emails return 422 (Pydantic validation error)
   - Test that empty strings are rejected

## Acceptance Criteria

- Signup and login reject malformed emails with 422
- User.email column has a max_length constraint
- `email-validator` added to requirements

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/routers/auth.py` | Change `email: str` to `email: EmailStr` |
| `backend/src/models/user.py` | Add `max_length=254` to email field |
| `backend/requirements.txt` | Add `email-validator` |
| `backend/tests/test_auth.py` | Add malformed email tests |
