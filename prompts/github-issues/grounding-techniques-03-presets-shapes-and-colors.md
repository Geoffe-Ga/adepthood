# grounding-techniques-03: Seed Find Shapes + Find Colors presets

**Labels:** `backend`, `feature`, `practice`, `seeding`
**Epic:** [Generalize grounding techniques](grounding-techniques-epic.md)
**Depends on:** [grounding-techniques-01](grounding-techniques-01-tallied-mode-backend.md)
**Estimated LoC:** ~100

## Role

You are a backend engineer adding catalog content. You follow the
existing seed-preset pattern in `backend/src/seed_practices.py` and
validate every payload at import time via `ModeConfigAdapter`.

## Goal

Add two `tallied_grounding` presets to the practice catalog so users
can pick them from the catalog at the appropriate stages:

- **Find Shapes** — 3 rounds × [3 squares, 3 triangles, 3 circles]
- **Find Colors** — 3 rounds × one of each rainbow color (7 colors)

## Context

`backend/src/seed_practices.py:88-98` shows how the 5-4-3-2-1 preset is
seeded today: `_build_preset(stage_number, name, mode=..., mode_config=...,
default_duration_minutes=...)`. The list `_PRESET_PRACTICES` is iterated
at seed time; each `mode_config` is validated through
`ModeConfigAdapter.validate_python()` so a typo crashes the seeder, not
the runtime.

Stage placement is at the team's discretion — recommend:

- **Find Shapes:** stage 1 (alternative grounding for users who don't
  resonate with 5-4-3-2-1; same stage as the canonical sense grounding)
- **Find Colors:** stage 1 (same rationale)

Both alternatives let stage 1 still have one canonical preset
(`5-4-3-2-1 grounding`) used by the frequency-banner endpoint; verify
in `STAGE_TO_PRESET_NAME` that the canonical pointer is unchanged.

## Tasks

1. **Add prompt builders to `seed_practices.py`**
   - `_find_shapes_categories()` returns:
     ```python
     [
         {"key": "squares",   "label": "a square",   "target_count": 3},
         {"key": "triangles", "label": "a triangle", "target_count": 3},
         {"key": "circles",   "label": "a circle",   "target_count": 3},
     ]
     ```
   - `_find_colors_categories()` returns the 7 rainbow colors, each with
     `target_count=1`, labels: "something red", "something orange", …,
     "something violet".

2. **Append preset rows to `_PRESET_PRACTICES`**
   - "Find Shapes" preset at stage 1:
     ```python
     mode="tallied_grounding",
     mode_config={
         "mode": "tallied_grounding",
         "rounds": 3,
         "categories": _find_shapes_categories(),
     },
     default_duration_minutes=5,
     ```
   - "Find Colors" preset at stage 1, same shape with 7 categories.

3. **Add preset copy to `seed_practice_copy.py`** (if a stage-1 entry
   isn't already reused, or if the existing key collides).
   - Each preset needs `(description, instructions)`. If the stage-1
     entry is keyed by stage number only, add a per-preset override
     mechanism — but the existing system keys copy by stage. If only one
     copy entry per stage is supported, **extend the keying** to
     `(stage_number, name)` for these new entries; otherwise reuse the
     stage copy and accept identical descriptions. Surface the choice
     in the PR description.

4. **Tests**
   - `backend/tests/test_seed_practices.py`:
     - `test_find_shapes_preset_seeds()` — preset row inserts, mode is
       `tallied_grounding`, categories list length is 3, rounds is 3
     - `test_find_colors_preset_seeds()` — categories list length is 7,
       rounds is 3
     - `test_seed_is_idempotent_with_new_presets()` — running the seeder
       twice does not double-insert

## Acceptance Criteria

- [ ] `pytest backend/` green
- [ ] Running `python -m seed_practices` on a fresh DB inserts both
      presets
- [ ] Running it a second time inserts nothing new
- [ ] Catalog `GET /practices` returns both presets at stage 1

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/seed_practices.py` | Modify |
| `backend/src/seed_practice_copy.py` | Possibly modify |
| `backend/tests/test_seed_practices.py` | Modify |

## Constraints

- Do not change the existing `5-4-3-2-1 grounding` preset.
- Validate every preset's `mode_config` via `ModeConfigAdapter.validate_python()`.
- Choose labels that read naturally in a prompt ("Find a square" not
  "squares").

## Example output

```
$ curl /practices?stage=1
[
  {"name": "5-4-3-2-1 grounding", "mode": "sense_grounding", ...},
  {"name": "Find Shapes",         "mode": "tallied_grounding", ...},
  {"name": "Find Colors",         "mode": "tallied_grounding", ...}
]
```
