# Continue Epic

Pick up the next incomplete issue from the Adepthood roadmap and drive it to a
merge-ready pull request. Every invocation should leave the codebase strictly
better than it found it — no half-measures, no shortcuts, no tech debt IOUs.

---

## Trigger

Activate when the user says any of:
- "continue epic"
- "next issue"
- "pick up where we left off"
- "work on the next task"

---

## Instructions

### 1. Read the Plan

Load the master roadmap and understand the full scope before touching anything.

```
prompts/github-issues/README.md          # Phase table + dependency graph
prompts/github-issues/phase-*-epic.md    # Epic-level context per phase
```

The roadmap contains 40 issues across 4 phases:

| Phase | Name                        | Issues | Priority |
|-------|-----------------------------|--------|----------|
| 1     | Make It Real (Critical)     | 11     | Critical — everything depends on this |
| 2     | Decompose the Monolith      | 7      | High — pure refactoring |
| 3     | Build Missing Features      | 14     | Medium — new screens + deep links |
| 4     | Polish & Harden             | 8      | Lower — type safety, security, docs |

Each issue file (`phase-N-NN-slug.md`) contains: labels, epic reference,
estimated LoC, problem statement, scope, numbered tasks, acceptance criteria,
and a files-to-create/modify table. Read the target issue file thoroughly before
writing any code.

### 2. Read the Git Log

```bash
git log --oneline --all -40
```

Cross-reference merged branches and commit messages against the issue list.
A branch named `phase-1-01-database-setup` (or similar) that has been merged
to `main` means that issue is done. Look for:

- Merged PRs whose branch names match issue slugs
- Commit messages referencing issue numbers or slugs
- Actual codebase state (e.g., if `backend/src/database.py` exists, issue 01 is
  likely complete even without a perfectly named branch)

### 3. Determine the Next Incomplete Issue

Walk the roadmap **in dependency order**, not just sequential order. The
dependency graph in `README.md` is authoritative:

```
phase-1-01 (DB setup)
  +-- phase-1-02 (Habits -> DB)
  |     +-- phase-1-05 (Goals -> DB)
  +-- phase-1-03 (Auth -> DB)
  |     +-- phase-1-04 (Practice -> DB)
  +-- phase-1-06 (Energy TTL)
  +-- phase-1-11 (Type alignment)

phase-1-07 (API consolidation)
  +-- phase-1-08 (Habits <-> API)
        +-- phase-1-09 (AsyncStorage)

phase-1-03 + phase-1-07 + phase-1-09
  +-- phase-1-10 (Auth screens)

Phase 2 starts after Phase 1 core (01-03, 07)
Phase 3 starts after Phase 1 complete
Phase 4 can run in parallel with Phase 3
```

**Verify completion by inspecting the codebase**, not just branch names. An
issue is truly done only when its acceptance criteria are met in the current
code on `main`. If a previous issue was partially completed or regressed, fix
it before moving on.

Once you have identified the next issue, tell the user:
> "The next incomplete issue is **phase-X-NN: [title]**. Here is what it
> requires: [brief summary]. Starting work now."

### 4. Check Out a Feature Branch

```bash
git checkout main
git pull origin main
git checkout -b phase-X-NN-issue-slug
```

Branch naming convention: `phase-{phase}-{number}-{slug}` matching the issue
filename without the `.md` extension. Examples:
- `phase-1-01-database-setup`
- `phase-2-03-global-state-layer`
- `phase-3-07-botmason-ai`

### 5. Set Up the Development Environment

Every session must start from a clean, verified environment. Do not skip steps
even if you believe packages are already installed — verify, don't assume.

#### Python (Backend)

```bash
# Create or reuse virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install production + dev dependencies
pip install -r backend/requirements.txt
pip install -r backend/requirements-dev.txt

# Verify key tools are available
python -c "import pytest; import black; import ruff; import mypy"
```

#### Node (Frontend)

```bash
# Install from lockfile for deterministic builds
cd frontend && npm ci && cd ..
```

Use `npm ci` (not `npm install`) to respect `package-lock.json` exactly. This
ensures reproducible builds and avoids phantom dependency drift.

#### Pre-commit

```bash
# Install hooks into the local git repo
source .venv/bin/activate
pip install pre-commit
pre-commit install
pre-commit install --hook-type commit-msg
pre-commit install --hook-type pre-push
```

The project uses an extensive pre-commit configuration
(`.pre-commit-config.yaml`) with the following hooks:

**Python quality gates:**
- `black` — code formatting (line-length 100)
- `ruff` — linting with auto-fix (strict rule set)
- `ruff-format` — additional formatting
- `mypy` — strict type checking (with pydantic plugin)
- `isort` — import sorting (black-compatible profile)
- `bandit` — security scanning
- `pip-audit` — dependency vulnerability scanning
- `detect-secrets` — secret detection against baseline

**Frontend quality gates:**
- `eslint` — linting with React/Hooks plugins + unicorn
- `prettier` — formatting (write mode)
- `tsc --noEmit` — strict TypeScript type checking
- `jest` — test runner (passWithNoTests)

