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

## Semantic layer (weekly)

`.github/workflows/graph-semantic.yml` runs a **weekly LLM semantic pass**
over the docs/prose corpus — cron Mondays 05:20 UTC, plus manual
`workflow_dispatch`. It never runs on push or pull_request: the pass makes
paid LLM calls, so it must not be triggerable by ordinary code changes. It
runs `graphify extract . --backend claude --token-budget 60000
--max-concurrency 2` and republishes the same rolling `knowledge-graph`
release that `graph-build` maintains, upgrading `graph-meta.json`'s `kind`
from `code-only` (AST only) to `code+semantic` (edges now carry meaning
extracted from prose).

The workflow **hard-fails** if the `ANTHROPIC_API_KEY` repo secret is
missing — it refuses to publish a docs-blind graph mislabeled as
`code+semantic`.

**Cost**: the first run is the expensive one — it pays for the full corpus
(the vendored course content alone is ~130k+ words), on the order of
single-digit dollars. graphify's semantic cache is SHA256 content-keyed per
file, and the workflow persists that cache back to the release as
`semantic-cache.tar.gz`, restoring it on the next run — so every subsequent
run only re-extracts prose that actually changed, and typically costs near
$0. Each run's token counts land in the Actions job summary; a near-zero
count means the cache was hot.

After the extract, the workflow re-clusters and re-labels the graph so its
communities carry stable, LLM-named groupings, then renders an
agent-crawlable wiki from the result:

1. **Cluster** — `graphify cluster-only . --no-viz --no-label` recomputes
   communities from graph structure alone and writes an interim,
   placeholder-named `GRAPH_REPORT.md`. `--no-viz` skips the heavy HTML
   render (unused by agents); `--no-label` defers naming to the next step
   so community names are computed exactly once.
2. **Label** — `graphify label . --missing-only --backend claude
   --batch-size 100` names communities with the LLM. `--missing-only`
   names only freshly-created communities, so existing community names
   stay stable across runs; batching 100 communities per call keeps it
   cheap. `label` re-clusters and **rewrites `GRAPH_REPORT.md` with the
   final names** as it runs, so the shipped report reflects the labelled
   communities, not the interim placeholders from step 1.
3. **Guard** — `scripts/graph/check_placeholder_labels.py` hard-fails if any
   community is left with a bare `Community <N>` placeholder, checked in all
   three artifacts a placeholder could leak through: `.graphify_labels.json`,
   the graph's node `community_name` fields, and the rewritten
   `GRAPH_REPORT.md` itself (its quoted community-heading label and its bare
   navigation-list entries). Verifying the report — a required release asset —
   rather than trusting the label step's rewrite ordering makes a
   placeholder-laden report structurally unable to ship. Same refuse-to-publish
   posture as the `ANTHROPIC_API_KEY` guard above, now applied to placeholder
   labels.
4. **Export** — `scripts/graph/wiki_export.py` renders the labelled graph
   into an agent-crawlable wiki: one `index.md` (a table of every
   community with node counts and links) plus one
   `community-<NN>-<slug>.md` article per community, grouping members by
   source file and calling out god nodes and surprising cross-community
   bridges. Packed as `wiki.tar.gz`.

Assets republished: `graph.json`, `graph-meta.json` (now `kind:
code+semantic`, with `tokens_input`/`tokens_output`), `semantic-cache.tar.gz`,
`GRAPH_REPORT.md` (now always regenerated with the final community names by the
label step and verified placeholder-free by the guard, no longer conditional on
presence), and `wiki.tar.gz` (new — the community wiki).

```bash
gh release download knowledge-graph --pattern wiki.tar.gz --dir graphify-out
```

**Known interaction**: `graph-build.yml`'s nightly forced code-only rebuild
shares the same rolling release. It can republish `graph.json` /
`graph-meta.json` and transiently reset `kind` back to `code-only` until the
next weekly semantic run re-enriches it — an eventual-consistency property of
having two writers on one release, not something this workflow resolves. That
nightly rebuild does not re-cluster, re-label, or touch the wiki — clustering,
labelling, and `wiki.tar.gz` are weekly-only, produced solely by this
workflow.

## Federation (nightly)

`.github/workflows/graph-federate.yml` runs nightly — cron 06:10 UTC, right
after `graph-build`'s 04:40 code rebuild — plus manual `workflow_dispatch`
and `repository_dispatch` (event type `graph-updated`, which a satellite
repo can send to poke a re-federation). It merges adepthood's own code graph
with the published knowledge graphs of four satellite repos (Creek-Vault,
aptitude-course, wavelength-demo, WavelengthWatch) into one
`pan-graph.json`, published on the SAME rolling `knowledge-graph` release
that `graph-build` and `graph-semantic` maintain.

