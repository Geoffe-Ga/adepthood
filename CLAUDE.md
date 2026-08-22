# Adepthood — Claude Code Project Configuration

## Project Overview

Adepthood is a React Native + FastAPI full-stack application built on a
philosophy of **graduated engagement**: at its floor it is a journal-first
personal knowledge base whose growing corpus becomes a "Higher Self" that
reflects the user's own wisdom back in the language of the 36-week APTITUDE
program and the Archetypal Wavelength. Around that floor are optional,
self-chosen **depths** — prompted journaling, habit scaffolding, a practice
ramp, the course reading, and the Digital Sangha. Nothing is gated and nothing
is mandatory: the governing principle is **"you choose your depth."** Deeper
rings are offered only as resonant, declinable invitations — never gamified
pressure. The product vision lives in `NORTH-STAR.md`; the "Candle & Ink" visual north
star and implemented design system live in `frontend/src/design/DESIGN.md`
(tokens under `frontend/src/design/`). Root `DESIGN.md` is an external
inspiration reference — an analysis of the Anthropic / Claude.com
marketing-site aesthetic that informed the Candle & Ink vocabulary.

- **Frontend:** React Native with Expo (TypeScript, Zustand, React Navigation)
- **Backend:** FastAPI with PostgreSQL (SQLModel, async, Alembic migrations)
- **Monorepo:** `frontend/` and `backend/` at the root

## Architecture at a Glance

```
adepthood/
  backend/
    src/
      main.py              # FastAPI app, CORS, router mounting
      database.py          # Async engine, session factory, get_session
      models/              # 27 SQLModel ORM classes
      routers/             # Route handlers (auth, habits, practices, etc.)
      schemas/             # Pydantic request/response DTOs
      domain/              # Business logic (energy, streaks, stage progress,
                           #   resonance + completion-suggestion detection)
      seed_content.py      # Content seeder (run on FastAPI startup lifespan)
      errors.py            # Custom exceptions
    conftest.py            # Pytest fixtures (db_session, async_client)
    pyproject.toml         # All Python tool configs
  frontend/
    src/
      App.tsx              # Entry point with AuthProvider + navigation
      features/            # Feature modules (Today, Habits, Practice, Course,
                           #   Journal, Map, plus Auth, Welcome, Settings)
      api/                 # HTTP client + TypeScript types
      context/             # AuthContext (JWT management)
      navigation/          # React Navigation (BottomTabs: Today/Habits/Practice/
                           #   Course/Journal/Map, RootStack, AuthStack)
      design/              # Candle & Ink design system (tokens, theme, DESIGN.md)
      components/          # Shared UI components
      store/               # State management (Zustand)
      storage/             # AsyncStorage persistence
    package.json
    tsconfig.json
  prompts/github-issues/   # Roadmap: phased epics (see its README for the graph)
  AGENTS.md                # Development philosophy (read this)
  .pre-commit-config.yaml  # 15+ quality gates
```

## Development Commands

```bash
# Environment setup (idempotent)
source .venv/bin/activate           # ALWAYS activate before Python work
pip install -r backend/requirements.txt -r backend/requirements-dev.txt
# Installs what is missing but never what is stale; scripts/backend/deps.sh fails the gate on drift

# Quality checks
pre-commit run --all-files          # Whole-tree sweep — reserve for a wide
                                    # rename, a suspected cross-file type
                                    # error, or a hook-config change; git
                                    # commit already re-runs the hooks on
                                    # your staged diff seconds later
pre-commit run <hook-id> --all-files  # Run a specific hook

# Backend
cd backend && pytest                # Run tests
cd backend && pytest --cov=. --cov-report=term-missing --cov-fail-under=90
cd backend && python -m uvicorn src.main:app --reload

# Frontend
cd frontend && npm ci               # Install from lockfile (deterministic)
cd frontend && npm test             # Jest
cd frontend && npm run lint         # ESLint
cd frontend && npx tsc --noEmit     # Type check
```

## Guardrails

### Things I Must Always Do
- Activate `.venv` before any Python or pre-commit work
- Read issue files and acceptance criteria before starting work
- Follow the dependency graph in `prompts/github-issues/README.md`
- Use TDD: write the test first, watch it fail, then implement
- Run `./scripts/<side>/check-all.sh` once Gate 1 is green; reserve a full
  `pre-commit run --all-files` sweep for a wide rename, a suspected
  cross-file type error, or a hook-config change — `git commit` already
  re-runs the hooks on your staged diff
- Register a journey in `frontend/e2e/journeys.json` for any PR that adds or
  changes a user-facing feature — `status: "covered"` naming the seam-crossing
  spec, or `status: "uncovered"` with a linked issue. Declaring a gap is
  expected; hiding one is not
- Use conventional commit messages (enforced by commitlint)
- Keep commits small and atomic — one logical change each
- Respect existing patterns and conventions in the codebase

### Things I Must Never Do
- Comment out tests to make the suite pass
- Add `# noqa`, `# type: ignore`, `// @ts-ignore`, `// eslint-disable` for real errors
- Use `any` types to dodge proper typing
- Reduce coverage thresholds or weaken test config
- Push to `main` directly — always use feature branches
- Skip pre-commit hooks (`--no-verify`)
- Install packages with `npm install` instead of `npm ci` in CI/session contexts
- Introduce magic numbers without named constants
- Leave TODOs for problems solvable now

### Quality Thresholds
- **Journey coverage:** every critical user journey is declared in
  `frontend/e2e/journeys.json` and either covered by a seam-crossing spec or
  marked `uncovered` with an issue. Every other threshold here is a *volume*
  metric: none of them can distinguish 90% coverage of a feature nobody can
  reach from 90% coverage of a feature that works
