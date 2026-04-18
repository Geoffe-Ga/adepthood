# Backend Models & Schemas Bug Report — 2026-04-18

**Scope:** SQLModel ORM classes under `backend/src/models/**` (17 files, ~559 LOC) and Pydantic DTOs under `backend/src/schemas/**` (16 files, ~776 LOC). Covers the contract layer between the database, the API surface, and the React Native client.

**Total bugs: 15 — 2 Critical / 6 High / 6 Medium / 1 Low**

## Executive Summary

This audit surfaces systemic drift between the three contract layers (DB → ORM → DTO) and the mobile client:

1. **Client-controlled economy inputs (Critical/High).** BotMason `BalanceAddRequest.amount` has no bounds (BUG-SCHEMA-009) — any authenticated user can mint credits. `StageProgressUpdate.current_stage` similarly has no `ge/le` (BUG-SCHEMA-006), allowing instant jump to stage 36. `EnergyPlanRequest` accepts client-supplied `energy_cost`/`energy_return` on arbitrary habit IDs (BUG-SCHEMA-007). These three together mean the "game economy" is effectively client-driven.
2. **Missing user-lifecycle flags on the ORM (High).** `User` has no `is_active`, `email_verified`, `is_admin`, or soft-delete column (BUG-MODEL-001). Admin-gating, account suspension, and GDPR erasure are all structurally impossible today. Pairs with BUG-AUTH-018 (no admin check) and BUG-DB-001 (case-sensitive email uniqueness).
3. **FK cascade gaps (High).** Every `user.id` foreign key uses SQLModel shorthand with no `ondelete` (BUG-MODEL-002). Deleting a user would raise `ForeignKeyViolation` on 11+ child tables, blocking any future "delete my account" feature. Mirrors BUG-DB-003.
4. **Response schemas leak `user_id`** (BUG-SCHEMA-001, BUG-SCHEMA-010) on `HabitResponse`, `GoalGroupResponse`, `ContentCompletionResponse`, `PracticeResponse`. Inconsistent with the explicit scrubbing done on `JournalMessageResponse`.
5. **Backdateable writes (High).** `PracticeSessionCreate.timestamp` is client-supplied and only upper-bounded (BUG-SCHEMA-008) — sessions can be back-dated to inflate streaks or fabricate stage-unlock evidence. Parallels BUG-DB-002.
6. **Validation vocabulary drift (Medium).** `CheckInResult.reason_code` is a free `str` (BUG-SCHEMA-003), `Milestone` is a one-field stub (BUG-SCHEMA-002), `JournalEntry.sender` is an unconstrained `str(max_length=10)` (BUG-MODEL-004). Widespread `str` where `Enum`/`Literal` would protect both the OpenAPI surface and the DB write path (BUG-SCHEMA-010).

## Table of Contents

| # | ID | Severity | Component | Title |
|---|----|----------|-----------|-------|
| 1 | BUG-MODEL-001 | High | `models/user.py` | User model lacks `is_active` / `email_verified` / `is_admin` / soft-delete |
| 2 | BUG-MODEL-002 | High | `models/*.py` | FKs to `user.id` have no `ondelete` — user delete raises |
| 3 | BUG-MODEL-003 | Medium | `models/__init__.py` | Alphabetical import order loads `User` last |
| 4 | BUG-MODEL-004 | Medium | `models/journal_entry.py` | `sender` is unconstrained `str(max_length=10)` |
| 5 | BUG-MODEL-005 | Low | `models/*.py` | No `server_default=func.now()` on timestamp columns |
| 6 | BUG-SCHEMA-001 | Medium | `schemas/habit.py` | `HabitResponse` leaks `user_id` |
| 7 | BUG-SCHEMA-002 | High | `schemas/milestone.py` | `Milestone` is a one-field stub |
| 8 | BUG-SCHEMA-003 | High | `schemas/checkin.py` | `CheckInResult.reason_code` unconstrained `str` |
| 9 | BUG-SCHEMA-004 | Medium | `schemas/habit.py` | `HabitCreate` missing input bounds |
| 10 | BUG-SCHEMA-005 | Medium | `schemas/journal.py` | `JournalListResponse` bespoke envelope |
| 11 | BUG-SCHEMA-006 | Critical | `schemas/stage.py` | `StageProgressUpdate.current_stage` unbounded |
| 12 | BUG-SCHEMA-007 | High | `schemas/energy.py` | `EnergyPlanRequest` trusts client energy values |
| 13 | BUG-SCHEMA-008 | High | `schemas/practice.py` | `PracticeSessionCreate.timestamp` backdateable |
| 14 | BUG-SCHEMA-009 | Critical | `schemas/botmason.py` | `BalanceAddRequest.amount` unbounded |
| 15 | BUG-SCHEMA-010 | Medium | `schemas/course.py`, `stage.py`, `practice.py` | Free-form `str` where `Enum`/`Literal` needed; `submitted_by_user_id` leak |

