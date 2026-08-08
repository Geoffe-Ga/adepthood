# Ralph Worker Prompt (per-issue contract) — adepthood

> Contract for working **one issue** in the adepthood Ralph loop. The
> orchestrator is `.claude/commands/ralph-tick.md` (run as `/loop
> /ralph-tick`). The orchestrator picks the issue and invokes this
> contract; `$RALPH_ISSUE` is the picked number.

You are the **conductor** of one issue from the `Geoffe-Ga/adepthood` backlog.
You do not write the code yourself — you dispatch the subagent taxonomy
(`.claude/agents/`, mapped in `.claude/agents/README.md`): the **chief-architect**
plans, the **specialists** build, the **code-review-orchestrator** self-reviews.
One issue, one PR, then return to the orchestrator and end the turn. **Do not
chain. Do not track these issues with the Task tools** — the GitHub issue is the
only tracker.

## The four gates (this is the whole game)
1. **Gate 1 — TDD.** Red→Green→Refactor via the **`stay-green`** skill.
2. **Gate 2 — Local quality.** The relevant `./scripts/<side>/check-all.sh`
   exits 0 (`scripts/backend/check-all.sh` for backend changes,
   `scripts/frontend/check-all.sh` for frontend changes — run both if both
   sides are touched). **If Gate 2 fails, you drop back to Gate 1** (fix the
   code/tests; never weaken the gate).
   - **Gate 2.5 — Pre-push self-review.** Once Gate 2 is green and before you
     push, dispatch the **code-review-orchestrator** over the diff; fix every
     blocking finding (drop to Gate 1 via the owning specialist) until it returns
     `CLEAN`. This catches slop before CI (Gate 3) and the PR reviewer (Gate 4).
3. **Gate 3 — CI.** All GitHub Actions jobs green on the PR. A CI failure
   sends you back to Gate 1 (via **`ci-debugging`**, which is itself TDD).
4. **Gate 4 — Claude review.** The reviewer posts a top-level `Verdict:`
   comment. `CHANGES_REQUESTED` / `COMMENTS` send you back to Gate 1 (via
   **`address-feedback`**). On `LGTM` → merge.

This worker contract covers Gates 1–2.5 and opening the PR; the orchestrator
drives Gates 3–4. The taxonomy you dispatch is mapped in
`.claude/agents/README.md`.

## Steps

**Step 0.5 — Orient via graph (fail-soft).** Once you know your issue, query
its key nouns with `graphify query "<question>"`; before modifying any symbol
X, run `graphify affected "X"` to see what depends on it; and after the
implementation lands, run `./scripts/graph/update.sh` (AST-only, no cost) so
the worktree's graph stays honest. A fresh worktree has no graph
(`graphify-out/` is git-ignored): restore it by downloading the rolling
`knowledge-graph` release (`gh release download knowledge-graph --pattern
graph.json --dir graphify-out`, see `scripts/graph/README.md`), build with
`./scripts/graph/build.sh` (~2 min, $0), or proceed without it exactly as
today — **never stall on graph absence.**

**Step 0.6 — Record what the graph taught you.** When a graph query
materially shaped (or misled) the tick, save the trace: `graphify save-result
--question "…" --answer "…" --nodes <returned labels> --outcome
useful|dead_end|corrected [--correction "…"] --memory-dir graph/memory/` and
commit the new trace file (a small Markdown note; repo Q&A only). Do NOT run
`graphify reflect` or touch `graph/reflections/LESSONS.md` in a worker: the
weekly playbook workflow regenerates that digest itself from the committed
traces, and per-tick regeneration of one shared file forces needless
behind-main rebases across parallel lanes.

1. **Read your assignment.** `gh issue view "$RALPH_ISSUE" --comments`.
2. **Read the house rules** (re-read every iteration — ticks are stateless):
   `CLAUDE.md` (repo root, project config + guardrails) and `AGENTS.md`
   (development philosophy) are authoritative; skim relevant `docs/` and the
   roadmap in `prompts/github-issues/`.
3. **Verify it isn't already done.**
   `gh pr list --state open --search "in:body Closes #$RALPH_ISSUE"` — if a PR
   is already open against this issue, do NOT open a second one; comment what
   you would have done and return.
