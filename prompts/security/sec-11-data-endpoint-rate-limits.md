# sec-11: No rate limiting on data endpoints

**Labels:** `security`, `backend`, `priority-medium`
**Severity:** MEDIUM
**OWASP:** A04:2021 — Insecure Design
**Estimated LoC:** ~30

## Problem

Rate limiting is only applied to auth endpoints (`/auth/signup` at 3/min,
`/auth/login` at 5/min). All other endpoints have no rate limits:

- `POST /journal/chat` — triggers an LLM API call (costs money per request)
- `GET /journal/` — list with pagination (data enumeration)
- `POST /practices/` — create practices (spam)
- `POST /prompts/{week}/respond` — submit responses
- `POST /user/balance/add` — add credits (no payment validation yet)
- All `GET` endpoints — scraping

An authenticated attacker can:
1. **Exhaust LLM credits** by spamming `/journal/chat` faster than the
   balance deduction can protect (race condition on `offering_balance`)
2. **Enumerate all user data** by paginating through list endpoints at high speed
3. **Spam user-created content** by flooding POST endpoints

## Tasks

1. **Add global rate limiting**
   ```python
   # In main.py — apply a default limit to all endpoints
   app.state.limiter = limiter
   # In rate_limit.py — set a global default
   limiter = Limiter(
       key_func=get_remote_address,
       default_limits=["60/minute"],
   )
   ```

2. **Add stricter limits on expensive endpoints**
   | Endpoint | Suggested Limit | Reason |
   |----------|----------------|--------|
   | `POST /journal/chat` | 10/minute | LLM API cost |
   | `POST /user/balance/add` | 5/minute | Financial operation |
   | `POST /practices/` | 5/minute | Content creation |
   | `GET /journal/` | 30/minute | Data enumeration |

3. **Update tests**
   - Test that global rate limits return 429 when exceeded
   - Test that per-endpoint limits are enforced independently

## Acceptance Criteria

- All endpoints have a default rate limit (60/minute suggested)
- Expensive endpoints have stricter per-endpoint limits
- Rate limit responses include `Retry-After` header
- Existing auth rate limits remain unchanged

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/rate_limit.py` | Add default_limits to Limiter |
| `backend/src/routers/botmason.py` | Add per-endpoint limit on /journal/chat |
| `backend/src/routers/journal.py` | Add per-endpoint limit on list |
| `backend/tests/` | Add rate limit tests |