---

## SQLModel ORM classes — `backend/src/models/**`

### BUG-MODEL-001: `User` model lacks `is_active` / `email_verified` / `is_admin` / soft-delete columns
**Severity:** High
**Component:** `backend/src/models/user.py:35-51`
**Symptom:** The `User` ORM class has no flags for account state — there is no `is_active`, `is_admin`, `email_verified`, `deleted_at`, or equivalent. Consequences: (a) there is no way to disable an abusive account short of physical `DELETE` (which itself fails because of missing `ON DELETE` — cross-link BUG-DB-003); (b) every authenticated endpoint treats every persisted user as fully active, so admin-only endpoints are un-gateable without a follow-up schema migration; (c) GDPR/CCPA "right to erasure" cannot be implemented softly — the only options are a destructive purge or leaving the row in place with stale data; (d) combined with BUG-AUTH-018 (`password_hash` default `""`), there is no column to flag a half-provisioned / password-less account as "needs verification" before logins are permitted.
**Root cause:**
```python
class User(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    offering_balance: int = Field(default=0)
    monthly_messages_used: int = Field(default=0)
    monthly_reset_date: datetime = Field(...)
    email: str = Field(unique=True, index=True, max_length=254)
    password_hash: str = Field(default="")  # pragma: allowlist secret
    created_at: datetime = Field(...)
    # No is_active, is_admin, email_verified, deleted_at, last_login_at.
```
Adding these columns later requires a backfill migration and careful default semantics (existing rows must be considered active). Designing them in up front is nearly free; retrofitting them is not.

**Fix:** Add `is_active: bool = Field(default=True, nullable=False)`, `is_admin: bool = Field(default=False, nullable=False)`, `email_verified: bool = Field(default=False, nullable=False)`, and `deleted_at: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True), nullable=True))`. Gate login on `is_active and deleted_at is None`; gate admin endpoints on `is_admin`; gate the sensitive flows (password reset, BotMason) on `email_verified` once an email-verification flow lands. Replace `password_hash: str = Field(default="")` with `password_hash: str = Field(nullable=False)` — no default — so a password-less insert fails loudly.

---

### BUG-MODEL-002: `Habit.user_id` uses shorthand `foreign_key="user.id"` with no `ondelete`, blocking user deletion
**Severity:** High
**Component:** `backend/src/models/habit.py:23`
**Symptom:** Every FK in the model layer that points to `user.id` uses SQLModel's shorthand `Field(foreign_key="user.id")`, which emits `FOREIGN KEY ... REFERENCES "user"(id)` with **no** `ON DELETE` clause — Postgres interprets that as `NO ACTION`. Consequently, deleting a user row raises `ForeignKeyViolation` because `habit`, `goalcompletion`, `practicesession`, `userpractice`, `journalentry`, `promptresponse`, `contentcompletion`, `llmusagelog`, `goalgroup`, and `loginattempt` all hold references. Only `Goal.habit_id` (habit.py via `Column(ForeignKey(..., ondelete="CASCADE"))`) and `Goal.goal_group_id` were written the long-form, cascading way — every other relationship is silently `RESTRICT`. Cross-link: BUG-DB-003 (migration side), BUG-AUTH-* (account-delete flow cannot be implemented).
**Root cause:**
```python
# habit.py
user_id: int = Field(foreign_key="user.id")  # no ondelete
# goal_completion.py
user_id: int = Field(foreign_key="user.id")  # no ondelete
# practice_session.py, user_practice.py, journal_entry.py, prompt_response.py,
# content_completion.py, llm_usage_log.py, login_attempt.py (email FK-like) — all same.
# Only goal.habit_id was written correctly:
habit_id: int = Field(
    sa_column=Column(ForeignKey("habit.id", ondelete="CASCADE"), nullable=False),
)
```
The inconsistency is the giveaway — the author clearly knew the long form; they just didn't apply it to the rest.

**Fix:** Rewrite every FK in the models package using the explicit `sa_column=Column(ForeignKey(..., ondelete="CASCADE"), nullable=False)` pattern. Pick the right semantic per relationship: `CASCADE` for per-user personal data (habits, journals, goalcompletion, practicesession, stageprogress, contentcompletion, userpractice, promptresponse, loginattempt by email), `SET NULL` for `practice.submitted_by_user_id` (preserve community-submitted practices), and preserve `llmusagelog` rows for audit (consider `SET NULL` on user_id plus a retention policy). Emit a companion Alembic migration that drops and recreates each FK with the new rule. Add a test that inserts a user, children across every table, deletes the user, and asserts children are gone (or nulled, per policy).

---

