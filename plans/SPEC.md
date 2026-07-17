# SPEC: Graphify — A Federated Knowledge Graph for the Adepthood Ecosystem

- **Status:** Draft for decomposition (not for merge to `main`)
- **Date:** 2026-07-17
- **Author:** Claude (research session on branch `claude/graphify-knowledge-base-dkegd6`)
- **Tool under adoption:** [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) — PyPI package `graphifyy`, CLI `graphify`, MIT license, validated at **v0.9.17**
- **Repos in scope:** `Geoffe-Ga/adepthood` (hub) + satellites `Geoffe-Ga/Creek-Vault`, `Geoffe-Ga/aptitude-course`, `Geoffe-Ga/wavelength-demo`, `Geoffe-Ga/WavelengthWatch` (all five public)

---

## How to read this document

This spec is written to be decomposed into Ralph-ready GitHub issues. Section 7
contains the issue catalog: every issue block follows the 6-component prompt
framework (Role, Goal, Context, Output Format, Examples, Constraints) used by
`flare` and `scan-issue-writer`, so each block can be lifted near-verbatim into
an `agent-ready` issue. Sections 1–6 are the shared context that issue bodies
should link to or excerpt. Section 8 covers the four cross-repo satellite
issues (already filed — links to be recorded when filed). Sections 9–11 are
operations, risks, and horizon.

Everything in Section 2 (tool ground truth) and Section 4 (empirical pilot) was
**verified by running graphify v0.9.17 in this session**, not read from
marketing copy. Where behavior is version-sensitive it is flagged.

---

## 1. Why: the problem and the payoff

### 1.1 Problem

Five repositories carry one body of knowledge — the APTITUDE program, the
Archetypal Wavelength, and the software that embodies them — but every agent
session rediscovers it from scratch:

1. **Token burn on rediscovery.** Every Ralph worker, scan, review, and chat
   session greps and reads its way to the same architectural facts (how
   resonance works, where the Candle & Ink tokens live, what the manifest
   contract is). The corpus across the five repos is ~754k words of code and
   docs (~1M tokens naive); a typical agent re-reads a meaningful slice of it
   per task.
