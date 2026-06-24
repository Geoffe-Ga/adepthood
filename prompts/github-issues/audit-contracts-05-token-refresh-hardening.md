# audit-contracts-05: Harden token refresh (timeout + in-flight dedupe)

**Labels:** `audit-contracts`, `frontend`, `bug`, `priority-medium`
**Epic:** Data-Layer Contracts & Schema Drift
**Estimated LoC:** ~280  (hard cap 700)

## Problem

`attemptTokenRefresh` (`frontend/src/api/index.ts:417-455`) issues the
`POST /auth/refresh` call with a **raw `fetch`** (`index.ts:422-426`) — no
timeout, no `AbortSignal`, none of the retry/backoff guarantees the rest of the
client gets from `fetchWithTimeout` / `request()` (`index.ts:513+`). Worse,
there is no in-flight dedupe: when several requests 401 at once (the common
cold-start / expired-token case), each independently calls
`attemptTokenRefresh`, firing a **storm** of concurrent refreshes against the
same token. **Current state:** an un-timed, un-deduped refresh path — §5.4
class: token-refresh race (contracts).

## Scope

Covers: routing the refresh request through `fetchWithTimeout` (so it inherits
the timeout/abort contract) and sharing a single in-flight refresh promise so N
concurrent 401s trigger exactly one network refresh, all awaiting the same
result.

Does NOT cover: the SSE retry path's own refresh reuse (`retryStreamWithRefresh`
already calls `attemptTokenRefresh`, so it inherits the dedupe for free) or
changing the backend refresh contract. The existing `loginAuthResponseSchema`
validation (`index.ts:438`) stays as-is.

## Tasks

1. **Route through `fetchWithTimeout`** — replace the raw `fetch` at
   `index.ts:422-426` with the same timeout/abort-aware helper the rest of the
   client uses (`doFetch` / `fetchWithTimeout`, `index.ts:513+`), so a hung
   refresh aborts instead of pinning the 401-retry loop.
2. **Share a single in-flight promise** — add a module-level
   `let inFlightRefresh: Promise<{ token: string | null; hadToken: boolean }> | null`.
   On entry, if one is in flight return it; otherwise create it, store it, and
   clear it in a `finally`. All concurrent callers await the same refresh.
3. **Preserve existing semantics** — the no-token short-circuit
   (`index.ts:418-419`), the `safeParse` failure path (`index.ts:438-444`), and
   the `onTokenRefreshedCallback` (`index.ts:450`) must behave identically; only
   the transport and concurrency change.
4. **TDD** — a test that fires two concurrent `attemptTokenRefresh()` calls with
   a single mocked refresh response and asserts the underlying fetch was called
   **once**; a test that a timeout/abort resolves to `{ token: null }` rather
   than throwing.

## Acceptance Criteria

- [ ] Two concurrent `attemptTokenRefresh()` calls produce exactly **one**
      network refresh, proven by a mock-fetch call-count assertion.
- [ ] The refresh request goes through `fetchWithTimeout` and aborts on
      timeout, resolving to `{ token: null, hadToken: true }` (no uncaught
      throw), proven by a test.
- [ ] The in-flight promise is cleared after settle (success or failure) so a
      later, genuine refresh still fires.
- [ ] Existing refresh behaviour (no-token short-circuit, malformed-body
      rejection, timezone forwarding) is unchanged and still covered.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/api/index.ts` | Modify — `attemptTokenRefresh` transport + in-flight dedupe |
| `frontend/src/api/__tests__/retryAndValidation.test.ts` | Modify — concurrency + timeout cases |
</content>
