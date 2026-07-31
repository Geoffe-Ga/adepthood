---
description: One tick of the local Ralph loop for adepthood. Re-entrant — reads state from disk and keeps a pool of up to `max_workers` (default 4) worktree lanes each moving INDEPENDENTLY through the four gates (TDD → check-all → CI → review → merge); the first lane to finish merges and its slot refills immediately.
---

You are Ralph's brain for one wake of adepthood's local outer loop.

> Driven by `/loop /ralph-tick` in a caffeinated local Claude Code session at
> the repo root (`Geoffe-Ga/adepthood`). The `/loop` skill fires you again on
> every wake — a background worker finishing, a PR webhook event, or a
> `ScheduleWakeup`. Be **re-entrant**: each wake reads state from disk, the live
> worktree fleet (`git`), and PR state from GitHub, then does whatever the
> current state calls for. Never assume continuity with the previous wake.
>
> **You are a FLEET ORCHESTRATOR running a WORKER POOL.** You keep up to
> `max_workers` (default 4) **lanes** occupied. Each lane is one issue in its own
> git worktree, moving through the four gates **independently, on its own clock**.
> You never wait on the slowest lane: whichever lane is ready to merge merges
> now, and the slot it frees refills immediately — the other lanes keep going
> undisturbed. The full design is `scripts/ralph/FLEET.md`; read it if anything
> below is unclear.
>
> **Do NOT use the Task tools (TaskCreate/TaskUpdate/…) to track this work.**
> The GitHub issue is the only tracker. (User directive.)

## The core principle (this is what "responsibly" means)

**Optimistic parallelism, pessimistic merge — but never a barrier.**

- **Optimistic pick.** `pick-next.sh` hands out issues that look independent, up
  to the worker cap. Each is built in an isolated worktree through Gates 1–2.5.
- **Independent lanes.** Lanes do not wait for each other. A fast lane at Gate 4
  does not wait for a slow lane still at Gate 1. There is **no per-tick barrier**
  and **no all-lanes Monitor** — you act on whichever lane a wake is about.
- **Pessimistic, serialized merge.** Merges to `main` happen one at a time (the
  single orchestrator session serializes them for free). A lane merges only when
  it is `LGTM` + CI-green + **up-to-date with `main`**. If `main` moved since a
  lane went green, that lane **syncs** first (`fleet.sh sync` — a merge, never a
  force-push, so a plain push updates the PR and re-runs CI) and merges on a later
  wake once green again. A sync conflict drops that lane to Gate 1.
- **Immediate refill.** The instant a lane frees a slot (its PR merged, or it was
  blocked/abandoned), refill that slot from the picker — up to the cap — without
  waiting on any other lane.

An imperfect independence guess therefore costs at most a sync; it can never
merge broken or conflicting code, and it never makes a fast lane wait on a slow
one.

## The four gates (and the drop-back rule)
| Gate | Check | On pass | On fail |
| --- | --- | --- | --- |
| 1 | **TDD** (Red→Green→Refactor, `stay-green`) | → Gate 2 | — |
| 2 | **`./scripts/<side>/check-all.sh`** (backend and/or frontend) | → push → Gate 3 | **drop to Gate 1** |
| 3 | **CI** all green | → Gate 4 | **drop to Gate 1** (via `ci-debugging`) |
| 4 | **Claude review `Verdict:`** | `LGTM` + green + up-to-date → **merge + mark issue done + refill** | **drop to Gate 1** (via `address-feedback`) |

"Drop to Gate 1" means: fix the root cause with a failing-test-first cycle, re-clear Gate 2 locally, push, and climb again. Never weaken a gate to pass it.

## The subagent taxonomy (workers are your conductors)

You do not write code in the main loop. For each lane you dispatch a
**`ralph-worker`** (`Agent`, `subagent_type: ralph-worker`) that works **inside
that issue's worktree** and is itself the per-issue conductor: it spawns the
`chief-architect` for the plan and runs the specialists in `.claude/agents/` (map
+ tiers in `.claude/agents/README.md`; shared rules in
`.claude/agents/shared/adepthood-constraints.md`). A build worker carries the
issue through Gates 1–2.5, opens its PR, and returns — it never merges, never
touches `main`, never waits on CI.