2. **Cross-repo blindness.** The canonical ontology (10 stages × 6 Wavelength
   phases × Medicine/Toxic dose matrix) is **duplicated four times** — in
   `aptitude-course` CSVs and prose, Creek-Vault's ontology spec
   (`docs/Ontology/creek_ontology_agent_prompt.md`), `wavelength-demo`
   `content/reference/*.md`, and `WavelengthWatch` `backend/data/*.csv` — with
   no machine-checkable link between them. Agents working in one repo cannot
   see the others' encodings, contracts (`aptitude-course` manifest →
   `backend/content/`; Creek↔Adepthood MCP contract), or prior art
   (Creek's embedding/linking engine).
3. **No compounding memory.** The fleet completes ~595 issues and counting,
   but what it *learns* per issue evaporates. The weekly playbook captures
   failure rules; nothing captures structural knowledge.

### 1.2 Payoff (the "maximum utility" definition)

| Benefit | Mechanism | Measured/measurable by |
|---|---|---|
| Fewer tokens per question | `graphify query` returns a scoped subgraph instead of file dumps | `graphify benchmark`: **16.8× avg reduction** on the pilot merged graph (see §4) |
| Better one-shot accuracy | Every node carries `source_file:line` provenance; edges are tagged EXTRACTED/INFERRED; god nodes + communities give agents the map before the territory | Claude review verdict rate; playbook bug rate |
| Cross-repo answers | `merge-graphs` builds one pan-graph with a `repo` attribute per node | `graphify path "JournalEntry" "creek ontology Fragments"` resolves |
| Impact analysis | `graphify affected "X"` reverse-traverses dependents | Used in review + refactor issues |
| Compounding memory | `save-result` / `reflect` produce a deterministic `LESSONS.md` from real query outcomes | Weekly reflect output feeding the playbook |
| Zero-cost maintenance | AST re-extraction is deterministic, local, LLM-free; only doc/semantic changes cost tokens | CI runtime + `cost.json` tracker |

### 1.3 Non-goals (this epic)

- **No user-data ingestion.** Journal entries, per-user corpora, and anything
  behind auth stay out of the graph. The graph covers *repository* content
  only. The product-side "Higher Self" retrieval upgrade (replacing
  `domain/resonance.py`'s 5-most-recent-entries window) is a separate future
  epic — see §11 — and is bound by ADR 0002 (intimate content never leaves
  local).
- **No graph database service.** graphify is JSON-on-disk + CLI; we introduce
  no Neo4j/pgvector/servers. (Export paths exist if ever needed.)
- **No rewrite of Creek-Vault's linking engine.** Creek keeps its own
  vault-side pipeline; the graph ingests Creek's *repo* (code + ontology spec)
  like any satellite.

---

## 2. Tool ground truth (graphify v0.9.17, verified in-session)

### 2.1 What it is

- Local-first knowledge-graph extractor: **code via tree-sitter AST**
  (36 languages, deterministic, zero LLM cost, nothing leaves the machine);
  **docs/papers/images via LLM semantic extraction** (headless backends:
  `gemini|kimi|claude|openai|deepseek|ollama`; or host-agent subagents when
  run as a skill inside Claude Code).
- Outputs to `graphify-out/`: `graph.json` (the graph), `GRAPH_REPORT.md`
  (god nodes, communities, surprising connections, suggested questions),
  `graph.html` (interactive viz), optional `wiki/` (agent-crawlable index),
  optional Obsidian vault export.
- Leiden community detection; communities get LLM-written 2–5-word labels.
- Edge audit trail: `EXTRACTED` / `INFERRED` / `AMBIGUOUS`.

### 2.2 Commands this design relies on (verbatim from `graphify --help`)

| Command | Role in this design |
|---|---|
| `graphify extract <path> --code-only --no-cluster` | Zero-LLM CI extraction of a code repo |
| `graphify extract <path> --backend claude` | Headless semantic extraction of docs (uses `ANTHROPIC_API_KEY`; honors `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`) |
| `graphify extract <path> --out DIR` | Redirect `graphify-out/` (keeps working trees clean) |
| `graphify update <path>` | Incremental AST-only refresh, no LLM |
| `graphify merge-graphs g1 g2 … --out <path>` | **Cross-repo pan-graph**; each node gains a `repo` attribute |
| `graphify query "<q>" [--budget N] [--graph <path>]` | BFS scoped-subgraph answer (default budget 2000 tokens) |
| `graphify path "A" "B"` / `graphify explain "X"` / `graphify affected "X"` | Relationship, concept, impact queries |
| `graphify cluster-only <path>` / `graphify label <path> --backend claude` | Re-cluster and (re)name communities |
| `graphify hook install` | post-commit/post-checkout AST rebuild + `graph.json` union merge driver |
| `graphify claude install` | Writes a `## graphify` section into `CLAUDE.md` **and PreToolUse hooks** (`hook-guard search` on Bash, `hook-guard read` on Read/Glob) that steer agents to query the graph before grepping |
| `graphify save-result` / `graphify reflect` | Query-outcome memory → deterministic `LESSONS.md` |
| `graphify check-update <path>` | Cron-safe staleness check for pending semantic re-extraction |
| `graphify benchmark [graph.json]` | Token-reduction measurement vs naive full-corpus reading |
| `python -m graphify.serve <graph.json> [--transport http --api-key …]` | MCP server exposing `query_graph`, `get_node`, `get_neighbors`, `get_community`, `god_nodes`, `graph_stats`, `shortest_path`, `list_prs`, `get_pr_impact`, `triage_prs` |

### 2.3 Behaviors that shape the design

- **Semantic cache:** `graphify-out/cache/` is SHA256-keyed per file; re-runs
  only pay for changed files. The cache must be persisted across CI runs or
  every scheduled run re-pays the full corpus.
- **Shrink guard:** a rebuild producing fewer nodes than the existing
  `graph.json` refuses to write unless `--force`/`GRAPHIFY_FORCE=1` (protects
  against clobbering a good graph after deletions/refactors — pass `--force`
  deliberately after intentional deletions).
- **Sensitive-file skipping + `.graphifyignore`:** extraction respects
  `.gitignore` and `.graphifyignore` and skips sensitive-looking files;
  unclassifiable files are reported, not silently dropped.
- **No API key is ever required for code:** a code-only corpus never invokes
  an LLM.
- **Skill vs CLI:** inside Claude Code the `/graphify` skill orchestrates
  extraction using the *session itself* as the LLM (subagent fan-out). In CI
  we use the headless CLI exclusively — deterministic, budgetable.

---

## 3. What we have: the five-repo corpus map

| Repo | Kind | Knowledge payload | Graph-relevant facts |
|---|---|---|---|
| **adepthood** (hub) | RN + FastAPI app | `NORTH-STAR.md`, `AGENTS.md`, design system (`frontend/src/design/DESIGN.md`), `docs/` (ADRs, creek MCP contract, curriculum), vendored course content `backend/content/markdown/` + `manifest.json`, `prompts/` (65+ issue specs, 13 scan prompts), 27 SQLModel models, domain logic | Ralph fleet + 20 workflows + 30 skills already here; the natural hub. **Code-only extract: 14,339 nodes / 35,713 edges / ~17 MB / ~2 min / $0** (measured) |
| **aptitude-course** | Content corpus | The 36-week curriculum: ~219 chapters, ~134k words, YAML frontmatter (`id`, `stage`, `chapter`, `release_day`…), **schema-versioned `manifest.json`** (82 KB, CI-enforced), 6 source-of-truth CSVs (`APTITUDE Complete Map`, Wavelength modes, quotes, practices…) | The richest semantic target; manifest is the ideal ingestion anchor; already contract-coupled to adepthood (`backend/content/` vendoring, issues #388/#389) |
| **Creek-Vault** | Python toolchain + ontology | `docs/Ontology/creek_ontology_agent_prompt.md` (~10k words: Fragments/Resonances/Threads/Eddies/Praxis, F1–F10 frequencies, Wavelength Medicine/Toxic maps), decision docs incl. the **Adepthood↔Creek MCP contract** (ontology version `aptitude-wavelength/2026-05-23`), 500 `.py` files incl. embedding/linking prior art | Largest codebase; its own Ralph-style fleet; ontology spec is the canonical prose encoding |
| **wavelength-demo** | Vite/React promo site | `content/wavelengths/` — 21 curated "the Wavelength applied to X" mode files with AQAL quadrant frontmatter + phase tables; `content/reference/` — 9 stage files; ~4.5k words | Small, exquisitely structured; **code-only extract: 248 nodes / 417 edges / seconds / $0** (measured) |
| **WavelengthWatch** | watchOS + FastAPI | `backend/data/*.csv` — the exact stage × phase × Medicine/Toxic curriculum + headers + strategies; 194 Swift files | Swift is tree-sitter-supported; CSVs are the structured dose matrix |

**The unification thesis:** the same entities recur in all five repos under
the same names (Beige…Clear Light; Rising…Restoration; Medicine/Rx vs
Toxic/OD). AST extraction will produce per-repo nodes; the semantic pass +
one curated **ontology spine** document (issue G2.3) makes those shared
entities *resolve to shared nodes*, which is what turns five graphs merged
into one graph *connected*.

---

## 4. Empirical pilot (run in this session — reproduce anytime)

```bash
pip install graphifyy==0.9.17

# 1. Code-only extraction, zero LLM, ~2 min for the whole monorepo
graphify extract /path/to/adepthood     --code-only --no-cluster --out /tmp/g/adepthood
graphify extract /path/to/wavelength-demo --code-only --no-cluster   # → in-repo graphify-out/

# 2. Cross-repo merge
graphify merge-graphs \
  /tmp/g/adepthood/graphify-out/graph.json \
  /path/to/wavelength-demo/graphify-out/graph.json \
  --out /tmp/g/merged/graph.json
# → "Merged 2 graphs -> 15080 nodes, 35598 edges" (20 MB JSON)

# 3. Query with provenance
graphify query "how does resonance marginalia generation work" \
  --graph /tmp/g/merged/graph.json --budget 1200
# → scoped subgraph: Marginalia [marginalia.py L54], JournalEntry
#   [journal_entry.py L135], get_current_user [auth.py L805] …

# 4. Measure
graphify benchmark /tmp/g/merged/graph.json
# → Corpus 754,000 words ≈ 1,005,333 tokens naive
#   Reduction: 16.8x fewer tokens per query
#   ("how does authentication work" 19.9x; "what connects the data layer
#    to the api" 42.2x)
```

Two caveats the pilot surfaced (both addressed in issues):

1. **Unclustered graphs answer noisily.** Without Leiden communities +
   labels, `query` returns a flat unranked node list. Clustering + labeling
   (G2.2) is not optional polish; it is what makes answers readable.
2. **Graph artifacts are big and churn-prone.** 17 MB for adepthood alone,
   rebuilt on every commit by the git hook. Committing `graphify-out/` into
   *adepthood* would put 17 MB diffs in every Ralph PR. Hence the split
   artifact strategy in D3.

---

## 5. Architecture

### 5.1 Shape: hub-and-spoke federation

```
 aptitude-course      Creek-Vault      wavelength-demo     WavelengthWatch
   (satellite)         (satellite)       (satellite)         (satellite)
       │ graph.json commits │                 │                   │
       │ + CI keeps fresh   │                 │                   │
       └─────────┬──────────┴───────┬─────────┴─────────┬─────────┘
                 ▼  fetch raw graph.json from each default branch
        ┌─────────────────────────────────────────────┐
        │  adepthood  .github/workflows/graph-*.yml   │
        │  1. extract own graph (code + semantic)     │
        │  2. merge-graphs → pan-graph.json           │
        │  3. cluster + label + wiki + report         │
        │  4. publish rolling Release `knowledge-graph`│
        └─────────────────────┬───────────────────────┘
                              ▼
        consumers: Ralph workers · scans · reviews · chat sessions
        (SessionStart hook restores graph; PreToolUse hook-guard and
         CLAUDE.md steer every agent to `graphify query` before grep)
```

### 5.2 Design decisions

**D1 — Adopt graphify (vs build pgvector RAG in-house; vs GraphRAG frameworks).**
Chosen: graphify. It is MIT, zero-infrastructure (JSON on disk), already ships
the whole lifecycle we'd otherwise build (incremental extraction, cross-repo
merge, MCP server, agent hooks, memory loop), and its code path is free and
deterministic. An in-house pgvector build would couple dev-knowledge tooling
to the product database and cost a multi-week epic before the first query.
Risk accepted: young, fast-moving project → **pin `graphifyy==0.9.17`** and
upgrade deliberately (G0.1); MIT license verified from package metadata.

**D2 — Hub lives in adepthood.** It has the fleet, the workflows, the skills,
and the most consumers. A dedicated sixth repo would isolate churn but double
the automation surface and orphan the graph from the agents that use it.

**D3 — Split artifact strategy.**
- *Satellites* (small, low-churn): **commit `graphify-out/`** (graph.json +
  GRAPH_REPORT.md), maintained by a tiny CI workflow (`graphify update` on
  push — AST-only, free) and optionally the local post-commit hook. This is
  graphify's native team workflow, and their graphs are sub-MB to few-MB.
- *adepthood* (large, ~torrid commit rate): **`graphify-out/` is
  git-ignored.** CI builds it; distribution is a **rolling GitHub Release
  tagged `knowledge-graph`** whose assets are `graph.json`, `pan-graph.json`,
  `GRAPH_REPORT.md`, `wiki.tar.gz`, plus the **semantic cache tarball** so any
  environment can resume incrementally. Local/web sessions restore via the
  SessionStart hook (seconds) or rebuild code-only (~2 min, $0).
- Rationale: no 17 MB diffs in PRs, no union-merge-driver noise across ~4
  parallel Ralph worktrees, satellites stay simple.

**D4 — Semantic backend = `claude` headless in CI; session-as-LLM only for
ad-hoc local runs.** `ANTHROPIC_API_KEY` already exists as a repo secret for
the review workflows. Costs are bounded by the SHA256 cache: the first full
semantic pass over the pan-corpus (~300–400k words of true docs after
filtering `.claude/` scaffolding) is a one-time spend; steady-state runs pay
only for changed files. `ollama` remains the designated backend for any
future *user-content* graphs (ADR 0002 alignment).

**D5 — Ontology spine as a first-class document.** A single curated
`graph/ontology-spine.md` in adepthood enumerates the canonical entities (10
stages with colors/archetypes/modes, 6 phases, Medicine/Toxic axis, Creek
primitives, Frequencies F1–F10, ontology version `aptitude-wavelength/2026-05-23`)
with one-line definitions and explicit "also known as" aliases. Semantic
extraction of this file yields hub nodes that the four duplicated
vocabularies resolve onto, stitching the pan-graph. Cheap, inspectable,
versioned — and doubles as human documentation.

**D6 — Utilization is enforced by hooks, not hoped for in prompts.**
`graphify claude install` writes PreToolUse hooks (`hook-guard search|read`)
that intercept Bash/Read/Glob and remind the agent the graph exists, plus a
CLAUDE.md section. We adopt both, then additionally wire the Ralph prompt
chain (PROMPT.md, chief-architect, scan prompts) so *fleet* agents — which
don't read user-level CLAUDE.md sections as reliably — get graph-first
instructions in their own contracts.

### 5.3 Privacy & security posture

- Graph covers **public repo content only**; all five repos are public, so
  the merged graph and release assets leak nothing new.
- `.graphifyignore` in every repo mirrors secret-bearing paths (`.env*`,
  `**/secrets/**`, `google_docs/` raw exports if ever private); graphify
  additionally skips sensitive-looking files by default and reports counts.
- `detect-secrets` (already a pre-commit gate) runs over any committed
  `graphify-out/` in satellites.
- No journal/user data ever enters extraction (non-goal §1.3); the future
  product-side epic must use local `ollama` extraction per ADR 0002.
- CI secrets: only `ANTHROPIC_API_KEY` (existing) and the default
  `GITHUB_TOKEN` (release upload). Satellite fetch uses raw.githubusercontent
  on public repos — no cross-repo PATs needed. (If a satellite ever goes
  private, switch that fetch to a fine-grained PAT and move the merged graph
  off public releases — see Risks.)

---

## 6. Lifecycle: setup → maintenance → utilization → feedback

| Stage | Mechanism | Cost | Trigger |
|---|---|---|---|
| **Setup** | `scripts/graph/build.sh` (pinned install + code-only extract) per repo; semantic bootstrap workflow run once | One-time semantic pass (~$ single-digit, cache-amortized) | Manual dispatch |
| **Maintenance (code)** | adepthood: `graph-build.yml` on push to `main` → `graphify update` (AST-only) + nightly full rebuild; satellites: same in miniature, committing the result | $0 | push / cron |
| **Maintenance (docs)** | Weekly `graph-semantic.yml`: `extract --backend claude` (cache makes it incremental) → `label --missing-only` → wiki → release | Only changed docs | cron (weekly) + `workflow_dispatch` |
| **Maintenance (federation)** | `graph-federate.yml`: fetch 4 satellite graph.json → `merge-graphs` → publish `pan-graph.json` | $0 | nightly cron + `repository_dispatch` from satellites |
| **Utilization** | SessionStart restore; CLAUDE.md section; PreToolUse hook-guard; Ralph PROMPT.md + chief-architect + scan prompts query-first; `/graph` skill for humans | $0 per query (CLI is local traversal) | every session |
| **Feedback** | Agents call `save-result` after graph-backed answers (incl. `--outcome dead_end|corrected`); weekly `graphify reflect` → `LESSONS.md` → input to `weekly-playbook.yml`; `graphify benchmark` + `cost.json` trend in the recap | $0 | continuous + weekly |
| **Staleness alarm** | `graphify check-update` in the nightly job fails loudly if semantic re-extraction is pending too long | $0 | cron |

---

## 7. Issue catalog (adepthood epic — decompose these into GitHub issues)

Conventions: labels `agent-ready` + priority as noted + epic label
`epic:graphify` (serialized unless marked `parallelizable`). Dependency
graph:

```
G0.1 ── G0.2 ── G1.1 ── G1.2 ── G2.1 ── G2.2 ── G3.5 ── G4.2
          │                       │                └ G4.1 ── G5.1 ── G5.2
          └──────────────────── G2.3 (parallelizable after G0.1)
(satellite issues §8 are external prerequisites of G3.5)
```

> Sizing note: each issue below is scoped to Ralph's ~300 LoC / single-PR
> norm. Workflow YAML sketches are *starting points*; the worker owns making
> CI green.

---

### G0.1 — Graph tooling foundation (`P1`, blocks everything)

**Role:** You are a build-tooling engineer adding a pinned, reproducible
knowledge-graph toolchain to a FastAPI + React Native monorepo.

**Goal:** Add `scripts/graph/` with an idempotent bootstrap + build wrapper so
any environment (dev laptop, Ralph worktree, CI, Claude web session) can
produce/refresh the adepthood code graph with one command and zero API keys.

**Context:**
- Tool: `graphifyy==0.9.17` (PyPI, MIT). CLI verbs used here: `extract
  <path> --code-only --no-cluster --out <dir>`, `update <path>`.
- The repo's `.venv` is the Python home (`CLAUDE.md` guardrails). Pin the
  version in `backend/requirements-dev.txt` or a dedicated
  `scripts/graph/requirements.txt` (worker's choice — keep it out of prod
  deps).
- `graphify-out/` must be **git-ignored** in this repo (decision D3;
  rationale: 17 MB artifacts, 4 parallel worktrees).
- Add `.graphifyignore` excluding `.venv/`, `frontend/node_modules/`,
  `**/.env*`, `graphify-out/`, `.git/`.

**Output format:** PR containing `scripts/graph/build.sh` (full extract),
`scripts/graph/update.sh` (incremental), `.graphifyignore`, `.gitignore`
entry, and a `scripts/graph/README.md` (≤1 page: what, why, commands).
Shell scripts must pass the repo's shellcheck/pre-commit gates.

**Example acceptance run:**
```bash
./scripts/graph/build.sh   # installs pinned graphifyy if absent,
                           # → graphify-out/graph.json, prints node/edge count
./scripts/graph/update.sh  # AST-only refresh, exits 0 with "no changes" when clean
```

**Constraints:** No LLM calls anywhere in these scripts. No `--force` by
default (respect the shrink guard; expose `GRAPHIFY_FORCE=1` passthrough and
document when to use it). Idempotent; safe inside any worktree.

---

### G0.2 — Always-on agent integration: CLAUDE.md section + hook-guard (`P1`)

**Role:** You are a Claude Code platform engineer wiring a knowledge graph
into every session's default behavior.

**Goal:** Every Claude session in this repo (interactive, web, Ralph worker)
is *steered* to `graphify query` before grep/read sweeps, and knows how to
keep the graph current.

**Context:**
- `graphify claude install` writes (a) a `## graphify` section into CLAUDE.md
  and (b) PreToolUse hooks into `.claude/settings.json`: matcher `Bash` →
  `graphify hook-guard search`, matcher `Read|Glob` → `graphify hook-guard
  read`. **Do not run the installer blind**: this repo's CLAUDE.md carries a
  playbook-managed section and `.claude/settings.json` carries a SessionStart
  hook — merge, don't clobber. Author the section and hook entries by hand to
  match what the installer would write (see the installer's output in a
  scratch dir first).
- The CLAUDE.md section must state: query first for codebase questions
  (`graphify query|path|explain|affected`), `./scripts/graph/update.sh` after
  code changes, and where the graph comes from when absent (G1.2 hook or
  `build.sh`).
- Hook commands must fail-soft: if `graphify` or `graphify-out/graph.json` is
  missing, hook-guard must not block the tool call (verify; wrap with `|| true`
  if needed).

**Output format:** PR editing `CLAUDE.md` (new `## Knowledge Graph
(graphify)` section, outside playbook markers), `.claude/settings.json`
(hooks appended, existing hooks preserved), plus a smoke test or documented
manual verification of the fail-soft path.

**Example:** In a session with the graph present, asking "what calls
`get_current_user`?" should route through `graphify query` (~2k tokens)
rather than `grep -r` + 6 file reads (~40k tokens).

**Constraints:** Never remove or reorder existing hooks. Keep the CLAUDE.md
section ≤ 15 lines. No `--no-verify`, all pre-commit gates green.

---

### G1.1 — CI graph freshness + rolling release distribution (`P1`)

**Role:** You are a GitHub Actions engineer.

**Goal:** `main` always has a ≤24h-fresh code graph published where any
environment can fetch it in seconds.

**Context:**
- New workflow `.github/workflows/graph-build.yml`:
  - `on: push` (branches: `[main]`, path-filtered to code) → restore prior
    graph + cache → `./scripts/graph/update.sh` → upload.
  - `on: schedule` (nightly) + `workflow_dispatch` → full
    `./scripts/graph/build.sh` (catches deletions with an explicit,
    logged `GRAPHIFY_FORCE=1`).
  - Publish step: upsert a rolling release tagged `knowledge-graph`
    (`gh release upload --clobber` or the equivalent action) with assets
    `graph.json`, `GRAPH_REPORT.md`, and `graph-meta.json` (schema: built-at
    ISO timestamp, source SHA, node/edge counts, graphifyy version).
- Use `actions/cache` keyed on graphifyy version for the tool install; the
  graph itself travels via the release, not the cache (cache is per-branch
  scoped and evictable).
- Concurrency group so overlapping pushes don't race the release upload.

**Output format:** PR with the workflow + any script tweaks; workflow run
link demonstrating a green nightly build and populated release.

**Example `graph-meta.json`:**
```json
{"built_at": "2026-07-17T04:40:00Z", "sha": "abc1234", "nodes": 14339,
 "edges": 35713, "graphifyy": "0.9.17", "kind": "code-only"}
```

**Constraints:** Job must be $0 (code-only; no LLM steps here). Total runtime
target < 5 min. `GITHUB_TOKEN` only. Must not fail the whole workflow if the
release upload races — retry once, then surface.

---

### G1.2 — SessionStart graph restore (`P2`)

**Role:** You are a developer-experience engineer.

**Goal:** Any fresh session (Claude web container, new clone, Ralph worktree)
gets the latest published graph without building it.

**Context:** Extend `.claude/hooks/session-start.sh` (exists; installs deps
today): after current steps, if `graphify-out/graph.json` is missing or
`graph-meta.json` is older than 48h, download the `knowledge-graph` release
assets (public repo — plain `curl -L` to
`https://github.com/Geoffe-Ga/adepthood/releases/download/knowledge-graph/…`);
on any failure print one warning line and continue (never block session
start). Also fetch `pan-graph.json` when present (exists after G3.5).

**Output format:** PR editing the hook + a `bats`-style or shell smoke test
if the repo has a pattern for hook tests; otherwise documented manual
verification matrix (asset present / absent / network down).

**Constraints:** ≤10s added to session start in the happy path; strictly
fail-soft; no secrets.

---

### G2.1 — Semantic layer: docs corpus extraction (`P1`)

**Role:** You are an LLM-pipeline engineer running headless semantic
extraction in CI.

**Goal:** The adepthood graph understands its *prose* — NORTH-STAR, ADRs,
design docs, issue specs, and the vendored course content — not just its AST.

**Context:**
- New workflow `.github/workflows/graph-semantic.yml`: weekly cron +
  `workflow_dispatch`. Steps: restore release graph + **semantic cache
  tarball** (add `semantic-cache.tar.gz` to the release assets) →
  `graphify extract . --backend claude --token-budget 60000
  --max-concurrency 2` → re-upload graph + cache + report.
- Semantic targets (everything else is already AST-covered or excluded):
  `NORTH-STAR.md`, `AGENTS.md`, root + design `DESIGN.md`, `docs/**`,
  `prompts/**`, `backend/content/markdown/**`, `plan/**`. Extend
  `.graphifyignore` so semantic extraction skips `.claude/**` (skill
  scaffolding is noise, per the satellite survey) and `frontend/assets/**`.
- Uses repo secret `ANTHROPIC_API_KEY` (already present for review
  workflows). Default model is fine; expose `ANTHROPIC_MODEL` env passthrough.
- First run is the expensive one (~130k+ words vendored content alone);
  subsequent runs hit the SHA256 cache. Log token counts from `cost.json`
  into the job summary.

**Output format:** PR with workflow + `.graphifyignore` additions + a
`docs/` note on cost expectations; a dispatched run showing cache hit
behavior on the second invocation.

**Constraints:** Hard-fail if `ANTHROPIC_API_KEY` is absent (don't silently
build a docs-blind graph). Never run on PR events (cost control). Respect the
shrink guard.

---

### G2.2 — Clustering, labeling, report, wiki (`P2`)

**Role:** You are a knowledge-graph quality engineer.

**Goal:** Turn the raw graph into a *navigable* one: labeled Leiden
communities, `GRAPH_REPORT.md` with god nodes / surprising connections /
suggested questions, and the agent-crawlable `wiki/` export.

**Context:** Pilot finding: unclustered graphs answer noisily (§4 caveat 1).
Append to `graph-semantic.yml` (or a chained job): `graphify cluster-only .
--no-viz` sized for >5k-node graphs, then `graphify label . --missing-only
--backend claude --batch-size 100`, then the wiki export; ship
`GRAPH_REPORT.md` + `wiki.tar.gz` in the release. Community labels are small
LLM calls (batched 100/call) — cheap.

**Output format:** PR + a run whose `GRAPH_REPORT.md` shows named communities
(e.g. "Practice Engine", "Candle & Ink Tokens", "Auth & JWT") rather than
"Community 7".

**Constraints:** `--no-viz` in CI (HTML viz on >5k nodes is heavy and
unused by agents). Labeling must use `--missing-only` on incremental runs so
stable communities keep stable names.

---

### G2.3 — Ontology spine (`P1`, `parallelizable`)

**Role:** You are an ontologist-engineer encoding the APTITUDE / Archetypal
Wavelength canon as a graph-resolvable document.

**Goal:** One curated `graph/ontology-spine.md` whose extraction produces the
hub entities that all five repos' vocabularies resolve onto — so the merged
pan-graph is *connected*, not merely concatenated.

**Context:**
- Canonical content sources (do not invent; transcribe + cite):
  `backend/content/markdown/` stage frontmatter; aptitude-course
  `google_docs/database_of_course_curriculum/*.csv` (via the vendored
  content); Creek's `docs/Ontology/creek_ontology_agent_prompt.md` §6–7
  (Frequencies F1–F10, Medicine/Toxic per phase); wavelength-demo
  `content/reference/` (already vendored concepts); ontology version anchor
  `aptitude-wavelength/2026-05-23` from Creek's decision doc.
- Structure: one `##` per entity class — Stages (10: color, archetype, mode,
  divine gender, gift, shadow), Wavelength Phases (6: Rising, Peaking,
  Withdrawal, Diminishing, Bottoming Out, Restoration), Dose axis
  (Medicine/Rx vs Toxic/OD), Creek primitives (Fragment, Resonance, Thread,
  Eddy, Praxis), Frequencies (F1–F10 ↔ stage mapping), plus an `### Aliases`
  list per entity ("Beige" = "Stage 1" = "F1" = "BEIGE"). Wikilink-free
  strict CommonMark, YAML frontmatter with `ontology_version`.
- This file is *also* human documentation; write it to that standard.

**Output format:** PR adding `graph/ontology-spine.md` (+ inclusion in the
semantic target list from G2.1). Acceptance: after the next semantic run,
`graphify explain "Restoration"` returns the phase node with edges into at
least two distinct repos' content (verifiable post-G3.5; until then, into
both `backend/content` and `NORTH-STAR.md` nodes).

**Constraints:** ≤ ~400 lines. Every fact must be traceable to a cited
source file; no novel doctrine. Keep the aliases exhaustive — they are the
entity-resolution mechanism.

---

### G3.5 — Federation: the pan-graph (`P1`; external deps: §8 satellite issues)

**Role:** You are a distributed-systems-minded CI engineer.

**Goal:** A nightly `pan-graph.json` merging all five repos, published on the
`knowledge-graph` release, queryable in any session.

**Context:**
- New `.github/workflows/graph-federate.yml`: nightly cron +
  `workflow_dispatch` + `repository_dispatch` (event
  `graph-updated`, sent by satellite workflows — see §8).
- Steps: download own `graph.json` from the release → fetch each satellite's
  committed `graphify-out/graph.json` via
  `https://raw.githubusercontent.com/Geoffe-Ga/<repo>/<default-branch>/graphify-out/graph.json`
  → `graphify merge-graphs adepthood.json creek.json course.json demo.json
  watch.json --out pan-graph.json` → `graphify benchmark pan-graph.json`
  into the job summary → upload `pan-graph.json` + `pan-meta.json` (per-repo
  SHAs + counts) to the release.
- Skip-and-warn per satellite: a missing/unfetchable satellite graph must
  not fail the merge of the rest (log which repos are in this pan build —
  the meta file is the record).
- Merged nodes carry a `repo` attribute (graphify native) — preserve it.

**Output format:** PR + a green dispatched run with all five repos merged
and the benchmark table in the job summary.

**Example verification:**
```bash
graphify path "JournalEntry" "Fragment" --graph pan-graph.json   # crosses adepthood→Creek
graphify query "where is the Medicine/Toxic matrix defined" --graph pan-graph.json
# → nodes from aptitude-course CSVs, WavelengthWatch data/, wavelength-demo reference/
```

**Constraints:** $0 job (merge is local; benchmark is local). If any
satellite repo becomes private, this design point must be revisited (public
raw fetch stops working; merged graph must move off the public release) —
encode that as a loud comment in the workflow.

---

### G4.1 — Ralph fleet wiring (`P1`)

**Role:** You are the Ralph fleet's toolsmith.

**Goal:** Every fleet role consults the graph at the moment it is most
valuable: architects at planning, workers at orientation, reviewers at
impact analysis.

**Context (insertion points, verified in-repo):**
- `scripts/ralph/PROMPT.md` — worker contract: add a "Step 0.5 — Orient via
  graph" (query the issue's key nouns; `affected "X"` before touching X;
  `./scripts/graph/update.sh` after implementation so the worktree graph
  stays honest).
