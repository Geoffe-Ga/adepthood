# audit-testq-02: Replace hollow model tests with real schema assertions

**Labels:** `audit-testq`, `backend`, `testing`, `priority-high`
**Epic:** Test Quality & Green Baseline
**Estimated LoC:** ~400  (hard cap 700)

## Problem

`backend/tests/test_models.py:35-56` contains three tests that nominally guard
all 23 SQLModel ORM classes but assert only that each discovered object "is a
class", "has a `str` `__name__`", "has a `str` `__module__`", and that the count
is "> 0". **Current state:** §5.4 "test that doesn't test"
(`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:147`) — these assertions survive almost any
mutation to the models: renaming a column, flipping a field's nullability,
dropping a `foreign_key`, changing a `max_length`, or deleting a relationship
would all leave the suite green. The package has 23 real models carrying real
constraints (e.g. `Habit.user_id` is a `CASCADE` FK, `GoalCompletion.timestamp`
is a tz-aware non-null `DateTime`), none of which is pinned by a test.

## Scope

**Covers:** replacing the three hollow tests with concrete assertions for the
models that carry real, load-bearing constraints — table names, key field names
+ Python/SQL types, nullability, primary keys, unique/index constraints, foreign
keys (incl. `ondelete`), and relationships. Keep the existing
`test_no_runtime_side_effects_on_import` guard (it is a genuine, useful test).

**Does NOT cover:** adding new models or migrations; changing any model
definition; CRUD/round-trip DB tests (those live in router/service suites);
exhaustively re-asserting every trivial scalar on every model — focus on the
constraint-bearing surface that mutations would silently break.

## Tasks

1. **Inventory the constraint surface** — for the 23 models under
   `backend/src/models/`, list the load-bearing facts a mutation could break:
   `__tablename__`, primary keys, FKs + `ondelete` (e.g.
   `Habit.user_id` → `user.id` CASCADE at `models/habit.py:23`;
   `GoalCompletion.goal_id` → `goal.id` CASCADE at `models/goal_completion.py:24-26`),
   unique/partial indexes, nullability, `max_length`, and relationship
   back-populates pairs.
2. **Write per-model assertions** in `backend/tests/test_models.py` — use
   `Model.__table__` (SQLAlchemy) to assert column presence, `.nullable`,
   `.primary_key`, `.type` (class), `.foreign_keys` (target + `ondelete`), and
   `Model.__tablename__`. Parametrize where a table of (model, expectations)
   keeps it DRY; one focused test per model or per constraint group is fine.
   TDD: write the assertion, watch it pass on the current schema, then sanity-
   check it fails when you locally flip a nullability/FK.
3. **Pin relationships** — assert the SQLModel `Relationship` pairs exist and
   `back_populates` matches (e.g. `Habit.goals` ↔ `Goal.habit`,
   `GoalCompletion.goal` ↔ `Goal.completions`).
4. **Delete the three hollow tests** (`test_discovers_at_least_one_model`,
   `test_discovered_models_have_basic_metadata`, and the count/identity
   assertions) once real coverage replaces them; keep
   `test_no_runtime_side_effects_on_import`.

## Acceptance Criteria

- [ ] Each constraint-bearing model has at least one assertion on a concrete
      schema fact (table name, a typed/nullable/PK column, an FK with its
      `ondelete`, or a relationship pair) — verifiable by locally flipping one
      `nullable=`/`foreign_key=`/`max_length=` and watching a test go red.
- [ ] Tests assert exact constraint values (column name strings, type classes,
      `True`/`False` nullability, `"CASCADE"` ondelete), not identity-level facts
      like "is a class" — mutation-grade.
- [ ] No existing useful test breaks; the import side-effect guard remains;
      coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|---|---|
| `backend/tests/test_models.py` | Modify — delete the three hollow tests; add concrete per-model schema assertions |
