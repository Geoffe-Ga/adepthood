# DAST harness

Two checks live here, sharing one identity bootstrap. The authorization matrix
is documented below; the contract-fuzz job is documented at the end.

## Authorization matrix

Asks one question of every route that names an object by id -- in its path, in
its JSON request body, or in its query string: **can identity B reach identity
A's object?**

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

Optional flags: `--allowlist PATH`, `--min-routes 20`, `--min-references 5`,
`--budget-seconds 120`, `--max-allowlist-fraction 0.5`.

The CI job passes none of them, so the defaults are what actually gate: a
dimension that quietly stopped probing anything fails the run rather than
reporting clean over a surface it never touched.

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

## How one reference is probed

An id carried in a body or a query string cannot be graded on its status. `GET
/journal/?practice_session_id=` applies its filter *after* scoping to the caller,
so a foreign id there is answered `200` with an empty page -- a correct route
that status-only grading would report as a leak. So each reference runs two
cells, both sent by B, and what changes is whose object the id names:

1. `CROSS_REFERENCE` — B's own request carrying **A's** id. A denial (403/404)
   passes. A 2xx is judged on evidence: the foreign object in the response is the
   leak; its absence proves nothing on its own and is `INCONCLUSIVE` unless the
   control below has shown this request surfaces an id it *can* see.
2. `REFERENCE_CONTROL` — the identical request with **B's own** id. It has to
   both succeed and surface that id, or `require_reference_positive_controls`
   fails the run: a route whose responses say nothing about which object was
   reached makes every cross-user 2xx unfalsifiable.

Any path ids the route interpolates are seeded as B, so the request gets past the
path's own ownership check and actually reaches the body.

Evidence lives in one of three places, declared per reference in
`references.py`:

- `ECHO` — the probe's own response repeats the id it was handed.
- `LISTING` — the probe is a read, so its body is the evidence.
- `READ_BACK` — the response says nothing, so the object is read back through a
  declared follow-up `GET` issued as its owner. This is only as sharp as the read
  surface it has: a follow-up that can do no better than confirm the object is
  reachable by its owner fires on every cell, which leaves the cross cell graded
  on its status.

The `read_back_path` carries an obligation nothing can check for you: it **must
name an owner-visible surface** — one that shows the object's owner every write
made against that object, by anyone. A listing scoped to whoever *created* the
row looks identical from the registry and is silently useless. The control reads
back its own write on its own object and finds it every time, while the cross
cell's write stays hidden from the owner it landed on, so the strategy
manufactures the very absence it then grades as a pass. Where the application
offers no owner-visible surface, reach for a witness over the route's own answer
instead.

If a cell's evidence cannot be read at all — a 2xx whose body is not JSON, a
read-back the target refused or answered 5xx — the cell records that
distinctly and grades `INCONCLUSIVE`. "Nobody could look" is not "the object was
not reached": the paired control has its own healthy response, so folding the
two together would let it license a pass over a request nobody ever examined.

What counts as a hit in that evidence is a second, independent choice. The
default is a scan for the injected id. A route that answers with no id anywhere
— a check-in reports a streak, a fold reports whether the quote is still pending
— instead declares an `EvidenceWitness`: a pointer into the evidence body and
the condition that field meets only once the write has landed
(`pending: false`, `streak >= 1`). A witness *replaces* the scan for the
reference that declares it, because there is no id to find and a numeric field
that happened to equal the id would be a leak reported against a route that did
nothing.

Two things keep a witness honest. The fast suite reads the app's own OpenAPI
document and asserts every witness pointer still names a property of that
route's success response, so a rename fails on the pull request that makes it.
And if one ever slipped through, the witness would go quiet on the control as
well as on the cross cell, and `require_reference_positive_controls` would fail
the live run by name rather than let the reference slide back to status
grading.

Two guards bound the dimension from the outside, and both run against the
document the *target* published rather than the one in this repository.
`require_reference_allowlist_bounded` caps the share of discovered references an
allow-list may excuse: the path ceiling cannot see a field-scoped entry, because
such an entry excuses no route and so enters neither side of that fraction.
`require_declared_references_classified` fails the run when a reference this
registry declares was neither probed nor classified — the shape a stale
deployment produces, where a route or a property has gone and the declaration
quietly stops being counted instead of surfacing as uncovered.

The coverage floor stays an absolute number rather than a fraction of what was
discovered. A fraction computed from the target's own document shrinks with the
document, so it goes quiet in exactly the case it is there to catch.

## Adding a reference probe

Add one entry to `REFERENCE_REGISTRY` in `references.py`, keyed by
`(method, path)`:

```python
("POST", "/journal/"): ReferenceProbe(
    method="POST",
    path="/journal/",
    body={"message": "probed by the authorization matrix"},
    references=(
        ObjectReference(
            field="practice_session_id",
            location=ReferenceLocation.BODY,
            seed_key="practice_session_id",
            evidence=EvidenceStrategy.ECHO,
        ),
    ),
),
```

