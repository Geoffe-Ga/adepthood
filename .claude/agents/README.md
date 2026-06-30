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

```
ralph-tick (main loop = CONDUCTOR; spawns every agent)
  └─ chief-architect ............ L0  opus    plan + ordered dispatch list (no code)
       ├─ test-specialist ........... L2  sonnet  Gate 1 RED: failing tests
       ├─ implementation-specialist . L2  opus    Gate 1 GREEN + Refactor
       ├─ security-specialist ....... L2  opus    harden auth/JWT/CORS/input/DB
       ├─ performance-specialist .... L2  sonnet  profile/optimize hot paths
       ├─ documentation-specialist .. L2  sonnet  docstrings/READMEs/ADRs
       ├─ dependency-review-spec. ... L2  sonnet  deps/pins/licenses (read-only)
       └─ code-review-orchestrator .. L1  opus    Gate 2.5 pre-push self-review
```

Only the two orchestrators (chief-architect, code-review-orchestrator) hold the
`Task` tool. The six specialists are leaf workers — they do their own work and do
not sub-delegate.

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
| Gate 2.5 | pre-push self-review of the diff | **code-review-orchestrator** → its specialists in review mode |
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
| `chief-architect.md` | chief-architect |
| `test-specialist.md` | test-specialist |
| `implementation-specialist.md` | implementation-specialist |
| `security-specialist.md` | security-specialist |
| `performance-specialist.md` | performance-specialist |
| `documentation-specialist.md` | documentation-specialist |
| `dependency-review-specialist.md` | dependency-review-specialist |
| `code-review-orchestrator.md` | code-review-orchestrator |
| `shared/adepthood-constraints.md` | (shared reference) |