### BUG-MODEL-003: `__init__.py` does not import `User` first, risking autogenerate ordering and mapper-configuration races
**Severity:** Medium
**Component:** `backend/src/models/__init__.py:3-18`
**Symptom:** The package imports submodules in alphabetical order — `ContentCompletion`, `CourseStage`, `Goal`, `GoalCompletion`, `GoalGroup`, `Habit`, `JournalEntry`, … — which means `User` loads **last** (line 17). Because almost every other model contains `foreign_key="user.id"` or a `Relationship(back_populates=...)` that targets `User`, SQLAlchemy's class-registry resolution happens lazily at `configure_mappers()`. This works in the happy path, but any import of a submodule *before* `models/__init__.py` has finished (e.g. a router importing `from models.habit import Habit` during app start) triggers a partially-loaded registry. Symptoms in that case: `InvalidRequestError: When initializing mapper Mapper[Habit(habit)], expression 'User' failed to locate a name`. Alembic autogenerate is also sensitive to module import order — missing an import here silently drops tables from the metadata and produces a no-op migration (cross-link BUG-DB-005).
**Root cause:**
```python
from .content_completion import ContentCompletion
from .course_stage import CourseStage
from .goal import Goal
# ... 13 more imports ...
from .user import User            # <-- last, but referenced by every prior import
from .user_practice import UserPractice
```
Neither the docstring nor a comment asserts "always import models via `from backend.src.models import *` — never from the submodule directly". The `Habit` / `Goal` / `JournalEntry` modules all guard the `User` import inside `TYPE_CHECKING`, which means runtime resolution is by string lookup in the SQLAlchemy class registry, which requires `User` to have been imported somewhere before `configure_mappers()` fires.

**Fix:** Import `User` first (it's the referent of most FKs), then the rest in any order. More robust: put a single `import backend.src.models  # noqa: F401` at the top of `database.py` / `main.py` so metadata is fully populated before any engine or migration runs, and add a startup test that calls `SQLModel.metadata.sorted_tables` and asserts the expected table count — a missing import here drops tables silently from `create_all`/autogenerate. Consider also adding `from sqlalchemy.orm import configure_mappers; configure_mappers()` at the bottom of `__init__.py` to force eager resolution at import time and turn latent string-ref typos into loud errors.

---

### BUG-MODEL-004: `JournalEntry.sender` is an unconstrained `str(max_length=10)` — no enum, no CHECK, no index
**Severity:** Medium
**Component:** `backend/src/models/journal_entry.py:46`
**Symptom:** `sender` is the discriminator between user messages and bot replies — the BotMason wallet, the `/journal/chat` LLM cost logging (every `LLMUsageLog.journal_entry_id` row points at a `sender='bot'` row per the docstring), and any future "show only my messages" UI all depend on this value being exactly one of `{"user", "bot"}`. As written, nothing enforces that: the column accepts any 10-character string. A typo (`"Bot"`, `"User "`, `"assistant"`) silently breaks every downstream filter. Worse, the value has no `index=True`, so `WHERE sender = 'bot'` queries (used by the LLM cost rollup) do a seq scan on a table that will grow to millions of rows. Related smell: the `tag: str = Field(default=JournalTag.FREEFORM, max_length=50)` line stores a `StrEnum` via its value but has no DB-level CHECK either — same enum-as-string drift risk as BUG-DB-010.
**Root cause:**
```python
message: str = Field(max_length=10_000)
sender: str = Field(max_length=10)  # 'user' or 'bot'   <-- comment, not constraint
user_id: int = Field(foreign_key="user.id")
tag: str = Field(default=JournalTag.FREEFORM, max_length=50)
```
The comment `# 'user' or 'bot'` is the only contract, and comments are not constraints. `JournalTag` is a `StrEnum` but the column type is plain `str`, so the ORM happily persists any value a Python `.insert()` call writes.

**Fix:** Define a `class Sender(StrEnum): USER = "user"; BOT = "bot"` and switch the column to `sender: Sender = Field(sa_column=Column(String(10), nullable=False))`, plus a `__table_args__ = (CheckConstraint("sender IN ('user', 'bot')", name="ck_journalentry_sender"),)`. Do the same for `tag` against `JournalTag`. Add a composite index `(user_id, timestamp DESC)` for the chat-history query and a partial index `(user_id) WHERE sender = 'bot'` for the BotMason cost rollup — both are load-bearing for the journal feature's hot paths and are missing today.

---

### BUG-MODEL-005: `datetime` defaults are correct but every `stage_started_at` / `timestamp` relies on app-layer clock — no `server_default=func.now()`
**Severity:** Low
**Component:** `backend/src/models/stage_progress.py:24-27`, `backend/src/models/goal_completion.py:27-30`, `backend/src/models/practice_session.py:18-21`, `backend/src/models/journal_entry.py:41-44`, `backend/src/models/prompt_response.py:27-30`, `backend/src/models/content_completion.py:15-18`, `backend/src/models/login_attempt.py:21-24`, `backend/src/models/llm_usage_log.py:31-34`, `backend/src/models/user.py:38-47`
**Symptom:** Every timestamp column uses `default_factory=lambda: datetime.now(UTC)` on the Python side and correctly sets `DateTime(timezone=True)` on the SQLAlchemy side. Good — that fixes the naive-datetime class of bugs (cross-link BUG-DB-002). However, **none** of the columns set a `server_default=func.now()`, which means any direct-SQL insert (a data migration, a seed script, a `psql` one-liner, an admin backfill) that doesn't name the column will get `NULL` — and every one of these columns is `nullable=False`, so the insert fails with `NotNullViolation`. More subtly, relying solely on app-side clocks means timestamps can drift between servers (each FastAPI worker's clock) and between the app and DB (Postgres clock), producing out-of-order rows in the rare case of clock skew. For `LoginAttempt.created_at` in particular, whose lockout window is keyed off `created_at >= now() - interval '15 min'`, clock drift across workers produces false positives / false negatives in the lockout check.
**Root cause:**
```python
# e.g. stage_progress.py
stage_started_at: datetime = Field(
    default_factory=lambda: datetime.now(UTC),
    sa_column=Column(DateTime(timezone=True), nullable=False),
)
# no server_default=func.now()
```
`default_factory` only fires when SQLAlchemy builds the INSERT through the ORM. A raw `INSERT INTO stageprogress (user_id, current_stage, completed_stages) VALUES (...)` executed via `connection.execute(text(...))` — which happens in Alembic data migrations — produces no value for `stage_started_at`, so the DB rejects the row. Having `server_default=sa.func.now()` would let the DB fill it transparently, and would keep all timestamps on a single clock.

