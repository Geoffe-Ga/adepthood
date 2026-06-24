# audit-async-08: Disable CORS credentials for the Bearer-token API

**Labels:** `audit-async`, `backend`, `security`, `priority-medium`
**Epic:** Backend Async Correctness & Query Performance
**Estimated LoC:** ~80  (hard cap 700)

## Problem
The CORS middleware is configured with `allow_credentials=True`, but the API
authenticates with `Authorization: Bearer` tokens and sets no cookies. Enabling
credentials mode for a cookieless API needlessly widens the attack surface and
constrains origin handling (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:58`; §5.3 CORS
surface).
**Current state:** `main.py:398-405` adds `CORSMiddleware` with
`allow_credentials=True`.

## Scope
Covers flipping `allow_credentials` to `False` in the single CORS middleware
registration and proving the Bearer-token flow is unaffected. Does NOT change the
allowed origins list, allowed methods/headers, or introduce cookie-based auth.

## Tasks
1. **Add a failing CORS config test** — in `tests/`, assert the app's
   `CORSMiddleware` is configured with `allow_credentials=False` (inspect the
   middleware options or a preflight `OPTIONS` response's
   `Access-Control-Allow-Credentials` header). Write it first; watch it fail.
2. **Set the flag** — change `allow_credentials=True` to `False` at
   `main.py:398-405`.
3. **Bearer-flow regression test** — assert an authenticated request with an
   `Authorization: Bearer` header still succeeds from an allowed origin and that
   no cookies are relied upon.

## Acceptance Criteria
- [ ] CORS middleware is configured with `allow_credentials=False`.
- [ ] A preflight `OPTIONS` does not return
      `Access-Control-Allow-Credentials: true`.
- [ ] An authenticated `Bearer`-token request from an allowed origin still
      succeeds.
- [ ] No existing tests break; coverage stays ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/main.py` | Modify |
| `backend/tests/test_cors_config.py` | Create |
