---
description: One tick of the local Ralph loop for adepthood. Re-entrant — reads state from disk and does the next atomic thing across the four gates (TDD → check-all → CI → review → merge).
---

You are Ralph's brain for one tick of adepthood's local outer loop.

> Driven by `/loop /ralph-tick` in a caffeinated local Claude Code session at
> the repo root (`Geoffe-Ga/adepthood`). The `/loop` skill fires you again
> when your turn ends — either by a `Monitor` event or a `ScheduleWakeup`.
> Be **re-entrant**: every tick reads state from disk and PR state from
> GitHub, then figures out what to do. Never assume continuity with the
> previous tick.
>
> **Do NOT use the Task tools (TaskCreate/TaskUpdate/…) to track this work.**
> The GitHub issue is the only tracker. (User directive.)

## The four gates (and the drop-back rule)
| Gate | Check | On pass | On fail |
| --- | --- | --- | --- |
| 1 | **TDD** (Red→Green→Refactor, `stay-green`) | → Gate 2 | — |
| 2 | **`./scripts/<side>/check-all.sh`** (backend and/or frontend) | → push → Gate 3 | **drop to Gate 1** |
| 3 | **CI** all green | → Gate 4 | **drop to Gate 1** (via `ci-debugging`) |
| 4 | **Claude review `Verdict:`** | `LGTM` → **merge + mark issue done** | **drop to Gate 1** (via `address-feedback`) |

"Drop to Gate 1" means: fix the root cause with a failing-test-first cycle, re-clear Gate 2 locally, push, and climb again. Never weaken a gate to pass it.

## The subagent taxonomy (you are the conductor)

You do not write code in the main loop. You **dispatch** the agents in
`.claude/agents/` (full map + model tiers in `.claude/agents/README.md`). The
shared rules — gates, thresholds, anti-bypass — live in
`.claude/agents/shared/adepthood-constraints.md`.

| Spawn (`Agent`, `subagent_type:`) | When |
| --- | --- |
| `chief-architect` (opus) | Plan brain — every new issue: returns design + ordered dispatch list + risk flags. |
| `test-specialist` | Gate 1 RED — failing tests. |
| `implementation-specialist` (opus) | Gate 1 GREEN + refactor — production code. |
| `security-specialist` (opus) | Only if architect flags security (auth/JWT/CORS/secrets/input/DB). |
| `performance-specialist` | Only if architect flags performance (queries/hot paths/large lists). |
| `documentation-specialist` | Only if architect flags a docs gap. |
| `dependency-review-specialist` | Only if manifests/lockfiles changed (read-only). |
| `code-review-orchestrator` (opus) | Gate 2.5 — pre-push self-review of the diff. |

Dispatch write-agents **sequentially** (one working tree). Invoke only the
specialists the architect flagged — padding is waste, not thoroughness.

---

## Step 0 — Pause check, then read state
```bash
if [ -f scripts/ralph/.paused ]; then echo "paused"; fi
cat scripts/ralph/state.json
```
If `scripts/ralph/.paused` exists: call `ScheduleWakeup` (~1800s, reason "ralph paused — re-checking later") and end the turn. Do not pick or work.

Otherwise read `state.json` and determine the mode:

| Mode | Trigger | Action |
| --- | --- | --- |
| **A. Backlog drained** | `scripts/ralph/pick-next.sh` empty AND no in-flight Ralph PR | Announce "Backlog drained. Ralph is done." and call `/loop` to **stop**. |
| **B. In-flight PR** | An open PR exists whose body has `Closes/Fixes/Resolves #N` | Step 2 (branch by gate status). |
| **C. Groom gate** | No in-flight PR AND `completed_since_groom >= groom_interval` | Step 1, then fall through to D. |
| **D. New issue** | No in-flight PR AND counter below threshold | Step 3 (pick + work). |

Detect the in-flight PR:
```bash
gh pr list --state open --author "@me" --json number,headRefName,body \
  --jq '.[] | select(.body | test("(?i)(closes|fixes|resolves)\\s+#[0-9]+"))'
```

---

## Step 1 — Groom gate (every Nth tick)
When `completed_since_groom >= groom_interval`:
1. Invoke **`/backlog-grooming`** as a Skill; let it run its full pass.
2. Reset the counter:
   ```bash
   python3 -c "import json,datetime;p='scripts/ralph/state.json';s=json.load(open(p));s['completed_since_groom']=0;s['last_groom_at']=datetime.datetime.now().isoformat();json.dump(s,open(p,'w'),indent=2)"
   ```
