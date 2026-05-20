# grounding-techniques-02: Add `mindful_anchor` practice mode (backend)

**Labels:** `backend`, `feature`, `practice`
**Epic:** [Generalize grounding techniques](grounding-techniques-epic.md)
**Depends on:** none (parallel with 01)
**Estimated LoC:** ~200

## Role

You are a FastAPI / SQLModel engineer extending a discriminated-union
practice mode catalog. Your changes preserve all existing modes and
introduce one new mode value, validated end-to-end.

## Goal

Introduce a new `mindful_anchor` practice mode that captures the
"single mindful act with optional chooser + soft duration floor" shape
shared by the **Touch Grass** and **Mindful Eating** techniques. The
mode must:

- Round-trip through `Practice.mode_config` JSON storage
- Validate at the API edge via Pydantic
- Pass the `practice.mode` `CHECK` constraint
- Emit a per-session metadata payload that records what the user chose
  and how long they spent

## Context

Both techniques are *single-action* mindful presence practices, not
step-based:

- **Touch Grass:** stand barefoot on grass / soil / sand / stone, take
  your time, mark complete.
- **Mindful Eating:** eat a small portion of a grounding food (root
  vegetable, dark chocolate, nuts, etc.) slowly and attentively.

Both share:

- A short instruction string
- A list of options the user picks from (surfaces / foods)
- A "take your time" expectation (no hard timer, soft minimum)
- A single "mark complete" action

## Tasks

1. **Extend `PracticeMode` enum**
   - In `backend/src/domain/practice_modes.py`, add
     `MINDFUL_ANCHOR = "mindful_anchor"`.

2. **Add `MindfulAnchorConfig` to `practice_mode_config.py`**
   - Define `MindfulAnchorOption(_ConfigBase)` with:
     - `key: str` (`min_length=1, max_length=64`, regex
       `^[a-z][a-z0-9_]*$`)
     - `label: str` (`min_length=1, max_length=255`)
     - `description: str | None = Field(default=None, max_length=500)`
   - Define `MindfulAnchorConfig(_ConfigBase)`:
     - `mode: Literal["mindful_anchor"] = "mindful_anchor"`
     - `instruction: str = Field(min_length=1, max_length=500)`
     - `min_duration_seconds: int = Field(ge=0, le=3600)` (soft floor, 0
       means "no nudge")
     - `options: list[MindfulAnchorOption] = Field(default_factory=list,
       max_length=20)`
     - `require_option_choice: bool = False`
   - `@model_validator(mode="after")` rejecting duplicate option keys.
   - If `require_option_choice` is True, `options` must be non-empty.
   - Add `MindfulAnchorConfig` to the `ModeConfig` union.

3. **Add `MindfulAnchorMetadata` to `practice_session_metadata.py`**
   - Fields:
     - `mode: Literal["mindful_anchor"] = "mindful_anchor"`
     - `chosen_option_key: str | None = Field(default=None, max_length=64)`
     - `duration_seconds: int = Field(ge=0, le=14400)` (4-hour cap)
     - `met_min_duration: bool` (server-derivable but emit from client
       for transparency)
   - Add to the `SessionMetadata` union.

4. **Alembic migration for the CHECK constraint**
   - Create
     `backend/migrations/versions/<rev>_add_mindful_anchor_mode.py`
   - Same pattern as 01 — drop & recreate `ck_practice_mode_value`.
   - `downgrade()` refuses if any rows carry `mindful_anchor`.

5. **Tests**
   - `backend/tests/test_practice_mode_config.py`:
     - `test_mindful_anchor_config_round_trip()`
     - `test_mindful_anchor_rejects_duplicate_option_keys()`
     - `test_mindful_anchor_requires_options_when_choice_required()`
     - `test_mindful_anchor_allows_no_options_when_choice_not_required()`
   - `backend/tests/test_practice_session_metadata.py`:
     - `test_mindful_anchor_metadata_round_trip()`
     - `test_mindful_anchor_metadata_with_no_option_chosen()` (when
       `require_option_choice=False`)

## Acceptance Criteria

- [ ] `pytest backend/` green
- [ ] `pre-commit run --all-files` green
- [ ] Coverage thresholds unchanged
- [ ] Migration runs cleanly on a fresh DB and rolls back without error
- [ ] `ALL_MODES` now contains `mindful_anchor`
- [ ] No changes to existing mode behavior

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/domain/practice_modes.py` | Modify |
| `backend/src/schemas/practice_mode_config.py` | Modify |
| `backend/src/schemas/practice_session_metadata.py` | Modify |
| `backend/migrations/versions/<rev>_add_mindful_anchor_mode.py` | **Create** |
| `backend/tests/test_practice_mode_config.py` | Modify |
| `backend/tests/test_practice_session_metadata.py` | Modify |

## Constraints

- `min_duration_seconds` is a **soft** floor. Server accepts sessions
  shorter than it; the field exists so the client can nudge the user.
- Do not introduce a server-side timer dependency. The duration is
  derived from `(ended_at - started_at)` on the session row; the
  metadata field records what the client observed.
- Keep `extra="forbid"`.
