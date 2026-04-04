# phase-1-03: Migrate auth router from in-memory dicts to database-backed users/sessions

**Labels:** `phase-1`, `backend`, `security`, `priority-critical`
**Epic:** Phase 1 — Make It Real
**Depends on:** phase-1-01
**Estimated LoC:** ~250–300

## Problem

`backend/src/routers/auth.py` stores users and tokens in module-level dicts:

```python
_users: dict[str, tuple[bytes, int]] = {}          # username -> (hashed_pw, user_id)
_tokens: dict[str, tuple[int, datetime]] = {}       # token -> (user_id, expiry)
_id_counter = count(1)
```

**Consequences:**
- All user accounts vanish on server restart
- All active sessions vanish on server restart
- Token cleanup (`_cleanup_tokens()`) is O(n) on every auth call and not thread-safe
- Token format is a raw `secrets.token_hex(16)` — no structure, no signature, can't be validated without the dict
- `_users` stores `tuple[bytes, int]` — untyped, fragile, easy to mix up indexes
- `.env.example` defines `SECRET_KEY=replace-me` but nothing reads it
- No password requirements (test uses `password="pw"`)
- No rate limiting, no account lockout

## Scope

Replace in-memory auth with database-backed users (using the existing `User` SQLModel) and either JWT tokens or database-backed sessions. Add basic password validation.

## Tasks

1. **Use the existing `User` model for storage**
   - `models/user.py` already defines `User` with `id`, `email`, `created_at`
   - Add `password_hash: str` field to the User model (currently missing — the model has no password field at all)
   - Add `username: str` field (currently the model only has `email`)
   - Decide: use `email` as the login identifier, or add separate `username`. Recommendation: use `email` — it's already on the model and is more standard

2. **Replace in-memory user storage with DB queries**
   - `signup`: Check `session.exec(select(User).where(User.email == payload.email))`, create if not exists
   - `login`: Fetch user by email, verify bcrypt hash, create token
   - Remove `_users` dict entirely

3. **Replace in-memory token storage**
   - **Option A (JWT):** Use `PyJWT` with the `SECRET_KEY` from `.env`. Encode `user_id` and `exp` into a signed token. No DB lookup needed for validation — just verify the signature. Add `PyJWT` to requirements.
   - **Option B (DB sessions):** Create a `Session` model with `token`, `user_id`, `expires_at`. Query on each request. Simpler but requires DB hit per request.
   - Recommendation: **JWT** — eliminates the token dict, the cleanup function, and scales horizontally.

4. **Add password validation**
   - Minimum 8 characters
   - Return a clear 400 error with a message if too short
   - Keep bcrypt for hashing, but set explicit rounds: `bcrypt.gensalt(rounds=12)`

5. **Read SECRET_KEY from environment**
   - Currently `.env.example` has `SECRET_KEY=replace-me` but nothing uses it
   - Fail fast at startup if `SECRET_KEY` is not set or is the default value

6. **Fix the `cast(bytes, ...)` type hack**
   - `auth.py:40` uses `cast(bytes, bcrypt.hashpw(...))` to suppress type errors
   - Install `types-bcrypt` or add a proper type stub instead of casting

7. **Update `get_current_user` dependency**
   - If JWT: decode token, extract user_id, return it
   - If DB sessions: query session table, check expiry, return user_id
   - Remove `_cleanup_tokens()` function entirely

8. **Update tests**
   - `tests/test_auth.py` currently manipulates `auth._tokens` directly — replace with proper test fixtures
   - Add test: password too short returns 400
   - Add test: duplicate email signup returns 400
   - Keep existing flow tests (signup → login → use token)

## Acceptance Criteria

- User accounts persist across server restarts
- Tokens are stateless (JWT) or database-backed — not in-memory dicts
- Password minimum length enforced
- `SECRET_KEY` read from environment, startup fails if missing
- No `cast()` type hacks remain
- All auth tests pass

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/routers/auth.py` | Rewrite |
| `backend/src/models/user.py` | Modify (add password_hash, username) |
| `backend/tests/test_auth.py` | Rewrite |
| `backend/requirements.txt` | Modify (add PyJWT if chosen) |
| `backend/.env.example` | Document SECRET_KEY usage |
