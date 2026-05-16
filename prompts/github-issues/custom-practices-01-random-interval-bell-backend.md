# custom-practices-01: Add `random_interval_bell` practice mode (backend)

**Labels:** `enhancement`, `ritual-practice`, `backend`
**Epic:** [Customizable practices](custom-practices-epic.md)
**Depends on:** none
**Estimated LoC:** ~200

## Role

You are a FastAPI / SQLModel engineer extending Adepthood's discriminated-union practice mode catalog with a non-deterministic timer variant. You follow the same pattern used by `interval_bell` and `tallied_grounding`.

## Goal

Add a `random_interval_bell` mode: a meditation timer that rings a bell at random offsets between configurable min/max bounds. Used for awareness practices where the unpredictability of the bell prompts re-anchoring attention.

## Context

`interval_bell` today supports evenly-spaced (`interval_minutes`) or explicit (`cue_offsets_minutes`) cue schedules (`backend/src/schemas/practice_mode_config.py:81-107`). Both are deterministic. The new mode introduces a third style — random within bounds — with its own validation rules. We add it as a separate mode rather than overloading `interval_bell` because the metadata shape differs (we record the actual struck offsets per session, not just a count).

## Tasks

1. **Extend `PracticeMode` enum** (`backend/src/domain/practice_modes.py`): add `RANDOM_INTERVAL_BELL = "random_interval_bell"`.

2. **Add `RandomIntervalBellConfig` to `practice_mode_config.py`**:
   - `mode: Literal["random_interval_bell"] = "random_interval_bell"`
   - `duration_minutes: float = Field(ge=_DURATION_MIN_MINUTES, le=_DURATION_MAX_MINUTES)`
   - `min_interval_seconds: int = Field(ge=5, le=3600)`
   - `max_interval_seconds: int = Field(ge=10, le=3600)`
   - `bell_tone: BellTone = "bowl"`
   - `max_bells: int | None = Field(default=None, ge=1, le=1000)` — optional cap on total bells
   - `start_bell: bool = True`
   - `end_bell: bool = True`
   - `@model_validator(mode="after")` enforcing:
     - `max_interval_seconds >= min_interval_seconds`
     - `min_interval_seconds <= duration_minutes * 60` (at least one bell can fit)
   - Add to the `ModeConfig` discriminated union.

3. **Add `RandomIntervalBellMetadata` to `practice_session_metadata.py`**:
   - `mode: Literal["random_interval_bell"] = "random_interval_bell"`
   - `bells_struck: int = Field(ge=0, le=1000)`
   - `interval_seconds: list[int] = Field(default_factory=list, max_length=1000)` — recorded offsets between consecutive bells, useful for "what was my actual rhythm" reflection
   - Add to the `SessionMetadata` union.

4. **Alembic migration** — `backend/migrations/versions/<rev>_add_random_interval_bell_mode.py`:
   - `upgrade()`: drop `ck_practice_mode_value`, recreate including `"random_interval_bell"`.
   - `downgrade()`: refuse if any rows carry the new mode.

5. **Tests**:
   - `test_practice_mode_config.py`: round-trip, rejects `max < min`, rejects `min > duration*60`, default tone is `bowl`.
   - `test_practice_session_metadata.py`: round-trip, accepts empty `interval_seconds`, accepts large lists up to `max_length`.

## Acceptance Criteria

- [ ] `pytest backend/` green
- [ ] `pre-commit run --all-files` green
- [ ] Coverage thresholds unchanged
- [ ] Migration runs cleanly on fresh DB and rolls back on empty `practice` table
- [ ] `ALL_MODES` contains `random_interval_bell`
- [ ] No changes to existing `interval_bell` behavior or tests

## Files

| File | Action |
|------|--------|
| `backend/src/domain/practice_modes.py` | Modify |
| `backend/src/schemas/practice_mode_config.py` | Modify |
| `backend/src/schemas/practice_session_metadata.py` | Modify |
| `backend/migrations/versions/<rev>_add_random_interval_bell_mode.py` | **Create** |
| `backend/tests/test_practice_mode_config.py` | Modify |
| `backend/tests/test_practice_session_metadata.py` | Modify |

## Constraints

- Do not change `interval_bell` config or metadata
- Keep `extra="forbid"` on the new model
- The client generates the random schedule; server only records what happened
