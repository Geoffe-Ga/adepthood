# scripts/graph — Adepthood code knowledge graph

A pinned, reproducible knowledge-graph toolchain. It turns this monorepo into a
queryable graph of code entities (files, classes, functions, calls, imports)
using [graphify](https://github.com/Graphify-Labs/graphify) (PyPI `graphifyy`,
pinned in [`requirements.txt`](./requirements.txt)).

Code extraction is a **tree-sitter AST** pass: local, deterministic, and free —
no LLM calls and no API keys. Any environment (dev laptop, Ralph worktree, CI,
web session) can produce or refresh the graph with one command.

## Why `graphify-out/` is git-ignored here

The build writes ~17 MB of artifacts to `graphify-out/graph.json`. With several
parallel Ralph worktrees each rebuilding it, committing the output would put
huge, churning diffs into every PR. So `graphify-out/` is git-ignored in this
repo; distribution happens later via a rolling GitHub Release. Rebuild it
locally whenever you need it.

## Commands

```bash
./scripts/graph/build.sh    # full code-only extract → graphify-out/graph.json
                            # prints "<nodes> nodes / <edges> edges"
./scripts/graph/update.sh   # incremental AST-only refresh; exit 0 when clean
```

Both scripts install the pinned toolchain into the active environment only if
the `graphify` CLI is missing, then operate on the repo root. Activate your
`.venv` first so the install lands there.

## `GRAPHIFY_FORCE`

graphify has a **shrink guard**: a rebuild that would produce fewer nodes than
the existing `graph.json` refuses to overwrite it, protecting against a
truncated or partial extract. The scripts never pass `--force`.

After you intentionally delete files (so a smaller graph is expected and
correct), re-run with the guard bypassed:

```bash
GRAPHIFY_FORCE=1 ./scripts/graph/build.sh
```
