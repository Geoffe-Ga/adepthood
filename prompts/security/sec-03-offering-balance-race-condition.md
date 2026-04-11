# sec-03: Offering balance race condition allows free LLM usage

**Labels:** `security`, `backend`, `priority-high`
**Severity:** HIGH
**OWASP:** A04:2021 — Insecure Design (TOCTOU race condition)
**Estimated LoC:** ~20

## Problem

The BotMason chat endpoint at `backend/src/routers/botmason.py:40-98` has a
Time-Of-Check-to-Time-Of-Use (TOCTOU) race condition on `offering_balance`:

```python
async def chat_with_botmason(...) -> ChatResponse:
    user = await _get_user(current_user, session)      # READ balance

    if user.offering_balance <= 0:                      # CHECK: balance > 0
        raise payment_required("insufficient_offerings")

    # ... store user message ...
    # ... load conversation history ...
    # ... call LLM API (slow, 1-5 seconds) ...

    user.offering_balance -= 1                          # USE: decrement
    session.add(user)
    await session.commit()                              # WRITE
```

Between the CHECK (line 57) and the WRITE (line 90), an attacker can fire
multiple concurrent requests. If a user has `offering_balance = 1`, they can
send 10 simultaneous requests. All 10 pass the `> 0` check before any of
them commit the decrement, resulting in 10 LLM calls but only 1 credit
deducted.

**Impact:** An attacker with 1 credit can make unlimited LLM API calls by
parallelizing requests, costing real money on the LLM provider.

Similarly, `POST /user/balance/add` at line 111-127 has no concurrency
control on the increment — concurrent calls could lose updates.

## Tasks

1. **Use `SELECT ... FOR UPDATE` to lock the row during the transaction**
   ```python
   from sqlalchemy import select as sa_select

   result = await session.execute(
       sa_select(User).where(User.id == user_id).with_for_update()
   )
   user = result.scalars().first()
   ```
   This acquires a row-level lock that blocks concurrent transactions from
   reading the same row until the lock is released by commit/rollback.

2. **Perform the check and decrement atomically**
   Alternatively, use an atomic UPDATE with a WHERE clause:
   ```python
   from sqlalchemy import update

   result = await session.execute(
       update(User)
       .where(User.id == current_user, User.offering_balance > 0)
       .values(offering_balance=User.offering_balance - 1)
       .returning(User.offering_balance)
   )
   new_balance = result.scalar()
   if new_balance is None:
       raise payment_required("insufficient_offerings")
   ```
   This is a single atomic SQL statement — no race window.

3. **Apply the same pattern to `/user/balance/add`**

4. **Add tests**
   - Test that concurrent chat requests with balance=1 result in exactly 1
     successful LLM call (use `asyncio.gather` with multiple requests)
   - Test that the balance never goes negative

## Acceptance Criteria

- Concurrent chat requests cannot bypass the balance check
- Balance deduction is atomic
- Balance never goes negative
- Balance addition is also atomic

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/routers/botmason.py` | Add row locking or atomic update |
| `backend/tests/test_botmason_api.py` | Add concurrency test |
