# Phase 6-04: Optimize N+1 Queries

## Problem

`backend/src/domain/stage_progress.py:121-172` runs 26 individual queries for what should be 2-3 JOINs. For a user with 5 habits across 3 goal tiers:

- 1 query to fetch habits
- 5 queries to count completions per habit
- 5 queries to fetch goals
- 15 queries to count completions per goal
- **Total: 26 queries per request**

Additionally, eager loading (`selectinload`) is used inconsistently across routers:
- `habits.py:60-67` — properly eager-loads goals + completions
- `goal_groups.py:81-83` — loads goals but not completions
- `practices.py:26-32` — no eager loading at all

## Fix

### Stage Progress — Replace loop queries with JOINs

```python
# Before (26 queries):
for habit in habits:
    completion_count = await session.execute(select(func.count()).where(...))
    goals = await session.execute(select(Goal).where(...))
    for goal in goals:
        gc_count = await session.execute(select(func.count()).where(...))

# After (2 queries):
habit_stats = await session.execute(
    select(
        Habit.id,
        func.count(GoalCompletion.id).label("completion_count"),
    )
    .join(Goal, Goal.habit_id == Habit.id)
    .outerjoin(GoalCompletion, GoalCompletion.goal_id == Goal.id)
    .where(Habit.user_id == user_id, Habit.stage == stage_number)
    .group_by(Habit.id)
)
```

### Standardize Eager Loading

Create a shared `load_options.py` module:

```python
HABIT_WITH_GOALS = selectinload(Habit.goals).selectinload(Goal.completions)
GOAL_GROUP_WITH_GOALS = selectinload(GoalGroup.goals)
```

Use consistently in all routers.

## Acceptance Criteria

- [ ] Stage progress endpoint uses ≤3 queries regardless of habit/goal count
- [ ] All routers use shared eager-load options
- [ ] No lazy-load warnings in test output
- [ ] Response times verified (before/after benchmark)
- [ ] All existing tests pass

## Estimated Scope
~200 LoC
