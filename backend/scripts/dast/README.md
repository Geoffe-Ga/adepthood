# DAST harness

Two checks live here, sharing one identity bootstrap. The authorization matrix
is documented below; the contract-fuzz job is documented at the end.

## Authorization matrix

Asks one question of every route that names an object by id in its path: **can
identity B reach identity A's object?**

The in-process suite (`backend/tests/security/test_idor.py`) already pins the
specific ownership rules. This harness is the one that exercises the whole stack
over a real socket, against the application's *own* OpenAPI document, so a route
that lands without an ownership check is caught the day it ships rather than the
day somebody remembers to write a test for it.

## Running it locally

```bash
cd backend
PYTHONPATH=src python -m scripts.dast.authz_matrix \
    --base-url http://127.0.0.1:8000 \
    --database-url "$DATABASE_URL"
```

`--database-url` is the async URL the instance itself is serving from: the two
identities are inserted through the application's own ORM, because signup is
gated on a live license verification that cannot be satisfied across a socket.
Both tokens are then minted over the real `POST /auth/login`, so every credential
the matrix sends came out of the genuine auth stack.

Both targets are required and neither has a default: a defaulted base URL is how
a run silently probes the wrong instance.

The instance must be started with `TRUSTED_PROXY_CIDRS=127.0.0.1/32`. The matrix
sends a distinct `X-Forwarded-For` per request so the application's global
per-minute rate limit cannot turn the run into a page of uniform, meaningless
denials; without that setting the header is ignored (correctly) and the run will
fail on the throttling guard.

Optional flags: `--allowlist PATH`, `--min-routes 20`, `--budget-seconds 120`,
`--max-allowlist-fraction 0.5`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The matrix ran, every cell passed, nothing was left uncovered. |
| `1` | An authorization finding: a foreign object was reached, or a probe returned a status that is not a denial. |
| `2` | A route has neither a seed strategy nor an allow-list entry. |
| `3` | A vacuity guard tripped: the run proved nothing. |

`3` outranks `1` on purpose. A run that could not prove anything must be louder
than a run that proved everything was fine.

An instance that cannot be reached, a database that will not take the identity
rows, an `/openapi.json` that never arrives — all of those are `3` as well, via
the `require_live_stages_completed` guard, and the report names the stage, the
target, and the error. That is not a detail: an uncaught exception exits `1`,
which is bit-for-bit the code for a real finding, so a harness that let one
escape would report "we found a BOLA" every time the instance was simply down.

## How one route is probed

A fresh object is seeded **per cell**, as identity A, and then four cells run in
this order:

1. `CROSS_USER` — B's token against A's object. 403 or 404 passes; a 2xx is the
   leak, a 401 means B's own credential is broken, a 429 means the limiter
   answered instead of the application.
2. `UNAUTH` — no token. Only 401 passes.
3. `FORGED_JWT` — a well-formed token signed with a key generated on the spot.
   Only 401 passes.
4. `POSITIVE_CONTROL` — A against her own object, **last**. Only a 2xx passes.

The last cell is what makes the first one mean anything: a route whose object was
never really created, or whose replay body was rejected as invalid, denies
everybody equally, which reads exactly like a correctly guarded route. Running it
last, on its own fresh object, is what keeps a destructive cross-user leak
reportable instead of collapsing into a harness error.

## Adding a seed strategy

Add one entry to `SEED_REGISTRY` in `seeds.py`, keyed by the **path-parameter
name** (`entry_id`, not "journal"). Parameter names are globally consistent in
this application, which is what lets a two-parameter route be filled by resolving
each parameter independently.

```python
"widget_id": SeedSpec(
    create_method="POST",
    create_path="/widgets/",
    payload={"name": "DAST widget {unique}"},
    id_pointer=("id",),
),
```

- `{unique}` in any string is replaced with a fresh random token, which is what
  keeps a slug or a name from colliding with the object seeded for the previous
  cell.
- `{some_id}` is replaced with an object seeded earlier in the same cell. Every
  parameter a `create_path` interpolates must also appear in `depends_on`.
- `id_pointer` reads the new id out of the response, traversing lists as well as
  objects: `("goals", 0, "id")`.

