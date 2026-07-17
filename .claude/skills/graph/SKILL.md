---
name: graph
description: >-
  Query the Adepthood knowledge graph to orient before reading code: what
  connects two modules, the impact of changing a symbol, a plain-language
  explanation of a node, or the graph's freshness/status. Use when the user
  says "query the graph", "what connects X and Y", "impact of changing X",
  "what depends on X", "is the graph fresh", "/graph", or wants a graph-first
  answer instead of a blind file sweep. Wraps the graphify query, path,
  explain, and affected subcommands plus a graph-meta.json freshness check, and
  defaults to the federated pan-graph.json when it is present. Do NOT use to file bugs or
  features (use flare), to run code-quality or slop audits (use de-slopify),
  or to build or refresh the graph itself (run scripts/graph/build.sh or
  scripts/graph/update.sh).
metadata:
  author: Geoff
  version: 1.0.0
---

# Graph

Answer a codebase question from the knowledge graph before sweeping files by
hand. This skill is a thin, accurate wrapper over the `graphify` CLI and the
graph's provenance metadata — it never duplicates the CLI reference, which
lives in `scripts/graph/README.md`.

## Instructions

### Step 1 — Pick the graph, restore it if missing

Read subcommands default to `graphify-out/graph.json`. Prefer the federated
`graphify-out/pan-graph.json` when it exists — it also carries the four
satellite repos — by passing `--graph graphify-out/pan-graph.json`.

```bash
GRAPH=graphify-out/graph.json
[ -f graphify-out/pan-graph.json ] && GRAPH=graphify-out/pan-graph.json
```

If neither file exists, the graph has not been restored. In a normal Claude
Code session the SessionStart hook (`.claude/hooks/session-start.sh`)
already fetches it from the rolling `knowledge-graph` release, skipping the
download when a local copy is under 48h fresh. If it is genuinely absent,
restore it manually (this is the exact command that hook and
`scripts/graph/README.md` use):

```bash
gh release download knowledge-graph --pattern graph.json --dir graphify-out
gh release download knowledge-graph --pattern 'pan-*.json' --dir graphify-out  # optional: federated graph
```

If the release is unreachable, build a local code-only graph with
`./scripts/graph/build.sh` (~2 min, local AST extract — no LLM or API cost;
first run pip-installs the pinned toolchain). If you cannot get a graph at
all, say so and fall back to Grep/Glob rather than inventing an answer.

### Step 2 — Choose the verb

| Question | Command |
| --- | --- |
| "what does X do / what's near it" | `graphify explain "X" --graph "$GRAPH"` |
| "how do A and B relate" | `graphify path "A" "B" --graph "$GRAPH"` |
| "what depends on X / blast radius" | `graphify affected "X" --graph "$GRAPH"` |
| open-ended "where is Y handled" | `graphify query "<question>" --graph "$GRAPH"` |
| "is the graph present / fresh" | read `graphify-out/graph-meta.json` (Step 3) |

`query` caps output with `--budget N` (default 2000 tokens); `affected` takes
`--depth N` and `--relation R`. See `scripts/graph/README.md` for the full flag
set — do not guess flags.

### Step 3 — Status is a metadata read, not a subcommand

graphify has no `status` subcommand. Report graph status by reading the
provenance file `graphify-out/graph-meta.json` (or `pan-meta.json` for the
federated graph), which records `built_at`, `sha`, `kind`
(`code-only` | `code+semantic` | `pan-graph`), node/edge counts, and the pinned
`graphifyy` version:

```bash
cat graphify-out/graph-meta.json   # or graphify-out/pan-meta.json
```

Report presence, `kind`, the `built_at` age, and the `sha` the graph was built
from. If `graph.json` exists but `graph-meta.json` does not, it is a local,
un-provenanced build (e.g. from `build.sh`) — say so rather than claiming a
release identity. Note the SessionStart hook restores only `graph.json`,
`graph-meta.json`, and `pan-graph.json`; `pan-meta.json` appears only after
the manual `--pattern 'pan-*.json'` restore, so when it is absent fall back
to `graph-meta.json` for freshness.

### Step 4 — Cite `source_location`, treat hits as leads

When you state a fact from the graph, quote the node's `source_location` so it
is verifiable (`file:line`). The graph is a lead generator, not proof: for
anything you will act on, confirm the finding by reading the cited code before
editing or reporting it as certain.

### Step 5 — After code changes, refresh the graph

If you have just modified code and want a current graph, refresh it with
`./scripts/graph/update.sh` (incremental, AST-only, no cost). This skill only
queries; building and refreshing are the `scripts/graph/` scripts' job.

## Examples

### Example 1 — Blast radius before a refactor
User: "what depends on `detect_completion`? I want to change its signature."

```bash
graphify affected "detect_completion" --graph graphify-out/graph.json
```

Report each dependent with its `source_location`, then read the top callers to
confirm the signature change is safe. This is the `graphify affected "X"`
change-impact path CLAUDE.md points to.

### Example 2 — How two modules connect
User: "what connects the habits router and the streaks domain?"

```bash
graphify path "habits router" "streaks" --graph graphify-out/graph.json
```

Summarize the shortest path (the intermediate calls/imports), quoting each
node's `source_location`.

### Example 3 — Is the graph fresh enough to trust?
User: "/graph status"

Read `graphify-out/graph-meta.json`, then answer with presence, `kind`
(code-only vs code+semantic), the `built_at` age, and whether a
`pan-graph.json` is also present. If it is stale (older than ~48h) or absent,
say so and offer to restore via the release or `build.sh`.

## Troubleshooting

### `graphify: command not found`
The CLI is not installed in the active environment. `scripts/graph/build.sh`
and `update.sh` install the pinned `graphifyy` toolchain on first use;
activate your `.venv` first so it lands there. This skill never pins or
upgrades the CLI itself — that is `scripts/graph/requirements.txt`.

### The graph is missing or stale
See Step 1: restore from the `knowledge-graph` release, or build locally with
`./scripts/graph/build.sh`. Never answer from a graph you could not load —
fall back to Grep/Glob and say the graph was unavailable.

### The user wants to file an issue or fix quality, not query
Stop and hand off: filing a bug/feature is the `flare` skill; a code-quality
or slop audit is the `de-slopify` skill. This skill only reads the graph — it
does not create issues or edit code.

### Looking for a `status` subcommand on the CLI
graphify has none for the graph — the only `status` it exposes is `hook
status` (git-hook wiring). Graph freshness comes from reading `graph-meta.json`
(Step 3), not from the CLI.
