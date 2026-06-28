# journal-load-fix-02: Audit every API-client path + add a route-contract test

**Labels:** `bug`, `frontend`, `tech-debt`
**Epic:** [Fix journal load failure](journal-load-fix-epic.md)
**Depends on:** [01](journal-load-fix-01-collection-trailing-slash.md) (land the journal fix first)
**Estimated LoC:** ~160

## Role

You are a frontend engineer eliminating an entire class of bug — a client
request path that doesn't match its FastAPI route — by auditing every endpoint
and adding a guard test so the next mismatch fails CI instead of reaching a user.

## Goal

Produce a single source of truth that maps each `frontend/src/api/index.ts`
collection endpoint to its canonical backend path, fix any drift the audit
finds, and add a test that fails if any client endpoint stops matching its
route's trailing-slash contract.

## Context

The journal bug (sub-issue 01) happened because `journal.list/create` requested
`/journal` while the route is `/journal/`, and **no test asserted the path**.
The same drift could exist on any other endpoint. The convention is:

- A FastAPI **collection** route registered at `@router.<verb>("/")` under a
  prefix is served at `<prefix>/` — the client must use the trailing slash
  (`'/habits/'`, `'/practices/'`).
- An **item / sub-resource** route (`@router.<verb>("/{id}")`,
  `@router.<verb>("/{id}/stats")`, `/prompts/current`, etc.) has no trailing
  slash and the client must not add one.

A mismatch in either direction (missing slash on a collection, extra slash on an
item) triggers a 307 redirect that can fail CORS / drop auth on web — silently,
and mislabeled as a network error.

## Tasks

1. **Audit.** Enumerate every `request<…>(path, …)` call in
   `frontend/src/api/index.ts`. For each, identify the backend route (search
   `backend/src/routers/` for the matching `@router.<verb>(…)` under its
   `APIRouter(prefix=…)`). Record: client path, route path, verb, and whether
   the slash matches. Capture the table in the PR description.

2. **Fix drift.** For any mismatch found, correct the **client** path (never the
   route — routes are public contract). Each fix needs a path assertion in step 3.

3. **Add the guard test** at
   `frontend/src/api/__tests__/route-contract.test.ts`. Build a parametrized
   table of `{ name, invoke, expectedUrl }` covering at minimum every collection
   endpoint (journal, habits, goals, practices, prompts, user-practices, users,
   wallet, marginalia/resonance). Mock `fetch`, invoke each client method with
   representative args, and assert the captured URL exactly equals the expected
   canonical path. Reuse the `jsonResponse` + `mockFetch` harness from
   `habits-api.test.ts:11-28`.

4. Confirm the test fails if you revert any client path to the wrong slash form
   (demonstrate with the journal entry, then restore).

## Acceptance Criteria

- [ ] PR description contains the full client-path → route audit table.
- [ ] Any drift the audit found is fixed on the client side, each with a test.
- [ ] `route-contract.test.ts` asserts the exact URL for every collection endpoint
      and fails on a reintroduced slash mismatch.
- [ ] No backend route path changed.
- [ ] `cd frontend && npm test`, `npx tsc --noEmit`, and `npm run lint` pass.
- [ ] `pre-commit run --all-files` green.

## Constraints

- Fix clients, not routes. If you believe a route is genuinely wrong, stop and
  flag it in the PR rather than changing a public path.
- Keep the test data-driven (one `it.each` table), not 30 copy-pasted blocks —
  sonarjs/no-duplicate-string is enforced.
- Conventional commit: `test(frontend): assert every API client hits its route path`.

## References

- `frontend/src/api/index.ts` — all `request<…>()` call sites
- `backend/src/routers/` — route definitions (grep `@router.` and `prefix=`)
- `frontend/src/api/__tests__/habits-api.test.ts:11-56` — harness + assertion pattern
- Sub-issue 01 — the first drift this guard would have caught