**Cross-cutting:**
- `commitlint` — conventional commit message enforcement
- `backend-tests-coverage` — pytest with 90% coverage minimum

**Activate the venv for ALL Python work and pre-commit execution.** Many hooks
(mypy, pytest, bandit) require the venv's site-packages to resolve imports
correctly.

### 6. Assume the Role

You are an **expert full-stack developer with unparalleled discernment**. This
means:

- You understand the architectural intent behind every file, not just its syntax.
- You anticipate edge cases and handle them before they become bugs.
- You write code that teaches — variable names are precise, function signatures
  are self-documenting, and comments explain *why*, never *what*.
- You respect existing patterns. If the codebase uses `async_sessionmaker` with
  `Depends(get_session)`, you do too. If the frontend uses feature-based
  directory structure, you follow it.
- You do not introduce unnecessary abstractions, premature optimizations, or
  speculative generality. Every line of code earns its place.
- You treat the acceptance criteria in each issue file as a contract, not a
  suggestion.

Read `AGENTS.md` at the project root. It defines the development philosophy
that governs all work:

1. **TDD is required** — tests before or alongside features, every bug fix
   starts with a failing test
2. **CI is the feedback loop** — `pre-commit run --all-files` before every
   commit attempt
3. **Small, meaningful commits** — one logical change per commit
4. **Optimize for learning** — code teaches, comments explain intent
5. **No untested assumptions** — validate everything
6. **Respect the Archetypal Wavelength** — test, think, implement, refine,
   repeat

### 7. Begin Work Using TDD

Follow the Red-Green-Refactor cycle religiously:

#### Red: Write a Failing Test

- Read the issue's acceptance criteria and tasks.
- For each task, write the test(s) that would prove it works.
- Run the tests. Confirm they fail for the right reason (not import errors or
  syntax mistakes — those are setup problems, not TDD).

#### Green: Write the Minimum Code to Pass

- Implement just enough to make the failing test pass.
- Do not gold-plate. Do not add features the test doesn't cover yet.
- Run the test again. It should pass.

#### Refactor: Clean Up Without Changing Behavior

- Eliminate duplication, improve naming, tighten types.
- Run all tests again. Nothing should break.
- Repeat for the next task in the issue.

**Backend testing patterns:**

The project uses pytest-asyncio with an in-memory SQLite test database.
`backend/conftest.py` provides `db_session` and `async_client` fixtures. Use
them — do not create parallel fixture infrastructure.

```python
# Pattern: async test with DB session
@pytest.mark.asyncio
async def test_something(async_client: AsyncClient) -> None:
    response = await async_client.post("/endpoint", json={...})
    assert response.status_code == 201
```

**Frontend testing patterns:**

The project uses Jest with `@testing-library/react-native`. Test behavior, not
implementation. Prefer `getByText`, `getByRole`, `fireEvent` over reaching into
component internals.

**Commit cadence:**

Make small, meaningful commits as you go. Each commit should compile, pass
lint, and pass tests. Use conventional commit messages:

```
feat(backend): add session factory and get_session dependency
test(backend): add integration tests for /health endpoint
fix(frontend): correct habit type mismatch in API response
refactor(frontend): extract useHabits hook from HabitsScreen
```

### 8. Iterate on Pre-commit Until All Green

Before every commit attempt, run the full suite:

```bash
source .venv/bin/activate
pre-commit run --all-files
```

If any hook fails:

1. **Read the error output carefully.** Understand what the hook is telling you.
2. **Fix the root cause.** Do not work around the tool — work with it.
3. **Re-run the specific failing hook** to confirm the fix:
   ```bash
   pre-commit run <hook-id> --all-files
   ```
4. **Re-run the full suite** to confirm no regressions:
   ```bash
   pre-commit run --all-files
   ```
5. Repeat until every hook passes.

Common gotchas and their real fixes:

| Hook | Common failure | Real fix |
|------|---------------|----------|
| `mypy` | Missing type annotations | Add proper types — never use `# type: ignore` unless the library genuinely lacks stubs |
| `ruff` | Unused imports | Remove them; do not add `# noqa` for real issues |
| `black` / `isort` | Formatting drift | Let the auto-formatter run; commit the result |
| `bandit` | Hardcoded secrets in tests | Use fixtures or env vars, not string literals for real secrets |
| `eslint` | React hooks dependency array | Fix the dependency array correctly; understand the hook's lifecycle |
| `tsc` | Type mismatch | Fix the types; do not cast to `any` |
| `jest` | Snapshot mismatch | Update the snapshot only if the change is intentional |
| `coverage` | Below 90% | Write more tests — the threshold exists for a reason |

### 9. Quality Standards — No Shortcuts

This is non-negotiable. The following are **never acceptable**:

- Commenting out failing tests to make the suite pass
- Adding `# noqa`, `# type: ignore`, `// @ts-ignore`, `// eslint-disable` to
  silence legitimate lint errors
