# phase-5-09: Add JWT refresh token flow for mobile sessions

**Labels:** `phase-5`, `full-stack`, `auth`, `priority-medium`
**Epic:** Phase 5 — Test Coverage & Security Hardening
**Estimated LoC:** ~275

## Problem

JWT tokens expire after 1 hour (`_TOKEN_TTL = timedelta(hours=1)` in
`routers/auth.py:32`) with no way to renew without re-entering credentials.
For a mobile app where sessions may span hours of intermittent use, this forces
frequent re-login — poor UX that will frustrate users during journaling or
practice sessions.

Current state: login returns `{"token": "...", "user_id": N}` with no refresh
mechanism. When the token expires, the frontend's `onUnauthorizedCallback`
fires and the user is logged out.

## Scope

Add a refresh token endpoint to the backend and integrate it into the frontend
auth flow. Does NOT change the access token TTL or add token revocation.

## Tasks

1. **Backend: refresh token endpoint**
   - Add `POST /auth/refresh` endpoint in `routers/auth.py`
   - Accept a valid (non-expired) or recently-expired JWT
   - Issue a new access token with refreshed expiry
   - Add a grace period (e.g., 24 hours after expiry) during which refresh is
     still allowed
   - Rate-limit to 10/minute to prevent abuse

2. **Backend: return refresh window info**
   - Add `expires_at` (ISO 8601) to `AuthResponse` so the frontend knows when
     to refresh proactively
   - Add `refresh_before` timestamp (expiry + grace period)

3. **Frontend: auto-refresh integration**
   - In `AuthContext`, set a timer to refresh the token before expiry
   - On 401, attempt one refresh before triggering logout
   - Store the token expiry in AsyncStorage for cold-start refresh

4. **Tests**
   - Test refresh with valid token returns new token
   - Test refresh with expired-but-within-grace token works
   - Test refresh with expired-beyond-grace token returns 401
   - Test rate limiting on refresh endpoint

## Acceptance Criteria

- Users are not logged out during active sessions shorter than 24 hours
- `POST /auth/refresh` returns a new token when called with a valid/recent JWT
- Frontend proactively refreshes before token expiry
- Expired-beyond-grace tokens are rejected with 401
- All new endpoints have tests

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/auth.py` | Modify |
| `backend/src/schemas/auth.py` | **Create** (if extracting schemas) |
| `backend/tests/test_auth.py` | Modify |
| `frontend/src/context/AuthContext.tsx` | Modify |
| `frontend/src/api/index.ts` | Modify (add refresh endpoint) |