- `body` carries everything else the route requires. Without it the route answers
  422 before it reads the reference at all — not a denial, just a probe that
  proved nothing.
- `seed_key` names a `SEED_REGISTRY` entry, and it is frequently *not* the
  field's own name: `goal_group_id` names a goal group, whose spec is keyed
  `group_id`.
- `path_seeds` lists the path parameters the probe interpolates; they are seeded
  as the caller.
- A `LISTING` reference usually needs a seed spec that creates the row the filter
  will match and hands back the *filtered* id — a control answering with an empty
  page proves nothing, and the guard fails the run when it does.
- A `READ_BACK` reference needs a `read_back_path` naming an **owner-visible**
  surface, not a creator-scoped one. See the obligation above; getting this wrong
  produces a probe that passes forever.
- Whatever the strategy, the reference is only genuinely covered if the route's
  answer would look *different* for a foreign reference it persisted than for a
  reference it never accepted. A serializer that resolves the field through an
  owner-scoped lookup renders both as `null`, and the cell then passes on an
  absence the application produced. Declare a witness over a fact only the landed
  write produces, and where neither is possible, say so in `allowlist.toml`
  rather than declaring a probe that cannot fail.

## Adding a seed strategy

Add one entry to `SEED_REGISTRY` in `seeds.py`, keyed by the **path-parameter
name** (`entry_id`, not "journal"). Parameter names are globally consistent in
this application, which is what lets a two-parameter route be filled by resolving
each parameter independently. A spec may also earn its keep by being named as the
`seed_key` of a reference, in which case the key is whatever reads best.

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

An optional `field = "practice_id"` narrows the entry to a single body property
or query parameter of that route. It excuses that field alone: not the route's
path ids, not its other references, and not a field the route has since stopped
declaring.

`backend/tests/scripts/dast/test_registry_covers_real_app.py` enforces all of
this in the fast unit suite with no server: a new router with an id in its path
fails that test until somebody decides whether it is seedable or excused.

## Scope

Object references named in the **path**, in a **JSON request body**, and in
**query parameters**. An id that reaches the application any other way -- inside
a nested body object, in a header, in a multipart form -- is outside the matrix,
and the report prints that note on every run so a green is never read as "no BOLA
anywhere".

Four limits are worth naming rather than discovering later.

The body heuristic reads *top-level* properties of the JSON schema the operation
declares, so an id nested one object deep is invisible to it.

It also matches a **singular** `*_id`. A plural collection — `habit_ids` on
`POST /metta-return/arc/release` — is a top-level property naming other users'
objects and is **not probed**, because substituting into a list of ids is a
different mechanism from substituting a single one. Those routes are authorized
in the application today; the gap is in this harness, not in them.

A `READ_BACK` reference is only as sharp as the read surface the application
gives it: where none exists, a witness over the route's own answer is the sharper
instrument, and where neither is available the cell falls back to being graded on
its status.

And a body- or query-carried id is covered only **where the response
distinguishes a foreign reference from an absent one**. Grading a cross-user 2xx
on the absence of the foreign id assumes the route renders a reference it
persisted the same way whoever owns the object it names — an assumption the
paired control cannot establish, because the control only ever shows the route
surfacing an id the caller *owns*. A serializer that resolves the field through
an owner-scoped lookup, or a read-back through a creator-scoped surface, renders
a persisted foreign id exactly as it renders none, and the cell passes with the
row on disk. Closing that needs a third probe establishing that the route
surfaces a foreign reference when it has one. Until it lands, a green here means
"no reference leak was observable in the answers these routes give" — not "no
reference leak happened".

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

Before the job trusts the fuzzer against the real application, it proves the
fuzzer can fail. The `Prove the fuzzer catches a planted bug` step runs
`backend/tests/scripts/dast/test_contract_fuzz_catches_a_planted_bug.py`, which
serves a deliberately broken `FastAPI` app over a real socket — one handler that
raises (a 500) and one that returns `{"count": "not-a-number"}` against a
published `{"count": integer}` — runs the real `contract_fuzz.sh` against it,
and requires the run to fail naming both findings. It then serves the repaired
twin and requires that run to pass *with every operation reached*, because
"green" and "fuzzed nothing" are the two states this whole gate exists to tell
apart. Argv assertions can only prove the command was built correctly; this is
the only thing that proves the checks fire.

That suite needs the `schemathesis` executable and deliberately does not use
`pytest.importorskip`. Where the tool is absent it skips with a reason naming
`requirements-dast.txt` and the `DAST_LANE_REQUIRE_SCHEMATHESIS` variable; the
workflow sets that variable, so in the one environment that installs the tool a
missing tool is a red job rather than a quiet pass. Nothing in Python imports
`schemathesis` — the CLI is driven by subprocess, exactly as CI drives it — so
`mypy --strict` never has to resolve a package that only one workflow installs,
and no suppression is needed anywhere.