**Fix:** For every `datetime` column with `default_factory=lambda: datetime.now(UTC)`, add `server_default=sa.func.now()` to the `Column(...)` call: `Column(DateTime(timezone=True), nullable=False, server_default=func.now())`. Keep the Python `default_factory` as a belt-and-braces fallback so tests that bypass the DB still get a value. Emit a single Alembic migration that `ALTER COLUMN ... SET DEFAULT now()` for each one — it's a metadata-only change, no table rewrite. Add a test that inserts a row via raw SQL without the timestamp and asserts the row round-trips with a non-null value.

---


---

## Pydantic schemas (habit / goal / journal / checkin / admin / pagination) — `backend/src/schemas/**`

### BUG-SCHEMA-001: `Habit` response schema leaks `user_id`, contradicting the pattern established for journal entries
**Severity:** Medium
**Component:** `backend/src/schemas/habit.py:19-39`
**Symptom:** Every habit fetched via `GET /habits` or `GET /habits/{id}` includes the owner's surrogate `user_id` in the payload. The client already knows its own identity from the auth token, so echoing `user_id` back only aids enumeration if a habit ID is ever leaked across users (or confused-deputy bugs surface). The journal schema explicitly strips `user_id` for exactly this reason (see `JournalMessageResponse` comment referencing BUG-JOURNAL-004), but `Habit` leaks it unconditionally.
**Root cause:**
```python
class Habit(BaseModel):
    id: int
    user_id: int            # <-- leaked on every response
    name: str
    icon: str
    ...
```
The `Habit` response model is used both as the wire representation and as a direct mirror of the ORM row. No `HabitResponse` variant exists that would scrub `user_id`, so every list and detail endpoint returns the owner ID to the only party that already knows it, while risking cross-user disclosure if authorization regresses.

**Fix:** Split into `HabitRead` (no `user_id`) for wire responses and keep `Habit` as an internal model, mirroring the `JournalMessageCreate` / `JournalMessageResponse` split. Update the router to serialise via `HabitRead.model_validate(habit)` and add a regression test asserting `"user_id" not in response.json()`.

---

### BUG-SCHEMA-002: `Milestone` schema is a one-field stub — callers cannot distinguish achieved from pending, or tie it to a goal
**Severity:** High
**Component:** `backend/src/schemas/milestone.py:1-9`, `backend/src/schemas/checkin.py:17-20`
**Symptom:** `CheckInResult.milestones: list[Milestone]` is returned on every check-in. The frontend renders milestone toasts from this list, but the schema exposes only an integer threshold — there is no `achieved_at`, no `goal_id`, no label, and no `tier`. Two callers hitting the same check-in endpoint cannot tell which goal each milestone belongs to, and `Config.extra` defaults to `"ignore"`, so if the domain layer starts returning richer objects they are silently truncated to `{threshold}` on the wire.
**Root cause:**
```python
class Milestone(BaseModel):
    threshold: int
```
That is the entire file. The check-in flow and the habit-stats flow both surface milestones to the client, but the wire shape has no way to identify *which* milestone or *when* it was hit. Any future enrichment (badge icon, narrative copy, `goal_id`) is silently dropped by Pydantic unless callers remember to widen this schema.

