# sec-09: No token refresh or expiration handling

**Labels:** `security`, `full-stack`, `priority-medium`
**Severity:** MEDIUM
**OWASP:** A07:2021 — Identification and Authentication Failures
**Estimated LoC:** ~120

## Problem

The frontend has no mechanism to handle JWT token expiration or refresh. The
current flow:

1. User logs in, receives a JWT with 1-hour TTL (`auth.py:32`)
2. Token is stored in `expo-secure-store` (`authStorage.ts`)
3. Token is loaded on app startup (`AuthContext.tsx:38-44`)
4. Token is used for all API requests (`api/index.ts:46-58`)
5. **When the token expires, API calls fail with 401**
6. `onUnauthorized` clears the token and logs the user out (`AuthContext.tsx:29-31`)

This means:
- **Users are silently logged out after 1 hour** of inactivity
- **In-progress work (journal entries, habit logs) is lost** when the token
  expires mid-session
- **No proactive refresh** — the user discovers expiration only when an API
  call fails
- **Expired tokens are loaded on app restart** — the app shows the
  authenticated UI briefly before the first API call fails and triggers logout

## Tasks

### Backend

1. **Add a refresh token endpoint**
   ```python
   @router.post("/auth/refresh", response_model=AuthResponse)
   async def refresh_token(
       current_user: int = Depends(get_current_user),
   ) -> AuthResponse:
       token = _create_token(current_user)
       return AuthResponse(token=token, user_id=current_user)
   ```
   - Accepts a valid (not-yet-expired) token and returns a fresh one
   - Rate limit to 1/minute to prevent abuse

2. **Consider a longer-lived refresh token** (optional)
   - Issue a separate refresh token with 7-day TTL stored in the database
   - Access token remains 1-hour, refresh token extends sessions

### Frontend

3. **Add proactive token refresh**
   - Decode the JWT client-side to check `exp` claim
   - Refresh the token 5 minutes before expiration
   - Use a background interval to check expiration

4. **Add token expiration check on app startup**
   ```typescript
   useEffect(() => {
     loadToken().then((stored) => {
       if (stored && !isTokenExpired(stored)) {
         setToken(stored);
       } else {
         clearToken();
       }
     }).finally(() => setIsLoading(false));
   }, []);
   ```

5. **Add retry-after-refresh for failed requests**
   - When a 401 is received, attempt to refresh the token once
   - If refresh succeeds, retry the original request
   - If refresh fails, log the user out

6. **Update tests**
   - Test token refresh endpoint
   - Test expired token detection on startup
   - Test automatic retry after refresh

## Acceptance Criteria

- Tokens are proactively refreshed before expiration
- Expired tokens are detected on app startup
- Failed requests due to expiration are retried after refresh
- User is only logged out when refresh also fails
- In-progress work is not lost due to token expiration

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/routers/auth.py` | Add /auth/refresh endpoint |
| `backend/tests/test_auth.py` | Add refresh tests |
| `frontend/src/context/AuthContext.tsx` | Add refresh logic and expiry check |
| `frontend/src/api/index.ts` | Add retry-after-refresh |
| `frontend/src/storage/authStorage.ts` | Add token expiry helper |
