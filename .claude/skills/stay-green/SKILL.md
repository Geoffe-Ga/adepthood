---
name: stay-green
description: >-
  Local TDD + quality-gate workflow: Gate 1 is Red-Green-Refactor testing,
  Gate 2 is `./scripts/<side>/check-all.sh` exiting 0. Use when implementing
  features, fixing bugs, or doing any development work. Ensures code is never
  pushed without passing tests and quality checks. Gates 3 (CI) and 4 (Claude
  review) are covered by `ci-debugging` and `address-feedback`.
  Do NOT use for bug-specific debugging (use bug-squashing-methodology).
metadata:
  author: Geoff
  version: 2.0.0
---

# Stay Green

Write tests first, then code. Never declare work finished until all checks pass.
This skill covers Gates 1-2 of the four-gate model in
`.claude/agents/shared/adepthood-constraints.md`; Gates 3 (CI) and 4 (Claude
review) live in `ci-debugging` and `address-feedback`.

## Instructions

### Gate 1: TDD (Red-Green-Refactor)

1. **Red** - Write a failing test describing the behavior you want
   ```bash
   ./scripts/backend/test.sh <path/to/test_file.py>  # Should fail
   ```

2. **Green** - Write just enough code to make the test pass
   ```bash
   ./scripts/backend/test.sh <path/to/test_file.py>  # Should pass
   ```

3. **Refactor** - Clean up while keeping tests green
   ```bash
   ./scripts/backend/test.sh <path/to/test_file.py>  # Should still pass
   ```

Repeat for each small piece of functionality. Write tests incrementally, not
all at once. A positional path runs unsharded, without coverage, and never
touches the whole-suite lock, so it is cheap enough to run every cycle.

### Gate 2: `check-all.sh`, once, when Gate 1 is green

The gate ladder runs each rung once — running one on top of another buys
nothing and doubles the wait:

| Rung | Runs | Cost |
| --- | --- | --- |
| `./scripts/backend/test.sh <paths>` (targeted) | every Red-Green cycle | seconds |
| `./scripts/<side>/check-all.sh` | once, when Gate 1 is green | ~4m23s cold backend; ~8s on a receipt hit |
| `git commit` hooks (staged files only) | automatic | seconds to ~1 min |
| `git push` hooks (full suite + coverage) | automatic | ~5 min |

The push rung fires on every push: `default_install_hook_types` in
`.pre-commit-config.yaml` makes a bare `pre-commit install` write the `pre-push`
hook alongside the other two. On a checkout predating that, run `pre-commit
install` once and confirm `.git/hooks/pre-push` exists -- a push producing no
hook output on such a box means the rung is not wired, and the checks surface
~18 minutes later in CI instead of ~5. Backend CI runs the stage regardless, so
nothing is skipped outright.

```bash
./scripts/backend/check-all.sh    # drift preflight, lint, format, mypy,
                                  # security, complexity, tests, coverage
```

When checks fail: read errors, fix issues, run again. Repeat until all green.
`./scripts/<side>/fix-all.sh` auto-fixes lint/format; never hand-patch what
the formatter owns.

Quality checks include: formatting (ruff-format), linting (ruff), type
checking (mypy), complexity (xenon A grade, radon MI >= B), security
(bandit + pip-audit), tests with coverage (>=90%), file hygiene.

Do not also hand-run `pre-commit run --all-files` before every commit --
`git commit` already re-runs lint/format/type checks on your staged diff
seconds later, and `check-all.sh` already swept the whole tree, so the ritual
whole-tree pass earns nothing those two didn't already cover. Reserve it for
what staged-file hooks cannot see: a wide rename, a suspected cross-file type
error, or a change to the hook configuration itself.

A whole-suite `test.sh` run (no positional path) takes an exclusive
per-worktree lock at `.gate-state/locks/backend-suite.lock`. A second
whole-suite run racing against itself in the same worktree exits 3, naming the
holding PID, rather than corrupting the shared coverage file and fixture
databases both runs would otherwise write. On exit 3: wait for the in-flight
run, do not route around the lock. A failure observed while another
whole-suite run was concurrently in flight is unproven until it is re-run
alone.

### Work is DONE when:
1. All tests pass (Gate 1 complete)
2. `check-all.sh` exits 0 (Gate 2 complete)

No exceptions.

### After Push: Await the Reviewer (if applicable)

If the repo runs the Claude reviewer GitHub Action, "done" extends past local gates: the latest verdict for HEAD must be `LGTM`. Don't poll, don't `sleep`, and don't wait on "CI green" as a proxy — the PR webhook does **not** deliver CI passes, only comments and CI failures. Use `await-claude-review` to subscribe and end the turn; the bot's verdict comment wakes the session via `<github-webhook-activity>`. From there, `address-feedback` handles the merge gate or the fix loop, including calling `mcp__github__unsubscribe_pr_activity` once the PR merges or closes.

## Examples

### Example 1: Adding a New Function

```python
# Gate 1 - Red: Write failing test
def test_calculate_cost_from_impressions():
    result = calculate_cost(impressions=1000, cpm=5.0)
    assert result == 5.0

# Gate 1 - Green: Make it pass
def calculate_cost(impressions: int, cpm: float) -> float:
    return impressions * (cpm / 1000)

# Gate 1 - Refactor: (already clean, move on)
# Gate 2: ./scripts/backend/check-all.sh -> All passed!
```

### Example 2: Fixing a Formatting Failure

```bash
# Gate 2 fails on formatting
$ ./scripts/backend/check-all.sh
Running: Formatting
...failed

# Auto-fix and re-run
$ ./scripts/backend/fix-all.sh
$ ./scripts/backend/check-all.sh
# All passed!
```

## Troubleshooting

### Error: Coverage below 90%
```bash
./scripts/backend/coverage.sh  # See what's not covered
# Add tests for uncovered lines, then re-run ./scripts/backend/check-all.sh
```

### Error: Complexity worse than A grade (cyclomatic 5, maintainability rank B)
```bash
./scripts/backend/complexity.sh  # Find complex functions
# Extract helper functions, simplify branching
# Then verify: ./scripts/backend/complexity.sh && ./scripts/backend/check-all.sh
```

### Error: Type errors from MyPy
```bash
./scripts/backend/typecheck.sh  # See specific errors
# Add/fix type annotations
# Then verify: ./scripts/backend/typecheck.sh && ./scripts/backend/check-all.sh
```
