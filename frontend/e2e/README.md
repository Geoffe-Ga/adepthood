# End-to-end lane: the real client against a real server

Every other test in this repository runs on one side of the wire. The backend
suite drives routes with an in-process client against SQLite; dozens of frontend
test files mock `src/api` outright and the rest never reach the network.
Both can be green while the two halves have never met — which is how six
shipped features turned out to be wired to nothing.

This lane is the one place they meet. It imports the production API client from
`src/api/index.ts` — unmocked, with its real Zod response validation, its real
retry and refresh loop, and a real `fetch` over a real socket — and drives it
through the journeys registered in `journeys.json` against a live FastAPI app on
a real Postgres whose schema was built by `alembic upgrade head`.

## Running it locally

```bash
docker run -d --name adepthood-e2e-pg \
  -e POSTGRES_USER=aptitude -e POSTGRES_PASSWORD=aptitude -e POSTGRES_DB=aptitude \
  -p 5432:5432 postgres:16

cd frontend
TEST_POSTGRES_URL=postgresql+asyncpg://aptitude:aptitude@localhost:5432/aptitude npm run test:e2e  # pragma: allowlist secret
```

The account in `TEST_POSTGRES_URL` needs `CREATE DATABASE`. The lane never
touches the database that URL names: it creates a randomly-suffixed one beside
it, migrates it, and drops it at teardown.

Python has to be able to import the backend. The lane uses `E2E_PYTHON` if set,
falls back to the repo's `.venv/bin/python`, and finally to `python3`. Inside a
git worktree the virtualenv is one level up and will not be found, so point at
it explicitly:

```bash
E2E_PYTHON=/path/to/adepthood/.venv/bin/python npm run test:e2e
```

## What is real, and the one thing that is not

Real: the routers, the middleware stack, CORS, session handling, the Pydantic
schemas, the migrations, the startup seeders, the JWTs, bcrypt password hashing,
Postgres constraints — and, on the client side, every wrapper, header, query
string and Zod schema in `src/api/index.ts`.

Stubbed: exactly one function, `routers.auth.verify_aptitude_license`. Signup is
gated on a live HTTPS call to Gumroad's license API, and an e2e lane that
depended on a third party's uptime would be a flake generator. `backend/conftest.py`
stubs the same seam for the same reason. Everything the gate does with the
answer — the duplicate-email refusal, the password hashing, the entitlement
grant — still runs for real.

The launcher also disarms the rate limiter. Signup is capped at three per minute
per client address and every journey here shares `127.0.0.1`, so leaving it
armed would make "how many journeys exist" a hidden global constraint: one more
journey, or one retry, would start failing on a cap rather than on a defect.
Rate limiting keeps its own tests in the backend suite.

`frontend/__tests__/e2eLaneGuard.test.ts` enforces both of those boundaries
mechanically. It runs in the ordinary frontend suite and fails if a journey ever
mocks the API module or `fetch`, if the launcher stubs anything besides the
license check, or if the CI job acquires a way to be disarmed.

## The ledger

`journeys.json` beside these specs is the repository's journey coverage ledger:
every critical journey, the surfaces it crosses (screen → client wrapper →
route → table), and either the spec that covers it or the issue tracking the
gap. It is not documentation. `npm run check:journeys` — and the
`journey-ledger` job in `.github/workflows/e2e.yml` — audits every claim in it
against the tree, and goes red when a covering spec is renamed, deleted or
turned off, when a spec here is not declared, or when a crossed surface no
longer exists under the name the ledger gives it.

Honest gaps are the point. A journey may declare `status: "uncovered"` with a
linked issue; the gate counts it and reports it and does not fail on it, because
a gate that goes red for accurate bookkeeping is a gate that gets deleted.
Omitting an uncovered journey to keep the number down is the one thing the
ledger cannot catch and the one thing that would make it worthless. An uncovered
journey names no `coveredBy`: claiming a spec while counting as a gap would drop
that spec out of the covered tally and out of the "no journey registers it"
check at once, which is coverage disappearing quietly — the exact thing this
ledger exists to prevent.

"Turned off" is judged per test registration rather than by searching the file
for marker text. A spec that parks one `it.skip` beside a live journey test
still covers the journey; a spec whose only live test sits inside a
`describe.skip` does not; and a spec narrowed by `.only` fails whatever else it
contains, because the tests `.only` silences are exactly the ones the ledger is
claiming. A comment or a test name that merely mentions `it.skip(` is not a
skipped test.

The checker lives at `frontend/__tests__/journeyLedger.ts` with the repository's
other structural guards, and is exercised by `journeyLedger.test.ts` against
synthetic fixtures for each failure mode — so the gate is proven to fire, not
merely proven to be green.

## No skips, ever

An absent Postgres, a server that will not boot, or a health probe that answers
wrong all throw. There is no conditional skip anywhere in the lane, because a
lane that quietly passes without making a request is precisely the gap it was
built to close.

## Teardown

`globalTeardown` SIGTERMs the server's process group, escalates to SIGKILL after
ten seconds, and then drops the database. The server cannot reliably drop its
own: uvicorn re-raises the signal that stopped it, ending the process before any
`finally` of its own runs. If the whole jest process is itself SIGKILLed, one
randomly-named database survives — it can never collide with a later run, and
`DROP DATABASE IF EXISTS adepthood_e2e_<suffix>` cleans it up.
