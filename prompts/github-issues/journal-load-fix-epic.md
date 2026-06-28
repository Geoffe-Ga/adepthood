# Epic: Fix journal "check your connection" load failure + harden the API route-contract

**Labels:** `bug`, `frontend`, `backend`, `journal`
**Scope:** One-line user-facing fix + class-wide prevention of frontend↔backend route drift
**Estimated total LoC:** ~480

## Role

You are a full-stack engineer fixing a production bug where the Journal shelf
fails to load with a misleading "check your connection" error, and then
hardening the codebase so the entire *class* of bug — a client request path
that doesn't match its FastAPI route — can never silently resurface.

## Goal

After this epic:

- The Journal shelf loads reliably on every platform (web included); a user who
  is online never sees "check your connection" when opening the journal.
- A request-path / route mismatch is caught by an automated test before it can
  reach a user, for **every** API-client collection endpoint — not just journal.
- A genuine route/CORS/redirect misconfiguration is no longer reported to the
  user (or logged) as "you appear to be offline"; it surfaces as a distinct,
  diagnosable failure.
- The backend cannot silently change a collection route's slash contract out
  from under the clients without a test failing.

## Context — root cause (RCA)

The Journal shelf calls `journal.list()`
(`frontend/src/api/index.ts:1200-1214`), which requests `/journal` and
`/journal?limit=…&offset=…` — **without a trailing slash**. The backend journal
router is `APIRouter(prefix="/journal")` with the collection handlers registered
at `@router.get("/")` and `@router.post("/")`
(`backend/src/routers/journal.py:62,94,179-181`), so the real route is
`/journal/`.

Starlette's default `redirect_slashes=True` answers `/journal?…` with a **307
redirect to `/journal/?…`**. On the web build that redirect lands on a path the
CORS preflight didn't cover and drops the `Authorization`-bearing preflighted
request, so `fetch` rejects with a `TypeError` ("Failed to fetch" / "Load
failed"). `isFetchNetworkError` (`frontend/src/api/errorMessages.ts:244-248`)
maps that `TypeError` to `network_error`, which renders as **"You appear to be
offline. Check your connection and try again."** — even though the network is
fine.

Only the **collection** routes (`list`, `create`) are affected. Single-entry
calls hit `/journal/{id}` (no slash ambiguity), which is why opening, editing,
and deleting a specific entry worked and the bug read as "the list won't load."

Every other collection client already uses the trailing slash
(`'/habits/'` `frontend/src/api/index.ts:956`, `'/practices/'`
`frontend/src/api/index.ts:1761`) and the habits API test even documents the
rule: *"Trailing slash matches the FastAPI route"*
(`frontend/src/api/__tests__/habits-api.test.ts:49`). The journal client was the
lone exception, and there is no API-level test asserting its request path — the
existing journal tests are component tests that mock the `journal` module, so
the real URL was never exercised.

PR #673 ("journal load failures + Get Resonance overlap") fixed a *different*
journal load failure (a missing `weekly_prompt` tag enum value caused Zod
validation to reject the whole page). That fix is correct and unrelated; the
trailing-slash mismatch is a second, still-open cause.

## Output format

Four sub-issues, ordered by urgency. Sub-issue 01 is the user-facing hotfix and
ships first and alone. 02–04 are prevention/hardening and can land in any order
after 01.

```
01 collection-trailing-slash  (hotfix — ship first)
        │
        ├── 02 api-route-contract-audit        (frontend, class-wide test)
        ├── 03 network-error-classification     (frontend, stop the mislabel)
        └── 04 backend-route-contract-guard      (backend, CI safety net)
```

## Sub-issues

| # | Title | Scope | LoC |
|---|-------|-------|-----|
| 01 | [Fix journal collection trailing-slash mismatch](journal-load-fix-01-collection-trailing-slash.md) | Frontend | ~70 |
| 02 | [Audit every API-client path against its route + add a contract test](journal-load-fix-02-api-route-contract-audit.md) | Frontend | ~160 |
| 03 | [Stop redirect/CORS failures masquerading as "offline"](journal-load-fix-03-network-error-classification.md) | Frontend | ~140 |
| 04 | [Backend test guard against collection-route slash drift](journal-load-fix-04-backend-route-contract-guard.md) | Backend | ~110 |

## Acceptance Criteria (epic-level)

- [ ] `journal.list()` and `journal.create()` request `/journal/` (trailing slash).
- [ ] An API-client test asserts the canonical request path for **every**
      collection endpoint, journal included; it fails if any is reverted.
- [ ] A redirect/CORS failure is no longer surfaced or logged as `network_error`
      / "you appear to be offline".
- [ ] A backend test fails if any collection route stops matching the documented
      trailing-slash contract.
- [ ] `pre-commit run --all-files` green on every sub-issue PR.
- [ ] Coverage and complexity thresholds unchanged (90% line / 80% branch).

## Constraints

- **TDD, no suppressions.** Write the failing test first. Do not reach for
  `// eslint-disable`, `# noqa`, `# type: ignore`, or `any` to dodge a real error
  (per `CLAUDE.md`).
- **Keep the slash convention; do not disable `redirect_slashes` globally.** The
  fix is to make clients match routes, not to silence Starlette's redirect for
  the whole app (that would change behavior for paths outside this epic).
- Do not change any backend route path or any response schema — these are public
  API contracts. The clients are wrong, not the routes.
- Each sub-issue is independently shippable behind its own PR and conventional
  commit (`fix(frontend): …`, `test(frontend): …`, `test(backend): …`).

## References

- `frontend/src/api/index.ts:1200-1239` — journal client (`list`/`create`/`get`/`update`/`delete`)
- `frontend/src/api/index.ts:956,990,1761,1811` — `/habits/` `/practices/` trailing-slash convention
- `frontend/src/api/errorMessages.ts:114,235-277` — network-error classification + copy
- `frontend/src/api/__tests__/habits-api.test.ts:30-56` — request-path assertion pattern to mirror
- `backend/src/routers/journal.py:62,94,179-181` — `/journal/` collection routes
- `backend/src/main.py` — router mounting (where to assert the route table in 04)