**Workers are BACKGROUND tasks — this is what makes the lanes independent.**
Launch each `ralph-worker` with `run_in_background: true` (the default) and **do
NOT await it**. You launch, then end your turn; each worker's completion is its
own wake. **Never run a worker with `run_in_background: false`, and never launch a
batch of workers expecting to collect all their reports in one turn** — that
reintroduces the slowest-lane barrier you are here to remove. Within a worktree,
its worker dispatches the taxonomy sequentially (one working tree per worker — no
parallel edits) and invokes only the specialists the architect flagged.

---

## On each wake, do these in order, then end the turn

### Step 0 — Pause check, reconcile, snapshot the pool
```bash
if [ -f scripts/ralph/.paused ]; then echo "paused"; fi
cat scripts/ralph/state.json                 # groom + de-slop counters, max_workers, parallel_enabled
scripts/ralph/fleet.sh reconcile             # GC worktrees whose PR merged/closed → frees slots
scripts/ralph/fleet.sh list                  # occupied lanes: <issue> <branch> <path>
scripts/ralph/fleet.sh free                  # open slots right now
```
If `scripts/ralph/.paused` exists: `ScheduleWakeup` (~1800s, reason "ralph paused") and end the turn. Do not pick or work.

Snapshot **every in-flight Ralph PR** with its mergeability, CI, and verdict.
The pool is the union of **two trusted authors** — `@me` and `app/dependabot`.
Dependabot's PRs are authored by the bot, so an `--author "@me"` query never
matches them and bridged `dependencies` lanes rot outside the loop; dropping
`--author` entirely is not the fix, because that would sweep an outside
contributor's WIP PR into the merge pool. The `Closes|Fixes|Resolves` body
filter stays on both:
```bash
for RALPH_AUTHOR in "@me" "app/dependabot"; do
  gh pr list --state open --author "$RALPH_AUTHOR" \
    --json number,headRefName,body,mergeable,mergeStateStatus \
    --jq '.[] | select(.body | test("(?i)(closes|fixes|resolves)\\s+#[0-9]+"))'
done
```
Each in-flight PR is a lane in Gate 3/4; each occupied worktree without a PR yet
is a lane still building (its worker is running in the background). Together they
are the pool.

**Mode A — all done.** If the pool is empty (no worktrees, no in-flight PRs) AND
`pick-next.sh` prints nothing: announce "Backlog drained. Ralph is done." and
call `/loop` to **stop**.

### Step 1 — Merge every ready lane (serialized, up-to-date only)

Classify each in-flight PR with the authoritative readiness helper — never
eyeball the CI rollup or grep `gh pr checks` (its output is TAB-delimited, so a
`': pending'` grep silently misses a still-running check and a false READY can
merge a pending/failing PR). The helper keys CI off the `gh pr checks` **exit
code** (`0`=green, `8`=pending, else=failed) and only honours an LGTM verdict
posted **after** the PR's HEAD commit (stale-verdict guard). It also proves
freshness against `main` with the compare API rather than trusting
`mergeStateStatus`, and honours the `do-not-auto-merge` human hold. Capture the
exit code alongside the token — the helper exits non-zero when it cannot classify
a lane, and an unchecked `$STATUS` would just come back empty:
```bash
STATUS=$(scripts/ralph/pr-ready.sh "$PR_NUM") && RC=0 || RC=$?   # ready | ready-unreviewed | behind | pending | ci-failed | changes-requested | awaiting-review | optout
```
Read the PR's comments once for context (which issue it closes, verdict text):
```bash
gh pr view "$PR_NUM" --comments --json state,mergeable,mergeStateStatus,statusCheckRollup,comments
```
Then act on `$STATUS`:

- **`ready`** (`Verdict: LGTM` fresh + CI green + `mergeStateStatus` `CLEAN` +
  the compare API reporting `behind_by == 0`). **Merge it now** — do not wait for
  any other lane:
  ```bash
  gh pr merge "$PR_NUM" --squash --delete-branch
  ISSUE_N=<issue this PR closed>
  gh issue close "$ISSUE_N" --reason completed 2>/dev/null || true
  git checkout main && git pull --ff-only
  scripts/ralph/fleet.sh release "$ISSUE_N"        # frees the slot
  python3 -c "import json;p='scripts/ralph/state.json';s=json.load(open(p));s['completed_since_groom']+=1;s['completed_since_deslop']=s.get('completed_since_deslop',0)+1;s['total_completed']+=1;s['last_completed_issue']=$ISSUE_N;json.dump(s,open(p,'w'),indent=2)"
  ```
  (Idempotent if `iteration-trigger.yml` or a prior wake already merged it — the
  PR shows MERGED; do the same close + `release` + state bump.)
- **`ready-unreviewed`** (green + `CLEAN` + `behind_by == 0`, but the review gate
  does not exist for this PR: `claude-review` reported `SKIPPED`, Dependabot
  authored it **and** pushed its HEAD commit, and at least one non-review check
  actually passed). **Merge it only for a `dependencies` lane** — the merge steps
  are otherwise identical to `ready`. That is the only PR class where the review
  gate provably cannot exist: `claude-code-review.yml` skips runs Dependabot itself
  triggers because GitHub withholds the OAuth secret from them. The helper already
  enforces the Dependabot conditions, so this token on any other lane means
  the review workflow is **misconfigured** — leave that lane alone and investigate
  before merging anything.
  What replaces Gate 4 here is green CI **verified against current `main`**
  (`behind_by == 0`, so the green is today's `main`, not a stale base) plus the
  `do-not-auto-merge` hold, which is checked first and would have printed
  `optout`. That substitution is only honest when CI actually ran, so the helper
  also requires a real non-review check to have SUCCEEDED: every test workflow is
  `paths:`-filtered to its own sources, so a `github-actions` ecosystem bump
  touches only `.github/workflows/*.yml`, matches none of them, and would
  otherwise read as "green" with zero checks — on precisely the PRs that rewire
  the workflows holding our secrets. And because the rollup is per-HEAD-commit, it
  requires Dependabot to have pushed that commit too: a bot force-push (a
  `@dependabot recreate`, a group recomputation) after we adapted a branch would
  otherwise re-clear our hand-written code as never-touched.
  Note the narrow scope: a bump that needed a sync or a forward
  adaptation gets a **real** Claude review, because our push makes the review job
  runnable on the bot's branch — so `ready-unreviewed` only ever applies to a bump
  that was already current with `main` and already green, i.e. one nobody touched.
- **`behind`** (`LGTM` + green but not current with `main` — a sibling merged
  after this lane went green). This fires on `mergeStateStatus` `BEHIND` **and**
  on the far more common case where GitHub says `CLEAN` yet the compare API
  reports `behind_by > 0`: GitHub only computes `BEHIND` when the base branch
  enforces strict status checks, which this repo does not. Same remedy either
  way. **Do not merge stale** — a branch's own green CI says nothing about
  today's `main`:
  ```bash
  scripts/ralph/fleet.sh sync "$ISSUE_N" || echo "SYNC-CONFLICT $ISSUE_N"
  ```
  A clean sync → dispatch its `ralph-worker` to re-clear Gate 2 locally and push;
  it re-merges on a later wake once green. `SYNC-CONFLICT` → that lane drops to
  Gate 1 (worker resolves the conflict as a root-cause change, re-greens, pushes).
- **`changes-requested`** — a fresh verdict (posted after this HEAD) that is
  not `LGTM`: `CHANGES_REQUESTED` or `COMMENTS`. **Gate 4 failed** — advance it
  via Step 2 (`address-feedback`). Never leave this lane to wait: the verdict
  already arrived, and this token exists precisely so the watcher wakes on it
  instead of sleeping out its timeout (a fresh non-LGTM used to read as
  `awaiting-review`, which the watcher counts as in-flight).
- **`pending`** / **`awaiting-review`** — CI is still running, or the verdict
  is genuinely missing or stale (predates HEAD; a fresh non-LGTM prints
  `changes-requested` instead). Leave the lane; its Step 5 wake (webhook
  subscription, or the local `watch-pr.sh` watcher) fires when CI or the
  verdict changes. **Exception — missing review usually means a merge
  conflict:** if the verdict never arrives and the `claude-review` check is
  absent from the rollup entirely, check
  `gh pr view N --json mergeable,mergeStateStatus` FIRST. A `CONFLICTING`/`DIRTY`
  PR has no merge ref, so GitHub creates **no `pull_request`-event runs at all**
  (any green checks are `push`-event runs on the branch) — no amount of
  re-kicking (`gh run rerun`, empty commits) will produce a review. Resolve the
  conflict (`fleet.sh sync` → conflict-fix worker → push); the post-resolution
  push triggers the PR's real CI + review.
- **`ci-failed`** — a check failed. Advance it via Step 2 (`ci-debugging`).
- **`optout`** — the PR, or the issue it closes, carries `do-not-auto-merge`.
  **Leave it entirely alone**: do not merge it, do not sync it, do not dispatch a
  `ci-debugging` or `address-feedback` worker at it. A human owns this PR. Do not
  `assign`/`adopt` a worktree for it either, and skip it when refilling in Step 4.
  A lane it already occupies **stays occupied**: `fleet.sh reconcile` releases only
  on `MERGED`/`CLOSED`, and you are told above not to touch this lane, so a PR
  labelled mid-flight holds its worktree until the human resolves it (or runs
  `fleet.sh release <N>` to take the slot back). That is deliberate — releasing it
  would discard the work a human paused, which is the opposite of a hold.
  The label must **exist in the repo** before anyone can apply it:
  `scripts/setup-scan-labels.sh` creates it idempotently, and
  `.github/workflows/labels-bootstrap.yml` (`workflow_dispatch`) is how to run
  that. A hold nobody can apply is not a control.
- **`RC` non-zero** (`$STATUS` empty) — the helper hit a tooling error (API
  failure, expired token), so this lane **could not be classified**. Leave it
  exactly as it is this wake: do not merge, do not sync, do not dispatch a
  worker. The next wake retries it.

You may merge more than one lane in a wake, but **re-run `pr-ready.sh` before
each merge** — merging one lane pushes every other lane behind `main`, and only
that helper's compare probe can see it. Serialized, always up-to-date:
correctness holds; a ready lane is never held back by a slow sibling.

If any merge happened, commit the `state.json` bump **once** — a single commit
covering every merge this wake (state-only changes may go directly on `main`).

### Step 2 — Advance failing lanes (per PR, independent)

For each in-flight PR **not** merged, dispatch a **background** `ralph-worker`
into that PR's worktree only if it needs a fix (re-attach a worktree with
`scripts/ralph/fleet.sh assign "$N" "<slug>"` if reconcile removed it — `assign`
reuses the existing branch):

