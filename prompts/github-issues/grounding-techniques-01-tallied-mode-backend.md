# grounding-techniques-01: Add `tallied_grounding` practice mode (backend)

**Labels:** `backend`, `feature`, `practice`
**Epic:** [Generalize grounding techniques](grounding-techniques-epic.md)
**Depends on:** none
**Estimated LoC:** ~250

## Role

You are a FastAPI / SQLModel engineer extending a discriminated-union
practice mode catalog. Your changes preserve all existing modes and
introduce one new mode value, validated end-to-end.

## Goal

Introduce a new `tallied_grounding` practice mode that captures the
"rounds × categories × target_count_per_category" shape shared by the
**Find Shapes** and **Find Colors** techniques. The mode must:

- Round-trip through `Practice.mode_config` JSON storage
- Validate at the API edge via Pydantic
- Pass the `practice.mode` `CHECK` constraint
- Emit a per-session metadata payload that records progress

## Context

Today the only step-based grounding mode is `sense_grounding`. Find
Shapes ("3 squares, 3 triangles, 3 circles, repeat 3×") and Find Colors
("one of each rainbow color, repeat 3×") are conceptually the same
shape:

```
rounds × [
  { key: "squares",   label: "a square",   target_count: 3 },
  { key: "triangles", label: "a triangle", target_count: 3 },
  { key: "circles",   label: "a circle",   target_count: 3 },
]
```

Existing migration that establishes the `mode` CHECK constraint:
`backend/migrations/versions/e9f0a1b2c3d4_practice_mode_and_mode_config.py`.
Adding a new value to `ALL_MODES` is necessary but not sufficient —
the constraint itself must be dropped and recreated in a new migration.

## Tasks

1. **Extend `PracticeMode` enum**
   - In `backend/src/domain/practice_modes.py`, add
     `TALLIED_GROUNDING = "tallied_grounding"`. This automatically
     extends `ALL_MODES`.

2. **Add `TalliedGroundingConfig` to `practice_mode_config.py`**
   - Define `TalliedCategory(_ConfigBase)` with fields:
     - `key: str` (slug, `min_length=1, max_length=64`, regex
       `^[a-z][a-z0-9_]*$`)
     - `label: str` (`min_length=1, max_length=255`)
     - `target_count: int` (`ge=1, le=20`)
   - Define `TalliedGroundingConfig(_ConfigBase)`:
     - `mode: Literal["tallied_grounding"] = "tallied_grounding"`
     - `rounds: int = Field(ge=1, le=10)`
     - `categories: list[TalliedCategory] = Field(min_length=1, max_length=12)`
     - `@model_validator(mode="after")` rejecting duplicate `key` across
       categories.
   - Add `TalliedGroundingConfig` to the `ModeConfig` `Annotated[... |
     ... ]` union.

3. **Add `TalliedGroundingMetadata` to `practice_session_metadata.py`**
   - Fields:
     - `mode: Literal["tallied_grounding"] = "tallied_grounding"`
     - `rounds_completed: int = Field(ge=0, le=10)`
     - `total_rounds: int = Field(ge=1, le=10)`
     - `items_completed: int = Field(ge=0, le=2400)` (cap = 10 rounds ×
       12 categories × 20 items)
   - `@model_validator(mode="after")` rejecting
     `rounds_completed > total_rounds`.
   - Add to the `SessionMetadata` union.

4. **Alembic migration for the CHECK constraint**
   - Create
     `backend/migrations/versions/<rev>_add_tallied_grounding_mode.py`
   - `upgrade()`: `op.drop_constraint("ck_practice_mode_value", ...)`
     then `op.create_check_constraint(...)` listing the new
     `ALL_MODES` tuple.
   - `downgrade()`: reverse — drop, then recreate without
     `tallied_grounding`. Treat existing `tallied_grounding` rows as a
     downgrade error: refuse to downgrade if any rows still carry the
     mode (mirror prior migration style).

5. **Tests**
   - `backend/tests/test_practice_mode_config.py`:
     - `test_tallied_grounding_config_round_trip()` — JSON → model → JSON
       preserves all fields
     - `test_tallied_grounding_rejects_duplicate_keys()`
     - `test_tallied_grounding_rejects_rounds_below_1()`
     - `test_tallied_grounding_rejects_empty_categories()`
   - `backend/tests/test_practice_session_metadata.py`:
     - `test_tallied_grounding_metadata_round_trip()`
     - `test_tallied_grounding_metadata_rejects_overcount()`
   - `backend/tests/test_practice_session_routes.py` (or wherever the
     mode-mismatch check lives): add a test that posting a
     `tallied_grounding` session to a `sense_grounding` practice
     returns 400.

## Acceptance Criteria

- [ ] `pytest backend/` green
- [ ] `pre-commit run --all-files` green
- [ ] Coverage thresholds unchanged (90% line / 80% branch / 85% docstring)
- [ ] Migration runs cleanly on a fresh DB and rolls back without error
      on an empty `practice` table
- [ ] `ALL_MODES` now contains `tallied_grounding`
- [ ] No changes to `sense_grounding` tests or behavior

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/domain/practice_modes.py` | Modify (add enum value) |
| `backend/src/schemas/practice_mode_config.py` | Modify (add config) |
| `backend/src/schemas/practice_session_metadata.py` | Modify (add metadata) |
| `backend/migrations/versions/<rev>_add_tallied_grounding_mode.py` | **Create** |
| `backend/tests/test_practice_mode_config.py` | Modify |
| `backend/tests/test_practice_session_metadata.py` | Modify |

## Constraints

- No changes to the `Practice` or `PracticeSession` table shapes —
  everything fits in the existing JSON columns.
- Keep `extra="forbid"` on every new `_ConfigBase` / `_MetadataBase`
  subclass — silently accepting unknown fields is how schemas drift.
- Do **not** modify `SenseGroundingConfig` or its tests.
