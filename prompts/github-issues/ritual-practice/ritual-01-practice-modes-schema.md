# ritual-01: Practice modes + mode_config schema

**Labels:** `ritual-practice`, `backend`, `feature`, `priority-high`
**Epic:** Ritual Practice Screen
**Depends on:** phase-3-04 (Practice/UserPractice/PracticeSession exist)
**Estimated LoC:** ~400 (model + migration + schemas + tests)

## Problem

`Practice` today only knows `default_duration_minutes` — enough for a generic
countdown but not for a metronome (needs BPM), an interval bell clock (needs
a list of cue offsets), a rep counter (needs a target / unit label), a
sense-grounding sequence (needs ordered prompts), a tarot meditation (needs a
card deck reference), or a count-up timer (no target at all).

We need a **mode discriminator** plus a per-mode configuration payload, both
on the catalog row (`Practice`) and overridable per user (`UserPractice`,
covered in `ritual-03`).

## Scope

Add a `mode` enum and a `mode_config` JSON column to `Practice`. Validate the
config payload per mode at the schema layer so bad presets fail at write time,
not in the UI.

## Tasks

1. **Define the mode enum** in `backend/src/domain/practice_modes.py`
   - Values: `meditation_timer`, `count_up`, `metronome`, `interval_bell`,
     `rep_counter`, `sense_grounding`, `tarot`.
   - Pure-Python `StrEnum`; expose `ALL_MODES` for serialization.

2. **Define `ModeConfig` Pydantic discriminated union** in
   `backend/src/schemas/practice_mode_config.py`
   - One model per mode, each with the minimum fields needed:
     - `MeditationTimerConfig`: `duration_minutes: float >= 0.5`,
       `start_bell: bool = True`, `halfway_bell: bool = False`,
       `end_bell: bool = True`.
     - `CountUpConfig`: `soft_cap_minutes: float | None` (used for "you've been
       at it an hour" gentle nudges).
     - `MetronomeConfig`: `bpm: int 20..240`, plus an embedded
       `MeditationTimerConfig` for the surrounding session window.
     - `IntervalBellConfig`: `duration_minutes: float`, `interval_minutes:
       float >= 0.5` OR `cue_offsets_minutes: list[float]` (mutually
       exclusive — validator), `bell_tone: Literal["bowl", "chime", "gong"]`.
     - `RepCounterConfig`: `target_reps: int >= 1`, `unit_label: str` (e.g.
       "breath cycles", "prostrations"), `time_cap_minutes: float | None`.
     - `SenseGroundingConfig`: `prompts: list[SensePrompt]` where
       `SensePrompt = {sense: Literal["sight","touch","hearing","smell","taste"],
       label: str}`. Default is the 5-4-3-2-1 ordering.
     - `TarotConfig`: `deck: Literal["major_arcana"]`,
       `per_card_minutes: float = 5`, `hide_timer_during_meditation: bool =
       True`.
   - Wrap them in `ModeConfig = Annotated[Union[...], Field(discriminator="mode")]`.
     Each model carries a `mode: Literal["..."]` field so the union tags
     itself, no hand-rolled if/else.

3. **Extend the `Practice` model** (`backend/src/models/practice.py`)
   - Add `mode: str` (StrEnum value) with a non-null DB constraint.
   - Add `mode_config: dict[str, Any]` mapped to a JSON column. Use
     `sa_column=Column(JSON, nullable=False, server_default="{}")` so the
     existing rows can be backfilled with a dict per their default mode in
     the migration.
   - Keep `default_duration_minutes` as the canonical "show me a number on
     the catalog tile" hint; treat `mode_config` as the source of truth for
     the engine.

4. **Alembic migration** (`backend/alembic/versions/<rev>_practice_modes.py`)
   - Add the two columns nullable, backfill every existing row with
     `mode='meditation_timer'` and a `MeditationTimerConfig` derived from
     `default_duration_minutes`, then alter to `NOT NULL`.
   - Reversible `downgrade()` drops the columns.

5. **Refresh the response schema** (`backend/src/schemas/practice.py`)
   - `PracticeResponse` gains `mode: str` and `mode_config: ModeConfig`.
   - `PracticeCreate` (user submissions) accepts both; default mode is
     `meditation_timer` if omitted, with `mode_config` derived from the
     submitted `default_duration_minutes`.
   - Reject `mode_config.mode != mode` mismatches at the validator layer.

6. **Tests** (target: 100% branch coverage on the new files)
   - `backend/tests/test_practice_mode_config.py`
     - Each mode round-trips through `ModeConfig.model_validate()`.
     - Mismatched `mode` discriminator raises.
     - `IntervalBellConfig` rejects "both `interval_minutes` and
       `cue_offsets_minutes`" and "neither set".
     - `MetronomeConfig.bpm` rejects 0 / 19 / 241.
     - `SenseGroundingConfig` rejects empty `prompts` and unknown sense
       literals.
   - `backend/tests/test_practices_api.py` — extend
     - `POST /practices/` accepts every mode + a valid config.
     - `POST /practices/` rejects invalid configs with 422.
     - `GET /practices/{id}` echoes `mode` + `mode_config`.

## Acceptance Criteria

- Migration applies cleanly forward and backward against the seeded DB.
- Existing data is preserved; every pre-existing `Practice` row reads back as
  `mode='meditation_timer'` with a valid `mode_config`.
- `pre-commit run --all-files` is clean; coverage ≥ 90% line / 80% branch on
  changed modules; no new suppressions.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/domain/practice_modes.py` | **Create** |
| `backend/src/schemas/practice_mode_config.py` | **Create** |
| `backend/src/schemas/practice.py` | Modify |
| `backend/src/models/practice.py` | Modify |
| `backend/alembic/versions/<rev>_practice_modes.py` | **Create** |
| `backend/tests/test_practice_mode_config.py` | **Create** |
| `backend/tests/test_practices_api.py` | Modify |

## If you blow the budget

Split as `01a` (model + migration + enum) and `01b` (Pydantic
discriminated-union schemas + validators + tests). The migration must land
first because every other backend issue assumes the columns exist.
