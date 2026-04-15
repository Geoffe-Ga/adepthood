# Backend Infrastructure & Cross-Cutting — Bug Remediation Report

**Component:** FastAPI app setup, CORS, database/session, errors, rate limiting, migrations, admin, observability
**Date:** 2026-04-14
**Auditor:** Claude Code (self-review)
**Branch:** `claude/code-review-bug-analysis-BvOHp`

## Executive Summary

27 infrastructure bugs. The ones that are production-hot:

- **Energy plan endpoint is synchronous (`def`) but expected to run in an async stack** — a single slow call will block the entire event loop and stall every other request.
- **`await session.delete(group)` in `goal_groups.py:155`** — `Session.delete` is not awaitable in SQLAlchemy async; this raises `TypeError: object NoneType can't be used in 'await' expression`. Deletion is broken.
- **No pagination on seven list endpoints** — `/practices/`, `/habits/`, `/practice-sessions/`, `/goal-groups/`, `/stages/`, `/user-practices/`, `/course/stages/{n}/content`.
- **Unauthenticated `GET /` leaks status** and returns 200 without auth.
- **Security headers incomplete** — no CSP, no Referrer-Policy, no Permissions-Policy.
- **Broken downgrade migration** for timestamptz columns.

---

## Table of Contents

| # | Severity | Title |
|---|---|---|
| BUG-INFRA-009 | Critical | Energy endpoint is sync inside async stack |
| BUG-INFRA-019 | Critical | `await session.delete(...)` raises TypeError in goal_groups |
| BUG-INFRA-022 | Critical | Downgrade migration has broken SQL escaping |
| BUG-INFRA-001 | High | No Content-Security-Policy header |
| BUG-INFRA-004 | High | Unauthenticated root endpoint |
| BUG-INFRA-010 | High | Misplaced `await` on `session.delete()` |
| BUG-INFRA-012 | High | `/practices/` no pagination |
| BUG-INFRA-013 | High | `/habits/` no pagination |
| BUG-INFRA-014 | High | `/practice-sessions/` no pagination |
| BUG-INFRA-015 | High | `/goal-groups/` no pagination |
| BUG-INFRA-017 | High | `/user-practices/` no pagination |
| BUG-INFRA-018 | High | `/course/stages/{n}/content` no pagination |
| BUG-INFRA-002 | Medium | Missing Referrer-Policy header |
| BUG-INFRA-003 | Medium | Missing Permissions-Policy header |
| BUG-INFRA-005 | Medium | CORS `allow_credentials=True` with env-parsed origins |
| BUG-INFRA-006 | Medium | Dev mode ignores `PROD_DOMAIN` silently |
| BUG-INFRA-008 | Medium | Globally permissive HTTP methods in CORS |
| BUG-INFRA-011 | Medium | Stream rollback path incomplete |
| BUG-INFRA-016 | Medium | `/stages` no pagination |
| BUG-INFRA-020 | Medium | Post-refresh `.one()` raises on race |
| BUG-INFRA-021 | Medium | Health-check session leak on failure |
| BUG-INFRA-023 | Medium | No CI guard that new models have migrations |
| BUG-INFRA-024 | Medium | Most routers have no structured logging |
| BUG-INFRA-025 | Medium | No correlation ID / request tracing |
| BUG-INFRA-026 | Medium | Test client cookies don't mirror prod flags |
| BUG-INFRA-027 | Medium | `db_session` fixture teardown not in `try/finally` |
| BUG-INFRA-007 | Low | CORS origin list not deduplicated |

---

### BUG-INFRA-009: Energy endpoint sync in async stack
**Severity:** Critical
**Component:** `backend/src/routers/energy.py:14-18`
**Symptom:** `def create_plan(...)` (not `async def`) is mounted on an `AsyncSession` app. FastAPI runs sync endpoints in a threadpool, but because `get_or_generate_plan` calls down into sync code that owns no session, any heavy work here serializes against the default threadpool limit.
**Fix:** Convert to `async def`. If the plan generation is CPU-bound, offload with `asyncio.to_thread`.

---

### BUG-INFRA-019 / 010: `await session.delete(...)` misuse
**Severity:** Critical
**Component:** `backend/src/routers/goal_groups.py:155` (plus any callers using the same pattern)
**Symptom:** `AsyncSession.delete` returns `None`; `await None` raises `TypeError`.
**Fix:** Drop the `await` — `session.delete(group)` then `await session.commit()`. Audit the other routers for the same pattern with a grep.

---

### BUG-INFRA-022: Broken downgrade migration
**Severity:** Critical
**Component:** `backend/migrations/versions/78b1620cafde_convert_datetime_columns_to_timestamptz.py:63`
**Symptom:** `postgresql_using` expression has malformed quote escaping; downgrade fails with a SQL syntax error.
**Fix:** `postgresql_using=f'"{column}" AT TIME ZONE \'UTC\''` and add a test that runs `alembic upgrade head && alembic downgrade -1 && alembic upgrade head` in CI.

---

