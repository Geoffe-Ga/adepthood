# Backend Database & Migrations Bug Report — 2026-04-18

**Scope:** `backend/src/database.py` (51 LOC — async engine, session factory, `get_session`), `backend/migrations/env.py` (133 LOC — Alembic env), 10 Alembic migrations under `backend/migrations/versions/` (1022 LOC combined).

**Total bugs:** 10 — **2 Critical / 5 High / 3 Medium / 0 Low**.

## Executive summary

This report covers two surfaces that compound each other:

1. **Schema & engine defaults in `database.py` / `env.py` / the initial migration** were laid down with assumptions that later migrations are still paying down four versions later.
2. **The later migrations themselves** either ship data-loss downgrades, missing-pre-dedup `UNIQUE` indexes, un-validated CHECK constraints, or enum conversions that will fail on any real-world historical data.

Two Critical findings demand attention before the next deploy:

- **BUG-DB-001 (Critical)** — `user.email` UNIQUE index is case-sensitive. `alice@x.com` and `Alice@x.com` both succeed at signup, but login lower-cases input — one account becomes unreachable. Follow-up migration `e8376b41c6a1` exists precisely to patch this. This is one of the root causes of "I signed up but can't log in" alongside BUG-AUTH-001 and BUG-API-016.
- **BUG-DB-007 (Critical)** — The duplicate-email merge migration (`e8376b41c6a1`) bulk-reassigns child rows (userpractice, practicesession, journalentry, etc.) from duplicate users to the keeper with no dedup, no audit, and no user consent. Per-user data streams are silently merged; `f6a7b8c9d0e1`'s partial unique index will then fail on the real duplicates that were just created.

Five High findings cover TIMESTAMP-vs-TIMESTAMPTZ rewrites, missing FK ondelete clauses, goal-completion unique-index retrofitting without dedup, practice-duration integer truncation on downgrade, and enum conversion with no data normalisation. Three Medium findings address missing FK indexes, `env.py` autogenerate gaps, and un-validated CHECK constraints.

## Table of contents

| ID | Severity | Component | Title |
|----|----------|-----------|-------|
| BUG-DB-001 | Critical | `initial_schema:user.email` | Case-sensitive email UNIQUE — duplicate accounts possible; login lower-cases input and misses one |
| BUG-DB-002 | High     | `initial_schema:*.datetime_*` | Naive `DateTime` columns instead of `TIMESTAMPTZ` — tz comparisons break lockout/rate-limit logic |
| BUG-DB-003 | High     | `initial_schema` (FKs) | Zero `ondelete=` clauses on any FK — user deletion impossible without hand-rolled purge (GDPR blocker) |
| BUG-DB-004 | Medium   | `initial_schema` (FK indexes) | ~15 FK columns without covering indexes — seq scans on authenticated reads and cascade deletes |
| BUG-DB-005 | Medium   | `migrations/env.py` | Missing `compare_type=True`/`compare_server_default=True`; silent fallback to `alembic.ini` URL |
| BUG-DB-006 | High     | `a8b9c0d1e2f3_align_practice_duration_...` | Downgrade truncates fractional `default_duration_minutes` via `::integer` cast; promptresponse rows not restored |
| BUG-DB-007 | Critical | `e8376b41c6a1_unique_lower_email_index` | Bulk-reassigns duplicate users' child rows with no dedup or audit — silently merges per-user data |
| BUG-DB-008 | High     | `d4e5f6a7b8c9_goal_completion_unique_per_day_...` | Adds goalcompletion UNIQUE index with no pre-dedup and no `CONCURRENTLY`/`IF NOT EXISTS` |
| BUG-DB-009 | Medium   | `b2c3d4e5f6a7_goalgroup_shared_template_check` | CHECK constraint added without `NOT VALID`/`VALIDATE` split — takes ACCESS EXCLUSIVE, hard-fails on legacy data |
| BUG-DB-010 | High     | `c3d4e5f6a7b8_goal_tier_enum` | Enum CHECK added with no upstream normalisation; any legacy freeform tier value aborts upgrade |

---

## Critical, High & Medium — `database.py`, `env.py`, and initial schema

