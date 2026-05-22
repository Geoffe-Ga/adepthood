# custom-practices-02: Add `card_meditation` practice mode (backend)

**Labels:** `enhancement`, `ritual-practice`, `backend`
**Epic:** [Customizable practices](custom-practices-epic.md)
**Depends on:** none
**Estimated LoC:** ~250

## Role

You are a FastAPI / SQLModel engineer adding a new, deck-agnostic card-meditation mode that generalizes the existing `tarot` mode without removing it.

## Goal

Add a `card_meditation` mode that powers full-screen card meditation for any deck — bundled (RWS, Major Arcana text) or user-curated (a list of `{name, image_uri}` entries). The existing `tarot` mode stays for backward compatibility.

## Context

`tarot` today (`backend/src/schemas/practice_mode_config.py:134-141`) is hardcoded to the 22-card major arcana with text-only display. The user wants to display **images** (curated decks shipped by the app, plus optional photos picked from the user's device), to support **multiple decks** (RWS, Thoth, Marseille, oracle cards), and to let users **author custom card sets**. This mode is the structural home for all of that.

Frontend has the existing major-arcana data at `frontend/src/features/Practice/data/tarot.ts`. The RWS bundle is delivered in sub-issue 04.

## Tasks

1. **Extend `PracticeMode` enum**: add `CARD_MEDITATION = "card_meditation"`.

2. **Add `CardMeditationCard` and `CardMeditationConfig` to `practice_mode_config.py`**:
   - `CardMeditationCard(_ConfigBase)`:
     - `name: str = Field(min_length=1, max_length=120)`
     - `image_asset_key: str | None = Field(default=None, max_length=200)` — references a bundled asset (e.g. `"rws/the_fool"`) or null for text-only
     - `image_uri: str | None = Field(default=None, max_length=500)` — remote URL or device path; **client-only**, server never resolves
     - `symbolism: str | None = Field(default=None, max_length=500)` — optional reading
     - `@model_validator`: reject if both `image_asset_key` and `image_uri` are set
   - `CardMeditationConfig(_ConfigBase)`:
     - `mode: Literal["card_meditation"] = "card_meditation"`
     - `deck_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_]*$")` — examples: `rws`, `major_arcana_text`, `custom`
     - `per_card_minutes: float = Field(default=5, ge=_DURATION_MIN_MINUTES, le=_DURATION_MAX_MINUTES)`
     - `shuffle: bool = True`
     - `reveal_after_meditation: bool = False` — if True, the timer runs **first** with the card hidden, then the card is revealed
     - `hide_timer_during_meditation: bool = True`
     - `cards: list[CardMeditationCard] | None = Field(default=None, max_length=200)` — null means "use the bundled deck named by `deck_id`"; non-null overrides
   - `@model_validator`: if `deck_id == "custom"`, `cards` must be non-null and non-empty.
   - Add to the `ModeConfig` discriminated union.

3. **Add `CardMeditationMetadata` to `practice_session_metadata.py`**:
   - `mode: Literal["card_meditation"] = "card_meditation"`
   - `deck_id: str = Field(min_length=1, max_length=64)`
   - `card_drawn_name: str = Field(min_length=1, max_length=120)`
   - `card_drawn_index: int | None = Field(default=None, ge=0, le=999)` — optional, useful for reproducing shuffles
   - Add to the `SessionMetadata` union.

4. **Alembic migration** — add `card_meditation` to `ck_practice_mode_value`.

5. **Tests**:
   - `test_practice_mode_config.py`:
     - Round-trip with bundled deck (no `cards`)
     - Round-trip with custom deck (`cards` populated)
     - Rejects `deck_id="custom"` with `cards=None`
     - Rejects a card with both `image_asset_key` and `image_uri` set
     - Accepts a card with neither (text-only display)
   - `test_practice_session_metadata.py`: round-trip, accepts null `card_drawn_index`.

## Acceptance Criteria

- [ ] `pytest backend/` green
- [ ] `pre-commit run --all-files` green
- [ ] Migration runs cleanly on fresh DB and rolls back on empty `practice` table
- [ ] `ALL_MODES` contains `card_meditation`
- [ ] `tarot` mode tests and behavior unchanged

## Files

| File | Action |
|------|--------|
| `backend/src/domain/practice_modes.py` | Modify |
| `backend/src/schemas/practice_mode_config.py` | Modify |
| `backend/src/schemas/practice_session_metadata.py` | Modify |
| `backend/migrations/versions/<rev>_add_card_meditation_mode.py` | **Create** |
| `backend/tests/test_practice_mode_config.py` | Modify |
| `backend/tests/test_practice_session_metadata.py` | Modify |

## Constraints

- Do not modify or deprecate `tarot` — both modes coexist
- Server never fetches `image_uri` content; it's just a string the client uses
- `image_asset_key` is opaque to the server; frontend resolves it against the deck manifest
- Keep `extra="forbid"`

## Example payloads

```json
// Custom deck shipped with the app
{
  "mode": "card_meditation",
  "deck_id": "rws",
  "per_card_minutes": 7,
  "shuffle": true,
  "reveal_after_meditation": false,
  "hide_timer_during_meditation": true,
  "cards": null
}

// User-authored deck of phone photos
{
  "mode": "card_meditation",
  "deck_id": "custom",
  "per_card_minutes": 5,
  "shuffle": true,
  "reveal_after_meditation": true,
  "hide_timer_during_meditation": true,
  "cards": [
    {"name": "Mountain", "image_uri": "file:///var/.../IMG_0123.jpg", "symbolism": "Stillness."},
    {"name": "River",    "image_uri": "file:///var/.../IMG_0124.jpg", "symbolism": "Flow."}
  ]
}
```
