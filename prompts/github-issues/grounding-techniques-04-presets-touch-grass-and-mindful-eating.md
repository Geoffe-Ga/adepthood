# grounding-techniques-04: Seed Touch Grass + Mindful Eating presets

**Labels:** `backend`, `feature`, `practice`, `seeding`
**Epic:** [Generalize grounding techniques](grounding-techniques-epic.md)
**Depends on:** [grounding-techniques-02](grounding-techniques-02-mindful-anchor-mode-backend.md)
**Estimated LoC:** ~100

## Role

You are a backend engineer adding catalog content. You follow the
existing seed-preset pattern and validate every payload at import time.

## Goal

Add two `mindful_anchor` presets to the practice catalog:

- **Touch Grass** — stand barefoot on a natural surface
- **Mindful Eating** — slowly eat one small portion of a grounding food

## Context

These are single-action mindful presence practices. They differ from
the step-based grounding presets: the user picks one option (or none),
takes their time, and marks complete. The view should surface elapsed
time and gently nudge if the user marks complete before
`min_duration_seconds`.

Recommended stage placement is at the team's discretion; default to
stage 1 alongside the other grounding alternatives.

## Tasks

1. **Add option builders to `seed_practices.py`**
   - `_touch_grass_options()`:
     ```python
     [
         {"key": "grass", "label": "Grass",
          "description": "A lawn, a park, a meadow."},
         {"key": "soil", "label": "Soil",
          "description": "Garden bed, forest floor, planter."},
         {"key": "sand", "label": "Sand",
          "description": "A beach or a sandbox."},
         {"key": "stone", "label": "Stone",
          "description": "Bare rock, a flagstone path."},
     ]
     ```
   - `_mindful_eating_options()`:
     ```python
     [
         {"key": "nuts_seeds",     "label": "Nuts or seeds",
          "description": "Almonds, walnuts, pumpkin seeds."},
         {"key": "root_vegetable", "label": "Root vegetable",
          "description": "Carrot, beet, sweet potato."},
         {"key": "whole_grain",    "label": "Whole-grain bread",
          "description": "Dense, hearty, a slow chew."},
         {"key": "dark_chocolate", "label": "Dark chocolate",
          "description": "A single square, savored."},
         {"key": "fresh_fruit",    "label": "Fresh fruit",
          "description": "Apple, pear, berries."},
     ]
     ```

2. **Append preset rows to `_PRESET_PRACTICES`**
   - **Touch Grass** preset:
     ```python
     mode="mindful_anchor",
     mode_config={
         "mode": "mindful_anchor",
         "instruction": "Stand barefoot on the earth. Notice the texture, "
                        "temperature, and pressure under your feet. "
                        "Stay until you feel settled.",
         "min_duration_seconds": 120,
         "options": _touch_grass_options(),
         "require_option_choice": True,
     },
     default_duration_minutes=3,
     ```
   - **Mindful Eating** preset:
     ```python
     mode="mindful_anchor",
     mode_config={
         "mode": "mindful_anchor",
         "instruction": "Eat one small portion slowly. Notice texture, "
                        "temperature, aroma, and flavor with each bite. "
                        "Pause between bites.",
         "min_duration_seconds": 180,
         "options": _mindful_eating_options(),
         "require_option_choice": True,
     },
     default_duration_minutes=5,
     ```

3. **Tests**
   - `backend/tests/test_seed_practices.py`:
     - `test_touch_grass_preset_seeds()` — preset row inserts, mode is
       `mindful_anchor`, 4 options, `require_option_choice=True`
     - `test_mindful_eating_preset_seeds()` — 5 options, instruction
       non-empty, `min_duration_seconds=180`
     - `test_seed_is_idempotent_with_new_presets()` (extended)

## Acceptance Criteria

- [ ] `pytest backend/` green
- [ ] Running `python -m seed_practices` on a fresh DB inserts both presets
- [ ] Running it a second time inserts nothing new
- [ ] Catalog returns both presets with the configured options

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/seed_practices.py` | Modify |
| `backend/src/seed_practice_copy.py` | Possibly modify |
| `backend/tests/test_seed_practices.py` | Modify |

## Constraints

- Validate every preset's `mode_config` via `ModeConfigAdapter`.
- Option keys are slugs (`^[a-z][a-z0-9_]*$`); labels are display text.
- Keep descriptions concrete and sensory — they appear in the chooser UI.
- `min_duration_seconds` is a soft nudge, not a lock. The view will
  encourage but not enforce.