**Fix:** Replace with the full product shape — at minimum `goal_id: int`, `threshold: int`, `achieved_at: datetime`, `label: str`, and `tier: GoalTier` — and add `model_config = ConfigDict(extra="forbid")` so future drift raises instead of silently truncating. Add a schema test that round-trips a populated milestone through `model_dump()`.

---

### BUG-SCHEMA-003: `CheckInResult.reason_code` is an unconstrained `str` — enum drift hides typos and breaks the client switch
**Severity:** High
**Component:** `backend/src/schemas/checkin.py:17-20`
**Symptom:** The frontend branches on `reason_code` to decide which toast/animation to render (`"already_checked_in"`, `"new_streak"`, `"milestone_hit"`, etc.). The schema types it as a bare `str` with no `Literal`, no enum, and no validator, so a backend typo (`"milesone_hit"`) serialises cleanly, the client's `switch` falls through to the default branch, and the user silently loses the milestone celebration. There is also no discovery mechanism — the OpenAPI spec documents "string" and nothing else.
**Root cause:**
```python
class CheckInResult(BaseModel):
    streak: int
    milestones: list[Milestone] = []
    reason_code: str          # <-- any string, no validation, no enum
```
The domain layer in `backend/src/domain/streaks.py` already emits a fixed vocabulary of reason codes; the schema does not reflect that, so callers get zero type safety and the OpenAPI schema exported to the frontend is unusable for codegen.

**Fix:** Introduce `class CheckInReasonCode(StrEnum)` in `domain/` with the canonical set of values and type the field as `reason_code: CheckInReasonCode`. Pydantic will then reject unknown codes at serialisation time, the OpenAPI schema gains an enum, and the frontend can codegen an exhaustive switch.

---

### BUG-SCHEMA-004: `HabitCreate` accepts empty icon and unbounded notification arrays — client can post megabyte-scale payloads
**Severity:** Medium
**Component:** `backend/src/schemas/habit.py:48-65`
**Symptom:** `HabitCreate` applies `max_length` to `name` and `icon` but no `min_length` on `icon`, no length caps on the `notification_times` / `notification_days` list, and no per-element length cap on those string items. A client can POST `{"icon": "", "notification_times": ["00:00"] * 100_000, "notification_days": ["x" * 1000] * 100_000}` and the request is accepted by Pydantic, flowing all the way to the `PG_ARRAY(String)` column in `models/habit.py`. Nothing validates that `notification_times` entries are `HH:MM` strings or that `notification_days` entries are valid weekdays either.
**Root cause:**
```python
class HabitCreate(BaseModel):
    name: str = Field(min_length=1, max_length=HABIT_NAME_MAX_LENGTH)
    icon: str = Field(max_length=HABIT_ICON_MAX_LENGTH)      # no min_length
    ...
    notification_times: list[str] | None = None               # no list bound, no regex
    notification_frequency: NOTIFICATION_FREQUENCY | None = None
    notification_days: list[str] | None = None                # no list bound, no enum
```
The ORM column `notification_times` is a `PG_ARRAY(String)` — Postgres will happily take anything, so the schema is the only line of defence and it has none for length or content.

**Fix:** Add `min_length=1` to `icon`, constrain lists with `Field(max_length=24)` on `notification_times` and `max_length=7` on `notification_days`, and add `@field_validator` helpers that enforce the `HH:MM` regex and a `{"mon", "tue", ..., "sun"}` enum respectively. Reject unknown values with 422.

---

### BUG-SCHEMA-005: `JournalListResponse` is a paginated-looking envelope that never echoes `limit`/`offset`, breaking deterministic replay
**Severity:** Medium
**Component:** `backend/src/schemas/journal.py:57-63`, `backend/src/schemas/pagination.py:41-45`
**Symptom:** Journal listing uses a bespoke envelope (`items`, `total`, `has_more`) that diverges from the canonical `Page[T]` envelope in `pagination.py` (`items`, `total`, `limit`, `offset`, `has_more`). Because `limit` and `offset` are not echoed back, the client cannot safely retry or deep-link to a page — if the caller omitted `limit`, it has no way to know which default page size the server applied, and pagination drifts when the default is tuned server-side. The two envelope shapes also force the frontend to maintain two decoders for the same concept.
**Root cause:**
```python
class JournalListResponse(BaseModel):
    """Paginated list of journal entries."""

    items: list[JournalMessageResponse]
    total: int
    has_more: bool            # <-- no limit, no offset echoed
```
Compare with the canonical envelope one file over:
```python
class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    limit: int
    offset: int
    has_more: bool
```
`JournalListResponse` predates (or bypasses) the shared `Page[T]` envelope and silently drops the request parameters, so paginated clients cannot reconstruct the exact page they received.