### BUG-DB-001: `user.email` uniqueness is case-sensitive, allowing duplicate accounts that differ only in case
**Severity:** Critical
**Component:** `backend/migrations/versions/145d340640ce_initial_schema.py:53-64`
**Symptom:** Two users can successfully sign up with `alice@example.com` and `Alice@example.com` (or any other case variant) because the unique index on `user.email` is a plain B-tree over the raw string. At login time, `_normalize_email` lower-cases the input, so one of the two accounts becomes permanently unreachable via the login form: the lookup resolves to whichever row the query planner returns first, and the other user is locked out even though signup "worked". It also opens an account-enumeration / impersonation vector — an attacker can register `Admin@foo.com` when `admin@foo.com` already exists. The follow-on migration `e8376b41c6a1_unique_lower_email_index.py` has to clean this up after the fact, but any production database that ran the initial schema first can already contain colliding rows that block the later migration from applying.

**Root cause:**
```python
sa.Column("email", sqlmodel.sql.sqltypes.AutoString(length=254), nullable=False),
...
op.create_index(op.f("ix_user_email"), "user", ["email"], unique=True)
```
The unique index is on the raw `email` column, not on `lower(email)`. Postgres treats `'alice@x.com'` and `'Alice@x.com'` as distinct values, so the `UNIQUE` constraint does not protect against case-variant duplicates. Citext was never considered, and no functional index was emitted.

**Fix:** Replace `op.create_index(..., unique=True)` in the initial migration with a functional unique index on `lower(email)` via `op.execute("CREATE UNIQUE INDEX ix_user_email ON \"user\" (lower(email))")`, and lower-case the value at write time in the ORM (overriding `__init__` / using a validator). For existing databases, a data-migration must collapse colliding rows before `e8376b41c6a1` can apply — otherwise the later `CREATE UNIQUE INDEX` will fail with `could not create unique index`. Add a regression test that signs up `A@x.com` and then expects `a@x.com` to 409.

---

### BUG-DB-002: Every `DateTime` column is naive (no timezone), silently dropping the offset on write
**Severity:** High
**Component:** `backend/migrations/versions/145d340640ce_initial_schema.py:49,58,61,126,153,167,234,253,268,293`
**Symptom:** All timestamp columns in the initial schema — `loginattempt.created_at`, `user.monthly_reset_date`, `user.created_at`, `promptresponse.timestamp`, `stageprogress.stage_started_at`, `contentcompletion.completed_at`, `goalcompletion.timestamp`, `practicesession.timestamp`, `journalentry.timestamp`, `llmusagelog.timestamp` — are created as bare `TIMESTAMP WITHOUT TIME ZONE`. A Python `datetime.now(tz=UTC)` persists correctly, but on read SQLAlchemy hands back a naive `datetime`, and any comparison against an aware value (e.g. the `datetime.now(UTC)` used in lockout and rate-limit logic) raises `TypeError: can't compare offset-naive and offset-aware datetimes`. Users in non-UTC regions hitting the login-attempt query therefore see 500s, and streak / energy calculations silently drift by whatever offset the writer assumed. Migration `78b1620cafde_convert_datetime_columns_to_timestamptz.py` exists specifically to fix this, confirming the initial schema was wrong — but any environment that ran on the initial schema for any length of time has already persisted timestamps under ambiguous semantics.

**Root cause:**
```python
sa.Column("created_at", sa.DateTime(), nullable=False),
...
sa.Column("timestamp", sa.DateTime(), nullable=False),
```
`sa.DateTime()` with no `timezone=True` resolves to Postgres `TIMESTAMP WITHOUT TIME ZONE`. The initial migration emits this for every temporal column without exception, across ten separate tables.

**Fix:** The initial migration should have used `sa.DateTime(timezone=True)` for every timestamp, producing `TIMESTAMPTZ`. For forward-only repair, the existing `78b1620cafde` must run before any production traffic that relies on tz math, and the SQLModel definitions in `backend/src/models/` need to be audited so that every `datetime` field carries `sa_column=Column(DateTime(timezone=True), ...)`. Add a migration-time assertion (or a test that introspects `information_schema.columns`) that fails CI if any `TIMESTAMP WITHOUT TIME ZONE` column slips in again.

---

