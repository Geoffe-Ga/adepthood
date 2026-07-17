# Shared constraints — adepthood subagent taxonomy

> Single source of truth for every agent in `.claude/agents/`. Each agent links
> here instead of restating the rules. If a rule changes, change it **once**,
> here. The taxonomy map lives in [`../README.md`](../README.md).

## Product north star (read before building)

Adepthood is a **journal-first PKM** built on **graduated engagement** — "you
choose your depth." Nothing is gated or mandatory; deeper rings surface only as
resonant, one-tap-declinable invitations. **No gamified pressure** — no
streak-shame, no guilt mechanics, no dark patterns. The thesis lives in
`NORTH-STAR.md`; the visual direction ("Candle & Ink") and implemented design
system in `frontend/src/design/DESIGN.md` (root `DESIGN.md` is the external
inspiration reference — a marketing-site aesthetic analysis, not the build
target); the development philosophy in `AGENTS.md`. Build accordingly.

## The stack

- **Frontend:** React Native + Expo — TypeScript (strict), Zustand, React
  Navigation. Tests: Jest + React Native Testing Library. Lives in `frontend/`.
- **Backend:** FastAPI — SQLModel (async), Alembic, PostgreSQL. Tests: pytest
  (`@pytest.mark.asyncio`, `async_client`/`db_session` fixtures from
  `backend/conftest.py`). Lives in `backend/`.
- Layout, commands, and patterns are authoritative in `CLAUDE.md` (repo root).

## Graph first, grep second

When `graphify-out/graph.json` exists, orient with the code graph before
sweeping files: `graphify query "<question>"` for questions,
`graphify path "A" "B"` for relationships, `graphify explain "X"` for
concepts, `graphify affected "X"` for change impact — quoting each cited
node's `source_location`. Fail-soft: fresh worktrees have no graph
(`graphify-out/` is git-ignored); restore via the session hook, build with
`./scripts/graph/build.sh` (~2 min, $0), or proceed with Read/Grep/Glob
exactly as today. **Never stall on graph absence.**

## The four gates (the whole game)

| Gate | Check | On pass | On fail |
| --- | --- | --- | --- |
| 1 | **TDD** Red→Green→Refactor (`stay-green` skill) | → Gate 2 | — |
| 2 | **`./scripts/<side>/check-all.sh`** exits 0 (backend and/or frontend) | → self-review → push → Gate 3 | **drop to Gate 1** |
| 3 | **CI** all green | → Gate 4 | **drop to Gate 1** (`ci-debugging`) |
| 4 | **Claude review `Verdict:`** | `LGTM` → merge | **drop to Gate 1** (`address-feedback`) |

"Drop to Gate 1" means: fix the **root cause** with a failing-test-first cycle,
re-clear Gate 2 locally, push, climb again. **Never weaken a gate to pass it.**

## Quality thresholds (non-negotiable — from `CLAUDE.md`)

- **Backend:** ≥90% line / ≥80% branch coverage (pytest-cov), ≥85% docstring
  (interrogate), xenon A-grade complexity, radon MI ≥ B, mypy **strict**, ruff
  `select = ["ALL"]` clean, bandit + pip-audit + detect-secrets pass.
- **Frontend:** ≥90% Jest coverage, ESLint **zero-warning** (sonarjs/unicorn),
  `tsc --noEmit` **strict**, prettier-clean.
- Run `./scripts/<side>/fix-all.sh` for autofixable lint/format; never hand-patch
  what the formatter owns.

## Anti-bypass (verbatim, non-negotiable)

> No bypasses. Do not add `# noqa`, `# type: ignore`, `# pylint: disable`,
> `@pytest.mark.skip`, `// @ts-ignore`, `// eslint-disable`, or
> `git commit --no-verify`; do not lower coverage / branch / complexity /
> docstring thresholds in `pyproject.toml`, `jest.config`, or the scripts; do
> not delete tests or code to make a metric pass; do not swallow exceptions to
> silence a linter. Fix the root cause. The only allowed escape hatch is an
> inline `# noqa: RULE  # Issue #N: <reason>` (or `# type: ignore  # Issue #N:
> …`) tied to a real tracking issue, per `max-quality-no-shortcuts`.

## Minimal change & scope discipline

- Implement **exactly** the issue — smallest change that satisfies it.
- Found an unrelated bug or improvement? `gh issue create` for it and reference
  it; **do not** fix it in this change.
- Respect existing patterns and conventions; write code that teaches (comment
  intent, not syntax); no magic numbers without a named constant.
- One issue → one PR. Never chain. Never write to `main` directly. Never
  force-push.

## Commit & PR conventions

- Conventional-commit subjects (`feat(backend): …`, `fix(frontend): …`,
  `refactor(...): …`, `test(...): …`), body referencing the issue, ending with
  the repo trailer (kept model-agnostic on purpose — a tick's commit is produced
  across several models: the conductor plus specialists on opus/sonnet/haiku/fable):
  `Co-Authored-By: Claude <noreply@anthropic.com>`
- PR body: `## Summary` (1–3 bullets), `## Test plan` (what you ran),
  `Closes #N` on its own line, `Refs #<epic>` if the issue names one.