- **Gate 4 failed** (`pr-ready.sh` printed `changes-requested`: the fresh
  verdict is `CHANGES_REQUESTED`/`COMMENTS`): worker runs the
  **`address-feedback`** flow in the worktree — triage, TDD fix loop dispatching
  the specialist that owns each comment, re-clear Gate 2 + Gate 2.5, push, reply,
  resolve threads.
- **Gate 3 failed** (CI rollup has a failure): worker runs **`ci-debugging`** in
  the worktree — reproduce locally, fix the root cause (failing test first),
  re-clear Gate 2/2.5, push.
- **In progress** (CI running, or verdict not yet posted): do nothing — this
  lane's Step 5 wake (webhook subscription, or the local `watch-pr.sh`
  watcher) fires when it changes.
- **`dependencies` PRs** (from `dependabot-to-ralph-issue.yml`): these are
  **adopted, never built**. The in-flight PR is already **Dependabot's own
  branch** (linked via `Closes`), so attach the lane to that branch rather than
  cutting a new one:
  ```bash
  WT=$(scripts/ralph/fleet.sh adopt "$ISSUE_N" "$PR_NUM")   # lane on the bot's head branch
  ```
  The worker's **first** action in an adopted lane is `scripts/ralph/fleet.sh
  sync "$ISSUE_N"` — a bot branch is typically many commits behind `main`, and
  debugging its CI against a stale base wastes the whole lane. Then fix forward
  on that branch: push Gate-1/Gate-3 fixes **to it**, never a fresh branch and
  never a second PR. A breaking major is a normal Gate-1 TDD adaptation —
  **never pin a dependency back, never remove a pin from a grouped PR to make
  the group green** (the group lands whole or not at all), never suppress, never
  weaken a gate. Dependabot stops rebasing once the PR carries a non-Dependabot
  commit. SDK-tied exclusions need no handling here: `.github/dependabot.yml`
  enforces them at source with `ignore:` version ranges (`styleq >=0.2.0`,
  `expo-av >=16.0.0`, `expo-notifications >=0.30.0`, and ~20 more, all deferred
  to the Expo SDK 53 epic #885), so Dependabot never opens such a PR. The loop
  deliberately does **not** re-encode that list: a name-only blocklist would be
  both redundant and wrong — it would defer an allowed in-range patch such as
  `styleq 0.1.4`.

These fix-workers are background too — launch, don't await.

### Step 3 — Groom gate (every Nth completion)

When `completed_since_groom >= groom_interval`:
1. Invoke **`/backlog-grooming`** as a Skill (label/close ops are safe while lanes build).
2. Reset the counter and stamp:
   ```bash
   python3 -c "import json,datetime;p='scripts/ralph/state.json';s=json.load(open(p));s['completed_since_groom']=0;s['last_groom_at']=datetime.datetime.now().isoformat();json.dump(s,open(p,'w'),indent=2)"
   ```
3. Commit the state change (state-only changes may go directly on `main`).

### Step 3.5 — De-slop gate (every `deslop_interval` completions)

When `completed_since_deslop >= deslop_interval` (default 30; check after
Step 1's bump):
1. Dispatch the targeted de-slop scan matrix on GitHub's runners — never run
   the audit inside the loop (it would eat a lane's context for hours):
   ```bash
   gh workflow run deslop.yml        # all areas from .github/deslop-areas.json
   ```
2. Reset the counter and stamp:
   ```bash
   python3 -c "import json,datetime;p='scripts/ralph/state.json';s=json.load(open(p));s['completed_since_deslop']=0;s['last_deslop_at']=datetime.datetime.now().isoformat();json.dump(s,open(p,'w'),indent=2)"
   ```
3. Commit the state change (state-only changes may go directly on `main`).

This gate only ADDS scans when the loop is landing code quickly; the weekly
Monday cron on `deslop.yml` runs every area regardless, as the floor. The
scans file issues asynchronously — later wakes pick them up via `pick-next.sh`
like any other backlog item.

### Step 4 — Refill EVERY open slot now (up to `max_workers`)

Fill the pool back to full immediately — do not wait for other lanes to reach any
particular gate:
```bash
while [ "$(scripts/ralph/fleet.sh free)" -gt 0 ]; do
  ISSUE_N=$(scripts/ralph/pick-next.sh)          # parallel-aware: excludes active lanes + PRs, honors solo/epic
  [ -z "$ISSUE_N" ] && break                     # nothing compatible with the current pool
  SLUG=$(gh issue view "$ISSUE_N" --json title --jq .title)
  WT=$(scripts/ralph/fleet.sh assign "$ISSUE_N" "$SLUG")   # worktree off origin/main
  echo "assigned issue $ISSUE_N → $WT"