**The job is a pull-request gate.** Its triggers are `pull_request`, `push`
scoped to `branches: [main]`, and `workflow_dispatch`; both event triggers are
filtered on paths `backend/**` and `.github/workflows/dast-contract.yml`. That
list is exactly what the gate consumes and nothing wider: the application
under `src/`, `alembic.ini` and the migrations, `scripts/dast/contract_fuzz.sh`,
the requirements files, and the self-proof suite. It deliberately excludes
`scripts/backend/**`, even though `backend-ci.yml` has to include that
directory: `scripts/backend/export_openapi.py` writes the checked-in OpenAPI
export, and this job never reads that export — it reads the document the
running app publishes about itself, so a change confined to the export changes
nothing this gate measures. The workflow's own path is in the filter too, so
the gate cannot be edited into doing less while no run exists to prove it.
`push` is scoped to `main` rather than left open, because an unscoped `push`
fires on every push to a PR branch as well as on merge, starting two identical
runs seconds apart — one from `push`, one from `pull_request` — and this
workflow did exactly that on 2026-08-25.

What unblocked the promotion is that the blocking findings are gone. A
`workflow_dispatch` run against `main` — run 33039651652, commit 479c1f3d —
concluded success: "Operations: 116 selected / 128 total", all 116 tested,
"116 passed", all four checks enabled (`not_a_server_error`,
`content_type_conformance`, `response_schema_conformance`,
`status_code_conformance`), and no failure-cap truncation. The run this
paragraph used to describe was the opposite of that: 19 operations answering
`500` to an out-of-`int32` path parameter, and a report truncated before 41 of
the selected operations were even reached.

There is no scheduled run any more. Every input to a run here is pinned — the
fuzz seed is fixed at `1337` in `contract_fuzz.sh`, Schemathesis is pinned
`==` in `requirements-dast.txt`, and the actions in this workflow are
SHA-pinned — so a cron firing against unchanged code cannot discover anything
a previous run did not already report: it is a bit-identical repeat. Anything
that could change the answer changes a file under `backend/**`, which now
starts a run with an author and a pull request attached instead. The schedule
also earned nothing empirically: across this workflow's whole history it
fired exactly once, on 2026-08-26, that run failed, and no issue or fix
followed from it.

`continue-on-error` on the `pull_request` trigger was considered and rejected,
not merely never added: it would produce a permanently green report of a
permanently red run, which is worse than not having the job at all.
`test_contract_workflow.py` asserts the string never appears in the workflow.

Measured across five successful runs, the whole job — Postgres service
startup, install, migration, instance boot, token mint, and the fuzz itself —
takes 64-78 seconds end to end.

Running on `pull_request` does not, by itself, make this a required check.
This repository has no branch protection and no rulesets on `main`, so
nothing here blocks a merge automatically; that would need a human to add a
ruleset naming this job.

Four checks are enabled — `not_a_server_error`, `content_type_conformance`,
`response_schema_conformance` and `status_code_conformance`. The last of those
was held back for a measured property of this API rather than a preference: not
one of its 128 operations declared a `401`, `403`, `404` or `429` response, so
it measured a documentation gap rather than a fuzzing finding. It went on once
`error_responses.build_router` gave every operation the refusals it can actually
send.

`content_type_conformance` is the check with the narrowest target: it can only
fail where a response answers with something other than what its operation
publishes, and every operation returning `application/json` passes it by
construction. `GET /users/me/export/journal.md` is the one body on this API that
is not JSON, which makes it the only operation that check can be exercised
against — so it must never be excluded from the run, and
`test_contract_fuzz_script.py` fails if it is.

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
not a 5xx and is a refusal every operation now declares, so all four enabled
checks pass and the job reports success having reached no handler. Those two
are the only operations reachable by the fuzzer that do this: a sweep of the
auth and user routers found `_revoke_token_payload` called from
`/auth/refresh` alone, and the only other credential-invalidating path
(`password_changed_at`, advanced by
`/auth/password-reset/confirm`) needs a reset token the fuzzer cannot mint.

Schemathesis is pinned in `backend/requirements-dast.txt` rather than
`requirements-dev.txt`; that file's header says why.

The instance is started with `ADEPTHOOD_DEFAULT_RATE_LIMIT` set wide. The matrix varies
`X-Forwarded-For` per request to stay under the global limit, but the
Schemathesis CLI sends one fixed header set for a whole run and cannot, so
without a wider default the fuzzer would spend its budget collecting 429s — a
uniform denial none of the enabled checks can tell apart from a healthy API. No
deployment sets that variable; `backend/src/rate_limit.py` refuses to start on a
value it cannot parse rather than falling back to no limit at all. The name is
namespaced on purpose: a bare `DEFAULT_RATE_LIMIT` is one another tool in the
same environment may already own, and this knob both loosens a global limit and
refuses to boot on an unparseable value.