### BUG-INFRA-001 / 002 / 003: Missing security headers
**Severity:** High / Medium / Medium
**Component:** `backend/src/main.py:97-115` (SecurityHeadersMiddleware)
**Fix:** Append `Content-Security-Policy`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), microphone=(), camera=()`. Stake out CSP values that match the frontend's real needs — `script-src` should not include `unsafe-inline` unless Expo web requires it.

---

### BUG-INFRA-004: Unauthenticated `GET /`
**Severity:** High
**Component:** `backend/src/main.py:167-170`
**Fix:** Remove it, or gate behind an admin dependency. If you want a public liveness probe, expose `/health` only.

---

### BUG-INFRA-012–018: Pagination gaps
**Severity:** High (012–015, 017, 018), Medium (016 only because stages are few)
**Component:**
- `/practices/` — `routers/practices.py:19-32`
- `/habits/` — `routers/habits.py:37-50`
- `/practice-sessions/` — `routers/practice_sessions.py:49-62`
- `/goal-groups/` — `routers/goal_groups.py:56-71`
- `/stages` — `routers/stages.py:35-64`
- `/user-practices/` — `routers/user_practices.py:54-61`
- `/course/stages/{n}/content` — `routers/course.py:75-97`
**Fix:** Add `limit` / `offset` (or cursor) with sensible maxima (e.g., `le=200`). Return `{items, total, limit, offset}` or `Link` headers. Add a shared `PaginationParams` dependency.

---

### BUG-INFRA-005: `allow_credentials=True` with env-parsed origins
**Severity:** Medium
**Component:** `backend/src/main.py:142-148`
**Fix:** Hard-fail startup if `*` ever lands in the allow-list while `allow_credentials=True`. Also reject origins that don't parse as valid URLs.

---

### BUG-INFRA-006: Dev mode ignores `PROD_DOMAIN`
**Severity:** Medium
**Component:** `backend/src/main.py:67-84`
**Fix:** Log a warning when `ENV=development` and `PROD_DOMAIN` is set so misconfiguration is obvious.

---

### BUG-INFRA-008: Globally permissive methods
**Severity:** Medium
**Component:** `backend/src/main.py:142-148`
**Fix:** Explicitly list only methods the API uses. Drop `DELETE` unless exposed.

---

### BUG-INFRA-011: Stream rollback path incomplete
**Severity:** Medium
**Component:** `backend/src/services/chat_stream.py:145-176`
**Fix:** Use `try/except/else/finally`; ensure `finalise_stream_commit` runs only on the success branch and `session.rollback` is idempotent on abort.

---

### BUG-INFRA-020: `.one()` after refresh races the record's existence
**Severity:** Medium
**Component:** `backend/src/routers/goal_groups.py:107-111` (pattern likely repeats)
**Fix:** `.first()` with a None check and `not_found` fallback.

---

### BUG-INFRA-021: Health-check session leak
**Severity:** Medium
**Component:** `backend/src/main.py:173-187`
**Fix:** Rely on the `Depends(get_session)` cleanup, but log the error and ensure that `get_session` itself has `try/finally` with explicit close/rollback.

---

### BUG-INFRA-023: No migration drift CI guard
**Severity:** Medium
**Component:** `backend/migrations/`, pre-commit config
**Fix:** Add a CI step (or pre-commit hook) that runs `alembic check` or autogenerates a migration in a temp DB and fails if a diff exists.

---

### BUG-INFRA-024: No structured logging in routers
**Severity:** Medium
**Component:** `backend/src/routers/*.py`
**Fix:** Centralize a `logger = structlog.get_logger(__name__)` (or std `logging` with a JSON formatter) and log one event per mutating endpoint: `habit_created`, `goal_completed`, etc. Include user_id but redact emails. Add a `logging.yaml` / dict-config loaded from env.

---

### BUG-INFRA-025: No correlation ID
**Severity:** Medium
**Component:** App-wide
**Fix:** Middleware that reads `X-Request-ID` (or mints one), stores in `contextvars`, injects into log records and into the LLM provider calls so BotMason traces can be matched to user sessions. Echo back on the response.

---

### BUG-INFRA-026 / 027: Test fixture hygiene
**Severity:** Medium
**Component:** `backend/conftest.py:49-77`
**Fix:** Wrap the `db_session` fixture body in `try/finally` so tables are dropped even on exception. Assert that `app.dependency_overrides` is empty at teardown.

---

### BUG-INFRA-007: CORS origin list not deduplicated
**Severity:** Low
**Component:** `backend/src/main.py:49-64`
**Fix:** `list(dict.fromkeys(origins))` — order-preserving dedup.

---

## Suggested remediation order

1. **010 / 019** and **022** (crashes) — same PR, trivial.
2. **009** (sync-in-async) — same PR, include a load test.
3. **012–018** (pagination) — big single PR with a shared dependency.
4. **001–005** (security headers + CORS hardening).
5. **024 / 025** (observability) — groundwork for anything else.
6. **023, 027, 026** (CI + test hygiene).
7. Remaining MEDIUM / LOW.