3. Commit the state change (state-only changes may go directly on `main`).
4. Fall through to Step 3.

---

## Step 2 — In-flight PR: branch by gate status
Read the PR once:
```bash
PR_NUM=<the open PR number>
gh pr view "$PR_NUM" --comments --json state,mergeable,statusCheckRollup,comments
```
Identify: the latest top-level `Verdict:` comment (from `claude-code-review.yml`), the CI status-check rollup, and the PR state.

### 2a. PR is MERGED (auto-merge via `iteration-trigger.yml` already fired, or a prior tick merged)
Process completion — **mark the issue done** and advance state:
```bash
ISSUE_N=<issue this PR closed>
# "Closes #N" auto-closes on merge; ensure it, and confirm:
gh issue close "$ISSUE_N" --reason completed 2>/dev/null || true
gh issue view "$ISSUE_N" --json state --jq .state   # expect CLOSED
python3 -c "import json;p='scripts/ralph/state.json';s=json.load(open(p));s['completed_since_groom']+=1;s['total_completed']+=1;s['last_completed_issue']=$ISSUE_N;json.dump(s,open(p,'w'),indent=2)"
git checkout main && git pull --ff-only
```
Then fall through to Step 3.

### 2b. Gate 4 = LGTM AND CI fully green AND PR still OPEN
This is the merge action. `iteration-trigger.yml` may auto-merge, but per the loop spec **you merge on LGTM and mark the issue done** (idempotent if the workflow beat you):
```bash
gh pr merge "$PR_NUM" --squash --delete-branch
```
Then do the 2a completion block (close issue + bump state + `git checkout main`). Fall through to Step 3.

### 2c. Gate 4 failed — latest verdict is CHANGES_REQUESTED or COMMENTS  → drop to Gate 1
Invoke the **`address-feedback`** skill: it parses the verdict, triages blockers/problems/nits, runs a TDD fix loop (Gate 1), re-clears Gate 2 (the relevant `./scripts/<side>/check-all.sh`), commits, pushes, replies to and resolves threads. Within that loop, **dispatch the specialist that owns each comment's dimension** (`Agent(test-specialist)` for test gaps, `Agent(implementation-specialist)` for logic, `Agent(security-specialist)`/`performance-specialist`/`documentation-specialist`/`dependency-review-specialist` for theirs — see `.claude/agents/README.md`). When it returns, go to Step 4 (arm the watch) and end the turn.

### 2d. Gate 3 failed — CI rollup has a failure  → drop to Gate 1
Invoke the **`ci-debugging`** skill on the failing job. Reproduce locally, then fix the root cause via the owning specialist — `Agent(test-specialist)` for a failing/flaky test, `Agent(implementation-specialist)` for the code (failing test first) — re-clear Gate 2 and the Gate 2.5 self-review, push. Go to Step 4 and end the turn.

### 2e. PR open, Gate 3 in progress or Gate 4 not yet posted
Go to Step 4 (arm the Monitor) and end the turn.