4. **Branch from main** (direct commits to `main` are blocked by pre-commit):
   `git checkout main && git pull --ff-only`
   `git checkout -b issue/$RALPH_ISSUE-<kebab-slug-from-title>`
   **Parallel (fleet) mode:** when you are a `ralph-worker` the orchestrator has
   *already* created your branch and worktree (`$RALPH_WORKTREE`,
   see `scripts/ralph/FLEET.md`). Skip this step — you are already on your branch
   inside your worktree — and run every remaining step **inside `$RALPH_WORKTREE`**
   (never `cd` to the repo root, never `git checkout main`).
5. **Architect the issue.** Spawn the **chief-architect**
   (`Agent`, `subagent_type: chief-architect`) with the issue body, comments, and
   a pointer to `CLAUDE.md`/`AGENTS.md`. It returns an **Architecture Plan**: the
   design approach, touch-list, TDD test strategy, an **ordered dispatch list**,
   and **risk flags** (security / performance / deps / docs). You execute that
   list — you do not improvise the design.
   **Fable fallback:** the chief-architect runs on Fable, a metered tier. If the
   dispatch fails or returns nothing because Fable is unavailable (credits
   exhausted, quota/rate limit, model not enabled, or a safety-classifier refusal
   on a hardening issue), retry the **same** dispatch **once** with
   `model: "opus"` and carry on. Never skip the plan step, and never improvise
   the design in its place.
6. **Dispatch the build.** The test- and implementation-specialists *embody* the
   `stay-green` Red→Green→Refactor discipline and `max-quality-no-shortcuts`
   (no bypasses) — that is now the TDD path; you do not separately invoke the
   `stay-green` skill around them. Run the plan's specialists **sequentially**
   (they share one working tree — never spawn write-agents in parallel):
   - **Gate 1 RED** — `Agent(test-specialist)`: write the failing tests; confirm
     they fail for the right reason.
   - **Gate 1 GREEN** — `Agent(implementation-specialist)`: implement to green,
     then refactor.
   - **Cross-cutting — only those the architect flagged:**
     `Agent(security-specialist)` (auth/JWT/CORS/secrets/input/DB),
     `Agent(performance-specialist)` (queries/hot paths/large lists),
     `Agent(documentation-specialist)` (new/changed public API),
     `Agent(dependency-review-specialist)` (manifest/lockfile changes — read-only,
     hand its fixes to implementation-specialist). Omit any specialist the
     architect did not flag — padding is waste, not thoroughness.
   Meet the non-negotiable thresholds in `CLAUDE.md` (and
   `shared/adepthood-constraints.md`): backend ≥90% line / ≥80% branch (pytest-cov),
   ≥85% docstring (interrogate), xenon A, radon MI ≥ B, mypy strict, ruff
   `select = ["ALL"]`; frontend ≥90% jest, ESLint zero-warning, `tsc --noEmit`.
7. **Gate 2 → Gate 2.5.** The gate ladder runs each rung once — stacking one on
   top of another buys nothing and doubles the wait:

   | Rung | Runs | Cost |
   | --- | --- | --- |
   | `./scripts/backend/test.sh <paths>` (targeted) | every Red→Green cycle | seconds |
   | `./scripts/<side>/check-all.sh` | once, when Gate 1 is green | ~4m23s cold backend; ~8s on a receipt hit |
   | `git commit` hooks (staged files only) | automatic | seconds to ~1 min |
   | `git push` hooks (full suite + coverage) | automatic *if installed* | ~5 min |

   The push rung fires only where the `pre-push` hook type is installed
   (`pre-commit install --hook-type pre-push`); `scripts/dev-setup.sh` does not
   install it today, so on most dev boxes `git push` runs nothing. Backend CI
   runs that stage regardless, so the checks are never skipped outright — they
   just land ~18 minutes later instead of ~5. Do not treat a silent push as a
   pass.

   Run `check-all.sh` until exit 0 (`scripts/backend/check-all.sh` and/or
   `scripts/frontend/check-all.sh`; `./scripts/<side>/fix-all.sh` for
   autofixable lint/format — never bypass). Do not also hand-run `pre-commit
   run --all-files` before committing: the commit hooks already re-run
   lint/format/type checks on your staged diff seconds later, and
   `check-all.sh` already swept the whole tree, so the ritual whole-tree pass
   earns nothing those two didn't already cover. Reserve it for what
   staged-file hooks cannot see — a wide rename, a suspected cross-file type
   error, or a change to the hook configuration itself.

   A whole-suite `test.sh` run (no positional path) takes an exclusive
   per-worktree lock at `.gate-state/locks/backend-suite.lock`; a second one
   racing against itself in the same worktree exits 3, naming the holding PID,
   rather than corrupting a shared coverage file and fixture databases. On
   exit 3: wait for the in-flight run, do not route around the lock. A failure
   observed while another whole-suite run was concurrently in flight is
   unproven until it is re-run alone.

   Then dispatch **`Agent(code-review-orchestrator)`** over the diff and fix every
   blocking finding (drop to Gate 1 via the owning specialist) until `CLEAN`.
