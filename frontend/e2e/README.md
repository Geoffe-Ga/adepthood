# End-to-end lane: the real client against a real server

Every other test in this repository runs on one side of the wire. The backend
suite drives routes with an in-process client against SQLite; dozens of frontend
test files mock `src/api` outright and the rest never reach the network.
Both can be green while the two halves have never met — which is how six
shipped features turned out to be wired to nothing.

This lane is the one place they meet. It imports the production API client from
`src/api/index.ts` — unmocked, with its real Zod response validation, its real
retry and refresh loop, and a real `fetch` over a real socket — and drives it
through three journeys against a live FastAPI app on a real Postgres whose
schema was built by `alembic upgrade head`.

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
armed would make "how many journeys exist" a hidden global constraint: a fourth
journey, or one retry, would start failing on a cap rather than on a defect.
Rate limiting keeps its own tests in the backend suite.

`frontend/__tests__/e2eLaneGuard.test.ts` enforces both of those boundaries
mechanically. It runs in the ordinary frontend suite and fails if a journey ever
mocks the API module or `fetch`, if the launcher stubs anything besides the
license check, or if the CI job acquires a way to be disarmed.

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
