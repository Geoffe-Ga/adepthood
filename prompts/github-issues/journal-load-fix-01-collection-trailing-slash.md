# journal-load-fix-01: Fix journal collection trailing-slash mismatch

**Labels:** `bug`, `frontend`, `journal`
**Epic:** [Fix journal load failure](journal-load-fix-epic.md)
**Depends on:** none
**Estimated LoC:** ~70

## Role

You are a frontend engineer shipping the minimal, surgical fix for a
user-blocking bug: the Journal shelf won't load and shows "check your
connection" even when the user is online.

## Goal

Make `journal.list()` and `journal.create()` request the trailing-slash path
`/journal/` so they hit the FastAPI route directly instead of triggering a 307
redirect that fails CORS on web. Lock the behavior with an API-client regression
test.

## Context

`frontend/src/api/index.ts` — the journal collection client omits the trailing
slash:

```ts
list(params: JournalListParams = {}, token?: string): Promise<JournalListResponse> {
  // ...builds qs...
  return request<JournalListResponse>(`/journal${qs ? `?${qs}` : ''}`, {   // ← no trailing slash
    token,
    schema: journalListResponseSchema as unknown as z.ZodType<JournalListResponse>,
  });
},
create(entry: JournalMessageCreate, token?: string): Promise<JournalMessage> {
  return request<JournalMessage>('/journal', {                              // ← no trailing slash
    method: 'POST', body: entry, token,
  });
},
```

The backend route is `/journal/` (`backend/src/routers/journal.py:62,94,179`).
A request to `/journal?…` gets a 307 → `/journal/?…`; on web the redirect drops
the preflighted auth request and `fetch` throws a `TypeError`, which
`errorMessages.ts` maps to `network_error` → "check your connection". See the
epic for the full RCA.

The single-entry methods (`get`/`update`/`delete`) target `/journal/{id}` and
are **correct** — do not touch them. Only `list` and `create` (the collection
`/` routes) need the slash. The fix mirrors the existing convention for
`'/habits/'` (`index.ts:956,990`) and `'/practices/'` (`index.ts:1761,1811`).

## Tasks

1. **Write the failing test first** at
   `frontend/src/api/__tests__/journal-api.test.ts`, mirroring the fetch-mock
   pattern in `habits-api.test.ts:30-56`. Assert the exact request URL:
   - `journal.list({ limit: 20, offset: 0 }, token)` → `http://test/journal/?limit=20&offset=0`
   - `journal.list({}, token)` → `http://test/journal/`
   - `journal.create({ message: 'hi' }, token)` → `http://test/journal/` with `method: 'POST'`

   Run it and confirm it fails against the current code (URLs lack the slash).

2. **Apply the fix** in `frontend/src/api/index.ts`:
   - `list`: change the template to `` `/journal/${qs ? `?${qs}` : ''}` ``
   - `create`: change `'/journal'` to `'/journal/'`

3. Run the new test → green. Run the existing journal component tests
   (`features/Journal/__tests__/*`) to confirm no regression.

## Acceptance Criteria

- [ ] `journal.list()` requests `/journal/` (with the query string after the slash).
- [ ] `journal.create()` POSTs to `/journal/`.
- [ ] `journal.get/update/delete` are unchanged (`/journal/{id}`).
- [ ] New `journal-api.test.ts` asserts all three paths and fails if the slash is removed.
- [ ] `cd frontend && npm test` and `npx tsc --noEmit` pass.
- [ ] `pre-commit run --all-files` green.

## Constraints

- Touch only `journal.list` and `journal.create` in `index.ts` plus the new test
  file. No schema, type, or backend changes.
- Conventional commit: `fix(frontend): hit /journal/ so the shelf loads (no 307/CORS)`.

## References

- `frontend/src/api/index.ts:1200-1239` — journal client
- `frontend/src/api/__tests__/habits-api.test.ts:30-56` — test pattern to mirror
- `backend/src/routers/journal.py:62,94,179-181` — `/journal/` routes
- `frontend/src/api/errorMessages.ts:235-277` — why the failure read as "offline"
