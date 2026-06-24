# audit-async-01: Offload synchronous bcrypt hashing to a worker thread

**Labels:** `audit-async`, `backend`, `async-correctness`, `priority-critical`
**Epic:** Backend Async Correctness & Query Performance
**Estimated LoC:** ~180  (hard cap 700)

## Problem
`routers/auth.py` calls bcrypt cost-12 `hashpw`/`checkpw` synchronously inside
`async def` signup, login, confirm, and reset handlers — including the
anti-enumeration dummy verifications run when an account does not exist. Each
call costs ~250ms and pins the single worker, so concurrent auth requests
serialize across the whole process
(`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:36`, `:51`; §5.3 event-loop blocking).
**Current state:** bcrypt runs on the event loop at call sites ~251, 256, 508,
589, 920, 929, 939, 952, 1310, 1396 of `routers/auth.py`; by contrast
`services/energy.py` and `services/email.py` already offload heavy/blocking work
with `asyncio.to_thread`.

## Scope
Covers every synchronous bcrypt hash and verify (including anti-enumeration dummy
verifications) reachable from an `async def` handler in `routers/auth.py`. Does
NOT change the bcrypt cost factor, the password policy, the anti-enumeration
masking behavior, or any response shape/status code — only where the CPU work
runs.

## Tasks
1. **Add a failing async-offload test** — in `tests/routers/` (e.g.
   `test_auth_async.py`), patch `bcrypt.hashpw`/`bcrypt.checkpw` (or the auth
   helper that wraps them) with a stub that records the running thread, and
   assert it executes off the main event-loop thread (e.g. via a spy on
   `asyncio.to_thread`, or asserting the call thread differs from the loop's
   thread). Write it first and watch it fail.
2. **Introduce thread-offloaded helpers** — add small `async` wrappers
   (e.g. `async def hash_password(...)` / `async def verify_password(...)`) in
   `routers/auth.py` (or a colocated helper module) that call
   `await asyncio.to_thread(bcrypt.hashpw, ...)` /
   `await asyncio.to_thread(bcrypt.checkpw, ...)`.
3. **Replace all call sites** — convert each of the ~10 listed call sites
   (251, 256, 508, 589, 920, 929, 939, 952, 1310, 1396) to `await` the new
   helper, including the anti-enumeration dummy verify paths so timing stays
   constant.
4. **Regression-guard** — add/extend a login + signup integration test asserting
   success and failure paths still return the same status codes and that the
   anti-enumeration dummy verify still runs when the account is absent.

## Acceptance Criteria
- [ ] All bcrypt hash/verify calls in `routers/auth.py` execute via
      `asyncio.to_thread` (no direct `bcrypt.hashpw`/`checkpw` on the loop).
- [ ] Anti-enumeration dummy verifications are also offloaded (constant-time
      behavior preserved for absent accounts).
- [ ] The offload test asserts the hash/verify runs off the event-loop thread
      and fails if a call site is reverted to a synchronous call.
- [ ] Signup, login, email-confirm, and password-reset integration tests pass
      with unchanged status codes/response shapes.
- [ ] No existing tests break; coverage stays ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify
| File | Action |
|------|--------|
| `backend/src/routers/auth.py` | Modify |
| `backend/tests/routers/test_auth_async.py` | Create |