**Fix:** Delete `JournalListResponse` and have the journal router return `Page[JournalMessageResponse]` via `build_page(items, total, params)`. This unifies the wire shape across endpoints, restores `limit`/`offset` echo, and eliminates the duplicate envelope decoder on the frontend.

---


---

## Pydantic schemas (practice / course / botmason / energy / prompt / stage) — `backend/src/schemas/**`

### BUG-SCHEMA-006 — `StageProgressUpdate.current_stage` accepts unbounded integers, enabling instant progression to stage 36 (Severity: Critical)

**Component:** `backend/src/schemas/stage.py:38-41` (class `StageProgressUpdate`)

**Symptom:** A client can POST `{"current_stage": 36}` (or `999`, or `-1`) on day one and skip the entire 36-week program. The Pydantic schema applies no bounds, so the router receives the value and writes it to the user's progress row. This is a direct privilege/content-gate bypass — the stage-unlock system is the spine of the whole APTITUDE experience.

**Root cause:**
```python
class StageProgressUpdate(BaseModel):
    """Payload for updating current stage."""

    current_stage: int
```

No `Field(ge=1, le=36)`, no `model_config = ConfigDict(extra="forbid")`, no cross-validation against `CourseStage.stage_number` or the user's earned progress. `practice.py` already defines `MAX_STAGE_NUMBER = 36` — the same constant is not applied here. Negative values and `0` will also pass Pydantic validation and then either poison the UI or crash downstream comparisons.

**Fix:** Add `current_stage: int = Field(ge=1, le=MAX_STAGE_NUMBER)` (lift the constant into a shared `schemas/_constants.py` or re-import from `practice`). Additionally, the router — not the schema — must verify the requested stage is actually unlocked for the user; the schema only guards the integer range. Add `model_config = ConfigDict(extra="forbid")` to reject unknown keys so future refactors don't silently ignore typos like `currentStage`.

**Cross-references:** BUG-DB series (stage progression integrity).

---

### BUG-SCHEMA-007 — `EnergyPlanRequest` lets the client supply `Habit` rows with arbitrary `energy_cost`/`energy_return` and an unbounded list (Severity: High)

**Component:** `backend/src/schemas/energy.py:10-29` (classes `Habit`, `EnergyPlanRequest`)

**Symptom:** The energy planner is driven entirely by client-supplied numbers — the endpoint accepts a list of `Habit` objects with whatever `energy_cost` and `energy_return` the caller wants to send, and the list has no upper length. A malicious or buggy client can (a) game the planner's `net_energy` output, (b) submit thousands of habits per call and burn CPU in the planning solver, or (c) reference `habit_id` values that do not belong to the user.

**Root cause:**
```python
class Habit(BaseModel):
    id: int
    name: str
    energy_cost: int
    energy_return: int


class EnergyPlanRequest(BaseModel):
    habits: list[Habit]
    start_date: date
```

No `ge=0` / `le=<cap>` on `energy_cost` or `energy_return`, no `min_length=1` / `max_length=N` on `habits`, no `model_config = ConfigDict(extra="forbid")`, and — more fundamentally — energy costs should be fetched from the server's habit rows, not trusted from the client. The "Partial" shape the frontend sends (see BUG-API-020) flows straight through because the schema is lenient.

**Fix:** Change `EnergyPlanRequest` to accept only `habit_ids: list[int] = Field(min_length=1, max_length=50)` and `start_date: date`; the router loads the authoritative `energy_cost`/`energy_return` from the DB scoped to the authenticated user. If the planner truly needs the client to pass costs (e.g., for hypothetical planning), keep them but add `Field(ge=0, le=1000)` and an explicit `max_length=50` on the list. Add `extra="forbid"` to both models.

**Cross-references:** BUG-API-020.

---

### BUG-SCHEMA-008 — `PracticeSessionCreate.timestamp` is client-controlled with no lower bound, allowing unlimited back-dating of sessions (Severity: High)

**Component:** `backend/src/schemas/practice.py:88-105` (class `PracticeSessionCreate`)

**Symptom:** The session-log schema rejects future timestamps but happily accepts `timestamp = "1970-01-01T00:00:00Z"` or any other past date. Users can retroactively fabricate practice history — inflating streaks, stage progress, and any analytics/BotMason context derived from session cadence. Combined with the missing `model_config = ConfigDict(extra="forbid")`, clients can also smuggle in fields like `user_id` or `computed_score` that a future handler might trust.