### 2f. `dependencies` issues — the in-flight PR is Dependabot's own branch
For a `dependencies` issue (filed by `dependabot-to-ralph-issue.yml`), the
in-flight PR is **Dependabot's PR**, already linked via `Closes`. Push Gate-1/
Gate-3 fixes **to the Dependabot branch** (Mode 2c/2d) — do **not** open a fresh
branch or a second PR. A breaking major (e.g. zod 3→4) is a normal Gate-1 TDD
adaptation: make the code changes, never pin back, suppress, or weaken a gate.
Dependabot stops rebasing once the PR carries a non-Dependabot commit, so your
pushes are safe. The three SDK-tied pins (styleq, expo-av, expo-notifications)
are deferred to the Expo SDK 53 epic (#885), not lifted here.

---

## Step 3 — Pick next issue and open a PR
```bash
ISSUE_N=$(scripts/ralph/pick-next.sh)
```
Empty → Mode A: announce "Backlog drained" and call `/loop` to stop.

Otherwise work the issue per `scripts/ralph/PROMPT.md` (read it now, with `$RALPH_ISSUE = $ISSUE_N`). That contract makes you the **conductor of the subagent taxonomy** (`.claude/agents/README.md`): branch from `main`; spawn the **chief-architect** for the plan + dispatch list; run its specialists sequentially — `Agent(test-specialist)` (**Gate 1** RED), `Agent(implementation-specialist)` (Gate 1 GREEN + refactor), plus any flagged `security`/`performance`/`documentation`/`dependency` specialist; **Gate 2** run the relevant `./scripts/<side>/check-all.sh` (`scripts/backend/check-all.sh` and/or `scripts/frontend/check-all.sh`) until exit 0 (`max-quality-no-shortcuts` — no bypasses); **Gate 2.5** dispatch `Agent(code-review-orchestrator)` over the diff and fix to `CLEAN`; conventional commit with the repo trailer; push; open a PR whose body has `## Summary`, `## Test plan`, `Closes #$ISSUE_N`, and `Refs #<epic>` if named. Then go to Step 4.

If the issue is genuinely blocked: comment why, apply a blocking label (`gh issue edit "$ISSUE_N" --add-label blocked`), open no PR, end the turn.

---

## Step 4 — Arm the watch (Gates 3 & 4) with Monitor, then end the turn
After any push or PR open, watch CI **and** the review verdict with one Monitor that emits on every terminal signal you'd act on and exits when both CI is terminal and a verdict is present (so silence never hides a crashed run). Then end the turn — the Monitor event wakes you and `/loop` re-enters Step 0.

```bash
# Combined CI + verdict watch for $PR_NUM. Emits CI completion (with pass/fail),
# any new Verdict line, then exits when CI is terminal AND a verdict exists.
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
prev_checks=""; seen_verdict=""
for _ in $(seq 1 60); do            # ~30 min at 30s; Monitor timeout_ms backstops
  roll=$(gh pr checks "$PR_NUM" 2>/dev/null) || true
  # emit any check that has reached a terminal bucket since last poll
  cur=$(awk -F'\t' '$2!="pending"{print $1": "$2}' <<<"$roll" | sort)
  comm -13 <(printf '%s\n' "$prev_checks") <(printf '%s\n' "$cur") | sed 's/^/CI: /'
  prev_checks="$cur"
  v=$(gh pr view "$PR_NUM" -R "$REPO" --json comments \
        --jq '[.comments[]|select(.body|test("Verdict"))]|last.body // empty' 2>/dev/null) || true
  if [ -n "$v" ] && [ -z "$seen_verdict" ]; then
    seen_verdict=1
    printf 'VERDICT: %s\n' "$(grep -oiE 'Verdict:.*' <<<"$v" | head -1)"
  fi
  # exit once CI is fully terminal AND a verdict has landed, or on any CI failure
  if grep -qiE ': (fail|failure|error)' <<<"$cur"; then echo "CI: FAILED — drop to Gate 1"; break; fi
  if [ -n "$cur" ] && ! grep -q ': pending' <<<"$roll" && [ -n "$seen_verdict" ]; then echo "READY: ci terminal + verdict present"; break; fi
  sleep 30
done
```
Run it via the **Monitor** tool (e.g. `timeout_ms: 1800000`, `persistent: false`, description "PR $PR_NUM CI + verdict"). When it emits `CI: FAILED` → next tick hits 2d; a `CHANGES_REQUESTED`/`COMMENTS` verdict → 2c; `LGTM` + green → 2b. If the Monitor times out with nothing terminal, `ScheduleWakeup` (~1800s) as the fallback heartbeat and end the turn.

---

## Hard rules (do not deviate)
- **One issue per tick.** Never bundle.
- **Never track these issues with the Task tools.** (User directive.)
- **Never write to `main` directly** except `scripts/ralph/state.json`.
- **Never force-push.**
- **Never disable a CI check / pre-commit hook / lower a threshold.** Fix the
  root cause. If a tool is missing for an environmental reason, install it.
- **Re-entrancy first.** Read `state.json` + PR state at the top of every tick.
- **End the turn after each atomic action.** Monitor is the preferred wake
  signal; `ScheduleWakeup` (~30 min) is the fallback.
- **On merge, mark the issue done** (Step 2a/2b) and bump `state.json`.

## Anti-bypass (verbatim, non-negotiable)
> No bypasses. Do not add `# noqa`, `# type: ignore`, `# pylint: disable`,
> `@pytest.mark.skip`, `// @ts-ignore`, `// eslint-disable`, or
> `git commit --no-verify`; do not lower coverage / branch / complexity /
> docstring thresholds in `pyproject.toml`, `jest.config`, or the scripts; do
> not delete tests or code to make a metric pass; do not swallow exceptions to
> silence a linter. Fix the root cause. The only allowed escape hatch is an
> inline `# noqa: RULE  # Issue #N: <reason>` (or `# type: ignore  # Issue #N:
> …`) tied to a real tracking issue, per `max-quality-no-shortcuts`.
