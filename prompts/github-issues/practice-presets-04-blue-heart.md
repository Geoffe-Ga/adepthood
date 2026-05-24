# practice-presets-04: Seed BLUE (stage 4) alternative heart / lovingkindness presets

**Labels:** `backend`, `feature`, `practice`, `seeding`
**Epic:** [Spiral Dynamics practice-preset catalog expansion](practice-presets-epic.md)
**Depends on:** none
**Estimated LoC:** ~325

## Role

You are a backend engineer adding stage-4 alternative presets to the
catalog. You follow the existing seed-preset pattern in
`backend/src/seed_practices.py` and validate every payload at import
time via `ModeConfigAdapter`.

## Goal

Seed **ten** new BLUE-band heart / lovingkindness alternatives at
stage 4 so the catalog menu carries a deep menu of relational practices
beyond canonical Metta. The new presets are:

| Name                    | Mode               | Duration | Halfway bell | Source row                                                   |
|-------------------------|--------------------|----------|--------------|--------------------------------------------------------------|
| Tonglen                 | `meditation_timer` | 15 min   | Yes          | "Tonglen: breathing in pain, breathing out compassion"       |
| I Am Love Through       | `meditation_timer` | 15 min   | Yes          | "Selig's 'I am Love through so and so'"                      |
| Heart Centered Breath   | `meditation_timer` | 15 min   | Yes          | "Heart-centered breath (inhale into heart, exhale out)"      |
| Animist Gratitude       | `meditation_timer` | 10 min   | No           | "Animist Gratitude: Speaking thanks aloud for local beings"  |
| Hug Visualization       | `meditation_timer` | 10 min   | No           | "Guided visualization of hugging someone you miss"           |
| Relational Gratitude    | `meditation_timer` | 15 min   | Yes          | "Gratitude meditation focused on relationships"              |
| Blessing Strangers      | `meditation_timer` | 10 min   | No           | "Mentally blessing strangers while people-watching"          |
| Heart Imagery           | `meditation_timer` | 15 min   | Yes          | "Meditating on heart imagery (green rose, spiral, chalice)"  |
| Just Like Me            | `meditation_timer` | 15 min   | Yes          | "Repeating the phrase: 'Just like me, this being seeks happiness'" |
| Ancestral Connection    | `meditation_timer` | 15 min   | Yes          | "Establishing ancestral connection via gratitude or lovingkindness" |

## Context

Stage 4's canonical preset is `Metta` (`meditation_timer`, 15 min,
halfway bell). The new alternatives keep the 15-minute heart-sit default
for full-arc practices and drop to 10 minutes for the lighter
"in-the-world" practices (`Animist Gratitude`, `Hug Visualization`,
`Blessing Strangers`).

`Blessing Strangers` is intended to be done in public (a café, a park);
the instructions must make this explicit and tell the user they can do
it with eyes open.

## Tasks

1. **Add `(description, instructions)` tuples to `seed_practice_copy.py`**
   - One constant per preset, suffixed with the slug.
   - Each instructions block: 3-6 sentences. For phrase-based practices
     (`Just Like Me`, `I Am Love Through`), quote the exact phrase the
     user is meant to repeat so the preset is self-contained.
   - For `Tonglen`: keep the breath-direction language unambiguous
     ("inhale the discomfort of [target]; exhale ease toward them").
   - Append entries to `PRESET_COPY`.

2. **Append `_build_preset(...)` rows to `_ALTERNATIVE_PRESETS` in `seed_practices.py`**
   - All ten at `stage_number=4`.
   - All use `_meditation_timer(duration_minutes, halfway_bell=<bool>)`.
   - Group under a `# Stage 4 alternatives — heart / lovingkindness.` comment.

3. **Tests in `backend/tests/test_seed_practices.py`**
   - One assertion test per preset, mirroring
     `test_touch_grass_preset_seeds`.
   - Bump `EXPECTED_PRESET_COUNT` by +10.

## Acceptance Criteria

- [ ] `pytest backend/tests/test_seed_practices.py` green.
- [ ] All ten rows present after `seed_practices(session)`.
- [ ] `STAGE_TO_PRESET_NAME[4]` is still `"Metta"`.
- [ ] `GET /practices?stage=4` returns 11 rows.
- [ ] Re-running the seeder is a no-op.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/seed_practices.py` | Modify — append 10 entries to `_ALTERNATIVE_PRESETS` |
| `backend/src/seed_practice_copy.py` | Modify — add 10 copy tuples + `PRESET_COPY` entries |
| `backend/tests/test_seed_practices.py` | Modify — add 10 assertion tests, bump expected count |

## Constraints

- Names must be unique across `PRESET_COPY`.
- Do not change the canonical `Metta` entry.
- Do not introduce new modes.
- Heart practices benefit from a halfway bell as an "open the circle"
  cue; default to `halfway_bell=True` for any 15-minute sit and
  `halfway_bell=False` for 10-minute / in-the-world variants.