The five source graphs come from two mechanisms. aptitude-course,
wavelength-demo, and WavelengthWatch commit theirs in-tree at
`graphify-out/graph.json` on `main`, fetched over
`raw.githubusercontent.com`. Creek-Vault's graph is ~30 MB and is never
committed — it ships as a rolling release asset instead. adepthood's own
graph comes from its own `knowledge-graph` release, same as above.

An unfetchable satellite logs a `::warning` and is excluded from that
build; only a missing adepthood-own graph fails the job. `pan-meta.json`
records exactly which repos made it in — `built_at`, `sha`, `graphifyy`,
`kind: pan-graph`, `nodes`, `edges`, a per-repo `repos` map (`present`,
`source_url`, `nodes`, `edges`), plus `repos_present` / `repos_missing`.

Assets publish together — `pan-graph.json` and `pan-meta.json` — never a
pan-graph without its manifest:

```bash
gh release download knowledge-graph --pattern 'pan-*.json' --dir graphify-out
```

$0 / `GITHUB_TOKEN`-only: the built-in token (`contents: write`) covers the
own-graph download and the release publish; every satellite fetch —
including Creek-Vault's release asset — is unauthenticated public HTTPS.

**GO-PRIVATE caveat**: every satellite fetch assumes the repo is public. If
any satellite ever goes private, its fetch starts 404ing *and* — the
dangerous half — a pan-graph already carrying its structure must move off
this public release; distribution needs revisiting then (an authenticated
fetch plus a private artifact store), not a token quietly wired into the
fetch step.

`repository_dispatch` here is inbound-only: a satellite would need its own
PAT to send `graph-updated`, which is out of scope for this repo.

**Three writers, one release**: `graph-build` and `graph-semantic` share
`graph.json` / `graph-meta.json` (build writes them code-only, semantic
upgrades them to `code+semantic`) **and** `GRAPH_REPORT.md` (build emits a
code-only report on its nightly full build; semantic's label step rewrites it
as a clustered, LLM-labelled one, guarded placeholder-free before publish) —
those three assets are last-writer-wins between the two, the same
eventual-consistency property noted above. `wiki.tar.gz`
is exclusive to `graph-semantic`, and `pan-graph.json` / `pan-meta.json`
are exclusive to `graph-federate`, so neither of those can be clobbered by
another writer.

**Known interaction**: like the semantic layer, the pan-graph reflects
whatever each satellite last published — if a satellite hasn't rebuilt its
own graph recently, federation faithfully merges in a stale snapshot rather
than freshening it.

## Memory loop (weekly)

Graph queries that helped — or misled — leave a durable trace so the fleet
learns from its own orientation. Two `graphify` subcommands drive it:

```bash
# After a graph-backed answer proves out (or turns out wrong), record it:
graphify save-result --question "…" --answer "…" --type query \
  --nodes NodeA NodeB --outcome useful --memory-dir graph/memory/
#   wrong turn:      --outcome dead_end
#   graph was wrong: --outcome corrected --correction "the right answer was …"

# Weekly, distil the traces into a deterministic lessons digest ($0, no LLM):
graphify reflect --memory-dir graph/memory \
  --out graph/reflections/LESSONS.md --graph graphify-out/graph.json \
  --half-life-days 30 --min-corroboration 2
```

Each `save-result` writes a small **Markdown file with YAML frontmatter**
(`type`, `date`, `contributor`, `outcome`, `source_nodes`) — not JSON. Unlike
the git-ignored `graphify-out/` build artifacts, `graph/memory/` and
`graph/reflections/` are **committed**: the traces are tiny, reviewable, and
travel with the repo, and the `detect-secrets` pre-commit gate covers them.
Record repo Q&A only — never user data or secrets.

`reflect` reweights each node by recency (`--half-life-days`) and prefers nodes
corroborated by at least `--min-corroboration` useful results; with a graph it
also drops nodes that no longer exist and groups by community. Its
auto-generated header always reads "in graphify-out/memory/" regardless of the
`--memory-dir` value — a cosmetic upstream quirk, not a path the digest
actually read. The weekly `weekly-playbook.yml` workflow regenerates
`graph/reflections/LESSONS.md` from the committed memory and feeds it to the
playbook curator as a third failure/confirmation signal alongside flare-filed
bugs and blocked review verdicts.

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
