# Prompt 03 — Close the skip-to-stage-36 chain (Stage 2, serial after Prompt 02)

## Role
You are a backend engineer guarding the integrity of a 36-stage curriculum. You think about progression gates the way a game designer thinks about level unlocks: trust nothing from the client, derive everything from server state, and validate the full chain, not just the immediate predecessor.

## Goal
Make it impossible for a user to jump past uncompleted stages. Six bugs across four routers collaborate to expose the skip; they must land atomically so the chain cannot be re-opened by a partial fix.

Success criteria:

1. `POST /stage/progress` (or equivalent) ignores any client-supplied `current_stage` and recomputes from `completed_stages` server-side.
2. `is_stage_unlocked(user, n)` requires every stage in `[1..n-1]` to be in `completed_stages` — not just `n-1`.
3. `POST /practice` rejects when `stage_number` does not match the user's current unlocked stage (not just "any stage the client passes").
4. `GET /prompts/{week}` returns 403 when `week` > user's current week; `POST /prompts/{week}/respond` does the same.
5. `_get_user_week` derives week from server-owned progression, never `max(week_number)+1`.
6. Frontend `Map` and `Course` screens fetch `current_stage` from backend truth, not `max(stage_number)` over local data.

## Context
Bug IDs and reports:
- `prompts/2026-04-18-bug-remediation/07-backend-models-schemas.md` — **BUG-SCHEMA-006** (`StageProgressUpdate.current_stage` unbounded, client-writable)
- `prompts/2026-04-18-bug-remediation/14-course-stages-progression.md` — **BUG-STAGE-001** (chain-skip exposure), **BUG-COURSE-001** (`list_stage_content` skips unlock check)
- `prompts/2026-04-18-bug-remediation/11-practices-sessions.md` — **BUG-PRACTICE-004** (`stage_number` not validated against user progression)
- `prompts/2026-04-18-bug-remediation/15-weekly-prompts.md` — **BUG-PROMPT-001** (`max(week)+1` + no unlock gate), **BUG-PROMPT-002** (leaks full curriculum)
- `prompts/2026-04-18-bug-remediation/17-frontend-features-practice-course-map.md` — **BUG-FE-MAP-001**, **BUG-FE-MAP-002**, **BUG-FE-COURSE-001**, **BUG-FE-COURSE-002**, **BUG-FE-PRACTICE-001**, **BUG-FE-PRACTICE-002**
- `prompts/2026-04-18-bug-remediation/04-frontend-api-client.md` — note any Zod schemas that must reject dummy `user_id=0` in stage/practice responses (**BUG-API-006**, **BUG-API-016** if not closed by Prompt 01).

Files you will touch (expect ≤15): `backend/src/routers/{stages,course,practices,prompts}.py`, `backend/src/domain/{stages,progression}.py`, `backend/src/schemas/{stage,prompt}.py`, `frontend/src/features/{Map,Course,Practice}/*.ts(x)`, frontend API types.

## Output Format
Five atomic commits in this order:

1. `fix(backend): chain-validate stage unlock (BUG-STAGE-001)` + test that asserts "stage 5 requires {1,2,3,4} all completed, not just {4}".
2. `fix(backend): server-derive stage progress, ignore client current_stage (BUG-SCHEMA-006)`.
3. `fix(backend): validate practice.stage_number against user progression (BUG-PRACTICE-004)` + gate `list_stage_content` (BUG-COURSE-001).
4. `fix(backend): gate weekly prompt endpoints on user_week (BUG-PROMPT-001/-002)`.
5. `fix(frontend): fetch current_stage from backend, gate Map/Course/Practice on it (BUG-FE-MAP/COURSE/PRACTICE-001/-002)`.

## Examples

Chain-validated unlock:
```python
def is_stage_unlocked(user: User, stage_number: int) -> bool:
    if stage_number == 1:
        return True
    required = set(range(1, stage_number))
    return required.issubset(set(user.completed_stages))
```

Server-derived stage update:
```python
@router.post("/stage/progress")
async def mark_stage_complete(
    payload: StageProgressUpdate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    # Ignore payload.current_stage entirely.
    next_stage = max(user.completed_stages, default=0) + 1
    if payload.completed_stage != next_stage:
        raise HTTPException(409, "Out-of-order stage completion")
    # ... append, commit, return derived current_stage.
```

## Requirements
- `bug-squashing-methodology`: write the failing test first for each BUG-ID.
- `security`: do not leak curriculum metadata for locked stages (`BUG-PROMPT-002` says the full 36-week curriculum is currently enumerable — prune the response to unlocked-plus-current).
- `max-quality-no-shortcuts`: no `# type: ignore` to silence new model drift.
- One commit per BUG-cluster keeps the diff reviewable.
- Do not deprecate or rename existing stage fields — evolve the schema additively.
- Run `pre-commit run --all-files` before each commit; keep coverage >=90%.
- Do not re-read reports 07/11/14/15/17 end-to-end — grep for each BUG-ID, read the block, act.
- Frontend changes depend on backend shipping first; land commits in order.
