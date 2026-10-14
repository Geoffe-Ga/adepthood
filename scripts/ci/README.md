# Change-aware CI

The frontend workflow already runs only for frontend changes and its audit
gate. Backend CI and E2E also call `_affected.yml`, which compares the complete
push range or a pull request's merge base with its head using Git. Deleted paths
and both sides of a rename count; unavailable history runs every lane.

| Changed input | Jobs selected in addition to backend quality |
| --- | --- |
| Docs and root guard inputs | No runtime jobs |
| Backend meta-tests | Python compatibility and cross-boundary guards; no schema, Postgres, or E2E jobs |
| Backend source | Python compatibility, OpenAPI, migrations, integration, cross-boundary guards, E2E |
| Backend unit tests | Python compatibility, OpenAPI, migrations, integration, cross-boundary guards |
| Backend journey helpers (`backend/tests/e2e/`) | Python lanes, cross-boundary guards, E2E |
| Frontend source | Frontend CI, E2E; cross-boundary guards run in Frontend CI |
| Frontend runner scripts (`scripts/frontend/`) | Cross-boundary guards; no Python runtime or E2E jobs |
| Vendored content or curriculum artifacts | Content drift and E2E; non-Markdown backend inputs also select Python lanes |
| Content generation scripts | Content drift and Python lanes |
| Backend dependency files | Python lanes, cross-boundary guards, content drift, E2E |
| CI selector or its tests | All lanes in both caller workflows |
| A caller workflow | All of that workflow's jobs |

Backend quality retains its existing trigger paths because its tests read
documents, graph data, scripts, and frontend dependency/security configuration.
Skipping it for those changes would leave existing repository guards blind.
It has no dependency on the selector, so a selector failure cannot skip it.
The Python compatibility matrix has a separate selector from the runtime jobs:
all backend test changes, including script meta-tests, still run on Python 3.11
and 3.13 so incompatible test syntax or imports cannot merge undetected.
The small cross-boundary Jest lane watches all of `backend/`: its helper allows
guards to read arbitrary backend paths, including shared fixtures, configuration
examples, and contract assertions in backend tests.
It also watches `scripts/frontend/`, which owns the runner and its dependency
and lockfile helpers, so helper changes exercise the job that consumes them.
Graph tests and scheduled/manual scans retain their existing scopes.

Selection happens at job level, so unrelated jobs are skipped before dependencies
are installed or Postgres services are started. Existing job names stay intact.
Only a successful selector's explicit `false` skips a lane. A failed selector or
missing output runs the lane; cancelling the workflow still cancels its work.
The caller workflows retain their existing path filters; any branch protection
requiring those workflows on unrelated changes retains its existing behavior.

When adding an input outside an existing trigger scope, update both the push and
pull-request path lists in the caller and the selector. Add an example to
`test_affected.py`; the selector workflow runs these tests before choosing jobs.

Run the offline selector tests:

```sh
python3 -m unittest discover -s scripts/ci -p test_affected.py
```