If the operation is a mutating verb that requires fields, add a matching entry to
`REPLAY_BODIES` too. Without one the replay is answered 422 before the ownership
check ever runs, and the positive control turns the route inconclusive.

## Adding an allow-list entry

Only when no seed strategy can work. Prefer a seed strategy every time — the
allow-list may never excuse more than half the routes that carry a path
parameter, and every entry has to keep matching a live route or the build fails.

```toml
[[route]]
method   = "GET"
path     = "/course/content/{content_id}"
category = "shared_catalog"
reason   = "global course catalog; no per-user owner to cross"
```

Categories: `shared_catalog`, `not_object_scoped`, `admin_only`,
`capability_token`, `no_seed_strategy`, `known_leak`. Only `known_leak` may carry
`tracking_issue`, so nothing else can be made to look tracked.

`backend/tests/scripts/dast/test_registry_covers_real_app.py` enforces all of
this in the fast unit suite with no server: a new router with an id in its path
fails that test until somebody decides whether it is seedable or excused.

## Scope

Object references in the **path** only. Ids carried in query parameters or
request bodies are not covered, so a green run must never be read as "no BOLA
anywhere". The report prints that note on every run for the same reason.

## Known coverage gap

The path-only scope above is structural, not an oversight in the registry.
`RouteSpec` and `is_object_scoped` in `discovery.py` derive object-scoping
purely from templated path-parameter names, so a body field is invisible to
the matrix from the start. `replay_body()` in `seeds.py` then returns the
configured `REPLAY_BODIES` entry verbatim -- only *create* payloads are run
through `render_payload`, so a replay body is never rewritten to reference an
id the harness seeded. Seeding itself always runs as the owner identity
(every create in `runner.py` sends `session.owner.token`), so there is no
object seeded as the intruder for a forged body to point at. And denial
grading is global rather than per-route -- `_ACCEPTABLE_DENIALS` in
`verdict.py` accepts both 403 and 404 for every route alike -- so no
per-endpoint expectation exists to get wrong either.

`PUT /goals/{goal_id}` shows the gap without any registry bug: it is
registered, seeded, and probed like every other route, and its cross-user
cell against `goal_id` in the path is a clean denial. The leak was in
`goal_group_id`, a field of the replay *body*, which the matrix has no
mechanism to vary per credential or point at a foreign object. Closing this
class needs, at minimum: seeding at least one object as the intruder
identity, templating replay bodies the way create payloads already are, a
registry describing which body fields carry object references, a matching
`Cell` variant, and new assertions in `test_registry_covers_real_app.py`.

`POST /journal/` is a second, independent instance of the same class, found
by hand rather than by the harness. It is even further outside the matrix's
reach than `goals` was: its path is `/journal/`, with no id in it at all, so
`is_object_scoped` in `discovery.py` never puts it in the object-scoped set
to begin with, and `classify_routes` in `policy.py` leaves a route with no
path parameters out of the count entirely rather than probing or excusing
it -- there was no cross-user cell to run, clean or otherwise. The two
foreign-object references, `user_practice_id` and `practice_session_id`,
were both carried in the request body and are now checked in-app by
`resolve_owned_user_practice` and `resolve_owned_practice_session` in
`backend/src/dependencies/ownership.py`. Two instances of this class, found
by hand in two different routes the matrix has run green on, is what makes
the gap systemic rather than a one-off in `goals`: a clean matrix report is
still not a claim that no other route has an unguarded body reference.
Issue #2124 tracks closing the body-parameter gap described above; nothing
in this change closes it.

## Minting a token: `tokens.py`

Both checks need the same thing before they can start, and neither can get it
the way a user would. Signup is gated on a live license verification that cannot
be satisfied across a socket, so `tokens.py` inserts a user row through the
application's own ORM, hashes it with the application's own hasher, and then
mints the token over the real `POST /auth/login`. Only the row creation is
bypassed; every credential either check sends came out of the genuine auth
stack. The matrix imports `mint_identities` for its owner/intruder pair.

It is also a command, which is how the contract-fuzz job gets its credential:

```bash
cd backend
TOKEN=$(PYTHONPATH=src python -m scripts.dast.tokens \
    --base-url "$BASE_URL" --database-url "$DATABASE_URL")
```