- **Test coverage:** 90% minimum line coverage (backend pytest-cov; frontend jest)
- **Branch coverage:** 80% minimum (backend CI gate, target 90%)
- **Docstring coverage:** 85% minimum (backend, interrogate)
- **Lint:** zero warnings — ruff `select = ["ALL"]`, ESLint with sonarjs/unicorn
- **Types:** strict mode in both mypy and TypeScript
- **Security:** bandit + pip-audit + detect-secrets must all pass
- **Formatting:** ruff-format (Python), prettier (frontend) — auto-fixed
- **Complexity:** xenon A-grade absolute/modules/average, radon MI ≥ B

### Stay Green Workflow
Quality is enforced through a graduated ladder, cheapest first, each rung run
once:
1. **Targeted tests** (`./scripts/backend/test.sh <paths>`) on every TDD
   red → green cycle: seconds.
2. **`./scripts/<side>/check-all.sh`**, once targeted tests are green: lint,
   format, mypy, security, complexity, full suite, coverage (~4m23s cold
   backend; ~8s when it reuses a receipt for an unchanged tree).
3. **Git hooks** (automatic): `git commit` runs the pre-commit-stage hooks on
   your staged files; `git push` runs the pre-push-stage hooks (full suite +
   coverage + complexity), ~5 min. All three hook types are installed by a bare
   `pre-commit install`, via `default_install_hook_types` in
   `.pre-commit-config.yaml`. On a checkout set up before that landed, run
   `pre-commit install` once to pick up the `pre-push` hook — `ls .git/hooks/`
   should list `pre-push`. CI runs that stage regardless.
4. **CI**: all of the above plus cross-version compat (3.11/3.12/3.13),
   docstring coverage, branch coverage, security audit.

Never commit with `--no-verify`. Never push with failing gates. If a gate
fails, fix the root cause — don't suppress the check.

## Roadmap

The development plan lives in `prompts/github-issues/`, organized into phased
epics (the original Phase 1 "Make It Real" critical path has shipped; later
phases continue to be added). See `README.md` in that directory for the
dependency graph and the current phase breakdown.

When continuing work, always check git log and codebase state to determine
which issues are complete before picking up the next one.

## Useful Patterns

### Backend Test Pattern
```python
@pytest.mark.asyncio
async def test_endpoint(async_client: AsyncClient) -> None:
    response = await async_client.post("/endpoint", json={"key": "value"})
    assert response.status_code == 201
    assert response.json()["key"] == "value"
```

### Frontend Test Pattern
```typescript
import { render, fireEvent } from "@testing-library/react-native";
it("does the thing", () => {
  const { getByText } = render(<Component />);
  fireEvent.press(getByText("Button"));
  expect(getByText("Result")).toBeTruthy();
});
```

### Conventional Commits
```
feat(backend): add session factory and get_session dependency
test(backend): add integration tests for /health endpoint
fix(frontend): correct habit type mismatch in API response
refactor(frontend): extract useHabits hook from HabitsScreen
```

## Phone Interface Tips

When working from the phone interface, these skills are available:
- `/continue-epic` — Pick up the next issue from the roadmap and drive it to PR
- `/triage-and-plan` — Analyze the codebase and generate a new epic of issues
- `/preflight` — Run pre-commit, fix all failures, iterate until green
- `/review-diff` — Self-review the current branch diff before PR

## Knowledge Graph (graphify)

This repo ships a queryable code graph (see `scripts/graph/`). When
`graphify-out/graph.json` exists, prefer it over blind grep/read sweeps:

- For codebase questions, run `graphify query "<question>"` first; use
  `graphify path "A" "B"` for relationships, `graphify explain "X"` for
  concepts, and `graphify affected "X"` for change impact.
- When citing a fact from the graph, quote each node's `source_location`.
- After modifying code, refresh it with `./scripts/graph/update.sh`
  (AST-only, no cost).
- If the graph is absent, build it with `./scripts/graph/build.sh` (~2 min)
  or proceed without it.

## Playbook (auto-curated)

Concrete "when X, do Y" rules distilled weekly from real failures — flare-filed
bugs and Claude review verdicts that blocked LGTM — by
`.github/workflows/weekly-playbook.yml`, which specs each week's delta as a
P0 `agent-ready` issue (label `playbook`) that the Ralph fleet implements.
Every rule below carries an HTML-comment marker with its evidence; the
playbook may add, edit, or retire ONLY marker-bearing rules (here and in
`.claude/agents/` and `.claude/skills/` playbook sections). Edit rules by
hand freely — remove the marker to take a rule out of the playbook's
jurisdiction.

<!-- playbook rules are inserted below this line -->

- **When** a FastAPI request body or query schema carries an id referencing an object other than the path's own resource (any `*_id` field), **do** authorize the caller's ownership of it unconditionally whenever it is non-null, using the `resolve_owned_*` helpers in `backend/src/dependencies/ownership.py` with their 404-missing / 403-not-owner convention and `log_ownership_denied`, and add a cross-tenant regression test in `backend/tests/security/test_idor.py` asserting both the rejection and that no row was persisted. <!-- playbook added=2026-08-10 evidence=#2064,#2065,#2121,#2122,#2123 -->
- **When** adding or editing a command inside `scripts/**/*.sh` that a `check-all.sh` or pre-commit gate presents as enforcing, **do** run it once by hand to confirm it both executes and exits non-zero on a real violation, never wrap it in `|| true`, and add a meta-test under `backend/tests/scripts/` asserting the script fails on a deliberately violating fixture. <!-- playbook added=2026-08-10 evidence=#2024,#2055,#2015,#2006 -->
