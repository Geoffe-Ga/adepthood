# Authorization-matrix DAST harness

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