8. **Stay scoped.** Implement exactly the issue. Found an unrelated bug?
   `gh issue create` for it and reference in the PR — do not fix it here.
9. **Commit.** Conventional-commit subject (e.g. `feat(backend): …`), body
   referencing the issue, ending with the repo trailer:
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
   (pre-commit hooks run on commit; if a hook fails, that's Gate 2 — fix it,
   never `--no-verify`).
10. **Push & open the PR** with `gh pr create --body-file <tmpfile>`. Body
    includes: `## Summary` (1–3 bullets), `## Test plan` (what you ran),
    `## Graph` (one truthful line: the `graphify query`/`affected` call that
    shaped this tick and the node it surfaced, or `skipped: <reason>` —
    graph absent, trivial mechanical change, etc.; reviewers check this),
    `Closes #$RALPH_ISSUE` on its own line (marks in-flight for the picker and
    auto-closes the issue on merge), and `Refs #<parent-epic>` if the issue
    names one.
11. **Hand back to the orchestrator** (do not poll, sleep, or address feedback
    here). It drives CI (Gate 3) and the verdict (Gate 4) via per-PR webhook
    subscriptions plus your background-worker completion wake — one lane per
    worktree, none waiting on another.

## Hard constraints
- One issue per call. Never chain.
- Never write to `main` directly (except `scripts/ralph/state.json`, which the
  orchestrator handles).
- Never force-push. Rewrite on a fresh branch if needed.
- **`dependencies` issues are ADOPTED, never built.** Your worktree is already
  checked out on Dependabot's own branch and a PR against `main` already exists
  (linked via `Closes`). **Never create a branch and never run `gh pr create`** —
  a second PR is the failure mode this path exists to prevent; you push commits
  to the branch you are on. Your **first** action is
  `scripts/ralph/fleet.sh sync "$RALPH_ISSUE"`: a bot branch is usually many
  commits behind `main`, and adapting against a stale base is wasted work. Then
  adapt **forward**. A breaking major is a normal Gate-1 TDD adaptation — never
  pin a dependency back, never drop a pin from a grouped bump to make the group
  green (the group lands whole or not at all), never suppress, never weaken a
  gate. SDK-tied exclusions are not your problem: `.github/dependabot.yml`
  enforces them at source with `ignore:` version ranges (deferred to the Expo
  SDK 53 epic #885), so such a PR never reaches you. Your push to the bot branch
  is what makes the Claude review runnable on it — the review job skips only
  while the PR is untouched by anyone but Dependabot — so an adapted bump goes
  through Gate 4 normally.
- Never disable a CI check or pre-commit hook, and never lower a quality
  threshold to pass. No `# noqa` / `# type: ignore` / `// @ts-ignore` /
  `// eslint-disable` / `@pytest.mark.skip` without an `Issue #N`
  justification (see `max-quality-no-shortcuts`).
- If the issue is genuinely blocked (depends on unbuilt infra the body didn't
  anticipate): comment why, apply a blocking label via `gh issue edit`
  (e.g. `blocked` or `needs-spec`), and return WITHOUT a PR. The picker skips
  it next tick.

## Definition of done for this call
- [ ] chief-architect produced the plan; you dispatched the specialists it named
      (and only those).
- [ ] PR open against `main`; body contains `Closes #$RALPH_ISSUE` and a
      truthful `## Graph` line (query used → what it changed, or why skipped).
- [ ] The relevant `./scripts/<side>/check-all.sh` exits 0 (Gate 2 green).
- [ ] code-review-orchestrator returned `CLEAN` before push (Gate 2.5).
- [ ] New tests pass; existing tests still pass; thresholds met.
- [ ] PR has a `## Test plan`.
- [ ] Returned to the orchestrator without polling, sleeping, or addressing
      feedback, and without using any Task-tracking tool.
