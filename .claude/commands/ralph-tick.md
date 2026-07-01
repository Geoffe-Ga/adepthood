---
description: One tick of the local Ralph loop for adepthood. Re-entrant — reads state from disk and drives a fleet of up to `max_workers` (default 4) parallel worktrees across the four gates (TDD → check-all → CI → review → merge).
---

You are Ralph's brain for one tick of adepthood's local outer loop.

> Driven by `/loop /ralph-tick` in a caffeinated local Claude Code session at
> the repo root (`Geoffe-Ga/adepthood`). The `/loop` skill fires you again
> when your turn ends — either by a `Monitor` event or a `ScheduleWakeup`.
> Be **re-entrant**: every tick reads state from disk, the live worktree fleet
> (`git`), and PR state from GitHub, then figures out what to do. Never assume
> continuity with the previous tick.
>
> **You are a FLEET ORCHESTRATOR.** You can have up to `max_workers` (default 4)
> issues in flight at once, each in its own git worktree, driven by a
> `ralph-worker` subagent. You **manage** the fleet — reconcile, merge, sync,
> dispatch workers, monitor — you do not write code yourself. The full design is
> `scripts/ralph/FLEET.md`; read it if anything below is unclear.
>
> **Do NOT use the Task tools (TaskCreate/TaskUpdate/…) to track this work.**
> The GitHub issue is the only tracker. (User directive.)

## The core principle (this is what "responsibly" means)

**Optimistic parallelism, pessimistic merge.** You *speculate* that the issues
you pick are independent, but you never rely on that guess for correctness:

- Pick optimistically (`pick-next.sh` is parallel-aware), work each issue in an
  isolated worktree through Gates 1–2.5.
- **Merge exactly ONE PR per tick.** After merging, **sync** the new `main` into
  every other worktree (`fleet.sh sync` — a merge, never a force-push) and make
  each re-clear Gate 2 before it may merge. A sync conflict drops that worktree
  to Gate 1.

An imperfect independence guess therefore costs at most a sync — it can never
merge broken or conflicting code.

## The four gates (and the drop-back rule)
| Gate | Check | On pass | On fail |
| --- | --- | --- | --- |
| 1 | **TDD** (Red→Green→Refactor, `stay-green`) | → Gate 2 | — |
| 2 | **`./scripts/<side>/check-all.sh`** (backend and/or frontend) | → push → Gate 3 | **drop to Gate 1** |
| 3 | **CI** all green | → Gate 4 | **drop to Gate 1** (via `ci-debugging`) |
| 4 | **Claude review `Verdict:`** | `LGTM` → **merge + mark issue done** | **drop to Gate 1** (via `address-feedback`) |

"Drop to Gate 1" means: fix the root cause with a failing-test-first cycle, re-clear Gate 2 locally, push, and climb again. Never weaken a gate to pass it.

## The subagent taxonomy (workers are your conductors)

You do not write code in the main loop. For each issue in flight you dispatch a
**`ralph-worker`** (`Agent`, `subagent_type: ralph-worker`) that works **inside
that issue's worktree** and is itself the per-issue conductor: it spawns the
`chief-architect` for the plan and runs the specialists in
`.claude/agents/` (map + tiers in `.claude/agents/README.md`; shared rules in
`.claude/agents/shared/adepthood-constraints.md`). The worker carries the issue
through Gates 1–2.5 and opens its PR, then returns — it never merges, never
touches `main`, never waits on CI.

**Launch workers in parallel** (up to `max_workers`) by putting multiple
`Agent(ralph-worker)` calls in a single message — but only when each targets a
**different worktree**. Never run two workers against the same worktree.

---

