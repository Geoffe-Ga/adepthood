# Adepthood subagent taxonomy

The cast of subagents the **Ralph loop** dispatches to build one backlog issue per
tick. The conductor is the main Ralph session
(`.claude/commands/ralph-tick.md` → `scripts/ralph/PROMPT.md`); it spawns every
agent below via the `Agent` tool. The chief-architect is the strategic **brain**
(plans + a dispatch list); the specialists are the **hands**.

> Shared rules — the four gates, quality thresholds, and the anti-bypass block —
> live once in [`shared/adepthood-constraints.md`](shared/adepthood-constraints.md).
> Every agent links there; change a rule once, there.

## The graph (honest — every node exists in this repo)

In the **parallel fleet** (`scripts/ralph/FLEET.md`), `ralph-tick` is the fleet
**orchestrator**: it manages up to `max_workers` (default 4) git worktrees and
dispatches one **`ralph-worker`** per issue, each of which is the per-issue
conductor *inside its own worktree* (it spawns the graph below). In the classic
sequential loop the orchestrator drives a single worker. Either way the spawn
graph under a conductor is identical:

```
ralph-tick (fleet ORCHESTRATOR — reconcile · serialized-merge · sync · monitor)
  └─ ralph-worker × up to 4 . L1  opus    per-issue CONDUCTOR in an isolated worktree
       ├─ chief-architect ..... L0  opus    plan + ordered dispatch list (no code)
       ├─ test-specialist ..... L2  sonnet  Gate 1 RED: failing tests          ─┐
       ├─ implementation-spec.  L2  opus    Gate 1 GREEN + Refactor             │ run per
       ├─ security-specialist . L2  opus    harden auth/JWT/CORS/input/DB       │ the
       ├─ performance-spec. ... L2  sonnet  profile/optimize hot paths          │ architect's
       ├─ documentation-spec. . L2  sonnet  docstrings/READMEs/ADRs             │ dispatch
       ├─ dependency-review ... L2  sonnet  deps/pins/licenses (read-only)      │ list
       └─ code-review-orch. ... L1  opus    Gate 2.5 pre-push self-review      ─┘
```

**The tree above is the spawn graph: each conductor (`ralph-worker`, or
`ralph-tick` itself in the sequential loop) spawns every node under it directly.**
It is *not* a delegation hierarchy — the indentation does not mean chief-architect
spawns the others. chief-architect only *plans*; the conductor executes its
ordered dispatch list by spawning each specialist itself. The orchestrator
(`ralph-tick`) spawns `ralph-worker`s and nothing else; each worker spawns the
taxonomy inside its own worktree.

The frontmatter `delegates_to` / `receives_from` fields model **logical dataflow**
(who informs whom — e.g. the architect's risk flags reach the reviewers), **not**
the spawn mechanism, which is always the conductor. Only the two orchestrators
(chief-architect, code-review-orchestrator) hold the `Task` tool; the six
specialists are leaf workers that do their own work and do not sub-delegate.

## Model tiers (strategic mix)

**Opus** where judgment drives quality: `chief-architect` (design + dispatch),
`implementation-specialist` (production code is the core quality lever),
`security-specialist` (threat modeling), `code-review-orchestrator` (synthesis).
**Sonnet** for well-scoped roles guided by an explicit plan: `test-specialist`,
`performance-specialist`, `documentation-specialist`,
`dependency-review-specialist`.

## Gate → agent invocation matrix

| Stage | Conductor action | Agent(s) |
| --- | --- | --- |
| Plan | architect the issue → plan + dispatch list | **chief-architect** |
| Gate 1 RED | write failing tests | **test-specialist** |
| Gate 1 GREEN | implement + refactor to green | **implementation-specialist** |
| Cross-cutting (only if flagged) | harden / optimize / document / vet deps | **security / performance / documentation / dependency** specialists |
| Gate 2 | run `./scripts/<side>/check-all.sh` | — (conductor, Bash) |
| Gate 2.5 | pre-push self-review of the diff | **code-review-orchestrator** (reviews the flagged dimensions itself; may fan out to specialists in review mode where nested spawning is available) |
| Push / PR | commit, push, open PR | — (conductor) |
| Gate 3 fail (CI) | `ci-debugging` → fix | **test / implementation** specialist |
| Gate 4 fail (review) | `address-feedback` → fix | the specialist owning the comment's dimension |

## Dispatch sequence (one tick, one issue)

1. **chief-architect** reads the issue + `CLAUDE.md`/`AGENTS.md`, returns an
   Architecture Plan with an ordered dispatch list and risk flags
   (security / performance / deps / docs).
2. The conductor executes the list **sequentially** (write-agents share one
   working tree — no parallel edits): test-specialist → implementation-specialist
   → any flagged cross-cutting specialists.
3. Conductor runs **Gate 2** (`check-all.sh`); failures drop to Gate 1 via the
   relevant specialist.
4. **code-review-orchestrator** runs **Gate 2.5** over the diff and returns a
   consolidated, severity-ranked report; the conductor fixes blockers (drop to
   Gate 1) until `CLEAN`.
5. Conductor commits, pushes, opens the PR; Gates 3–4 proceed per
   `ralph-tick.md`.

## Design rules

- **Omit, don't pad.** The architect names only the specialists a given issue
  needs; invoking an unneeded specialist is waste, not thoroughness.
- **Plans flow down, findings flow up.** chief-architect → specialists;
  code-review-orchestrator ← specialists.
- **No gate is ever weakened to pass.** Every drop-back is a root-cause,
  failing-test-first fix (see `shared/adepthood-constraints.md`).

## Files

| File | Agent `name:` |
| --- | --- |
| `ralph-worker.md` | ralph-worker |
| `chief-architect.md` | chief-architect |
| `test-specialist.md` | test-specialist |
| `implementation-specialist.md` | implementation-specialist |
| `security-specialist.md` | security-specialist |
| `performance-specialist.md` | performance-specialist |
| `documentation-specialist.md` | documentation-specialist |
| `dependency-review-specialist.md` | dependency-review-specialist |
| `code-review-orchestrator.md` | code-review-orchestrator |
| `shared/adepthood-constraints.md` | (shared reference) |
