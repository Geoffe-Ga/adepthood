# sec-02: No rate limiting on data endpoints

**Labels:** `security`, `backend`, `priority-medium`
**Severity:** MEDIUM
**OWASP:** A04:2021 — Insecure Design
**Estimated LoC:** ~30

## Problem

Rate limiting is only applied to auth endpoints. The Limiter at
`backend/src/rate_limit.py:8` has no `default_limits`:

```python
limiter = Limiter(key_func=get_remote_address)
```

And no data endpoint has a `@limiter.limit()` decorator. An authenticated
attacker can hit every endpoint at unlimited speed:

| Endpoint | Risk |
|----------|------|
| `POST /journal/chat` | LLM API call — costs real money per request |
| `POST /user/balance/add` | Credit injection (no payment validation yet) |
| `POST /practices/` | Content spam |
| `POST /prompts/{week}/respond` | Payload spam |
| `GET /journal/` | Data enumeration via pagination |
| All `GET` endpoints | Scraping user data at scale |

The auth endpoints are properly limited (3/min signup, 5/min login, 1/min
refresh), but the data plane has zero protection.

## Tasks

1. **Add a global default rate limit to the Limiter**
   ```python
   limiter = Limiter(
       key_func=get_remote_address,
       default_limits=["60/minute"],
   )
   ```
   This applies 60 requests/minute/IP to every endpoint unless overridden.

2. **Add stricter per-endpoint limits on expensive operations**
   | Endpoint | Limit | Reason |
   |----------|-------|--------|
   | `POST /journal/chat` | `10/minute` | LLM API cost |
   | `POST /user/balance/add` | `5/minute` | Financial operation |
   | `POST /practices/` | `5/minute` | Content creation |

3. **Ensure auth endpoint limits remain explicit**
   - Auth endpoints already have explicit `@limiter.limit()` decorators
   - These override the global default, so no change needed

4. **Update tests**
   - Test that global rate limits return 429 when exceeded
   - Test that per-endpoint limits are enforced independently

## Acceptance Criteria

- All endpoints have a default rate limit (60/minute)
- Expensive endpoints have stricter per-endpoint limits
- Auth rate limits unchanged
- Tests cover 429 responses

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/rate_limit.py` | Add `default_limits=["60/minute"]` |
| `backend/src/routers/botmason.py` | Add `@limiter.limit("10/minute")` to chat |
| `backend/src/routers/botmason.py` | Add `@limiter.limit("5/minute")` to add_balance |
| `backend/src/routers/practices.py` | Add `@limiter.limit("5/minute")` to submit |
| `backend/tests/` | Add rate limit tests for data endpoints |