### BUG-DB-003: No foreign keys specify `ON DELETE` behaviour, so deleting a user fails or orphans rows
**Severity:** High
**Component:** `backend/migrations/versions/145d340640ce_initial_schema.py:74-77,98-101,114-117,128-131,142-145,155-158,168-175,201-208,219-226,237-244,255-262,275-286,301-308`
**Symptom:** Every `ForeignKeyConstraint` in the initial schema omits `ondelete=`, which Postgres interprets as `NO ACTION` (equivalent to `RESTRICT` at statement end). Consequently, any attempt to `DELETE FROM "user" WHERE id=…` raises `ForeignKeyViolation` because `habit`, `goalgroup`, `practice.submitted_by_user_id`, `promptresponse`, `stageprogress`, `contentcompletion`, `userpractice`, `goalcompletion`, `practicesession`, `journalentry`, and `llmusagelog` all reference it without a cascade rule. GDPR/CCPA account-deletion flows therefore cannot be implemented without a hand-rolled, multi-statement purge; integration tests that try to `tearDown` by deleting test users hang or fail; and the later migration `e5f6a7b8c9d0_cascade_goal_habit_id.py` only patches one relationship (`goal.habit_id`), leaving the rest broken. Inversely, the `practice.submitted_by_user_id` relationship should probably be `ON DELETE SET NULL` (preserve community-submitted practices when the author leaves) — instead it's `RESTRICT`, meaning anyone who submits a practice can never be deleted.

**Root cause:**
```python
sa.ForeignKeyConstraint(
    ["user_id"],
    ["user.id"],
),
```
No `ondelete` argument anywhere in the file. The default is `NO ACTION`.

**Fix:** Edit the initial migration (or add a comprehensive `ondelete`-patching follow-up) so every user-owned table uses `ondelete="CASCADE"` (`habit`, `goalgroup`, `promptresponse`, `stageprogress`, `contentcompletion`, `userpractice`, `goalcompletion`, `practicesession`, `journalentry`, `llmusagelog`, `goal` via habit), `practice.submitted_by_user_id` uses `ondelete="SET NULL"`, and child tables (`stagecontent → coursestage`, `contentcompletion → stagecontent`, `goalcompletion → goal`, `practicesession → userpractice`, `journalentry → practicesession/userpractice`) use `CASCADE` or `SET NULL` per product intent. Add a test that deletes a user with full fixture data and asserts all dependent rows are gone.

---

### BUG-DB-004: Foreign-key columns lack covering indexes, causing sequential scans on every parent delete/update
**Severity:** Medium
**Component:** `backend/migrations/versions/145d340640ce_initial_schema.py:65-103,104-119,120-133,134-147,148-161,184-210,211-228,229-246,247-264,265-288,289-317`
**Symptom:** Postgres does not automatically index FK columns. The initial migration creates indexes only for `loginattempt.email`, `user.email`, `contentcompletion.user_id`, `contentcompletion.content_id`, and the five `llmusagelog.*` columns. The remaining ~15 FK columns (`goalgroup.user_id`, `habit.user_id`, `practice.submitted_by_user_id`, `promptresponse.user_id`, `stagecontent.course_stage_id`, `stageprogress.user_id`, `goal.habit_id`, `goal.goal_group_id`, `userpractice.user_id`, `userpractice.practice_id`, `goalcompletion.goal_id`, `goalcompletion.user_id`, `practicesession.user_id`, `practicesession.user_practice_id`, `journalentry.user_id`, `journalentry.practice_session_id`, `journalentry.user_practice_id`) are not indexed. Every application query that filters by `user_id` (which is essentially every authenticated endpoint — habits list, goal completions, journal load, practice sessions) therefore sequentially scans the table. Once BUG-DB-003 is fixed and cascades are turned on, parent deletes will also do FK-check seq scans, making account deletion O(n·tables).

**Root cause:**
```python
sa.ForeignKeyConstraint(["user_id"], ["user.id"]),
# ...no companion op.create_index on user_id...
```
Indexes are opt-in in SQLAlchemy (`index=True` on the column or an explicit `op.create_index`), and the autogenerated migration only emitted indexes where the SQLModel field declared `index=True`. The vast majority of FK fields didn't, so no indexes were created.

**Fix:** Add an index for every FK column in a follow-up migration (e.g. `op.create_index("ix_habit_user_id", "habit", ["user_id"])` …) and update the SQLModel definitions so future autogenerate emits them. Where queries filter by `(user_id, timestamp)` or similar (journal, goal completions, practice sessions, llm usage), prefer composite indexes. Add a lint check that fails the build if an FK column in `information_schema` lacks a covering index.

---

