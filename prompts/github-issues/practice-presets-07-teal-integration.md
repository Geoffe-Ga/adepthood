# practice-presets-07: Seed TEAL (stage 8) alternative integration / shamanic presets

**Labels:** `backend`, `feature`, `practice`, `seeding`
**Epic:** [Spiral Dynamics practice-preset catalog expansion](practice-presets-epic.md)
**Depends on:** none
**Estimated LoC:** ~300

## Role

You are a backend engineer adding stage-8 alternative presets to the
catalog. You follow the existing seed-preset pattern in
`backend/src/seed_practices.py` and validate every payload at import
time via `ModeConfigAdapter`.

## Goal

Seed **nine** new TEAL-band integration / shamanic alternatives at
stage 8 so the catalog menu carries a deeper toolkit beyond canonical
Dog Walkin' Shamanism. The new presets are:

| Name                          | Mode               | Duration | Halfway bell | Source row                                                       |
|-------------------------------|--------------------|----------|--------------|------------------------------------------------------------------|
| Clairaudient Listening        | `meditation_timer` | 20 min   | Yes          | "Clairaudient Practice: Sitting and listening to the 'still small voice' inside" |
| Channeling Writing            | `count_up`         | —        | —            | "Channeling writing: ask 'What would you have me know?'"         |
| Active Imagination Dialogue   | `meditation_timer` | 30 min   | Yes          | "Jung's 'Active Imagination' dialogue with a part of self"       |
| Aura Scanning                 | `meditation_timer` | 15 min   | No           | "Subtle energy scanning of your own aura"                        |
| Sangha Field Tuning           | `meditation_timer` | 15 min   | No           | "Tuning into a collective prayer field or sangha field"          |
| Freedom Log                   | `count_up`         | —        | —            | "Freedom Log: Re-patterning practice"                            |
| Hierarchical Re-Feeling       | `count_up`         | —        | —            | "Hierarchical 'Re-Feeling' Journal"                              |
| Reflective Tarot Draw         | `meditation_timer` | 5 min    | No           | "Tarot Draw: 'What was the lesson of today / this event / that relationship'" |
| Sacred Pause                  | `meditation_timer` | 5 min    | No           | "Tara Brach's 'Sacred Pause' from Radical Acceptance"            |

## Context

Stage 8's canonical preset is `Dog Walkin' Shamanism` (`count_up`).
The TEAL band includes a mix of contemplative sits, open-ended
journaling, and short single-act practices.

**Three** of the new presets are `count_up` (Channeling Writing,
Freedom Log, Hierarchical Re-Feeling) — open-ended journaling
practices that complete when the user feels done. Reuse the existing
shape and the `_COUNT_UP_NOMINAL_DURATION_MINUTES` constant
(`seed_practices.py:46`).

`Reflective Tarot Draw` deliberately uses `meditation_timer` (not
`tarot` mode) because there is no full Major-Arcana progression here —
just a single card prompted by a reflective question. Treating it as
a 5-minute timed sit keeps the engine choice the user-facing
distinction (canonical 22-day Tarot meditation at stage 2 → `tarot`;
reflective single-card pull at stage 8 → `meditation_timer`).

## Tasks

1. **Add `(description, instructions)` tuples to `seed_practice_copy.py`**
   - One constant per preset, suffixed with the slug.
   - For `Channeling Writing`: instruct the user to write the exact
     prompt at the top of the page and then transcribe whatever
     arises without editing.
   - For `Active Imagination Dialogue`: name the Jung framing — invite
     a figure or aspect to appear, address it directly, record what
     it says.
   - For `Freedom Log` and `Hierarchical Re-Feeling`: brief description
     of the re-patterning intent; tell the user to journal until the
     practice feels complete.
   - For `Reflective Tarot Draw`: tell the user to shuffle, draw one
     card, and sit with the question "what was the lesson of today /
     this event / this relationship" for the full 5-minute timer.
   - For `Sacred Pause`: lift directly from Tara Brach's framing —
     stop, take a breath, notice what is here without trying to fix it.
   - Append entries to `PRESET_COPY`.

2. **Append `_build_preset(...)` rows to `_ALTERNATIVE_PRESETS` in `seed_practices.py`**
   - Six entries use `_meditation_timer(duration_minutes, halfway_bell=<bool>)`.
   - Three entries (`Channeling Writing`, `Freedom Log`,
     `Hierarchical Re-Feeling`) use the `count_up` shape.
   - Group under a `# Stage 8 alternatives — integration / shamanic.` comment.

3. **Tests in `backend/tests/test_seed_practices.py`**
   - One assertion test per preset. For the `count_up` presets, verify
     `mode == "count_up"` and `mode_config["soft_cap_minutes"] is None`.
   - Bump `EXPECTED_PRESET_COUNT` by +9.

## Acceptance Criteria

- [ ] `pytest backend/tests/test_seed_practices.py` green.
- [ ] All nine rows present after `seed_practices(session)`.
- [ ] `STAGE_TO_PRESET_NAME[8]` is still `"Dog Walkin' Shamanism"`.
- [ ] `GET /practices?stage=8` returns 10 rows.
- [ ] Re-running the seeder is a no-op.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/seed_practices.py` | Modify — append 9 entries to `_ALTERNATIVE_PRESETS` |
| `backend/src/seed_practice_copy.py` | Modify — add 9 copy tuples + `PRESET_COPY` entries |
| `backend/tests/test_seed_practices.py` | Modify — add 9 assertion tests, bump expected count |

## Constraints

- Names must be unique across `PRESET_COPY`.
- Do not change the canonical `Dog Walkin' Shamanism` entry.
- Do not introduce new modes. `Reflective Tarot Draw` does *not* use
  `tarot` mode — the engine would require a deck slug; this preset is
  a single-card timed sit instead.
- Keep instructions self-contained — TEAL practices often assume
  background a beginner won't have. Give just enough framing that a
  user encountering Active Imagination or Tonglen-style channeling
  for the first time can complete the session.
