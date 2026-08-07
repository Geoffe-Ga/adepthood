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
- **Merge pessimistically, but never with a barrier.** Merges to `main` are
  **serialized** (one at a time — the single orchestrator session serializes them
  for free) and each merge is **always up-to-date**: a lane merges only when it is
  `LGTM` + CI-green + **proven** current with `main` — the compare API's
  `behind_by == 0`, as `pr-ready.sh` measures it. `mergeStateStatus` is *not* a
  freshness signal: GitHub computes `BEHIND` only when the base branch enforces
  strict/up-to-date status checks, which this repo does not, so a branch many
  commits behind `main` reports `CLEAN`. The `BEHIND` path below was designed but
  had never once fired here, so lanes were routinely merging out of date on a
  green that proved nothing about today's `main`. `CLEAN` is retained only as the
  sole signal for `DIRTY`/`CONFLICTING`/`BLOCKED`/`DRAFT`/`UNKNOWN`. If a sibling
  merged after this lane went green, the lane is behind; it **syncs the new
  `main` into its branch (by merge, not rebase — a plain push updates the PR
  and re-runs CI, never a force-push)** and merges on a later wake once green
  again. A lane that cannot cleanly sync **drops to Gate 1**. This sync is **lazy**
  — a lane only pays it when it is itself about to merge, not proactively every
  time any sibling merges.
- **Never wait on the slowest lane.** Whichever lane is ready merges immediately;
  the slot it frees refills at once. A fast lane at Gate 4 never waits for a slow
  lane at Gate 1.

The result: an imperfect independence guess costs at most a sync — it can
**never** merge broken or conflicting code (every merge is re-validated against
the real, updated `main`), and it **never** stalls a ready lane behind a slow one.

```
pick optimistically ──▶ N lanes build in parallel (isolated worktrees)
        │
   a lane goes LGTM+green ──▶ current (behind_by == 0)? ──▶ merge NOW, refill slot
        │                 ──▶ behind? ── sync main in (lazy) ── re-green ── merge next wake
   sync conflict?         ──▶ that lane drops to Gate 1 (never a forced merge)
```

## Why worktrees (not branches in one tree, not clones)

- **Branches in one working tree** serialize edits — you can only have one
  checked out at a time. That is the *sequential* loop.
- **Full clones** duplicate history and lose the shared object store and hooks.
- **Worktrees** share one `.git` (one object store, one set of hooks, one config)
  while giving each issue its own checked-out files and index. That is exactly
  "N isolated working copies of one repo" — the right primitive here.

Ralph manages its **own persistent** worktrees rather than the `Agent` tool's
ephemeral `isolation: "worktree"` because a worktree must **survive across wakes**:
Gates 3–4 (CI + review) span many wakes, with the turn ending in between.

## Execution model — an event-driven worker pool

One re-entrant orchestrator session (`/loop /ralph-tick`) is the single brain. It
runs a **worker pool**: up to `max_workers` **lanes**, each one issue in its own
worktree moving through the four gates **independently, on its own clock**. There
is **no per-tick barrier and no all-lanes Monitor** — the orchestrator is woken by
*per-lane events* and acts on whichever lane the wake is about.

On each wake it:

1. **Reconciles** — releases worktrees whose PR merged/closed (`fleet.sh
   reconcile`), freeing their slots.
2. **Merges every ready lane** — any PR that `pr-ready.sh` calls `ready`
   (`LGTM` + green + `CLEAN` + the compare API's `behind_by == 0`; `CLEAN` alone
   is not freshness — see above) merges *now*, serialized; a lane that is behind
   lazily syncs first and merges on a later wake. A ready lane never waits for a
   slow one.
3. **Advances failing lanes** — a `ralph-worker` is dispatched into the worktree
   of any PR that needs a fix (CI failure → `ci-debugging`; `CHANGES_REQUESTED` →
   `address-feedback`).
4. **Refills every open slot** — while `fleet.sh free > 0` and `pick-next.sh`
   yields a compatible issue, assign a worktree and launch a `ralph-worker`.
5. **Arms per-lane wakes (platform-aware)** — background workers wake it on
   their own completion. Remote sessions `subscribe_pr_activity`-subscribe each
   in-flight PR and arm a short (~180s) `ScheduleWakeup` while any PR is in
   Gate 3/4 (long ~1200–1800s only when every lane is still building). Local
   sessions have no webhooks: each in-flight PR instead gets a background
   `scripts/ralph/watch-pr.sh <N>` watcher (idempotent via pidfile) whose exit
   on state-change IS the wake, with the long fallback kept as the safety net.
   Then it ends the turn.