- `.claude/agents/chief-architect.md` — plan phase: `graphify query` +
  `path` to map the blast radius before writing the dispatch plan.
- `.claude/agents/shared/adepthood-constraints.md` — one shared rule: "graph
  first, grep second" with the fail-soft caveat (graph may be absent in a
  fresh worktree; `build.sh` or proceed without).
- `.claude/agents/code-review-orchestrator.md` — reviewers run
  `graphify affected` on the diff's touched symbols to find un-reviewed
  dependents.
- Worktree note: `graphify-out/` is git-ignored, so each worktree either
  restores via the SessionStart hook (G1.2) or builds code-only in ~2 min.

**Output format:** PR editing the four prompt/agent files. Keep each
insertion ≤ 10 lines; these files are token-budgeted contracts, not essays.

**Constraints:** Do not touch playbook-marker-managed rule blocks. Fail-soft
language mandatory (a worker without a graph must degrade to today's
behavior, never stall).

---

### G4.2 — Scan prompts + `/graph` skill (`P2`)

**Role:** You are a skills author (see `skill-craft`).

**Goal:** (a) The 13 `prompts/scans/*.md` scans open with a graph
orientation step so scan agents stop re-mapping the repo each week;
(b) humans get a `/graph` skill wrapping query/path/explain/affected/status
with the pan-graph as default target when present.

