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

# Quality checks
pre-commit run --all-files          # Run ALL hooks — do this before every commit
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
- Run `pre-commit run --all-files` before every commit attempt
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
- **Test coverage:** 90% minimum line coverage (backend pytest-cov; frontend jest)
- **Branch coverage:** 80% minimum (backend CI gate, target 90%)
- **Docstring coverage:** 85% minimum (backend, interrogate)
- **Lint:** zero warnings — ruff `select = ["ALL"]`, ESLint with sonarjs/unicorn
- **Types:** strict mode in both mypy and TypeScript
- **Security:** bandit + pip-audit + detect-secrets must all pass
- **Formatting:** ruff-format (Python), prettier (frontend) — auto-fixed
- **Complexity:** xenon A-grade absolute/modules/average, radon MI ≥ B

### Stay Green Workflow
Quality is enforced through a 3-gate process:
1. **Gate 1 — Pre-commit** (~10s): format + lint + hygiene (28 hooks)
2. **Gate 2 — Pre-push**: full test suite + coverage + complexity
3. **Gate 3 — CI**: all of the above + cross-version compat (3.11/3.12/3.13)
   + docstring coverage + branch coverage + security audit

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