### BUG-DB-005: Alembic `env.py` silently falls back to `alembic.ini` when `DATABASE_URL` is missing and omits type/server-default comparison
**Severity:** Medium
**Component:** `backend/migrations/env.py:42-46,100-108`
**Symptom:** Two related problems in the Alembic environment:
1. When `DATABASE_URL` is unset, `run_async_migrations` reads `sqlalchemy.url` from `alembic.ini`. In production / staging / Railway that value is a dev default (or empty). A deploy with a missing env var therefore silently migrates the wrong database — often the developer's local one if the config leaked — or fails with an unhelpful connection error instead of failing closed with a clear "DATABASE_URL must be set" message.
2. `context.configure(...)` in `do_run_migrations` and `run_migrations_offline` does not pass `compare_type=True` or `compare_server_default=True`. As a consequence, `alembic revision --autogenerate` cannot detect column-type changes (e.g. `DateTime → DateTime(timezone=True)`, `String(50) → String(100)`) or `server_default` changes; autogenerate quietly produces empty migrations and the drift is shipped to prod. This directly enabled BUG-DB-002 to survive undetected — the naive-to-tz migration had to be written by hand.

**Root cause:**
```python
_db_url = os.getenv("DATABASE_URL")  # pragma: allowlist secret
if _db_url:
    config.set_main_option("sqlalchemy.url", normalize_database_url(_db_url))
...
def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        include_object=_include_object,
    )
```
`if _db_url:` is the only guard — when the env var is missing the code falls through to whatever `alembic.ini` contains. And `context.configure(...)` uses defaults for `compare_type` / `compare_server_default`, both of which are `False`.

**Fix:** Change the URL injection to fail closed outside development:
```python
_db_url = os.getenv("DATABASE_URL")  # pragma: allowlist secret
if not _db_url and os.getenv("ENV", "development") != "development":
    raise RuntimeError("DATABASE_URL must be set when running migrations outside development")
if _db_url:
    config.set_main_option("sqlalchemy.url", normalize_database_url(_db_url))
```
And pass `compare_type=True, compare_server_default=True` to both `context.configure(...)` calls so autogenerate catches type and default drift. Add a CI step that runs `alembic check` against the current HEAD — if models and migrations diverge, the build fails.

---

## Critical, High & Medium — Post-initial migrations

### BUG-DB-006: `default_duration_minutes` downgrade truncates fractional minutes
**Severity:** High
**Component:** `backend/migrations/versions/a8b9c0d1e2f3_align_practice_duration_and_promptresponse_unique.py:70-80`
**Symptom:** Running `alembic downgrade -1` silently rewrites every row in `practice` with a fractional default duration (e.g. `12.5`) to its truncated integer (`12`). The data is unrecoverable after the downgrade commits, and re-running the upgrade will never restore the lost precision. The migration's module docstring explicitly warns that "Postgres silently truncates fractional values" in the INTEGER column, yet the downgrade deliberately performs that exact truncation with no guardrail.
**Root cause:**
```python
def downgrade() -> None:
    """Revert column type and drop the unique constraint."""
    op.drop_constraint(_UNIQUE_CONSTRAINT, "promptresponse", type_="unique")
    op.alter_column(
        "practice",
        "default_duration_minutes",
        type_=sa.Integer(),
        existing_type=sa.Float(),
        existing_nullable=False,
        postgresql_using="default_duration_minutes::integer",
    )
```
The `USING ... ::integer` cast is a destructive narrowing conversion. The upgrade justifies the INTEGER→FLOAT direction as "a no-op cast — every existing integer is a valid float", but the reverse is not symmetric: every float in `(n, n+1)` for integer `n` collapses to `n`. Additionally, the promptresponse dedup in `upgrade()` (`DELETE FROM promptresponse WHERE id NOT IN (SELECT min(id) ...)`) is itself unreversed — the downgrade drops the unique constraint but the deleted rows are gone forever.

**Fix:** Either (a) refuse to downgrade when any fractional value exists (`SELECT 1 FROM practice WHERE default_duration_minutes != trunc(default_duration_minutes)` → raise) and document the restriction in the docstring, or (b) precede the `::integer` cast with an explicit `ROUND()` and log the affected row count via `op.get_bind().execute(...)` so the operator is made aware of the loss. For the promptresponse deletions, snapshot the rows into a `promptresponse_dedup_backup_a8b9c0d1e2f3` table inside `upgrade()` and restore from it in `downgrade()`.

---