- Reducing coverage thresholds
- Modifying test configuration to skip or weaken checks
- Using `any` types to avoid proper typing
- Writing tests that don't actually assert meaningful behavior
- Leaving `TODO` or `FIXME` comments for problems you could fix now
- Introducing magic numbers without named constants
- Copy-pasting code instead of extracting shared logic
- Ignoring the dependency graph and working on issues out of order

**Max quality code is always faster, more efficient, and more elegant** — even
when it seems like cutting a corner would save time. Corners cut today become
bugs filed tomorrow and hours spent debugging next week. The disciplined path
is the fast path.

When you encounter a hard problem, slow down. Re-read the issue. Re-read the
existing code. Think about the design before typing. The right abstraction will
present itself when you understand the problem deeply enough.

### 10. Signal Readiness for PR

When all of the following are true:

- [ ] Every acceptance criterion from the issue file is met
- [ ] `pre-commit run --all-files` passes with zero failures
- [ ] All existing tests still pass (no regressions)
- [ ] New tests cover the new functionality at or above the 90% threshold
- [ ] Commits are clean, atomic, and use conventional message format
- [ ] The branch is rebased on latest `main` with no conflicts
- [ ] You have reviewed your own diff and are confident in every line

Then tell the user:

> "All work for **phase-X-NN: [title]** is complete. Pre-commit passes green,
> all acceptance criteria are met, and coverage is above 90%. Ready to push and
> open a PR. Shall I proceed?"

Do **not** push or open a PR without explicit user approval.

---

## Key File Reference

These are the files you will consult most often. Know where they are.

| File | Purpose |
|------|---------|
| `prompts/github-issues/README.md` | Master roadmap with dependency graph |
| `prompts/github-issues/phase-*-*.md` | Individual issue specifications |
| `AGENTS.md` | Development philosophy and operating principles |
| `.pre-commit-config.yaml` | All quality gate definitions |
| `backend/pyproject.toml` | Python tool configs (black, ruff, mypy, isort, pytest, coverage) |
| `backend/requirements.txt` | Production Python dependencies |
| `backend/requirements-dev.txt` | Dev Python dependencies (pre-commit tooling) |
| `backend/conftest.py` | Pytest fixtures (db_session, async_client) |
| `backend/src/database.py` | Async engine, session factory, get_session |
| `backend/src/main.py` | FastAPI app with all routers |
| `backend/src/models/` | SQLModel ORM definitions (14 models) |
| `backend/src/routers/` | FastAPI route handlers |
| `backend/src/schemas/` | Pydantic request/response schemas |
| `backend/src/domain/` | Business logic (energy, streaks, goals, stages) |
| `frontend/package.json` | npm scripts and dependencies |
| `frontend/package-lock.json` | Deterministic dependency tree |
| `frontend/src/App.tsx` | Frontend entry point |
| `frontend/src/features/` | Feature modules (Auth, Habits, Journal, etc.) |
| `frontend/src/api/` | API client layer and TypeScript types |
| `frontend/tsconfig.json` | TypeScript strict configuration |
| `frontend/jest.config.js` | Jest test configuration |
| `frontend/eslint.config.cjs` | ESLint rule definitions |

---

## Environment Setup Summary

```bash
# Full setup from scratch (idempotent — safe to re-run)
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
pip install -r backend/requirements-dev.txt
pip install pre-commit
pre-commit install
pre-commit install --hook-type commit-msg
pre-commit install --hook-type pre-push
cd frontend && npm ci && cd ..
```

**Always activate the venv** before any Python or pre-commit work:
```bash
source .venv/bin/activate
```

---

## Conventional Commit Format

All commits must follow the [Conventional Commits](https://www.conventionalcommits.org/)
specification. The `commitlint` hook enforces this at commit time.

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Types:** `feat`, `fix`, `test`, `refactor`, `docs`, `style`, `chore`, `ci`, `perf`, `build`
**Scopes:** `backend`, `frontend`, `ci`, `deps`, or a specific module name

Examples:
```
feat(backend): add async session factory with get_session dependency
test(backend): add integration tests for habits CRUD endpoints
fix(frontend): resolve stale closure in useHabits effect cleanup
refactor(frontend): extract EmojiPicker into shared components
chore(deps): bump fastapi to 0.135.3
```

---

## Testing Configuration Quick Reference

**Backend (pytest):**
- Config: `backend/pyproject.toml` under `[tool.pytest.ini_options]`
- Async mode: `pytest-asyncio` with `auto` mode
- Test DB: SQLite in-memory via `aiosqlite` (overrides `get_session`)
- Coverage: 90% minimum, XML + terminal reports
- Fixtures: `db_session`, `async_client` in `backend/conftest.py`

**Frontend (Jest):**
- Config: `frontend/jest.config.js`
- Framework: `@testing-library/react-native`
- Runner: `jest` via npm scripts
- Lint: 0 max warnings enforced

---

## What Success Looks Like

A completed issue means:
1. The feature works as specified in the issue's acceptance criteria
2. Every new code path has test coverage
3. All 15+ pre-commit hooks pass on `--all-files`
4. The git log tells a clear story of incremental, purposeful changes
5. A reviewer could understand the PR without asking a single question
6. The codebase is cleaner than you found it
