# journal-load-fix-04: Backend test guard against collection-route slash drift

**Labels:** `bug`, `backend`, `tech-debt`
**Epic:** [Fix journal load failure](journal-load-fix-epic.md)
**Depends on:** none (independent of 01)
**Estimated LoC:** ~110

## Role

You are a backend engineer adding a cheap, durable safety net so the backend
can't silently change the slash contract of a collection route — the contract
the frontend clients depend on — without a test failing.

## Goal

A backend test asserts that every collection route in the mounted app is
registered at its canonical trailing-slash path, and documents the contract in
one place. If someone adds a router whose collection route drifts (or removes a
slash), the suite fails with a clear message naming the offending path.

## Context

The journal bug originated at the seam between FastAPI routes and the JS
clients: the route is `/journal/`, the client called `/journal`, and nothing on
either side asserted they agreed. Sub-issues 01–02 fix and guard the **frontend**
half. This issue guards the **backend** half so the contract is pinned from both
ends.

FastAPI exposes the full route table via `app.routes` (each `APIRoute` has
`.path` and `.methods`). The app is assembled in `backend/src/main.py`. A
collection route is one whose path ends in a prefix segment with no trailing
`{param}` — e.g. `/journal/`, `/habits/`, `/practices/`. The invariant: such
routes end with `/`, and item routes (`/journal/{entry_id}`) do not.

## Tasks

1. **Write the test** at `backend/tests/test_route_contract.py`:
   - Import the assembled `app` (`from src.main import app`).
   - Walk `app.routes`, keeping `APIRoute`s under the feature routers.
   - Assert: any route whose final path segment is **not** a `{param}`
     placeholder and which is the router's collection root ends with `/`.
   - Assert the known collection roots are present and slash-terminated. Encode
     the expected set explicitly (`/journal/`, `/habits/`, `/practices/`,
     `/goals/…`, `/user-practices/`, etc.) so an accidental route rename is also
     caught, not just a slash flip.
   - On failure, the assertion message must name the offending path.

2. **Document the contract** in a short module docstring in the test (and a one
   line pointer in `backend/src/routers/journal.py` if helpful): collection
   routes are slash-terminated; clients must match. Link the frontend guard
   (sub-issue 02).

3. Confirm the test fails if you temporarily register a collection route without
   the trailing slash, then restore.

## Acceptance Criteria

- [ ] `backend/tests/test_route_contract.py` asserts every collection route is
      slash-terminated and that the known roots exist.
- [ ] The failure message names the specific offending path.
- [ ] Test fails when a collection route's slash/name is changed; passes on `main`.
- [ ] `cd backend && pytest -q` passes; coverage/docstring thresholds unchanged.
- [ ] `pre-commit run --all-files` green.

## Constraints

- This is a **test-only** change — do not alter any route, schema, or
  `redirect_slashes` setting. The goal is to pin the existing contract, not
  change behavior.
- Derive the route list from the live `app` object, not a hand-maintained copy
  that can rot — but keep an explicit expected-set assertion so renames are
  caught too.
- Conventional commit: `test(backend): guard collection routes against slash drift`.

## References

- `backend/src/main.py` — app + router mounting (route table source)
- `backend/src/routers/journal.py:62,94,179-181` — `/journal/` collection routes
- `backend/conftest.py` — existing pytest fixtures
- Sub-issue 02 — the frontend half of the same contract guard