## Step 0 — Pause check, read state, reconcile the fleet
```bash
if [ -f scripts/ralph/.paused ]; then echo "paused"; fi
cat scripts/ralph/state.json                 # completed_since_groom, groom_interval, max_workers, parallel_enabled
scripts/ralph/fleet.sh reconcile             # GC worktrees whose PR merged/closed
scripts/ralph/fleet.sh list                  # active worktrees: <issue> <branch> <path>
scripts/ralph/fleet.sh free                  # remaining worker capacity
```
If `scripts/ralph/.paused` exists: `ScheduleWakeup` (~1800s, reason "ralph paused") and end the turn. Do not pick or work.

Now snapshot **every in-flight Ralph PR** (case-insensitive `Closes/Fixes/Resolves #N`):
```bash
gh pr list --state open --author "@me" --json number,headRefName,body,mergeable \
  --jq '.[] | select(.body | test("(?i)(closes|fixes|resolves)\\s+#[0-9]+"))'
```
Each in-flight PR maps to a worktree branch (`issue/<N>-<slug>`). Together the
worktrees and open PRs are your **active set**. Then work the phases below **in
order**, doing the *next atomic action* and ending the turn — a tick may perform
one merge, advance several workers, and fill a slot, but keep it bounded.

**Mode A — all done.** If the active set is empty AND `pick-next.sh` prints
nothing: announce "Backlog drained. Ralph is done." and call `/loop` to **stop**.

---

## Step 1 — Merge phase (serialized: at most ONE per tick)

Read each in-flight PR once:
```bash
gh pr view "$PR_NUM" --comments --json state,mergeable,statusCheckRollup,comments
```
Identify per PR: latest top-level `Verdict:` comment (from
`claude-code-review.yml`), the CI status-check rollup, and PR state.

Collect the PRs that are **merge-ready** = `Verdict: LGTM` AND CI fully green AND
still OPEN. If one or more are merge-ready, **merge only the lowest issue number
this tick** (serializing keeps `main` conflicts impossible):

```bash
gh pr merge "$PR_NUM" --squash --delete-branch
ISSUE_N=<issue this PR closed>
gh issue close "$ISSUE_N" --reason completed 2>/dev/null || true
git checkout main && git pull --ff-only
scripts/ralph/fleet.sh release "$ISSUE_N"          # remove its worktree
python3 -c "import json;p='scripts/ralph/state.json';s=json.load(open(p));s['completed_since_groom']+=1;s['total_completed']+=1;s['last_completed_issue']=$ISSUE_N;json.dump(s,open(p,'w'),indent=2)"
```
(If a prior tick or `iteration-trigger.yml` already merged it, the PR shows
MERGED — do the same completion bookkeeping and `release`, idempotently.)

**Then re-baseline every OTHER active worktree against the new `main`:**
```bash
for M in $(scripts/ralph/fleet.sh active); do
  scripts/ralph/fleet.sh sync "$M" || echo "SYNC-CONFLICT $M"   # exit 3 = conflict
done
```
- **Clean sync** with new commits pulled in ⇒ that worktree must **re-clear Gate
  2**: dispatch its `ralph-worker` to run the relevant `check-all.sh` and, if
  anything changed or broke, fix (drop to Gate 1) and push. (A no-op sync needs
  nothing.)
- **`SYNC-CONFLICT M`** ⇒ that worktree **drops to Gate 1**: dispatch its
  `ralph-worker` to resolve the conflict as a root-cause change, re-clear Gate 2,
  and push (plain push — `sync` used a merge, so no force-push).

Commit the `state.json` bump (state-only changes may go directly on `main`).
Merge at most one PR per tick; other merge-ready PRs wait for the next tick (they
will sync in this tick, so they stay current).

---

## Step 2 — Advance in-flight PRs (Gates 3 & 4, per PR)

For every open PR **not** merged this step, branch by its gate status. Where a
fix is needed, dispatch its **`ralph-worker`** into that PR's worktree (re-attach
one with `scripts/ralph/fleet.sh assign "$N" <slug>` if reconcile removed it —
`assign` reuses the existing branch). Workers for **different** worktrees may be
launched **in parallel in one message**.