**Context:** Scans run via `_claude-scan.yml` on schedules; each prompt is
self-contained. Add a shared preamble block (or a `prompts/scans/_graph-preamble.md`
include if the runner supports it — check first) instructing: query the
graph for the scan's domain (e.g. dead-code scan → `god_nodes` +
low-degree nodes as candidates), fall back gracefully. The skill lives at
`.claude/skills/graph/SKILL.md` following repo skill conventions
(description with trigger words, Do-NOT-use boundaries vs `de-slopify`
etc.).

**Output format:** One PR for the skill; one PR (or one per few scans if the
diff sprawls) for the scan preambles.

**Constraints:** Preamble ≤ 8 lines per scan. Skill must pass `skill-craft`
quality bars (progressive disclosure; no duplicated CLI docs — link
`scripts/graph/README.md`).

---

### G5.1 — Memory loop: save-result + weekly reflect (`P2`)

**Role:** You are an agent-memory engineer.

**Goal:** Graph queries that helped (or misled) leave a trace; a weekly
deterministic `LESSONS.md` distills those traces; the playbook workflow
consumes it.

**Context:**
- Instruct (in the G4.1 files + `/graph` skill): after a graph-backed answer
  proves out (tests pass / review LGTM), run `graphify save-result
  --question … --answer … --nodes … --outcome useful`; on wrong turns,
  `--outcome dead_end` or `--outcome corrected --correction …`.
