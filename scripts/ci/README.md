# Change-aware CI

The frontend workflow already runs only for frontend changes and its audit
gate. Backend CI and E2E also call `_affected.yml`, which compares the complete
push range or a pull request's merge base with its head using Git. Deleted paths
and both sides of a rename count; unavailable history runs every lane.

| Changed input | Jobs selected in addition to backend quality |
| --- | --- |
| Docs, root guard inputs, backend meta-tests | No runtime jobs |
| Backend source | Python compatibility, OpenAPI, migrations, integration, cross-boundary guards, E2E |
| Backend unit tests | Python compatibility, OpenAPI, migrations, integration |
| Frontend source | Frontend CI, E2E; cross-boundary guards run in Frontend CI |
| Vendored content or curriculum artifacts | Content drift and E2E; non-Markdown backend inputs also select Python lanes |
| Content generation scripts | Content drift and Python lanes |
| Backend dependency files | Python lanes, content drift, E2E |
| CI selector or its tests | All lanes in both caller workflows |
| A caller workflow | All of that workflow's jobs |

Backend quality retains its existing trigger paths because its tests read
documents, graph data, scripts, and frontend dependency/security configuration.
Skipping it for those changes would leave existing repository guards blind.
Graph tests and scheduled/manual scans retain their existing scopes.

Selection happens at job level, so unrelated jobs are skipped before dependencies
are installed or Postgres services are started. Existing job names stay intact.
The caller workflows retain their existing path filters; any branch protection
requiring those workflows on unrelated changes retains its existing behavior.

When adding an input outside an existing trigger scope, update both the push and
pull-request path lists in the caller and the selector. Add an example to
`test_affected.py`; the selector workflow runs these tests before choosing jobs.

Run the offline selector tests:

```sh
python3 -m unittest discover -s scripts/ci -p test_affected.py
```
