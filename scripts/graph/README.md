# scripts/graph — Adepthood code knowledge graph

A pinned, reproducible knowledge-graph toolchain. It turns this monorepo into a
queryable graph of code entities (files, classes, functions, calls, imports)
using [graphify](https://github.com/safishamsi/graphify) (PyPI `graphifyy`,
pinned in [`requirements.txt`](./requirements.txt)).

Code extraction is a **tree-sitter AST** pass: local, deterministic, and free —
no LLM calls and no API keys. Any environment (dev laptop, Ralph worktree, CI,
web session) can produce or refresh the graph with one command.

## Why `graphify-out/` is git-ignored here

The build writes ~17 MB of artifacts to `graphify-out/graph.json`. With several
parallel Ralph worktrees each rebuilding it, committing the output would put
huge, churning diffs into every PR. So `graphify-out/` is git-ignored in this
repo; distribution happens via a rolling GitHub Release. Rebuild it locally
whenever you need it, or fetch the latest published graph in seconds.

## Fetching the published graph

The `graph-build` workflow (`.github/workflows/graph-build.yml`) keeps `main`
carrying a graph that is at most 24h fresh, published as a **rolling release**
tagged `knowledge-graph`. It re-uploads three assets in place on every run —
`graph.json`, `graph-meta.json` (build provenance: `built_at`, `sha`, node /
edge counts, pinned `graphifyy` version, `kind`), and `GRAPH_REPORT.md` when
present. Any environment can pull the current graph without rebuilding:

```bash
gh release download knowledge-graph --pattern graph.json --dir graphify-out
```

The `knowledge-graph` git tag stays pinned at the commit where the release was
first created; it is **not** a version marker. The authoritative build identity
is `graph-meta.json`'s `sha` field, which tracks the commit each upload was
built from.

## Commands

```bash
./scripts/graph/build.sh    # full code-only extract → graphify-out/graph.json
                            # prints "<nodes> nodes / <edges> edges"
./scripts/graph/update.sh   # incremental AST-only refresh; exit 0 when clean
```

Both scripts install the pinned toolchain into the active environment only if
the `graphify` CLI is missing, then operate on the repo root. Activate your
`.venv` first so the install lands there.

## Provenance

The PyPI distribution is named `graphifyy` (double-y) while the upstream project
and CLI are named `graphify` (single-y). The extra `y` is a name-availability
quirk, not a typosquat: there is **no** `graphify` package on PyPI (the name
404s), so `graphifyy` has no same-named victim to impersonate. The upstream
source lives at [`safishamsi/graphify`](https://github.com/safishamsi/graphify),
which is the homepage/repository declared on the PyPI project page; its summary
matches this toolchain's purpose — turning a folder of code and docs into a
queryable knowledge graph for an AI assistant. The project had 185 releases at
verification time. Verified 2026-07-17 against the pin `graphifyy==0.9.17` in
[`requirements.txt`](./requirements.txt).

## `GRAPHIFY_FORCE`

graphify has a **shrink guard**: a rebuild that would produce fewer nodes than
the existing `graph.json` refuses to overwrite it, protecting against a
truncated or partial extract. The scripts never pass `--force`.

After you intentionally delete files (so a smaller graph is expected and
correct), re-run with the guard bypassed:

```bash
GRAPHIFY_FORCE=1 ./scripts/graph/build.sh
```
