# Prompt 07 — Normalize IDOR ordering + strip `user_id` from responses (Wave 3, parallelizable)

## Role
You are a backend engineer focused on authorization boundaries. You know that "404 before 403" is an information leak: a responder that returns 404 for missing rows but 403 for wrong-owner rows lets an attacker enumerate resource IDs.

## Goal
Normalize every feature router to the same pattern: resolve the row, authorize against `current_user.id`, return 403 for any cross-user access (never 404). Strip `user_id` from response DTOs. Enforce ownership on shared templates.

Success criteria:

1. Every `GET /resource/{id}`, `PATCH /resource/{id}`, `DELETE /resource/{id}` uses the same dependency that: (a) resolves the row or raises 404; (b) authorizes or raises 403 — both distinct branches, never merged.
2. Response DTOs never expose `user_id`. A shared base schema excludes it.
3. "Shared templates" (goal groups) cannot be mutated by non-owners; ownership check is tested.
4. An attacker probing N IDs cannot distinguish "not mine" from "does not exist" for any resource — always 403 for cross-user, 404 only for genuinely missing rows.
5. Zero regressions in existing access-control tests; add a new integration test file `tests/security/test_idor.py` with a matrix across every resource type.

## Context
- `prompts/2026-04-18-bug-remediation/14-course-stages-progression.md` — **BUG-COURSE-004** (`mark_content_read` returns 404 before 403).
- `prompts/2026-04-18-bug-remediation/12-journal.md` — **BUG-JOURNAL-002** (same pattern on journal entries), **BUG-JOURNAL-004** (`JournalMessageResponse` leaks `user_id`).
- `prompts/2026-04-18-bug-remediation/09-habits-streaks.md` — **BUG-HABIT-001** (habit response leaks `user_id`).
- `prompts/2026-04-18-bug-remediation/10-goals-completions-groups.md` — **BUG-GOAL-005** (`create_goal_group` double-applies client `user_id`), **BUG-GOAL-006** (shared templates editable/deletable by any user).
- `prompts/2026-04-18-bug-remediation/11-practices-sessions.md` — **BUG-PRACTICE-001** (practice detail IDOR via unapproved submissions).

Files you will touch (expect ≤15): `backend/src/dependencies/ownership.py` (new), `backend/src/routers/{journal,course,habits,goals,practices}.py`, response schemas, new `backend/tests/security/test_idor.py`.

## Output Format
Three atomic commits:

1. `feat(backend): add ownership dependency + response DTO base (no user_id)` — shared pattern, no call-site changes yet.
2. `fix(backend): migrate habit/journal/course/goal/practice routers to ownership dep (BUG-COURSE-004, BUG-JOURNAL-002/-004, BUG-HABIT-001, BUG-GOAL-005/-006, BUG-PRACTICE-001)` — one commit covers all routers because the pattern is identical.
3. `test(backend): add IDOR probe matrix` — asserts 403 (not 404) for cross-user on every resource endpoint.

## Examples

Shared ownership dependency — **the `**kwargs` sketch below is SEMANTIC, not a drop-in.** FastAPI's DI resolves dependency parameters by name using function introspection; a bare `**kwargs` won't surface the path parameter. You have three working options — pick one:

```python
# backend/src/dependencies/ownership.py

# Option 1 (recommended): factory returns a dep whose signature is built dynamically.
from functools import partial

def require_owned(model: type[T], id_param: str = "resource_id"):
    async def dep(
        resource_id: int,  # name must match what the factory is asked to bind
        session: AsyncSession = Depends(get_session),
        user: User = Depends(get_current_user),
    ) -> T:
        row = await session.get(model, resource_id)
        if row is None:
            raise HTTPException(404, "Not found")
        if row.user_id != user.id:
            raise HTTPException(403, "Forbidden")
        return row
    # Rename the parameter so FastAPI binds the matching path param.
    dep.__annotations__ = {**dep.__annotations__, id_param: dep.__annotations__.pop("resource_id")}
    dep.__signature__ = inspect.Signature(
        parameters=[
            inspect.Parameter(id_param, inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=int),
            *list(inspect.signature(dep).parameters.values())[1:],
        ]
    )
    return dep

# Option 2: don't generalize — write one dep per resource type. Most straightforward.
async def require_owned_habit(
    habit_id: int,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> Habit:
    habit = await session.get(Habit, habit_id)
    if habit is None:
        raise HTTPException(404, "Not found")
    if habit.user_id != user.id:
        raise HTTPException(403, "Forbidden")
    return habit
# ...one per resource. Verbose but zero magic.

# Option 3: use Annotated + a generic authorize() helper invoked inside each route.
# This keeps dep magic minimal while still centralizing the 404/403 policy.
```

Pick Option 2 if the dynamic signature work in Option 1 feels fragile. The **important** invariant is the 404-then-403 ordering, not the meta-programming.

Router use (assumes Option 1 or 2):
```python
@router.patch("/habits/{habit_id}")
async def update_habit(
    payload: HabitUpdate,
    habit: Habit = Depends(require_owned_habit),
    session: AsyncSession = Depends(get_session),
) -> HabitPublic:
    # habit is guaranteed to be owned by current_user.
    ...
```

Public response schema (no `user_id`):
```python
class HabitPublic(BaseModel):
    id: int
    title: str
    # user_id NOT included.
    model_config = ConfigDict(from_attributes=True)
```

## Requirements
- `security`: assert 403 in tests, not `!= 200`. Ordering matters — the test must specifically fail if a future commit regresses to 404-before-403.
- For shared resources (goal group templates): owner can edit, non-owners get 403, everyone can GET if `is_shared=True`.
- `BUG-GOAL-005`: drop client `user_id` entirely from `create_goal_group` — take it from `current_user`.
- `max-quality-no-shortcuts`: do not add a `# type: ignore` to suppress type warnings on the dep factory. Pick Option 2 (per-resource dep) if Option 1's `inspect.Signature` rewrite trips mypy — Option 2 is explicit and passes cleanly.
- `pre-commit run --all-files` before each commit; coverage >=90%.
- Parallelizable with Prompts 04-06, 08-10. If Prompt 06's goal_completion migration touches a related router, rebase order: 06 first, 07 second.