**Workers are background tasks.** Each `ralph-worker` is launched with
`run_in_background: true` and **never awaited** — launch, end the turn, and let its
completion be its own wake. Awaiting a batch of workers would re-introduce the
slowest-lane barrier this design exists to avoid. Workers never merge, never touch
`main`, and never coordinate with each other — all cross-lane coordination (merge
serialization, lazy sync, slot allocation) is the orchestrator's job: **fan-out
for building, serialize only the merge.**

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

These heuristics only reduce *sync churn*; they are **not** the correctness
mechanism. Correctness is the serialized, always-up-to-date merge (lazy sync +
re-green when behind) described above.

## Dependency lanes (Dependabot)

`.github/workflows/dependabot-to-ralph-issue.yml` files one `dependencies` issue
per bot PR and appends `Closes #<issue>` to that PR, so **the Dependabot PR is
Ralph's in-flight PR**. The loop therefore **adopts** such a lane instead of
building it: `fleet.sh adopt <issue> <PR>` puts the worktree on Dependabot's own
head branch, so fixes push there and a second PR is never opened.

**The picker needs no `RALPH_EXCLUDE_LABELS` override.** A bridged issue is
already never picked: `pick-next.sh` scans open PR bodies for
`(closes|fixes|resolves) #N`, and the bridge put `Closes #<issue>` there, so the
issue already reads as in-flight. Setting the override is a hazard in its own
right — it **replaces** the default exclusion list rather than adding to it, so
it silently re-admits `epic`, `blocked`, `wontfix`, `do-not-auto-merge`, and the
rest.

### `pr-ready.sh` tokens

One token per lane, exactly one action. This table, `pr-ready.sh`'s header, and
`.claude/commands/ralph-tick.md` Step 1 must always agree.

| Token | Means | Remedy |
| --- | --- | --- |
| `ready` | fresh `LGTM` + CI green + `CLEAN` + `behind_by == 0`. | Merge now. |
| `ready-unreviewed` | CI green *with at least one non-review check actually `SUCCESS`* + `CLEAN` + `behind_by == 0`, but this PR has no review gate: Dependabot both authored it and pushed its HEAD commit, and every `claude-review` entry reported `SKIPPED`. | Merge — on a `dependencies` lane only. On any other lane the review workflow is misconfigured: stop and investigate. |
| `behind` | `LGTM` + green but not current with `main`. | `fleet.sh sync <N>`; merge on a later wake once re-green. |
| `pending` | CI still running. | Wait for a later wake. |
| `ci-failed` | a check failed or errored. | Dispatch a `ci-debugging` worker into the lane. |
| `changes-requested` | a fresh verdict (posted after HEAD) that is not `LGTM` — `CHANGES_REQUESTED` or `COMMENTS`. Gate 4 failed. | Dispatch an `address-feedback` worker into the lane. Terminal for `watch-pr.sh` — the watcher exits on it, so the verdict is a wake, never a timeout. |
| `awaiting-review` | no verdict yet, or only a stale one that predates HEAD (a fresh non-LGTM is `changes-requested` instead). | Wait for the review or re-review; `watch-pr.sh` counts this as in-flight. |
| `optout` | `do-not-auto-merge` on the PR, on the issue its body closes, or — when a Dependabot PR's body links nothing — on the bridge issue carrying that PR's `<!-- dependabot-pr:<N> -->` marker. | Leave the lane entirely alone — no merge, no sync, no worker, and never `assign`/`adopt` a new one. A worktree it already holds **stays held** (`reconcile` releases only on `MERGED`/`CLOSED`): releasing it would discard work a human paused. Run `fleet.sh release <N>` by hand to take the slot back. |
| *non-zero exit* | could not classify (API failure, expired token). | Leave the lane alone this wake; the next wake retries. |

**Gate 4 on a bot PR.** `claude-code-review.yml` skips runs whose `github.actor`
is Dependabot, because GitHub withholds Actions secrets from them. That skip was
re-keyed from the PR's author to the actor, so once one of our commits lands on
the bot branch — which every synced or adapted lane produces — the review runs
and the bump clears Gate 4 normally. `ready-unreviewed` therefore covers only the
residual case: a bump already current with `main` and already green, that nobody
had to touch. The whole merge evidence there is green CI **verified against
current `main`**, and `pr-ready.sh` pins each word of that:

- **Green must mean CI ran.** `gh pr checks` exits 0 when every check merely
  skipped, and each test workflow is `paths:`-filtered to its own sources — so a
  `github-actions` ecosystem bump (only `.github/workflows/*.yml`) matches none
  and lands **zero** checks. At least one non-review check must report `SUCCESS`,
  or "green CI replaces the review" is a claim about nothing, on exactly the PRs
  that rewire the workflows holding our secrets.
- **Untouched must mean untouched.** The rollup is per-HEAD-commit, so a bot
  force-push (`@dependabot recreate`, a group recomputation) after we adapted a
  branch would hand back a fresh all-`SKIPPED` rollup with the author still
  `app/dependabot`. The PR's author *and* its HEAD commit's author must both be
  Dependabot.
- **Never a human PR.** The author match is exact (`app/dependabot`), so no skip
  condition landing on the review workflow can leak this token onto a human lane.

**Consent.** The previous operating rule — a bot-PR merge needs the repo owner's
explicit OK — is *replaced* by that evidence, not silently dropped. The per-PR
human hold is the `do-not-auto-merge` label on the PR or on its bridge issue: its
**absence** is what lets a lane merge, and its presence stops the loop dead
(`optout`). Two routes reach that bridge issue, because Dependabot regenerates
its PR body from its own template on every rebase and group recomputation and
takes the bridge's appended `Closes #N` with it: the body link, and — only on a
Dependabot PR whose body links nothing — the `<!-- dependabot-pr:<N> -->` marker
the bridge stamped into the ISSUE body, which the PR rewrite cannot reach. An
*undeterminable* hold (the label lookup failed) is a tooling error that stalls
the lane, never a silent "no hold"; so is an *unprovable* one, where neither
route resolves — that scan is filtered by the `dependencies` label, which has
been watched to fail to stick (hence `ensure-issue-label.sh`), so a matchless
scan is silence, not proof. Such a lane still classifies normally and is refused
(exit 2, no token) only where it would otherwise print `ready`/`ready-unreviewed`
— `behind` still prints `behind`, since a sync is always safe and often re-links
the body. The label must exist in the repo
for a human to apply it — `scripts/setup-scan-labels.sh` creates it idempotently,
run via `.github/workflows/labels-bootstrap.yml` (`workflow_dispatch`).

**A grouped bump lands whole or not at all.** Never remove a pin from the group
and never pin one back to make it green — adapt the code instead.

**SDK exclusions live in `.github/dependabot.yml`**, as `ignore:` version ranges
(`styleq >=0.2.0`, `expo-av >=16.0.0`, `expo-notifications >=0.30.0`, and ~20
more, deferred to epic #885), so Dependabot never opens such a PR. The loop
deliberately does **not** re-encode that list: a name-only blocklist would be
both redundant and wrong — it would defer an allowed in-range patch such as
`styleq 0.1.4`.

**Orphan cleanup.** A bot PR closed *without* merging leaves its bridge issue
orphaned — the `Closes` never fires, and the picker's in-flight scan sees only
open PRs — so the bridge workflow's reconciler closes those.

## Configuration (`scripts/ralph/state.json`)

`state.json` is **git-ignored** — it holds machine-local loop bookkeeping
(completion counters, groom/de-slop timers), not shared state. Tracking it meant
every tick pushed a counter-bump commit to `main`, which the `no-commit-to-branch`
hook exists to prevent. Seed a fresh clone with:

```bash
cp scripts/ralph/state.example.json scripts/ralph/state.json
```

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
| `adopt <N> <PR>` | Create/reuse a worktree for issue N on PR's **existing** head branch (a bot PR's), so fixes push there instead of opening a second PR; prints its path; refuses a fork PR, a full fleet, and reuse of an existing worktree that sits on a different branch (an `assign`ed lane would push to `issue/<N>-<slug>` and open that second PR). |
| `sync <N>` | Merge latest `origin/main` into issue N's branch (no force-push); exit 3 on conflict (aborted, left clean). |
| `release <N>` | Remove issue N's worktree + delete its branch. |
| `reconcile` | Release worktrees whose PR merged/closed or whose issue is closed; prune. |

`.ralph/` is git-ignored. Worktree state is always **derived from live git +
GitHub**, never from stored bookkeeping, so the loop stays re-entrant.