- Memory dir problem: `graphify-out/memory/` is git-ignored in adepthood and
  ephemeral in CI/worktrees. Solution: point `--memory-dir graph/memory/`
  (committed, tiny JSON files) — verify the flag supports it (it does:
  `--memory-dir DIR`); pre-commit `detect-secrets` covers it.
- New tail-step in the weekly `graph-semantic.yml` (or `weekly-playbook.yml`
  — worker's judgment): `graphify reflect --memory-dir graph/memory --out
  graph/reflections/LESSONS.md --graph graphify-out/graph.json
  --half-life-days 30 --min-corroboration 2`, commit the result, and add
  `graph/reflections/LESSONS.md` to the playbook workflow's input set.

**Output format:** PR(s) with the wiring + one seeded example memory entry +
a generated LESSONS.md.

**Constraints:** Memory entries must never contain user data or secrets
(they describe repo Q&A only). The reflect step is deterministic — no LLM.

---

### G5.2 — Measurement: benchmark trend + staleness alarm (`P3`)

**Role:** You are an observability engineer.

**Goal:** The recap surfaces graph ROI and rot before humans feel it.

**Context:** Nightly `graph-build.yml` tail: `graphify benchmark` → append
`{date, reduction_avg, nodes, edges}` to `graph/metrics/benchmark-trend.jsonl`
(committed) → `ralph-recap` workflows read it; `graphify check-update .`
fails the job (or opens a `flare` issue via existing patterns) when semantic
staleness exceeds threshold. Include `cost.json` cumulative token totals in
the job summary.

**Output format:** PR; a recap run showing the trend line.

**Constraints:** JSONL append-only; keep the committed metrics file tiny
(one line/day).

---

## 8. Satellite repo issues (filed on their boards)

One issue per satellite. Common body (adjusted per repo), following the same
6-component structure. Effort per repo: ~1 hour of agent time; `$0` for the
three code-dominant repos, one small semantic pass for `aptitude-course`.

**Title:** `Adopt graphify: build, commit, and maintain this repo's knowledge graph (adepthood federation)`

**Role:** Build-tooling engineer for this repository.

**Goal:** This repo owns a fresh `graphify-out/graph.json` on its default
branch, so the adepthood hub can federate it into the ecosystem pan-graph.

**Context:**
- Hub spec: `Geoffe-Ga/adepthood` branch `claude/graphify-knowledge-base-dkegd6`,
  `plans/SPEC.md` (§5 architecture, D3 artifact strategy: *satellites commit
  their graphs*).
- Steps: pin `graphifyy==0.9.17`; add `.graphifyignore` (exclude `.claude/**`
  skill scaffolding, lockfiles, `node_modules/`, build outputs); run
  `graphify extract . --code-only` (repo-appropriate: see per-repo notes);
  commit `graphify-out/graph.json` + `GRAPH_REPORT.md`; add
  `.github/workflows/graph-update.yml` — on push to default branch:
  `graphify update .` + auto-commit if changed, then `repository_dispatch`
  event `graph-updated` to `Geoffe-Ga/adepthood` (needs a fine-grained PAT
  secret `ADEPTHOOD_DISPATCH_TOKEN` with `contents:write`? No —
  `repository_dispatch` needs `repo`-scoped token on the *target*; owner
  must add it. **Fallback that needs no secret: skip dispatch; the hub's
  nightly cron picks the graph up within 24 h.** Implement dispatch only if
  the secret exists; guard with `if: secrets… != ''`).
- Optional local dev nicety: `graphify hook install` (post-commit AST
  rebuild + merge driver) — document, don't mandate.

**Per-repo notes:**
- **aptitude-course:** content-first repo — code-only extraction is nearly
  empty. Use full `graphify extract . --backend claude` once (owner supplies
  `ANTHROPIC_API_KEY` secret; ~134k words first pass) and weekly cron after;
  `manifest.json`-driven chapters make excellent semantic nodes. Exclude
  `markdown/backup/` and `*.zip`.
- **Creek-Vault:** code-only is rich (500 py files); additionally include
  `docs/Ontology/**` + `docs/decisions/**` in one semantic pass — the
  ontology spec is a federation keystone.
- **wavelength-demo:** code-only + one tiny semantic pass over `content/**`
  (~4.5k words). Already validated: 248 nodes / 417 edges in seconds.
- **WavelengthWatch:** code-only (Swift is supported); include
  `backend/data/*.csv` in extraction (SQL/CSV schema ingestion) so the dose
  matrix lands as nodes.

**Output format:** One PR per repo; graph committed; CI green; workflow run
demonstrating auto-update.

**Constraints:** Respect each repo's own gates (Creek and WavelengthWatch
have strict fleets of their own). Never commit caches with absolute paths;
verify `graphify-out/cache/` portability or exclude it from the commit and
let CI rebuild.