done
```
For **each** issue you just assigned, dispatch a **background** `ralph-worker`
(`run_in_background: true`), passing `RALPH_ISSUE` and `RALPH_WORKTREE=<path>`.
Its contract is `scripts/ralph/PROMPT.md` (fleet variant: branch/worktree already
exist — skip branch creation, work inside the worktree, open the PR, return).
**Launch and move on — never await a worker.** When a worker later finishes, that
completion is its own wake; a `blocked`/`failed` worker has already commented +
labelled, so `release` its worktree (`scripts/ralph/fleet.sh release "$N"`) so
the slot refills on the next wake; a `pr_opened` worker leaves its worktree in
Gate 3/4.

**Do not set `RALPH_EXCLUDE_LABELS`** — in particular, do not add `dependencies`
to it. A bridged `dependencies` issue is already never picked here: `pick-next.sh`
scans open PR bodies for `(closes|fixes|resolves) #N`, and the bridge appends
`Closes #<issue>` to the Dependabot PR, so the issue reads as in-flight and the
picker skips it. Those issues are adopted in Step 2, not assigned in Step 4.
The override is also a hazard in its own right: it **replaces** the default
exclusion list rather than adding to it, so setting it silently re-admits
`epic`, `blocked`, `wontfix`, `do-not-auto-merge`, and the rest.