Stdout carries the bare token and nothing else, because the caller splices it
straight into an `Authorization` header; every diagnostic goes to stderr. Before
printing anything the command spends the token once on an authenticated route
and exits `3` if that probe is not a 2xx. That guard is the whole reason this is
a module rather than two lines of shell: a fuzz run holding a broken credential
is denied uniformly, violates none of its response checks, and reports a clean
gate having reached no handler at all.

## Contract fuzz

`.github/workflows/dast-contract.yml` boots the same kind of ephemeral instance
and property-fuzzes every operation in the document *that instance publishes*,
using Schemathesis. Reading the live `/openapi.json` rather than the checked-in
export is the point: the spec the gate judges against cannot drift away from the
code it is judging.

The command itself is `backend/scripts/dast/contract_fuzz.sh`, not an inline
`run:` block, and that is a testability decision. A YAML block can only be
asserted about by grepping the file, and a substring search cannot tell a live
invocation from a commented-out one — the first version of this job's guard
passed with the whole fuzz command commented out and with the exclusion list
wired to no argument at all. The script is executed instead, by
`backend/tests/scripts/dast/test_contract_fuzz_script.py`, with a recording stub
named `schemathesis` first on `PATH`; every assertion there is about the argv
the script actually built. It reads `BASE_URL`, `DAST_TOKEN` and `REPORT_DIR`
from the environment, refuses to run if any is missing, takes no arguments (an
argument would be a way to append a filter the exclusion cap cannot see), and
`exec`s the fuzzer so that no trailing command can stand between a failing run
and a failing job.

**The job is not a pull-request gate yet.** It runs nightly and on
`workflow_dispatch`. Its first honest run — with the token-revoking operation
excluded, so the credential survives the whole run — is red: 19 operations
answer `500` to an out-of-`int32` path parameter, and the failure cap truncates
before 41 of the selected operations have been looked at. Making that a required
check would red every backend PR for bugs its author did not write, which is how
a gate gets muted. The follow-up issue tracking those 500s also tracks promoting
this job back to `pull_request`. Adding `continue-on-error` instead would be
worse than not having the job: a permanently green report of a permanently red
run.

Three checks are enabled — `not_a_server_error`, `content_type_conformance` and
`response_schema_conformance`. `status_code_conformance` is not, and the reason
is a measured property of this API rather than a preference: not one of its 128
operations declares a `401`, `403`, `404` or `429` response, so the check would
fail almost everywhere for a documentation gap rather than a fuzzing finding.
Issue #2425 tracks declaring those responses and turning the check on.

Operations are excluded **by exact name, with a reason on the same line**, never
by a path pattern — a named exclusion has to be defended and a pattern quietly
grows. `test_contract_fuzz_script.py` checks every name in that list against the
operations the application actually publishes, so a renamed route turns red
instead of leaving a dead line behind; proves each name reaches the fuzzer as an
`--exclude-name` argument; fails if any other `--exclude-*`/`--include-*` filter
appears, since a class filter is how the list stays small on paper while the run
shrinks; and fails if the list ever excuses half the API.

Two exclusions are load-bearing, and both destroy the credential the run depends
on: `DELETE /users/me` deletes the fuzzing identity, and `POST /auth/refresh`
revokes the presented token's `jti` before minting its replacement. Losing the
credential mid-run is invisible — every later request answers `401`, which is
not a 5xx and is undeclared on every operation, so all three enabled checks pass
and the job reports success having reached no handler. Those two are the only
operations reachable by the fuzzer that do this: a sweep of the auth and user
routers found `_revoke_token_payload` called from `/auth/refresh` alone, and the
only other credential-invalidating path (`password_changed_at`, advanced by
`/auth/password-reset/confirm`) needs a reset token the fuzzer cannot mint.

Schemathesis is pinned in `backend/requirements-dast.txt` rather than
`requirements-dev.txt`; that file's header says why.

The instance is started with `DEFAULT_RATE_LIMIT` set wide. The matrix varies
`X-Forwarded-For` per request to stay under the global limit, but the
Schemathesis CLI sends one fixed header set for a whole run and cannot, so
without a wider default the fuzzer would spend its budget collecting 429s — a
uniform denial none of the enabled checks can tell apart from a healthy API. No
deployment sets that variable; `backend/src/rate_limit.py` refuses to start on a
value it cannot parse rather than falling back to no limit at all.