---

## 9. Cost & effort summary

| Item | One-time | Steady-state |
|---|---|---|
| Code graphs (all 5 repos) | ~5 min compute total | $0 (AST only), minutes/night |
| Semantic layer (adepthood + course + creek docs + demo content) | one full pass over ~300–400k filtered words (single-digit $ at Sonnet-class pricing; cache-amortized) | only changed docs/week |
| Community labeling | batched, ~1–3 LLM calls/run | `--missing-only` |
| Federation merge + benchmark + reflect | $0 | $0 |
| Engineering | ~11 hub issues + 4 satellite issues, all Ralph-sized | playbook-maintained |

Payback: at 16.8× average per-query reduction (measured, code-only pilot;
expect better with clustering/labels), the semantic-pass spend is recovered
within days of normal fleet operation.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| graphify is young and moves fast (issue refs into the #1600s) | Pin 0.9.17 everywhere; upgrades via dedicated dependency issue (there's a `cve-remediation`/deps scan lane already); `graph-meta.json` records the version that built every artifact |
| Graph rot → confidently wrong answers | Shrink guard stays on; nightly rebuild; `check-update` alarm (G5.2); provenance (`file:line`) on every node lets agents verify before trusting |
| Unclustered/unlabeled interim graphs mislead | G2.2 ordered immediately after G2.1; CLAUDE.md section says "quote source_location when citing" |
| A satellite goes private | Federation fetch breaks loudly (skip-and-warn + meta file records absence); revisit distribution (PAT + private release) — flagged in G3.5 workflow comments |
| PreToolUse hook-guard annoys or blocks when graph absent | Fail-soft wrappers mandated in G0.2/G4.1; degrade to status-quo behavior |
| 20 MB+ release assets on every nightly | Rolling release (single tag, clobbered assets) keeps repo history clean; assets are not in git |
| Ralph worktrees fight over graph files | `graphify-out/` git-ignored in adepthood (D3); per-worktree rebuild/restore |
| Secrets/PII leak into a committed satellite graph | `.graphifyignore` + graphify's sensitive-file skip + existing `detect-secrets` gates; all-source-repos-public baseline |

## 11. Horizon (explicitly out of scope, recorded so nobody re-litigates)

1. **Higher-Self retrieval epic:** replace `domain/resonance.py`'s
   5-most-recent-entries window with retrieval over a *per-user* graph/index.
   Constraints already known: ADR 0002 (intimate tier never leaves local ⇒
   `ollama` backend or on-device), `EncryptedString` bodies, BotMason
   provider registry as the seam. The pan-graph built here becomes the
   *teachings* half of that conversation (user's words ↔ course's words).
2. **MCP server surface:** `python -m graphify.serve pan-graph.json` exposes
   `query_graph`/`shortest_path`/`triage_prs` etc. Adopt if/when a consumer
   can't shell out to the CLI (e.g. hosted reviewer). CLI-first until then.
3. **PR triage:** `graphify prs --triage` + `get_pr_impact` for
   review-queue ranking in `ralph-tick` — revisit after G4.x lands and the
   fleet has graph literacy.
4. **Public wiki:** `wiki/` export is agent-facing here, but it's one step
   from publishable reference docs for `aptitude.guru`.
5. **Creek-Vault convergence:** Creek's vault pipeline and this dev-graph
   share ontology but not storage. A future decision doc should say whether
   Creek's `embeddings.parquet` world and graphify's JSON world ever merge
   (current answer: no — different corpora, different privacy tiers).

## 12. Glossary

- **Pan-graph** — the merged five-repo graph (`pan-graph.json`), nodes tagged
  with `repo`.
- **Ontology spine** — `graph/ontology-spine.md`, the curated canonical
  entity document that stitches duplicated vocabularies (D5).
- **Hook-guard** — graphify's PreToolUse interception nudging agents to
  query the graph before grep/read.
- **Shrink guard** — graphify's refusal to overwrite a graph with a smaller
  one absent `--force`.
- **Rolling release** — the single `knowledge-graph` GitHub release whose
  assets are clobbered in place; the distribution channel for adepthood's
  (git-ignored) graph artifacts.
- **Satellite** — the four non-hub repos, each committing its own
  `graphify-out/` per D3.