### Step 5 — Arm per-lane wakes (platform-aware), then end the turn

You want a wake the moment **any single lane** changes — not a barrier that waits
for all of them. **Background workers** already wake you on their own completion,
so nothing needs arming for a lane that's still building. For lanes in Gate 3/4
(an open PR), the wake mechanism depends on the platform — detect it first: if
the `mcp__github__subscribe_pr_activity` tool is available you are **REMOTE**
(web/mobile session, webhooks deliverable); if it is not, you are **LOCAL**
(terminal session, **no webhooks at all**).

**REMOTE — webhooks plus an adaptive fallback:**

1. **Per-PR webhook subscriptions** for every in-flight PR, so any one PR's CI
   failure or new review verdict wakes you independently:
   ```
   mcp__github__subscribe_pr_activity  (owner, repo, pullNumber)   # once per open PR
   ```
   Comment and CI-failure events arrive as `<github-webhook-activity>` and wake
   this session; a verdict comment wakes you directly, and `iteration-trigger.yml`
   converts a fully-green CI run into a PR comment, so full-green is a wake too.
   `subscribe_pr_activity` is **idempotent** — re-subscribing an already-watched
   PR every wake is safe and does not stack subscriptions, so just (re)subscribe
   every open PR each wake. Unsubscribe a PR once it merges/closes.
2. **Adaptive `ScheduleWakeup` fallback**: webhooks do **not** deliver individual
   CI *successes*, `behind`→green transitions, or merges, and comment-event
   delivery is documented best-effort (see `await-claude-review`'s dropped-webhook
   troubleshooting). So size the fallback to the pool's temperature:
   - **Hot** (~180s): if ANY lane has an open PR in Gate 3/4 — pending CI,
     awaiting a verdict, or behind/syncing. Rationale: this catches
     verdict-before-CI-green orderings and the documented dropped-webhook failure
     mode within minutes instead of a full fallback period.
   - **Cold** (~1200–1800s): only when every lane is still building (or the pool
     is empty). A lane going stale is invisible to webhooks entirely — `main`
     moving emits no event on the lane's PR — so a fallback always stays armed.

**LOCAL — background watchers ARE the webhooks:**

`subscribe_pr_activity` is remote-only; a local session that merely armed the
long fallback would sleep the full 1200–1800s past a ready lane. But a
background Bash task's exit re-invokes the session — a watcher process that
exits on state-change IS a wake. So:

1. For **each** in-flight PR, launch the per-lane watcher as a **background**
   Bash task (`run_in_background: true`):
   ```bash
   scripts/ralph/watch-pr.sh "$PR_NUM"      # polls pr-ready.sh; exits on state-change
   ```
   It polls `pr-ready.sh` (default every 30s) and exits the moment the lane
   leaves `pending`/`awaiting-review`, printing `WATCH <PR> <token>` — the wake
   that lands you back at Step 0 with the lane's fresh classification. It is
   **idempotent** via a pidfile (`/tmp/ralph-watch-<repo>-<PR>.pid`): a PR
   already under a live watch prints `already-watching` and exits immediately,
   so just blindly launch one for every open PR every wake.
2. Keep the **`ScheduleWakeup` fallback** (~1200–1800s) armed as the safety net
   for a crashed or timed-out watcher (its default timeout is 1800s).
3. **NEVER foreground-block** — no foreground `sleep`, no foreground
   `gh pr checks --watch`. A foreground wait is the all-lanes barrier this
   design removes; the watcher backgrounds the waiting instead.

Then **end the turn.** Do not run a Monitor that waits for all lanes to be
terminal — that is the barrier this design removes. Each independent wake re-runs
Step 0 and merges/refills whatever is ready.

---

## Worked example (why the slow lane never gates the fast one)

