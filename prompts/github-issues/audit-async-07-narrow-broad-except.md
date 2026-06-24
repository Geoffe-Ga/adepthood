# audit-async-07: Narrow broad except in rate-limit and chat-stream paths

**Labels:** `audit-async`, `backend`, `correctness`, `priority-medium`
**Epic:** Backend Async Correctness & Query Performance
**Estimated LoC:** ~150  (hard cap 700)

## Problem
`except Exception` in the rate-limit key functions silently swallows programmer
bugs and falls back to an anonymous-IP key, while broad excepts in the chat
stream turn real bugs into a generic 502 — masking defects as benign behavior
(`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:59-60`; §5.3 broad except).
**Current state:** `routers/practices.py:43` and `routers/practice_share.py:93`
catch `except Exception` in their rate-limit key fns; `services/chat_stream.py:106`
and `:363` catch `except Exception` around provider calls.

## Scope
Covers narrowing the four named broad excepts: the two rate-limit key functions to
catch only `HTTPException`, and the two chat-stream sites to catch only the
expected provider error type and re-raise everything else. Does NOT change rate-
limit policy, the chat protocol, or any other `except` block in the codebase.

## Tasks
1. **Add failing propagation tests** — write tests that inject a non-HTTP error
   (e.g. a `ValueError`/`RuntimeError`) into each path and assert it propagates
   instead of being swallowed: the rate-limit key fns must not silently fall back
   to the anonymous key on a programmer bug, and the chat-stream sites must
   re-raise non-provider errors rather than emit a 502. Write these first.
2. **Narrow rate-limit excepts** — change `except Exception` to
   `except HTTPException` at `routers/practices.py:43` and
   `routers/practice_share.py:93`, matching botmason's narrowed version cited in
   the audit.
3. **Narrow + re-raise in chat-stream** — at `services/chat_stream.py:106` and
   `:363`, catch only the expected provider/network error type, and `raise` (or
   re-raise) any non-provider exception so genuine bugs surface.
4. **Provider-error regression test** — assert a genuine provider/network error
   still yields the existing graceful response (e.g. 502) so the happy
   degradation path is preserved.

## Acceptance Criteria
- [ ] `routers/practices.py:43` and `routers/practice_share.py:93` catch only
      `HTTPException`; a non-HTTP error propagates (asserted by test).
- [ ] `services/chat_stream.py:106` and `:363` re-raise non-provider exceptions;
      provider/network errors still degrade gracefully (asserted by test).
- [ ] No new `# noqa`/broad-except suppressions are introduced.
- [ ] No existing tests break; coverage stays ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/routers/practices.py` | Modify |
| `backend/src/routers/practice_share.py` | Modify |
| `backend/src/services/chat_stream.py` | Modify |
| `backend/tests/services/test_chat_stream_errors.py` | Create |
| `backend/tests/routers/test_rate_limit_key_errors.py` | Create |