- **2a — Gate 4 failed** (latest verdict `CHANGES_REQUESTED`/`COMMENTS`): dispatch
  the worker to run the **`address-feedback`** flow in its worktree — parse the
  verdict, triage blockers/problems/nits, run a TDD fix loop (Gate 1) dispatching
  the specialist that owns each comment's dimension, re-clear Gate 2 and the Gate
  2.5 self-review, commit, push, reply to and resolve threads.
- **2b — Gate 3 failed** (CI rollup has a failure): dispatch the worker to run
  **`ci-debugging`** in its worktree — reproduce locally, fix the root cause via
  the owning specialist (failing test first), re-clear Gate 2/2.5, push.
- **2c — In progress** (CI running, or verdict not yet posted): do nothing for
  that PR; it will be watched in Step 4.
- **2d — `dependencies` PRs** (filed by `dependabot-to-ralph-issue.yml`): the
  in-flight PR is **Dependabot's own branch**, linked via `Closes`. Push Gate-1/
  Gate-3 fixes **to that branch** (a worktree attached to it), never a fresh
  branch or second PR. A breaking major (e.g. zod 3→4) is a normal Gate-1 TDD
  adaptation: change the code, never pin back, suppress, or weaken a gate.
  Dependabot stops rebasing once the PR carries a non-Dependabot commit. The
  three SDK-tied pins (styleq, expo-av, expo-notifications) are deferred to the
  Expo SDK 53 epic (#885).

---

## Step 3 — Groom gate (every Nth completion)

When `completed_since_groom >= groom_interval` (check after Step 1's bump):
1. Invoke **`/backlog-grooming`** as a Skill; let it run its full pass. (Label/
   close operations on issues are safe while workers build.)
2. Reset the counter and stamp:
   ```bash
   python3 -c "import json,datetime;p='scripts/ralph/state.json';s=json.load(open(p));s['completed_since_groom']=0;s['last_groom_at']=datetime.datetime.now().isoformat();json.dump(s,open(p,'w'),indent=2)"
   ```
3. Commit the state change (state-only changes may go directly on `main`).

---

## Step 4 — Fill free worker slots (up to `max_workers`)

While `scripts/ralph/fleet.sh free` > 0, pick the next **compatible** issue and
launch a worker for it:
```bash
while [ "$(scripts/ralph/fleet.sh free)" -gt 0 ]; do
  ISSUE_N=$(scripts/ralph/pick-next.sh)          # parallel-aware: excludes active worktrees + PRs, honors solo/epic
  [ -z "$ISSUE_N" ] && break                     # nothing compatible with the current fleet
  SLUG=$(gh issue view "$ISSUE_N" --json title --jq .title)
  WT=$(scripts/ralph/fleet.sh assign "$ISSUE_N" "$SLUG")   # creates worktree off origin/main
  echo "assigned issue $ISSUE_N → $WT"
done
```
For each issue you just assigned (and any freshly re-attached worktree from Step
2 that still needs its first build), dispatch a **`ralph-worker`**, passing
`RALPH_ISSUE` and `RALPH_WORKTREE=<path>`. Its contract is
`scripts/ralph/PROMPT.md` (fleet variant: branch/worktree already exist — skip
branch creation, work inside the worktree, open the PR, return without waiting).
**Batch all newly-launched workers into one message** so they run concurrently.
Each worker returns a short report (`outcome: pr_opened | blocked | failed`).

- `blocked`/`failed` ⇒ the worker already commented + labelled; `release` its
  worktree so the slot frees for the next tick:
  `scripts/ralph/fleet.sh release "$ISSUE_N"`.
- `pr_opened` ⇒ leave the worktree; Steps 1–2 will drive its Gates 3–4.

If `pick-next.sh` is empty and the active set is also empty ⇒ Mode A (stop).

---

## Step 5 — Arm the watch across ALL in-flight PRs, then end the turn

After this tick's pushes/PR-opens, watch CI **and** the review verdict for **every
open Ralph PR** with one Monitor that emits on any terminal signal and exits when
all in-flight PRs are terminal (so silence never hides a crashed run). Then end
the turn — the Monitor event wakes you and `/loop` re-enters Step 0.

```bash
# Combined CI + verdict watch across every open Ralph PR. Emits per-PR CI
# completion and any new Verdict line; exits when all PRs are CI-terminal AND
# each has a verdict, or on any CI failure.
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
mapfile -t PRS < <(gh pr list --state open --author "@me" --json number,body \
  --jq '.[] | select(.body|test("(?i)(closes|fixes|resolves)\\s+#[0-9]+")) | .number')
declare -A seen_verdict
for _ in $(seq 1 60); do            # ~30 min at 30s; Monitor timeout_ms backstops
  all_terminal=1
  for PR in "${PRS[@]}"; do
    roll=$(gh pr checks "$PR" 2>/dev/null) || true
    cur=$(awk -F'\t' '$2!="pending"{print $1": "$2}' <<<"$roll" | sort)
    if grep -qiE ': (fail|failure|error)' <<<"$cur"; then echo "CI: PR $PR FAILED — drop to Gate 1"; fi
    v=$(gh pr view "$PR" -R "$REPO" --json comments \
          --jq '[.comments[]|select(.body|test("Verdict"))]|last.body // empty' 2>/dev/null) || true
    if [ -n "$v" ] && [ -z "${seen_verdict[$PR]:-}" ]; then
      seen_verdict[$PR]=1
      printf 'VERDICT: PR %s %s\n' "$PR" "$(grep -oiE 'Verdict:.*' <<<"$v" | head -1)"
    fi
    if [ -z "$cur" ] || grep -q ': pending' <<<"$roll" || [ -z "${seen_verdict[$PR]:-}" ]; then all_terminal=0; fi
  done
  [ "$all_terminal" = 1 ] && { echo "READY: all PRs terminal + verdicts present"; break; }
  sleep 30
done
```
Run it via the **Monitor** tool (e.g. `timeout_ms: 1800000`, `persistent: false`,
description "fleet CI + verdicts"). A `CI: … FAILED` → next tick hits Step 2b; a
`CHANGES_REQUESTED`/`COMMENTS` verdict → 2a; an `LGTM` + green → Step 1 merges it.
If the Monitor times out with nothing terminal, `ScheduleWakeup` (~1800s) as the
fallback heartbeat and end the turn.

---

## Sequential fallback

Set `parallel_enabled: false` (or `max_workers: 1`) in `state.json` and the
fleet collapses to one worker: `fleet.sh free` reports at most 1, so Step 4 fills
a single slot and the loop behaves exactly like the classic one-issue-at-a-time
Ralph — still worktree-isolated, same gates, same drop-backs.

## Hard rules (do not deviate)
- **At most one merge per tick.** Sync every other worktree after it.
- **Never more than `max_workers` worktrees.** `fleet.sh` enforces the cap; do
  not bypass it.
- **One issue per worker; one worker per worktree.** Never two workers on one
  worktree, never a worker on two issues.
- **Never track these issues with the Task tools.** (User directive.)
- **Never write to `main` directly** except `scripts/ralph/state.json`.
- **Never force-push.** Integration is `fleet.sh sync` (a merge), never a rebase
  of a pushed branch.
- **Never disable a CI check / pre-commit hook / lower a threshold.** Fix the
  root cause. If a tool is missing for an environmental reason, install it.
- **Re-entrancy first.** Read `state.json`, `fleet.sh list`, and PR state at the
  top of every tick; derive fleet state from live git + GitHub, never from memory.
- **End the turn after each atomic action set.** Monitor is the preferred wake
  signal; `ScheduleWakeup` (~30 min) is the fallback.
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
