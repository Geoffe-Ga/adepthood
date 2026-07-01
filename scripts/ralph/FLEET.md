# Ralph Fleet — worktree-parallel Ralph

Ralph's outer loop can work **up to `max_workers` (default 4) parallelizable
backlog issues at once**, each in its own git worktree, and still preserve every
correctness guarantee of the sequential loop. This document is the design; the
mechanism is `scripts/ralph/fleet.sh`, the orchestration lives in
`.claude/commands/ralph-tick.md`, and the per-issue worker contract lives in
`scripts/ralph/PROMPT.md` (run by the `ralph-worker` agent).

## The core principle: optimistic parallelism, pessimistic merge

Two issues are "parallelizable" only as a **speculation** — we cannot perfectly
predict which files a change will touch before we make it. So the loop never
*relies* on that speculation for correctness. Instead:

- **Pick optimistically.** `pick-next.sh` hands out issues that *look*
  independent (different epics, not marked `solo`), up to the worker cap.
- **Work in isolation.** Each issue gets its own worktree under
  `.ralph/worktrees/issue-<N>` on branch `issue/<N>-<slug>`, so concurrent edits
  never collide on disk. Each worktree runs the full four-gate pipeline exactly
  as the sequential loop does.
- **Merge pessimistically.** Only **one PR merges to `main` per tick**. After a
  merge, every surviving worktree **syncs the new `main` into its branch (by
  merge, not rebase — so a plain push updates the PR, never a force-push) and
  re-runs its local gate** (`check-all.sh`) before it is itself allowed to merge.
  A worktree that cannot cleanly sync **drops to Gate 1** and fixes the conflict
  as a root-cause, failing-test-first change.

The result: an imperfect independence guess costs at most a sync (and, in the
worst case, one worker redoing part of its work) — it can **never** merge broken
or conflicting code, because the serialized-merge-then-sync step re-validates
every worktree against the real, updated `main`.

```
pick optimistically ──▶ work in parallel (isolated worktrees)
        │
   merge ONE PR/tick ──▶ sync new main into every other worktree (merge)
        │            ──▶ re-run check-all in each
    sync conflict?   ──▶ that worktree drops to Gate 1 (never a forced merge)
```

## Why worktrees (not branches in one tree, not clones)

- **Branches in one working tree** serialize edits — you can only have one
  checked out at a time. That is the *sequential* loop.
- **Full clones** duplicate history and lose the shared object store and hooks.
- **Worktrees** share one `.git` (one object store, one set of hooks, one config)
  while giving each issue its own checked-out files and index. That is exactly
  "N isolated working copies of one repo" — the right primitive here.

Ralph manages its **own persistent** worktrees rather than the `Agent` tool's
ephemeral `isolation: "worktree"` because a worktree must **survive across ticks**:
Gates 3–4 (CI + review) span multiple ticks, with the turn ending in between.

## Execution model

One re-entrant orchestrator session (`/loop /ralph-tick`) remains the single
brain. Each tick it:

1. **Reconciles** the fleet — releases worktrees whose PR merged/closed
   (`fleet.sh reconcile`).
2. **Merges at most one** LGTM+green PR, then syncs (merges main into) +
   re-greens every other worktree (the pessimistic-merge step).
3. **Advances** each active worker that needs a code action (Gate-1/2 fix, CI
   fix, review feedback) by launching a `ralph-worker` subagent **in that
   worktree** — up to `max_workers` in parallel, in one `Agent` message.
4. **Fills** free slots: while `fleet.sh free > 0` and `pick-next.sh` yields a
   compatible issue, assign a worktree and launch a `ralph-worker` for it.
5. **Arms one Monitor** across all in-flight PRs and ends the turn.

Workers never merge, never touch `main`, and never coordinate with each other —
all cross-worker coordination (merge order, rebase, slot allocation) is the
orchestrator's job. This keeps the concurrency model simple: **fan-out for
building, serialize for integrating.**

## Which issues run in parallel (the safety gate)

`pick-next.sh` is parallel-aware. Beyond the existing require/exclude label
filters and open-PR exclusion, it:

- **Excludes live worktree issues** (started, PR not yet opened) so the same
  issue is never handed to two workers.
- Gives the **first** worker (empty fleet) the lowest eligible issue, exactly as
  before — sequential behavior is unchanged when nothing else is active.
- For **additional** workers, only returns an issue *independent* of every active
  one:
  - never an issue labeled **`solo`** (`RALPH_SOLO_LABEL`) while others are active,
    and once a `solo` issue is active it monopolizes the fleet;
  - unless labeled **`parallelizable`** (`RALPH_PARALLEL_LABEL`), never an issue
    that shares an **epic** label with an active issue (same epic ⇒ likely
    ordered/overlapping). Toggle with `RALPH_RESPECT_EPICS=0`.

These heuristics only reduce *rebase churn*; they are **not** the correctness
mechanism. Correctness is the serialized-merge + rebase + re-green step above.

## Configuration (`scripts/ralph/state.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `max_workers` | `4` | Maximum concurrent worktrees. |
| `parallel_enabled` | `true` | `false` ⇒ effective cap of 1 (classic sequential Ralph, worktree-isolated). |

Set `parallel_enabled` to `false` (or `max_workers` to `1`) to fall straight
back to the one-issue-at-a-time loop with zero other changes.

## `fleet.sh` reference

| Command | Effect |
| --- | --- |
| `list` | `<issue>\t<branch>\t<path>` per active worktree. |
| `active` | Active issue numbers, space-separated. |
| `count` / `free` | Active count / remaining capacity (honors `parallel_enabled`). |
| `path <N>` | Worktree path for issue N (exit 1 if none). |
| `assign <N> <slug>` | Create/reuse a worktree off `origin/main`; prints its path; refuses when full. |
| `sync <N>` | Merge latest `origin/main` into issue N's branch (no force-push); exit 3 on conflict (aborted, left clean). |
| `release <N>` | Remove issue N's worktree + delete its branch. |
| `reconcile` | Release worktrees whose PR merged/closed or whose issue is closed; prune. |

`.ralph/` is git-ignored. Worktree state is always **derived from live git +
GitHub**, never from stored bookkeeping, so the loop stays re-entrant.

## Tests

`scripts/ralph/test_fleet.sh` builds a throwaway repo (with an `origin` remote
and a fake `gh`) and exercises assign / list / count / free / path / sync
(clean **and** conflicting) / release / reconcile offline:

```bash
bash scripts/ralph/test_fleet.sh
```

## Failure modes and how they're handled

| Scenario | Handling |
| --- | --- |
| Two "independent" issues touch the same file | Second-to-merge syncs main in; conflict ⇒ drops to Gate 1. Never a broken merge. |
| A worker crashes / abandons an issue | `reconcile` releases it once its PR closes; an un-PR'd stale worktree is re-detected and either resumed or released next tick. |
| Fleet silts up with merged work | `reconcile` at the top of every tick GCs merged/closed worktrees. |
| A genuinely serial issue | Label it `solo`; it runs alone and blocks fills until done. |
| Want to disable parallelism | `parallel_enabled: false` in `state.json`. |
