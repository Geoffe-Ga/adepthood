# sec-08: HTTP fallback in API base URL configuration

**Labels:** `security`, `frontend`, `priority-high`
**Severity:** HIGH
**OWASP:** A02:2021 — Cryptographic Failures (cleartext transmission)
**Estimated LoC:** ~15

## Problem

The API base URL at `frontend/src/config.ts:1` defaults to HTTP:

```typescript
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8000';
```

If `EXPO_PUBLIC_API_BASE_URL` is not set in a production build, all API traffic
(including JWT tokens in `Authorization` headers and user credentials in login
requests) will be sent over unencrypted HTTP to `localhost:8000` — which will
silently fail rather than alerting the developer to the misconfiguration.

While the backend enforces HSTS headers in production, a missing env var
means the frontend never connects to the production backend at all, so HSTS
never takes effect.

## Tasks

1. **Add a runtime HTTPS check for production builds**
   ```typescript
   const DEFAULT_URL = __DEV__ ? 'http://localhost:8000' : '';

   export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_URL;

   if (!__DEV__ && !API_BASE_URL.startsWith('https://')) {
     throw new Error(
       'EXPO_PUBLIC_API_BASE_URL must be set to an HTTPS URL in production builds'
     );
   }
   ```

2. **Separate dev and production defaults**
   - `http://localhost:8000` is valid for development only
   - Production must have an explicit HTTPS URL or fail at startup

3. **Update tests**
   - Test that non-HTTPS URLs throw in production mode
   - Test that HTTP is allowed in development mode

## Acceptance Criteria

- Production builds refuse to start with HTTP or missing API base URL
- Development builds continue to use `http://localhost:8000`
- Error message clearly identifies the misconfiguration

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/config.ts` | Add HTTPS validation for production |
| `frontend/src/__tests__/config.test.ts` | Add validation tests |