## Tests

Seven offline suites cover the fleet — six shell, one Python — all run in CI by
`.github/workflows/ralph-recap-tests.yml` on any `scripts/ralph/**` change:

- `scripts/ralph/test_fleet.sh` builds a throwaway repo (with an `origin` remote
  and a fake `gh`) and exercises assign / adopt / list / count / free / path /
  sync (clean **and** conflicting) / release / reconcile.
- `scripts/ralph/test_pick_next.sh` stubs `gh` and exercises the picker's
  parallel-awareness: first-worker-lowest, worktree exclusion, in-flight-PR
  exclusion, the `solo` guard (candidate and active), the same-epic guard, the
  `parallelizable` override, and `RALPH_RESPECT_EPICS=0`.
- `scripts/ralph/test_pr_ready.sh` stubs `gh` and pins every status token: CI
  classification from the **exit code** (8 ⇒ `pending`, never `ready`), the
  stale-verdict guard, the `do-not-auto-merge` hold — including that it resolves
  the *last* issue link in the body, that it falls back to the bridge issue's
  `<!-- dependabot-pr:<N> -->` marker (whole-marker match, every match checked,
  bot lanes only) when Dependabot has rewritten that link away, and that an
  unreadable label answer or an unprovable hold fails closed (exit 2, not "no
  hold") — the freshness guard (`CLEAN` is not proof of
  being current) and its laziness (only a would-be-`ready` lane pays for the
  compare probe), the `ready-unreviewed` path, and the `changes-requested`
  split (a fresh non-LGTM verdict is actionable; missing/stale keeps waiting).
- `scripts/ralph/test_watch_pr.sh` covers `watch-pr.sh`, the per-lane hot
  watcher local sessions background: pidfile idempotence, the
  in-flight→terminal-token exit (including that `changes-requested` ends the
  watch), API-error tolerance, the `gone` exit, and the timeout.
- `scripts/ralph/test_exec_bits.sh` asserts every `scripts/ralph/*.sh` is
  committed `100755` (`git ls-files -s`), so a directly-invoked script can
  never again ship exiting 126 — the mode CI's `bash <script>` launches mask.
- `scripts/ralph/test_ensure_issue_label.sh` covers `ensure-issue-label.sh`, the
  prove-it-stuck labeller the Dependabot bridge files its issues with.
- `pytest scripts/ralph` (`test_recap_stats.py`) covers the recap's pure stats
  math and its backlog filter.

```bash
bash scripts/ralph/test_fleet.sh
bash scripts/ralph/test_pick_next.sh
bash scripts/ralph/test_pr_ready.sh
bash scripts/ralph/test_watch_pr.sh
bash scripts/ralph/test_exec_bits.sh
bash scripts/ralph/test_ensure_issue_label.sh
python -m pytest scripts/ralph -q
```

## Failure modes and how they're handled

| Scenario | Handling |
| --- | --- |
| Two "independent" issues touch the same file | Whichever merges first wins; the other reads `behind`, lazily syncs main in, re-greens, then merges. A sync conflict ⇒ drops to Gate 1. Never a broken merge. |
| A lane is green but out of date with `main` | Its own green proves nothing about today's `main`. `pr-ready.sh` derives freshness from the compare API (`behind_by`), not `mergeStateStatus`, so this reads `behind` even while GitHub says `CLEAN`; the lane syncs, re-greens, and merges on a later wake. |
| A bot PR whose review job cannot run | Untouched Dependabot PRs trigger no `claude-review` (no secrets for bot-actor runs). Any commit of ours on that branch makes the job runnable, so a synced or adapted bump clears Gate 4 normally; an untouched, already-current, already-green bump merges as `ready-unreviewed` on freshness-verified CI that demonstrably ran, with no `do-not-auto-merge` hold set. |
| A slow lane would stall a fast one | It can't — lanes are independent; a ready lane merges immediately and its slot refills without waiting on any sibling. |
| A worker crashes / abandons an issue | `reconcile` releases it once its PR closes; an un-PR'd stale worktree is re-detected and either resumed or released on the next wake. |
| Fleet silts up with merged work | `reconcile` at the top of every wake GCs merged/closed worktrees. |
| A genuinely serial issue | Label it `solo`; it runs alone and blocks fills until done. |
| Want to disable parallelism | `parallel_enabled: false` in `state.json`. |
