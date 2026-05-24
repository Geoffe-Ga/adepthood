# practice-presets-05: Seed ORANGE (stage 5) alternative activation / manifestation presets

**Labels:** `backend`, `feature`, `practice`, `seeding`
**Epic:** [Spiral Dynamics practice-preset catalog expansion](practice-presets-epic.md)
**Depends on:** none
**Estimated LoC:** ~275

## Role

You are a backend engineer adding stage-5 alternative presets to the
catalog. You follow the existing seed-preset pattern in
`backend/src/seed_practices.py` and validate every payload at import
time via `ModeConfigAdapter`.

## Goal

Seed **eight** new ORANGE-band activation / manifestation alternatives
at stage 5 so the catalog menu carries a wider menu of high-energy
practices beyond canonical Wim Hof. The new presets are:

| Name                              | Mode               | Duration | Halfway bell | Source row                                                       |
|-----------------------------------|--------------------|----------|--------------|------------------------------------------------------------------|
| Kapalabhati Skull Shining         | `meditation_timer` | 15 min   | Yes          | "Skull Shining (Kapalabhati) to boost focus and alertness"       |
| Middle Pillar                     | `meditation_timer` | 20 min   | Yes          | "'Middle Pillar' Golden Dawn exercise (energy body building)"    |
| Sigil Dhyana                      | `meditation_timer` | 20 min   | Yes          | "Chaos Magick's style meditation of Dhyana on Sigils…"           |
| Reality Selection Visualization   | `meditation_timer` | 20 min   | Yes          | "Neville Goddard style hypnagogic visualization…"                |
| Single Instrument Listening       | `meditation_timer` | 20 min   | No           | "Listen to energizing music, focusing on one instrument"         |
| Chanting or Kirtan                | `meditation_timer` | 20 min   | No           | "Chanting or Kirtan"                                             |
| Breath of Fire + Silence          | `meditation_timer` | 20 min   | Yes          | "Breath of Fire followed by a period of silence"                 |
| Lion's Breath                     | `meditation_timer` | 10 min   | No           | "Lion's Breath"                                                  |

## Context

Stage 5's canonical preset is `Wim Hof method` (`meditation_timer`,
20 min). The new alternatives mostly hold to a 20-minute sit so the
heart-rate / energy-spike profile is consistent with the stage's
intent. `Lion's Breath` is a shorter 10-minute session because the
practice itself is cathartic and quick.

`Breath of Fire + Silence` uses a halfway bell to mark the transition
from active breathwork to silent integration.

## Tasks

1. **Add `(description, instructions)` tuples to `seed_practice_copy.py`**
   - One constant per preset, suffixed with the slug.
   - For breath-intensive practices (`Kapalabhati`, `Breath of Fire`,
     `Lion's Breath`): include an explicit safety note — "ease off if
     you feel lightheaded; rest in normal breathing until it passes" —
     consistent with the canonical Wim Hof copy at
     `seed_practice_copy.py:56-61`.
   - For `Middle Pillar` and `Sigil Dhyana`: brief framing without
     requiring real ritual gear; the practice should be feasible from
     a seat with eyes closed.
   - For `Single Instrument Listening`: tell the user to queue a song
     before starting and stay with the one instrument until the bell.
   - Append entries to `PRESET_COPY`.

2. **Append `_build_preset(...)` rows to `_ALTERNATIVE_PRESETS` in `seed_practices.py`**
   - All eight at `stage_number=5`.
   - All use `_meditation_timer(duration_minutes, halfway_bell=<bool>)`.
   - Group under a `# Stage 5 alternatives — activation / manifestation.` comment.

3. **Tests in `backend/tests/test_seed_practices.py`**
   - One assertion test per preset.
   - Bump `EXPECTED_PRESET_COUNT` by +8.

## Acceptance Criteria

- [ ] `pytest backend/tests/test_seed_practices.py` green.
- [ ] All eight rows present after `seed_practices(session)`.
- [ ] `STAGE_TO_PRESET_NAME[5]` is still `"Wim Hof method"`.
- [ ] `GET /practices?stage=5` returns 9 rows.
- [ ] Re-running the seeder is a no-op.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/seed_practices.py` | Modify — append 8 entries to `_ALTERNATIVE_PRESETS` |
| `backend/src/seed_practice_copy.py` | Modify — add 8 copy tuples + `PRESET_COPY` entries |
| `backend/tests/test_seed_practices.py` | Modify — add 8 assertion tests, bump expected count |

## Constraints

- Names must be unique across `PRESET_COPY`.
- Do not change the canonical `Wim Hof method` entry.
- Do not introduce new modes.
- Every breathwork preset must carry an explicit safety note in its
  instructions.
