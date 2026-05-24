# practice-presets-01: Seed BEIGE (stage 1) alternative grounding presets

**Labels:** `backend`, `feature`, `practice`, `seeding`
**Epic:** [Spiral Dynamics practice-preset catalog expansion](practice-presets-epic.md)
**Depends on:** none
**Estimated LoC:** ~250

## Role

You are a backend engineer adding stage-1 alternative presets to the
catalog. You follow the existing seed-preset pattern in
`backend/src/seed_practices.py` and validate every payload at import
time via `ModeConfigAdapter`.

## Goal

Seed **seven** new BEIGE-band grounding alternatives at stage 1 so the
catalog menu for a stage-1 user offers a body-anchored toolkit beyond
the canonical 5-4-3-2-1 grounding. The new presets are:

| Name                           | Mode                | Duration | Notes                                       |
|--------------------------------|---------------------|----------|---------------------------------------------|
| Crystal Charging               | `meditation_timer`  | 5 min    | Hold a chosen crystal outdoors / on earth   |
| Tense and Release              | `meditation_timer`  | 5 min    | Halfway bell. Clench/release body scan      |
| Contact Points                 | `meditation_timer`  | 5 min    | Notice every point body meets a surface     |
| Box Breathing                  | `meditation_timer`  | 5 min    | Halfway bell. 4-4-4-4 pattern               |
| Toe Wiggling                   | `meditation_timer`  | 3 min    | Feel feet and wiggle toes                   |
| Body Scan                      | `meditation_timer`  | 5 min    | Halfway bell. Toes-to-head sweep            |
| Progressive Muscle Relaxation  | `meditation_timer`  | 10 min   | Halfway bell. Jacobson PMR                  |

## Context

`backend/src/seed_practices.py:257-314` shows the four existing stage-1
alternatives (Touch Grass, Mindful Eating, Find Shapes, Find Colors).
The source table's *Stand Barefoot Outdoors*, *Square-Circle-Triangle x5*,
and *Colors of the Rainbow* are intentionally skipped because they are
duplicates of those four — see the epic's constraints section.

Every preset in this issue uses `meditation_timer` mode with the
existing `_meditation_timer(...)` helper at `seed_practices.py:49-57`.
No new mode helpers required.

## Tasks

1. **Add `(description, instructions)` tuples to `seed_practice_copy.py`**
   - One module-level `_TUPLE` constant per preset, named after the
     practice (e.g. `_CRYSTAL_CHARGING`, `_BOX_BREATHING`).
   - Append each to the `PRESET_COPY` dict at the bottom of the file,
     keyed by the exact display name used in `seed_practices.py`.
   - Each description: 1-2 sentences, plain English, ≤ 2000 chars.
   - Each instructions block: 3-6 sentences, second-person imperative,
     ≤ 10000 chars. Lift from the source-table cell and elaborate
     enough that a first-timer can complete the practice.

2. **Append `_build_preset(...)` rows to `_ALTERNATIVE_PRESETS` in `seed_practices.py`**
   - All seven entries land at `stage_number=1`.
   - Use `_meditation_timer(duration_minutes, halfway_bell=<bool>)`
     for each `mode_config`.
   - Keep the new entries grouped together with a brief comment
     describing the BEIGE block, e.g.:
     ```python
     # Stage 1 alternatives — body-grounding / nervous-system regulation.
     _build_preset(1, "Crystal Charging", ...),
     ...
     ```

3. **Tests in `backend/tests/test_seed_practices.py`**
   - One assertion test per preset following the
     `test_touch_grass_preset_seeds` pattern at line 233. Verify:
     - The row is present after `seed_practices(session)`.
     - `mode == "meditation_timer"`.
     - `mode_config["duration_minutes"]` matches the spec.
     - `mode_config["halfway_bell"]` matches where applicable.
     - `stage_number == 1`.
   - **Do not** add a new global-invariant test — the existing
     `test_every_preset_sits_on_a_known_stage` and
     `test_every_preset_mode_config_is_valid` automatically cover the
     new rows.
   - Update the `EXPECTED_PRESET_COUNT` literal at the top of the file
     (line ~28) by +7.

## Acceptance Criteria

- [ ] `pytest backend/tests/test_seed_practices.py` green.
- [ ] `pytest backend/ -k preset` green.
- [ ] `python -c "from seed_practices import PRESET_PRACTICES; \
       print(len([p for p in PRESET_PRACTICES if p['stage_number']==1]))"`
       returns `12` (1 canonical + 4 prior alternatives + 7 new).
- [ ] `GET /practices?stage=1` returns 12 rows.
- [ ] `STAGE_TO_PRESET_NAME[1]` is still `"5-4-3-2-1 grounding"`.
- [ ] Running the seeder twice still inserts 7 net new rows the first
      time and 0 the second.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/seed_practices.py` | Modify — append 7 entries to `_ALTERNATIVE_PRESETS` |
| `backend/src/seed_practice_copy.py` | Modify — add 7 copy tuples + entries in `PRESET_COPY` |
| `backend/tests/test_seed_practices.py` | Modify — add 7 assertion tests, bump expected count |

## Constraints

- Names must be unique across `PRESET_COPY`. None of the seven proposed
  names collide with existing entries; do not rename them without
  checking the duplicate-name guard at `seed_practices.py:337-341`.
- Do not change `_CANONICAL_PRESETS` or the existing stage-1 alternatives.
- Keep descriptions and instructions tight; second-person imperative
  ("Sit upright. Inhale…") matches the existing copy voice at
  `seed_practice_copy.py:36-104`.

## Example output

```bash
$ curl -s 'http://localhost:8000/practices?stage=1' | jq '.[] | .name'
"5-4-3-2-1 grounding"
"Touch Grass"
"Mindful Eating"
"Find Shapes"
"Find Colors"
"Crystal Charging"
"Tense and Release"
"Contact Points"
"Box Breathing"
"Toe Wiggling"
"Body Scan"
"Progressive Muscle Relaxation"
```