**Root cause:**
```python
class PracticeSessionCreate(BaseModel):
    user_practice_id: int
    duration_minutes: float = Field(gt=0, le=MAX_DURATION_MINUTES)
    reflection: str | None = Field(default=None, max_length=PRACTICE_REFLECTION_MAX_LENGTH)
    timestamp: datetime | None = None

    @field_validator("timestamp")
    @classmethod
    def reject_future_timestamp(cls, v: datetime | None) -> datetime | None:
        if v is not None and v > datetime.now(UTC):
            msg = "timestamp cannot be in the future"
            raise ValueError(msg)
        return v
```

The validator only guards the upper edge. There is no lower bound (e.g. "not earlier than the `UserPractice.start_date`"), no timezone requirement (naive datetimes will be accepted and then compared against aware `datetime.now(UTC)` — this already raises `TypeError` today, masking user input as a 500), and no `extra="forbid"`.

**Fix:** Either (1) drop the `timestamp` field entirely and let the server stamp it with `datetime.now(UTC)` on insert — this is the right default for the "log a session I just finished" UX, or (2) keep it but also enforce `v >= user_practice.start_date` in the router (schema can't see cross-table state) and require `v.tzinfo is not None` in the validator. Add `model_config = ConfigDict(extra="forbid")` on every `*Create` schema in this file.

**Cross-references:** BUG-DB-002 (naive-datetime columns amplify the timezone half of this bug).

---

### BUG-SCHEMA-009 — `BalanceAddRequest.amount` is unbounded and unsigned-checked, letting a client mint arbitrary BotMason credits (Severity: Critical)

**Component:** `backend/src/schemas/botmason.py:40-50` (class `BalanceAddRequest`)

**Symptom:** The only validation on `amount` is that it is an `int`. A client can POST `{"amount": 2_000_000_000}` and the wallet adds two billion credits; they can also POST a negative amount and (depending on the router) either subtract someone else's balance or wrap into a very large positive after an unchecked addition. Either outcome is a monetization/trust failure and — because the BotMason `ChatResponse` exposes `remaining_balance` — it is trivially exploitable and immediately visible.

**Root cause:**
```python
class BalanceAddRequest(BaseModel):
    """Request to add credits to a user's offering balance."""

    amount: int
```

No `Field(ge=1, le=<server-side purchase cap>)`, no `model_config = ConfigDict(extra="forbid")`, and no indication that this endpoint should be restricted to a server-to-server webhook (payments provider) rather than a user-authenticated route. `ChatRequest` has `min_length`/`max_length` discipline; the credit path does not — which is exactly backwards from a security standpoint.

**Fix:** Replace with `amount: int = Field(ge=1, le=10_000)` (or whatever the largest legitimate single purchase is) and require that the route itself is gated by either an admin role or an HMAC-signed payment webhook. Add `extra="forbid"` so clients cannot sneak extra fields like `user_id` to credit someone else's account. `ChatResponse.remaining_balance`/`remaining_messages` being client-visible is fine — but only if the *input* side is locked down.

---

### BUG-SCHEMA-010 — Free-form `str` fields across course/stage/practice schemas leak internal IDs and allow enum drift from the ORM (Severity: Medium)

**Component:** `backend/src/schemas/course.py:10-37`, `backend/src/schemas/stage.py:10-27`, `backend/src/schemas/practice.py:20-30` (classes `ContentItemResponse`, `ContentCompletionResponse`, `StageResponse`, `PracticeResponse`)

**Symptom:** Several response schemas expose internal primary keys and typed-but-untyped strings to the client: `ContentCompletionResponse` returns both `id` (the completion row's PK) and `user_id` (echoing the caller's own ID back, an unnecessary sink for PII in logs/analytics); `StageResponse` exposes `category`, `aspect`, `spiral_dynamics_color`, `growing_up_stage`, `divine_gender_polarity`, and `relationship_to_free_will` as bare `str`; `ContentItemResponse.content_type` is a bare `str`; `PracticeResponse.submitted_by_user_id` leaks author identity. Any of these can silently drift from the ORM enum (missing value, typo, rename) without the schema layer catching it, and the frontend has no type-safe switch statement to rely on.

**Root cause:**
```python
class StageResponse(BaseModel):
    ...
    category: str
    aspect: str
    spiral_dynamics_color: str
    ...

class ContentItemResponse(BaseModel):
    ...
    content_type: str
    ...

class ContentCompletionResponse(BaseModel):
    id: int
    user_id: int
    content_id: int
    completed_at: datetime

class PracticeResponse(BaseModel):
    ...
    submitted_by_user_id: int | None = None
    approved: bool
```

`content_type`, `category`, `aspect`, `spiral_dynamics_color`, etc. should be `Enum`s (or `Literal[...]`) imported from the model layer so the Pydantic → OpenAPI → TypeScript pipeline carries the closed set. `ContentCompletionResponse.user_id` is redundant (the caller authenticated as that user) and `id` is a leaky internal row number. `submitted_by_user_id` should be replaced with a non-identifying `submitted_by_display_name` or omitted for non-admin responses.

**Fix:** (1) Define shared `Enum`s in `backend/src/models/` (or `schemas/_enums.py`) for `ContentType`, `StageCategory`, `SpiralDynamicsColor`, etc. and reference them from both the SQLModel ORM and the Pydantic response schema. (2) Drop `user_id` and `id` from `ContentCompletionResponse` (return `{"content_id": ..., "completed_at": ...}`). (3) Hide `submitted_by_user_id` behind an admin-only schema variant; regular users get `approved: bool` and nothing else about authorship. (4) While touching these files, add `model_config = ConfigDict(from_attributes=True, extra="forbid")` consistently — right now `extra` defaults to `"ignore"` everywhere, which is inconsistent with the security posture implied by the other bugs in this fragment.

**Cross-references:** BUG-API-020 (lenient `[key: string]` response shapes on the frontend side are the mirror of this laxity).


---

## Suggested Remediation Order

1. **BUG-SCHEMA-009** (Critical — credit minting) — minutes. Add `Field(ge=1, le=10_000)` and admin-only gating. Must land before any public BotMason launch.
2. **BUG-SCHEMA-006** (Critical — stage bypass) — minutes. Add `Field(ge=1, le=MAX_STAGE_NUMBER)` and make the router re-verify against actual progression; cross-check `practice.MAX_STAGE_NUMBER`.
3. **BUG-MODEL-001** (High — lifecycle flags) — one migration + router updates. Blocks the "can't disable abusive account" scenario and the admin-gating story.
4. **BUG-MODEL-002 / BUG-DB-003** (High — FK cascades) — single Alembic migration rewriting every `user.id` FK. Pair with a "delete my account" integration test.
5. **BUG-SCHEMA-007** (High — energy economy) — validate `habit_id` ownership server-side; hydrate `energy_cost`/`energy_return` from the DB, ignore client-supplied values; cap list length to e.g. 200.
6. **BUG-SCHEMA-008** (High — backdated sessions) — drop client `timestamp` or clamp `ge=now()-24h, le=now()+5m`; parallels BUG-DB-002.
7. **BUG-SCHEMA-002 / BUG-SCHEMA-003** (High — validation vocabulary) — promote `reason_code` to an `Enum`, flesh out `Milestone`.
8. **BUG-SCHEMA-001 / BUG-SCHEMA-010** (Medium — response leaks) — sweep response DTOs, strip `user_id` / `submitted_by_user_id`. Apply `model_config = ConfigDict(extra="forbid")` consistently across request DTOs.
9. **BUG-SCHEMA-004 / BUG-SCHEMA-005** (Medium — input caps / pagination) — `min_length`/`max_length` on `HabitCreate`; migrate `JournalListResponse` to the shared `Page[T]` envelope.
10. **BUG-MODEL-003 / BUG-MODEL-004 / BUG-MODEL-005** (Medium/Low) — alphabetize-safe imports, `sender` as Literal, `server_default=func.now()` on every timestamp column.

## Cross-References

- **BUG-AUTH-001** (backend signup returns dummy token) — paired with BUG-MODEL-001 (no `email_verified` flag means we cannot gate the dummy-token path behind "verified only").
- **BUG-AUTH-018** (no admin check on admin endpoints) — paired with BUG-MODEL-001 (no `is_admin` column to check).
- **BUG-DB-001** (case-sensitive email uniqueness) — schema side is the missing `EmailStr` coercion to `lower()` in `UserCreate`.
- **BUG-DB-002** (timestamp race on sessions) — mirrored by BUG-SCHEMA-008 client-supplied `timestamp`.
- **BUG-DB-003** (Alembic FK definitions lack `ondelete`) — mirrored in ORM by BUG-MODEL-002.
- **BUG-DB-007** (silent bulk reassign on duplicate emails) — pairs with BUG-MODEL-001 (no `deleted_at`).
- **BUG-API-016** (Zod `authResponseSchema` accepts `user_id=0`) — client-side mirror of the missing `Field(ge=1)` on server `UserCreateResponse` / `AuthResponse`.
- **BUG-API-018** / **BUG-API-020** (lenient EnergyPlanRequest / partial shapes) — client-side mirror of BUG-SCHEMA-007.
- **BUG-APP-006** (rate-limit trust of `X-Forwarded-For`) — pairs with BUG-MODEL-001: once `is_admin` exists, admin actions should still be rate-limited but with a higher ceiling.
- **BUG-NAV-001** (RootNavigator flips on null token) — downstream of `BUG-AUTH-*` + BUG-MODEL-001 (half-provisioned users).
