# practice-presets-03: Seed RED (stage 3) alternative energy / power presets

**Labels:** `backend`, `feature`, `practice`, `seeding`
**Epic:** [Spiral Dynamics practice-preset catalog expansion](practice-presets-epic.md)
**Depends on:** none
**Estimated LoC:** ~325

## Role

You are a backend engineer adding stage-3 alternative presets to the
catalog. You follow the existing seed-preset pattern in
`backend/src/seed_practices.py` and validate every payload at import
time via `ModeConfigAdapter`.

## Goal

Seed **ten** new RED-band energy / power-building alternatives at
stage 3 so the catalog menu offers a wider toolkit beyond canonical
belly breathing. The new presets are:

| Name                       | Mode               | Duration | Halfway bell | Source row                                                       |
|----------------------------|--------------------|----------|--------------|------------------------------------------------------------------|
| Hand Energy Sensing        | `meditation_timer` | 5 min    | No           | "Raise energy by rubbing hands together…"                        |
| Windhorse Breathwork       | `meditation_timer` | 10 min   | Yes          | "'Windhorse' breathwork (stoking inner fire)"                    |
| Water Charging             | `meditation_timer` | 5 min    | No           | "Charging Water using Damien Echols's techniques"                |
| Mini TED Talk              | `meditation_timer` | 10 min   | No           | "Mini-TED Talk: describe something you understand well…"         |
| Power Posture              | `meditation_timer` | 10 min   | No           | "Power posture meditation with steady breath"                    |
| Mountain Pose Sit          | `meditation_timer` | 10 min   | No           | "Seated mountain pose visualization ('I cannot be moved')"       |
| Fire Gazing                | `meditation_timer` | 10 min   | Yes          | "Fire gazing while anchoring into the solar plexus"              |
| Warrior Stillness          | `meditation_timer` | 10 min   | No           | "Holding one physical posture (e.g., warrior pose) in stillness" |
| Red Sphere Visualization   | `meditation_timer` | 10 min   | Yes          | "Visualizing a red sphere of light pulsing in your gut"          |
| Love to Past Selves        | `meditation_timer` | 15 min   | Yes          | "Sending love to different ages of your past self"               |

## Context

Stage 3's canonical preset is `Belly breathing`
(`meditation_timer`, 10 min). The new alternatives mostly follow the
same 10-minute timer with a halfway bell for the longer / more
demanding ones. `Love to Past Selves` is a 15-minute sit because the
practice steps through multiple ages.

## Tasks

1. **Add `(description, instructions)` tuples to `seed_practice_copy.py`**
   - One constant per preset, suffixed with the slug (e.g.
     `_HAND_ENERGY_SENSING`, `_MINI_TED_TALK`, `_RED_SPHERE_VISUALIZATION`).
   - Each instructions block must include setup (posture, where to
     focus attention), the practice itself, and a closing cue
     ("until the bell," "for the rest of the timer").
   - For `Mini TED Talk` specifically: spell out that the user should
     speak aloud or sub-vocalize for the full duration, picking a topic
     of genuine expertise.
   - For `Water Charging`: brief framing of the Damien Echols technique
     (sigil + intention into a held glass of water) without invoking
     real ritual gear.
   - Append entries to `PRESET_COPY`.

2. **Append `_build_preset(...)` rows to `_ALTERNATIVE_PRESETS` in `seed_practices.py`**
   - All ten at `stage_number=3`.
   - All use `_meditation_timer(duration_minutes, halfway_bell=<bool>)`.
   - Group under a `# Stage 3 alternatives — energy / power.` comment.

3. **Tests in `backend/tests/test_seed_practices.py`**
   - One assertion test per preset, mirroring
     `test_touch_grass_preset_seeds`. Verify the row's
     `stage_number`, `mode`, and the `mode_config.duration_minutes` /
     `mode_config.halfway_bell` flags.
   - Bump `EXPECTED_PRESET_COUNT` by +10.

## Acceptance Criteria

- [ ] `pytest backend/tests/test_seed_practices.py` green.
- [ ] All ten rows present after `seed_practices(session)`.
- [ ] `STAGE_TO_PRESET_NAME[3]` is still `"Belly breathing"`.
- [ ] `GET /practices?stage=3` returns 11 rows.
- [ ] Re-running the seeder is a no-op.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/seed_practices.py` | Modify — append 10 entries to `_ALTERNATIVE_PRESETS` |
| `backend/src/seed_practice_copy.py` | Modify — add 10 copy tuples + `PRESET_COPY` entries |
| `backend/tests/test_seed_practices.py` | Modify — add 10 assertion tests, bump expected count |

## Constraints

- Names must be unique across `PRESET_COPY`.
- Do not change the canonical `Belly breathing` entry.
- Do not introduce new modes; energy-raising flavour belongs in copy.
- Keep instructions safe: no breath-retention practice longer than the
  canonical Wim Hof preset, no advice that contradicts general medical
  guidance. The `Windhorse Breathwork` and `Fire Gazing` instructions
  should explicitly tell the user to ease off if they feel lightheaded.
