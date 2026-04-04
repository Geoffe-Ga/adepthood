# phase-4-08: Fix CORS production configuration

**Labels:** `phase-4`, `backend`, `security`, `priority-medium`
**Epic:** Phase 4 — Polish & Harden
**Estimated LoC:** ~30–50

## Problem

`backend/src/main.py` lines 19-28:

```python
if os.getenv("ENV", "development") == "development":
    origins = [
        "http://localhost:3000",
        "http://localhost:8080",
        "http://127.0.0.1:3000",
    ]
else:
    origins = [
        os.getenv("PROD_DOMAIN", ""),
    ]
```

**Issues:**
1. If `PROD_DOMAIN` is not set, `origins` contains `[""]` — an empty string. This may cause unexpected CORS behavior depending on the middleware implementation.
2. No validation that `PROD_DOMAIN` is a valid URL (must start with `https://`)
3. No support for multiple production domains (e.g., `app.adepthood.com` + `www.adepthood.com`)
4. Development origins use `http://` — fine for dev but the production domain should enforce `https://`
5. The `ENV` variable defaults to `"development"` — if someone forgets to set it in production, the server will accept requests from localhost

## Scope

Make CORS configuration safe for production deployment.

## Tasks

1. **Fail fast if production config is invalid**
   ```python
   if env == "production":
       prod_domain = os.getenv("PROD_DOMAIN")
       if not prod_domain:
           raise RuntimeError("PROD_DOMAIN must be set in production")
       if not prod_domain.startswith("https://"):
           raise RuntimeError("PROD_DOMAIN must use HTTPS")
       origins = [prod_domain]
   ```

2. **Support multiple production origins**
   - Accept `PROD_DOMAIN` as a comma-separated list: `https://app.adepthood.com,https://www.adepthood.com`
   - `origins = [d.strip() for d in prod_domain.split(",")]`

3. **Add `ENV` validation**
   - Accepted values: `"development"`, `"production"`, `"staging"`
   - If an unknown value is provided, fail fast

4. **Add CORS configuration test**
   - Test: development mode includes localhost origins
   - Test: production mode with valid PROD_DOMAIN works
   - Test: production mode without PROD_DOMAIN raises error
   - Test: production mode with HTTP domain raises error

## Acceptance Criteria

- Server refuses to start in production without a valid `PROD_DOMAIN`
- HTTPS is enforced for production domains
- Multiple production origins supported
- Unknown ENV values rejected at startup
- Tests cover all configuration scenarios

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/main.py` | Modify (CORS validation) |
| `backend/tests/test_cors.py` | Modify (add validation tests) |
| `backend/.env.example` | Modify (document PROD_DOMAIN format) |
