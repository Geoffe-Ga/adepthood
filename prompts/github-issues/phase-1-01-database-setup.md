# phase-1-01: Create database engine, session management, and Alembic setup

**Labels:** `phase-1`, `backend`, `infrastructure`, `priority-critical`
**Epic:** Phase 1 — Make It Real
**Estimated LoC:** ~200–300

## Problem

The backend has 14 SQLModel classes defined in `backend/src/models/` (`User`, `Habit`, `Goal`, `GoalCompletion`, `GoalGroup`, `JournalEntry`, `Practice`, `PracticeSession`, `CourseStage`, `StageContent`, `StageProgress`, `PromptResponse`, `UserPractice`) but no database connection exists anywhere. The `.env.example` references `DATABASE_URL=postgresql+asyncpg://...` but nothing reads it. Every router uses in-memory Python lists and dicts instead.

**Current state:**
- `models/__init__.py` imports all 14 models — they parse and pass `test_models.py` structural tests, but are never instantiated or queried.
- No `database.py`, no engine, no session factory, no migration tool.
- `conftest.py` only manipulates `sys.path` — no test database fixture.

## Scope

Create the foundational database layer that all subsequent Phase 1 issues depend on.

## Tasks

1. **Create `backend/src/database.py`**
   - Read `DATABASE_URL` from environment (with `python-dotenv` or `pydantic-settings`)
   - Create async SQLAlchemy engine via `create_async_engine()`
   - Create `async_sessionmaker` for dependency injection
   - Add a `get_session` async generator for FastAPI `Depends()`
   - Validate that `DATABASE_URL` is set at import time — fail fast with a clear error, not a silent empty string

2. **Add Alembic for migrations**
   - `alembic init backend/migrations`
   - Configure `env.py` to read `DATABASE_URL` from the same source
   - Import all models in `env.py` so `--autogenerate` detects them
   - Generate initial migration from existing SQLModel definitions
   - Add `alembic` to `requirements.txt`

3. **Update `conftest.py`**
   - Add a test database fixture using SQLite in-memory (`:memory:`) or a test PostgreSQL URL
   - Override `get_session` dependency in tests so routers use the test DB
   - Ensure the test database is created/torn down per test function (isolation)

4. **Update `main.py`**
   - Import and wire up database lifecycle (create tables on startup if needed for dev, or rely on Alembic)
   - Add a `/health` endpoint that validates the DB connection (currently `/` just returns `{"status": "ok"}` with no real check)

5. **Add `pydantic-settings` or `python-dotenv` to `requirements.txt`**

## Acceptance Criteria

- `uvicorn src.main:app` starts and connects to PostgreSQL
- `alembic upgrade head` creates all 14 model tables
- `pytest` runs against an isolated test database, not production
- `/health` returns 200 only when the DB is reachable
- No existing tests break

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/database.py` | **Create** |
| `backend/migrations/` | **Create** (Alembic) |
| `backend/alembic.ini` | **Create** |
| `backend/src/main.py` | Modify (add startup, health check) |
| `backend/conftest.py` | Modify (add DB fixture) |
| `backend/requirements.txt` | Modify (add alembic, pydantic-settings) |
| `backend/.env.example` | Modify (document DATABASE_URL) |