The JUnit report is uploaded as a build artifact, and Schemathesis prints a
reproduction `curl` for every finding — so the question of whether the bearer
token lands in it is a real one. Checked against 4.25.2: it does not. The
library filters the headers it was handed, rendering them as `Authorization:
[Filtered]`. Nothing in this repository redacts anything, because machinery for
a leak that does not exist is machinery that rots the day the library changes.
Instead the planted-bug suite asserts both halves — that the filtered marker is
present, proving the header really was sent, and that the sentinel token appears
nowhere in the report or the output — so a library upgrade that stopped
filtering fails the build.

## Deep API scan (OWASP ZAP)

The third check in this family, and the only one that does not run on a pull
request. `.github/workflows/dast-deep.yml` boots an ephemeral instance against
Postgres at **04:00 UTC nightly** (and on `workflow_dispatch`), imports the
document that instance publishes about itself into OWASP ZAP, and lets ZAP spend
up to twenty minutes sending the payloads a schema-aware fuzzer never sends —
traversal strings, injection probes, malformed encodings — at every published
operation, while the passive rules read every response that comes back.

**Where the results land.** Findings are converted to SARIF and published to the
repository's **Security tab**, where they get history, deduplication and
dismissal tracking. The raw JSON — the file the remediation loop reads — is
uploaded as the `dast-deep-report` artifact with 30-day retention.

**It reports; it does not block.** No branch waits on this job's colour, and
ZAP's own findings never redden it (`fail_action: false`). A nightly gate that
can fail for a reason nobody chose is a gate that gets muted, and a muted gate is
worse than none. What *does* redden the run is the harness failing — the instance
never becoming ready, the token not working, ZAP writing no report — because
those are exactly the states in which a clean-looking result means nothing was
scanned. Those open a tracking issue through the shared failure reporter.

**API scan, not baseline.** A ZAP baseline run spiders for links and forms. This
application serves JSON, has no HTML and nothing to crawl, so a spider would
visit one URL, find no links, and report a clean sweep of nothing. The passive
header rules still run and are still the point of the passive half: they turn
`backend/src/middleware/security_headers.py` from a control this repository
asserts into one an attacker's-eye view confirms.

**Rule dispositions** live in `.zap/rules.tsv`, one named rule per line with the
reason it cannot apply written beside it. ZAP's blanket `-I` — pass every
warning at once — is forbidden, and `test_deep_scan_workflow.py` fails the build
if it appears, if a suppression carries no reason, if the list grows past a
handful, or if any of the five header rules that verify the middleware is ever
silenced.

**The target is always an instance the job started itself.** There is no staging
deployment to point at, and aiming a nightly attack scan at one that appears
later would be an unauthorized-scan incident rather than a CI change — so the
target is the loopback instance, and a test fails the build if any other host is
named in the workflow.

### Running it locally

```bash
cd backend
# 1. Start an instance the way the job does, with the limiter widened.
ADEPTHOOD_DEFAULT_RATE_LIMIT=60000/minute PYTHONPATH=src \
    python -m uvicorn main:app --host 127.0.0.1 --port 8000 &

# 2. Mint a credential over the real auth stack.
export DAST_TOKEN=$(PYTHONPATH=src python -m scripts.dast.tokens \
    --base-url http://127.0.0.1:8000 --database-url "$DATABASE_URL")

# 3. Run the same ZAP image the job runs.
docker run --rm --network=host -v "$PWD/../:/zap/wrk/:rw" \
    -e ZAP_AUTH_HEADER=Authorization \
    -e ZAP_AUTH_HEADER_VALUE="Bearer $DAST_TOKEN" \
    -e ZAP_AUTH_HEADER_SITE=127.0.0.1 \
    -t ghcr.io/zaproxy/zaproxy:stable zap-api-scan.py \
    -t http://127.0.0.1:8000/openapi.json -f openapi \
    -J report_json.json -c .zap/rules.tsv -O http://127.0.0.1:8000 -T 20

# 4. Convert what it found, and read the summary it prints.
PYTHONPATH=src python -m scripts.dast.zap_sarif \
    --report ../report_json.json --sarif ../report_sarif.sarif
```

`scripts/dast/zap_sarif.py` exits `3` — the same "harness error" code the rest of
this package uses — when the report is absent, truncated, or not a ZAP report,
and writes no SARIF file in that case. That is deliberate: an empty SARIF run is
valid, uploads without complaint, and renders as a clean Security tab, so a scan
that did not happen must never be able to look like one that found nothing.