### BUG-DB-007: `unique_lower_email` migration can corrupt `userpractice`/`practicesession` integrity during dedup
**Severity:** Critical
**Component:** `backend/migrations/versions/e8376b41c6a1_unique_lower_email_index.py:48-77`
**Symptom:** When two users collide on `lower(email)` (e.g. `Geoff@example.com` and `geoff@example.com`), the migration reassigns every child row from the duplicate account to the keeper. For `userpractice` this silently merges two parallel streams of practice history into one account; for `practicesession` and `journalentry` the FK to `userpractice` / `practicesession` can now reference a row whose `user_id` no longer matches (the merged parent row has the keeper's `user_id`, but the child row may point at a sibling session owned by the dupe). The result is cross-user data exposure: the keeper's practice/journal views will include rows authored by the deleted duplicate account, and FK-joined queries produce mixed-user results.
**Root cause:**
```python
_CHILD_TABLES: list[tuple[str, str]] = [
    ("habit", "user_id"),
    ("promptresponse", "user_id"),
    ("contentcompletion", "user_id"),
    ("userpractice", "user_id"),
    ("goalcompletion", "user_id"),
    ("practicesession", "user_id"),
    ("journalentry", "user_id"),
    ("llmusagelog", "user_id"),
    ("goalgroup", "user_id"),
    ("practice", "submitted_by_user_id"),
]

for table, col in _CHILD_TABLES:
    op.execute(
        f"{_DUPES_CTE}"
        f'UPDATE "{table}" SET {col} = dupes.keeper_id '
        f'FROM dupes WHERE "{table}".{col} = dupes.dupe_id'
    )
```
There is no validation that child rows belong to the same semantic scope, no audit of how many rows are being reassigned, and no dedup of child-level uniqueness. In particular, the subsequent migration `f6a7b8c9d0e1` adds `CREATE UNIQUE INDEX ... ON userpractice (user_id, stage_number) WHERE end_date IS NULL`; if the keeper and the duplicate each had an active user_practice on the same stage, merging them produces two active rows that the next migration's unique index will reject, hard-failing the entire `alembic upgrade head` chain.

**Fix:** Before reassigning, count duplicates and raise if any exist so the operator can reconcile manually, OR add per-table dedup logic that chooses the winner row deterministically (e.g. keep the most recent `userpractice` for each `(keeper_id, stage_number)` and delete the rest). Also wrap the entire upgrade in an advisory lock (`SELECT pg_advisory_xact_lock(...)`) and emit `RAISE NOTICE` counts via `op.get_bind().execute()` so dedup activity is auditable.

---

### BUG-DB-008: `CREATE UNIQUE INDEX` on `goalcompletion` has no pre-dedup and no `IF NOT EXISTS`
**Severity:** High
**Component:** `backend/migrations/versions/d4e5f6a7b8c9_goal_completion_unique_per_day_and_index.py:35-45`
**Symptom:** This migration exists precisely because the application was allowing duplicate completions (BUG-HABITS-015 / BUG-GOAL-005). Any production database with the bug has duplicate rows; the upgrade will abort with `ERROR: could not create unique index "ix_goal_completion_unique_per_day" ... Key (goal_id, user_id, ...) is duplicated`. The migration includes no dedup step and the `CREATE UNIQUE INDEX` is not `IF NOT EXISTS`, so a partial re-run after manual cleanup also fails. There is no `CONCURRENTLY` either, so the index build takes an `ACCESS EXCLUSIVE`-equivalent lock on `goalcompletion` for the entire duration.
**Root cause:**
```python
def upgrade() -> None:
    """Add unique-per-day constraint and compound performance index."""
    op.execute(
        f'CREATE UNIQUE INDEX "{_UNIQUE_PER_DAY_INDEX}" '
        "ON goalcompletion "
        "(goal_id, user_id, ((timestamp AT TIME ZONE 'UTC')::date))"
    )
    op.execute(
        f'CREATE INDEX "{_COMPOUND_INDEX}" '
        "ON goalcompletion (goal_id, user_id, timestamp)"
    )
```
A migration that enforces an invariant which the app previously violated must first clean the existing data; otherwise it cannot run on any real deployment.

**Fix:** Dedupe first inside the same upgrade transaction — keep the earliest completion per `(goal_id, user_id, utc_date)` and delete the rest, snapshotting deleted rows into `goalcompletion_dedup_backup_d4e5f6a7b8c9`. Then add `IF NOT EXISTS` to both `CREATE INDEX` statements for re-runnability. Finally, since `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, split into two migrations: a regular transactional one for the dedup + backup, then a second migration that sets `transactional_ddl = False` and builds both indexes with `CONCURRENTLY IF NOT EXISTS` to avoid the long lock on tables with millions of completions.

---

### BUG-DB-009: `goalgroup` CHECK constraint is added without `NOT VALID`, scanning the whole table under `ACCESS EXCLUSIVE`
**Severity:** Medium
**Component:** `backend/migrations/versions/b2c3d4e5f6a7_goalgroup_shared_template_check.py:27-33`
**Symptom:** `ALTER TABLE goalgroup ADD CONSTRAINT ... CHECK (...)` without `NOT VALID` forces Postgres to (a) take an `ACCESS EXCLUSIVE` lock on `goalgroup` and (b) scan every row to verify the predicate before releasing the lock. If any pre-existing row violates the invariant — which is likely, given the invariant was previously enforced only at the application layer (per the docstring: "A direct INSERT or future refactor could violate it") — the migration aborts with `CHECK constraint ... is violated by some row`, leaving the ALTER partially applied and the app blocked on writes to `goalgroup` until the lock is released.
**Root cause:**
```python
def upgrade() -> None:
    """Add CHECK constraint tying shared_template to user_id."""
    op.create_check_constraint(
        _CONSTRAINT_NAME,
        "goalgroup",
        "(shared_template = true AND user_id IS NULL) "
        "OR (shared_template = false AND user_id IS NOT NULL)",
    )
```
The idiomatic Postgres pattern for adding a CHECK on a populated table in production is a two-step: `ADD CONSTRAINT ... CHECK (...) NOT VALID` (cheap, takes a brief lock, does not scan) followed by `VALIDATE CONSTRAINT ...` (scans without the ACCESS EXCLUSIVE upgrade — SHARE UPDATE EXCLUSIVE only). Neither form is used here.

**Fix:** Split the upgrade into:
```python
op.execute(
    "ALTER TABLE goalgroup ADD CONSTRAINT ck_goalgroup_shared_template_user_id "
    "CHECK ((shared_template = true AND user_id IS NULL) "
    "OR (shared_template = false AND user_id IS NOT NULL)) NOT VALID"
)
# Separately, in a new migration that runs after data cleanup:
op.execute("ALTER TABLE goalgroup VALIDATE CONSTRAINT ck_goalgroup_shared_template_user_id")
```
Before the VALIDATE step, add a dedicated cleanup that either normalizes violating rows or surfaces them for manual triage — do not silently let a constraint rewrite production schema when rows may fail it.

---

### BUG-DB-010: `goal.tier` CHECK enum conversion can corrupt data on upgrade and strip context on downgrade
**Severity:** High
**Component:** `backend/migrations/versions/c3d4e5f6a7b8_goal_tier_enum.py:32-43`
**Symptom:** Before this migration, `goal.tier` is a free-form string (`Field(max_length=50)` per `backend/src/models/goal.py:44`). Any row whose tier is not exactly one of `'low'`, `'clear'`, `'stretch'` — e.g. `'LOW'`, `'Stretch'`, `'med'`, `'standard'`, or historic values seeded before the enum was introduced — causes the `ADD CONSTRAINT ... CHECK` to fail validation and abort the migration. Symmetrically, the `downgrade()` simply drops the constraint, so if an operator upgrades, backfills data that depends on the enum (e.g. the UI now renders tier colors by enum), then downgrades and re-upgrades, any rows manually edited to out-of-enum values between downgrade and re-upgrade will block the second upgrade. There is no data-normalization or audit step in either direction.
**Root cause:**
```python
def upgrade() -> None:
    """Add CHECK constraint on goal.tier."""
    op.create_check_constraint(
        _CONSTRAINT_NAME,
        "goal",
        "tier IN ('low', 'clear', 'stretch')",
    )


def downgrade() -> None:
    """Drop the tier CHECK constraint."""
    op.drop_constraint(_CONSTRAINT_NAME, "goal", type_="check")
```
The docstring acknowledges that the field "previously accepted any string" but provides no migration step to coerce surviving values into the new domain. The constraint is added in its default `VALID` form, so the table-wide scan happens under `ACCESS EXCLUSIVE` (same class of problem as BUG-DB-009) and any single nonconforming row kills the whole upgrade.

**Fix:** In `upgrade()`, first normalize existing data: `UPDATE goal SET tier = lower(trim(tier))` then either coerce/discard unknown values (e.g. `UPDATE goal SET tier = 'clear' WHERE tier NOT IN ('low', 'clear', 'stretch')`) with a row-count RAISE NOTICE for auditability, or `SELECT 1 FROM goal WHERE tier NOT IN (...)` and raise a clear alembic error listing the bad rows so the operator reconciles manually. Then add the constraint as `NOT VALID` first and `VALIDATE CONSTRAINT` separately. For `downgrade()`, capture a snapshot of any rows whose tier was normalized during upgrade into `goal_tier_backfill_c3d4e5f6a7b8` so the original values can be restored if a re-upgrade is needed.

---

## Suggested remediation order

1. **BUG-DB-001** — the case-insensitive email index is already being added by `e8376b41c6a1`, but the **merge logic in that migration (BUG-DB-007) must be hardened first**. Until then, the schema-level fix will fail on any real duplicates.
2. **BUG-DB-007** — rewrite `e8376b41c6a1` to: (a) detect duplicate-email groups, (b) require an operator-signed resolution manifest (which user keeps which child rows), (c) archive the non-keeper rows before re-parenting, (d) fail the upgrade rather than silently merging. Without this, any historical dataset with case-variant duplicate emails will fuse user identities at migration time.
3. **BUG-DB-008** — dedup `goalcompletion` before applying the UNIQUE index; add `IF NOT EXISTS` and use `CREATE UNIQUE INDEX CONCURRENTLY` to avoid the ACCESS EXCLUSIVE lock on production tables.
4. **BUG-DB-010** — normalise existing `goal.tier` values (lowercase, map unknown → a new `legacy_*` enum value or quarantine column) before the enum CHECK is enforced. Otherwise this migration will fail on legacy data.
5. **BUG-DB-003** — add `ondelete="CASCADE"` / `ondelete="SET NULL"` on every FK that should participate in user deletion. Unblocks GDPR and account-deletion flows.
6. **BUG-DB-002** — follow-up migration `78b1620cafde` already converts datetime columns to `TIMESTAMPTZ`. Audit the application code (lockout-window checks, rate-limit expiry, reminder scheduling) to ensure it now uses `datetime.now(tz=UTC)` not naive `datetime.utcnow()`.
7. **BUG-DB-009** — rewrite `b2c3d4e5f6a7` to use `op.execute("ALTER TABLE ... ADD CONSTRAINT ... CHECK (...) NOT VALID")` followed by `VALIDATE CONSTRAINT` in a separate transaction. Add a pre-check that reports any violating rows before the validate step.
8. **BUG-DB-006** — fix `a8b9c0d1e2f3` downgrade to preserve fractional minutes (keep as `NUMERIC` or round with `::numeric(10,2)`) and document that `promptresponse` dedup is not reversible.
9. **BUG-DB-005** — add `compare_type=True, compare_server_default=True` to `env.py`'s `context.configure(...)`; make `DATABASE_URL` required outside of `ENV=development`.
10. **BUG-DB-004** — add covering indexes on every FK column used for ORM filtering (`habit.user_id`, `goal.habit_id`, `journalentry.user_id`, `practicesession.user_practice_id`, `goalcompletion.goal_id`, etc.). Can run non-blocking via `CREATE INDEX CONCURRENTLY`.

## Cross-references

- **BUG-DB-001** is the schema-level root cause of the "I signed up but can't log in" chain, alongside **BUG-AUTH-001/002/016** (backend dummy-token response), **BUG-FE-AUTH-010** (AuthContext persists the dummy token), and **BUG-API-006/016** (client-side validation gaps). All five need coordinated fixes.
- **BUG-DB-002** amplifies **BUG-AUTH-011** (SECRET_KEY lazy validation) and lockout-table logic in **BUG-AUTH-003/004**: naive timestamps in `LoginAttempt.created_at` mean a server deployed in non-UTC container drift miscalculates the 15-minute lockout window.
- **BUG-DB-007** is the highest-risk data-integrity finding across all reports so far — any production run with case-variant duplicate emails will silently merge two users' journals, practice sessions, and habit histories. Flag to the user explicitly.
- **BUG-DB-008** pairs with **BUG-HABITS-015** (will be logged in report 09) — the duplicate-goal-completion bug that `d4e5f6a7b8c9` was written to fix.
- **BUG-DB-004** is a performance and resilience prerequisite for reports 09-14's per-resource findings — missing FK indexes cause the same latency regressions the product-surface reports will attribute to specific queries.
