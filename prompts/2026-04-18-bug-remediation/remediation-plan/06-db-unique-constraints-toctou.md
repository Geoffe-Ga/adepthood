# Prompt 06 — Replace check-then-insert with DB-level unique constraints (Wave 3, parallelizable)

## Role
You are a database engineer who treats uniqueness as a schema property, not an application pattern. You prefer `IntegrityError → 409` over `SELECT ... then INSERT`, because the DB is the only observer that sees both rows in the race.

## Goal
Collapse every "check for duplicate, then insert" pattern into a DB-level unique constraint plus exception handling. Five routers exhibit the bug with slightly different shapes; standardize them.

Success criteria:

1. Each table below has a unique constraint covering the dedup columns, added via reversible Alembic migration:
   - `users(lower(email))` — case-insensitive
   - `goal_completions(user_id, goal_id, date)` — one per day
   - `stage_progress(user_id, stage_number)` — one row per stage
   - `content_reads(user_id, content_id)` — read once per content
   - `practice_sessions(user_id, practice_id, stage_number)` — one active per stage (partial index on `is_active=true`)
   - `prompt_responses(user_id, week_number)` — one response per week
2. Migrations run a dedup step before the constraint (keep oldest row, archive duplicates into `_duplicates_<table>` for audit).
3. Application code drops the pre-check and relies on `IntegrityError` → `409 Conflict`.
4. Login lower-cases email consistently; signup stores lower-cased email; one case-mismatch regression test.
5. Account-lockout TOCTOU (BUG-AUTH-007) closed via row lock / `SELECT ... FOR UPDATE` OR via moving the check into the same transaction as the attempt increment.

## Context
- `prompts/2026-04-18-bug-remediation/06-backend-database-migrations.md` — **BUG-DB-001** (case-sensitive email UNIQUE), **BUG-DB-007** (bulk-reassign dedup user merge), **BUG-DB-008** (goalcompletion unique missing).
- `prompts/2026-04-18-bug-remediation/10-goals-completions-groups.md` — **BUG-GOAL-001** (duplicate daily completion TOCTOU).
- `prompts/2026-04-18-bug-remediation/14-course-stages-progression.md` — **BUG-STAGE-003** (first-advance create path not row-locked), **BUG-COURSE-002** (`mark_content_read` check-then-insert).
- `prompts/2026-04-18-bug-remediation/11-practices-sessions.md` — **BUG-PRACTICE-005** (single-active-practice TOCTOU).
- `prompts/2026-04-18-bug-remediation/15-weekly-prompts.md` — **BUG-PROMPT-004** (inconsistent 400/409 split on duplicate).
- `prompts/2026-04-18-bug-remediation/01-auth-signup-login.md` — **BUG-AUTH-003** (two accounts with same email — duplicate race), **BUG-AUTH-007** (TOCTOU in `_is_account_locked`).

Files you will touch (expect ≤18): 6 new Alembic migrations (one per table, small and reversible), 6 router methods updated, shared `backend/src/errors.py` mapping `IntegrityError` → `HTTPException(409, detail=...)`.

## Output Format
Six atomic commits (one per table/constraint). Each commit:

- Adds the migration (with dedup step + constraint + reversible downgrade).
- Updates the router to drop the pre-check and catch `IntegrityError`.
- Adds a concurrency test that fires two simultaneous inserts and asserts exactly one succeeds, one returns 409.

Commit order (lowest risk first):
1. `users(lower(email))` unique + login/signup normalization (BUG-DB-001, BUG-AUTH-003).
2. `goal_completions` unique (BUG-DB-008, BUG-GOAL-001).
3. `content_reads` unique (BUG-COURSE-002).
4. `prompt_responses` unique (BUG-PROMPT-004).
5. `practice_sessions` unique partial index (BUG-PRACTICE-005).
6. `stage_progress` row lock + unique (BUG-STAGE-003).

## Examples

Migration pattern:
```python
def upgrade() -> None:
    # 1. Dedup: move duplicate rows to archive.
    op.execute("""
        CREATE TABLE IF NOT EXISTS _duplicates_goal_completions AS
        SELECT * FROM goal_completions WHERE false;
        INSERT INTO _duplicates_goal_completions
          SELECT * FROM goal_completions gc
          WHERE gc.id NOT IN (
            SELECT MIN(id) FROM goal_completions
            GROUP BY user_id, goal_id, date
          );
        DELETE FROM goal_completions
          WHERE id IN (SELECT id FROM _duplicates_goal_completions);
    """)
    # 2. Add the constraint.
    op.create_index(
        "uq_goal_completion_user_goal_date",
        "goal_completions", ["user_id", "goal_id", "date"],
        unique=True,
    )

def downgrade() -> None:
    op.drop_index("uq_goal_completion_user_goal_date", "goal_completions")
```

Router pattern:
```python
try:
    session.add(GoalCompletion(user_id=user.id, goal_id=goal_id, date=today))
    await session.commit()
except IntegrityError as e:
    await session.rollback()
    raise HTTPException(409, detail="Already completed today") from e
```

## Requirements
- `security`: the dedup archive must not be user-readable.
- `max-quality-no-shortcuts`: no try/except swallowing — re-raise anything that isn't a uniqueness violation.
- Every migration `downgrade()` must round-trip on a sample DB — include a CI smoke or a note in the commit that you verified manually.
- Do NOT use `ON CONFLICT DO NOTHING` for cases where the client needs to know a duplicate happened — return 409.
- BUG-DB-007 (user merge) is the riskiest — if it needs coordination with account-deletion flow, stop and document; do not attempt in a single commit.
- `pre-commit run --all-files` before each commit; coverage >=90%.
- Parallelizable with 04, 05, 07, 08, 09, 10. Conflicts with Prompt 12 (backend feature remainders) — Prompt 06 lands first.
