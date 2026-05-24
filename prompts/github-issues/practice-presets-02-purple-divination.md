# practice-presets-02: Seed PURPLE (stage 2) alternative divination / symbol presets

**Labels:** `backend`, `feature`, `practice`, `seeding`
**Epic:** [Spiral Dynamics practice-preset catalog expansion](practice-presets-epic.md)
**Depends on:** none
**Estimated LoC:** ~275

## Role

You are a backend engineer adding stage-2 alternative presets to the
catalog. You follow the existing seed-preset pattern in
`backend/src/seed_practices.py` and validate every payload at import
time via `ModeConfigAdapter`.

## Goal

Seed **eight** new PURPLE-band divination / symbolic alternatives at
stage 2 so the catalog menu offers a richer set of intuitive practices
beyond the canonical daily Tarot draw. The new presets are:

| Name                  | Mode               | Duration | Halfway bell | Source row                                             |
|-----------------------|--------------------|----------|--------------|--------------------------------------------------------|
| Traffic Lights        | `meditation_timer` | 5 min    | No           | "Traffic lights" — visualize and decode color signals  |
| I Ching Toss          | `meditation_timer` | 10 min   | Yes          | "I Ching coin toss with meditative journaling"         |
| Bibliomancy           | `meditation_timer` | 5 min    | No           | "Bibliomancy: random passage reading and reflection"   |
| Synchronicity Sweep   | `meditation_timer` | 5 min    | No           | "Tracking Synchronicity"                               |
| Trataka Candle Gazing | `meditation_timer` | 10 min   | Yes          | "Candle gazing (Trataka) while inviting intuitive imagery" |
| Dream Recollection    | `meditation_timer` | 10 min   | Yes          | "Dream recollection and symbol mapping"                |
| Archetypal Mantra     | `meditation_timer` | 10 min   | Yes          | "Repetitive mantra with archetypal resonance"          |
| Totem Meditation      | `meditation_timer` | 5 min    | No           | "Meditating on a personal totem or object"             |

## Context

Stage 2's canonical preset is `Tarot meditation` (mode `tarot`). These
alternatives all use the simpler `meditation_timer` engine with
descriptive instructions so they pose zero migration / schema risk — the
intuitive content is in the copy, not the mode.

See `backend/src/seed_practices.py:179-189` for the canonical entry and
`seed_practice_copy.py:26-33` for the voice / length of the canonical
copy.

## Tasks

1. **Add `(description, instructions)` tuples to `seed_practice_copy.py`**
   - One constant per preset, named `_TRAFFIC_LIGHTS`, `_I_CHING_TOSS`,
     `_BIBLIOMANCY`, `_SYNCHRONICITY_SWEEP`, `_TRATAKA`,
     `_DREAM_RECOLLECTION`, `_ARCHETYPAL_MANTRA`, `_TOTEM_MEDITATION`.
   - Each description: 1-2 sentences capturing the practice's flavour.
   - Each instructions block: 3-6 sentences, second-person imperative,
     covering setup, focus, and completion. For divination practices,
     name the *posture* explicitly (e.g. "Sit with the coins in your
     palm before the first toss") so a beginner can perform the
     practice without further context.
   - Append entries to `PRESET_COPY` keyed by display name.

2. **Append `_build_preset(...)` rows to `_ALTERNATIVE_PRESETS` in `seed_practices.py`**
   - All eight at `stage_number=2`.
   - All use `_meditation_timer(duration_minutes, halfway_bell=<bool>)`.
   - Group under a brief comment, e.g.
     `# Stage 2 alternatives — divination / symbolic intuition.`

3. **Tests in `backend/tests/test_seed_practices.py`**
   - One assertion test per preset, mirroring
     `test_touch_grass_preset_seeds`. Verify the row's
     `stage_number`, `mode`, `mode_config.duration_minutes`, and
     `mode_config.halfway_bell` (where set).
   - Bump `EXPECTED_PRESET_COUNT` by +8.

## Acceptance Criteria

- [ ] `pytest backend/tests/test_seed_practices.py` green.
- [ ] All eight rows present after `seed_practices(session)`.
- [ ] `STAGE_TO_PRESET_NAME[2]` is still `"Tarot meditation"`.
- [ ] `GET /practices?stage=2` returns 9 rows (canonical + 8 new).
- [ ] Re-running the seeder is a no-op (idempotent).

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/seed_practices.py` | Modify — append 8 entries to `_ALTERNATIVE_PRESETS` |
| `backend/src/seed_practice_copy.py` | Modify — add 8 copy tuples + `PRESET_COPY` entries |
| `backend/tests/test_seed_practices.py` | Modify — add 8 assertion tests, bump expected count |

## Constraints

- Names must be unique across `PRESET_COPY`.
- Do not change the canonical `Tarot meditation` entry or its config.
- Do not introduce new modes. The intuitive flavour of these practices
  belongs in the copy, not the engine. If you believe a row really
  wants `tarot` or `metronome`, surface the choice in the PR description
  before opening the PR.
- Match the existing copy voice — declarative, present-tense, no
  hedging, no marketing language.