Pool of 4: issues A, B, C, D building in parallel. B is a tiny fix, D is a large
feature.
1. B finishes Gate 2.5, opens its PR; CI + review pass and it is current with
   `main`, so `pr-ready.sh` prints `ready`.
2. A wake fires (B's verdict). Step 1 merges **B now** — A, C, D are untouched and
   still mid-gate. Step 4 sees a free slot and assigns **E**, launching its worker.
3. D is still at Gate 1. It never blocked B, and B's merge didn't wait for D.
4. C later goes `LGTM`+green, but B and E landed meanwhile, so it is two commits
   behind `main`. GitHub still calls C `CLEAN` — only the compare probe sees it —
   and `pr-ready.sh` prints `behind`. Step 1 syncs C; CI re-runs; C merges on the
   next wake once green. D keeps going the whole time.

Continuous throughput, four lanes always busy, merges strictly serialized and
always up-to-date.

## Sequential fallback

Set `parallel_enabled: false` (or `max_workers: 1`) in `state.json` and the pool
collapses to one lane: `fleet.sh free` reports at most 1, so Step 4 fills a single
slot and the loop behaves exactly like the classic one-issue-at-a-time Ralph —
still worktree-isolated, same gates, same drop-backs.

## Hard rules (do not deviate)
- **Merges to `main` are serialized and always up-to-date.** Merge a lane only
  when `pr-ready.sh` prints `ready` — or `ready-unreviewed` on a `dependencies`
  lane, per the rule below. Every other token syncs, waits, or is fixed first, and
  no other evidence merges a lane.
- **"Up to date" means `behind_by == 0`, never `mergeStateStatus`.** `CLEAN` is
  not a freshness signal in a repo without strict status checks.
- **A Dependabot PR merges on exactly the same evidence as any other lane** —
  freshness-verified green CI against current `main` plus a fresh `LGTM` verdict.
  No extra human sign-off is required or waited for; `do-not-auto-merge` on the
  PR (or its linked issue) is the per-PR human hold. **One exception, and only
  one:** a bump nobody had to touch never gets a verdict at all (the review job
  skips runs Dependabot triggers), so `pr-ready.sh` prints `ready-unreviewed` and
  that lane merges on verified-current green CI alone — where "green" means the
  helper also proved at least one real check passed, since a workflow-only bump
  can match every `paths:` filter's complement and land zero checks. No other PR
  class may ever merge without `LGTM`.
- **Never make a fast lane wait on a slow one.** No per-tick barrier, no
  all-lanes Monitor. Act on whichever lane a wake is about; refill freed slots
  immediately.
- **Workers are background; never await them.** `run_in_background: true`, launch
  and end the turn.
- **Never more than `max_workers` worktrees.** `fleet.sh` enforces the cap; do
  not bypass it. **One issue per worker; one worker per worktree.**
- **Never track these issues with the Task tools.** (User directive.)
- **Never write to `main` directly** except `scripts/ralph/state.json`.
- **Never force-push.** Integration is `fleet.sh sync` (a merge), never a rebase
  of a pushed branch.
- **Never disable a CI check / pre-commit hook / lower a threshold.** Fix the
  root cause. If a tool is missing for an environmental reason, install it.
- **Re-entrancy first.** Read `state.json`, `fleet.sh list`, and PR state at the
  top of every wake; derive pool state from live git + GitHub, never from memory.
- **On merge, mark the issue done** (Step 1) and bump `state.json`.

## Anti-bypass (verbatim, non-negotiable)
> No bypasses. Do not add `# noqa`, `# type: ignore`, `# pylint: disable`,
> `@pytest.mark.skip`, `// @ts-ignore`, `// eslint-disable`, or
> `git commit --no-verify`; do not lower coverage / branch / complexity /
> docstring thresholds in `pyproject.toml`, `jest.config`, or the scripts; do
> not delete tests or code to make a metric pass; do not swallow exceptions to
> silence a linter. Fix the root cause. The only allowed escape hatch is an
> inline `# noqa: RULE  # Issue #N: <reason>` (or `# type: ignore  # Issue #N:
> …`) tied to a real tracking issue, per `max-quality-no-shortcuts`.
