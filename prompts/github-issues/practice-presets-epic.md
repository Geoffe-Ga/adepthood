# Epic: Spiral Dynamics practice-preset catalog expansion

**Labels:** `epic`, `backend`, `feature`, `practice`, `seeding`
**Scope:** Backend (preset rows + copy + tests). No new modes, no migrations,
no frontend changes.
**Estimated total LoC:** ~1,900 across 7 sub-issues.

## Role

You are a backend engineer extending the seeded practice catalog with
alternative presets that share each stage with the canonical practice.
You follow the established seed-preset pattern (`seed_practices.py` +
`seed_practice_copy.py`) and validate every payload at import time via
`ModeConfigAdapter`.

## Goal

Add **~60 alternative presets** across stages 1-8 so each Spiral Dynamics
frequency band offers users a deep menu of practices they can swap in for
the canonical stage practice. Source content is the practitioner-authored
"alternative practices per frequency" table — one column per color, each
row a discrete practice with its own instructions.

After this epic ships, the catalog browse screen shows the canonical
preset *plus* this color's alternatives whenever the user opens the
practice catalog at a given stage.

## Context

The catalog is mode-discriminated and already supports multiple
alternative presets per stage — see the stage-1 alternatives Touch Grass,
Mindful Eating, Find Shapes, Find Colors in
`backend/src/seed_practices.py:257-314`. The seeder is idempotent on
`(stage_number, name)` and a partial unique index at the DB layer
arbitrates races (migration `d2e3f4a5b6c7`). Adding a preset is a
content-only change:

1. Add `(description, instructions)` to `PRESET_COPY` in `seed_practice_copy.py`.
2. Append a `_build_preset(...)` entry to `_ALTERNATIVE_PRESETS` in
   `seed_practices.py` with a validated `mode_config`.
3. Add catalog assertion tests in `tests/test_seed_practices.py`
   (mode, key fields, idempotency).

No new `PracticeMode` enum values are needed — every preset in the source
table maps to an existing mode (`meditation_timer`, `count_up`, or
`mindful_anchor`). No migrations are needed. No frontend changes are
needed: the catalog screen, frequency banner, and `UserPractice`
customization flow already iterate over whatever presets exist.

## Stage-to-color mapping

| Stage | Color       | Canonical (already seeded)          | Alternatives in source table |
|-------|-------------|-------------------------------------|------------------------------|
| 1     | BEIGE       | `5-4-3-2-1 grounding`               | 10 (3 already seeded as Touch Grass / Find Shapes / Find Colors) |
| 2     | PURPLE      | `Tarot meditation`                  | 8 |
| 3     | RED         | `Belly breathing`                   | 10 |
| 4     | BLUE        | `Metta`                             | 10 |
| 5     | ORANGE      | `Wim Hof method`                    | 8 |
| 6     | GREEN       | `Shadow work`                       | 8 |
| 7     | YELLOW      | `Blissy meditation`                 | 0 (source row is "see Blissy instructions") |
| 8     | TEAL        | `Dog Walkin' Shamanism`             | 9 |
| 9     | ULTRAVIOLET | `Concentration practice`            | 0 (no alternatives in source) |
| 10    | CLEAR LIGHT | `Insight practice`                  | 0 (no alternatives in source) |

YELLOW, ULTRAVIOLET, and CLEAR LIGHT have no alternatives in the source
table and are not part of this epic.

## Sub-issues

| # | Title | Stage | New presets | LoC |
|---|-------|-------|-------------|-----|
| 01 | [Seed BEIGE alternatives](practice-presets-01-beige-grounding.md)        | 1 | 7 | ~250 |
| 02 | [Seed PURPLE alternatives](practice-presets-02-purple-divination.md)     | 2 | 8 | ~275 |
| 03 | [Seed RED alternatives](practice-presets-03-red-energy.md)               | 3 | 10 | ~325 |
| 04 | [Seed BLUE alternatives](practice-presets-04-blue-heart.md)              | 4 | 10 | ~325 |
| 05 | [Seed ORANGE alternatives](practice-presets-05-orange-activation.md)     | 5 | 8 | ~275 |
| 06 | [Seed GREEN alternatives](practice-presets-06-green-shadow.md)           | 6 | 8 | ~275 |
| 07 | [Seed TEAL alternatives](practice-presets-07-teal-integration.md)        | 8 | 9 | ~300 |

All seven sub-issues are **fully independent** — they touch the same
three files but at disjoint locations (different stage_number rows,
different `PRESET_COPY` keys, different test functions). Conflicts on
merge are limited to import-ordering / list-append friction that resolves
trivially. They can ship in any order or in parallel.

## Acceptance Criteria (epic-level)

- [ ] ~60 new alternative presets seeded across 7 stages.
- [ ] `STAGE_TO_PRESET_NAME` (canonical pointer) is unchanged after each PR.
- [ ] `pytest backend/` green, coverage thresholds unchanged.
- [ ] `pre-commit run --all-files` green on every sub-issue PR.
- [ ] `python -m seed_practices` on a fresh DB inserts every new preset
      exactly once and is idempotent on re-run.
- [ ] `GET /practices?stage=N` returns each new preset alongside the
      stage's canonical and any prior alternatives.

## Constraints

- **Do not** alter `_CANONICAL_PRESETS`. Only `_ALTERNATIVE_PRESETS` and
  `PRESET_COPY` change.
- **Do not** introduce new `PracticeMode` values, schemas, or Alembic
  migrations. Every preset uses one of: `meditation_timer`, `count_up`,
  `mindful_anchor`.
- **Preset names must be unique** across the entire catalog (the
  import-time guard at `seed_practices.py:337-341` enforces this). Pick
  short, clear, capitalized names; do not reuse a name already in
  `PRESET_COPY`.
- **Skip source rows that duplicate an already-seeded preset.** For
  stage 1 specifically:
  - *Stand Barefoot Outdoors* ≈ existing `Touch Grass` — skip.
  - *Square - Circle - Triangle x5* ≈ existing `Find Shapes` — skip.
  - *Colors of the Rainbow* ≈ existing `Find Colors` — skip.
- Each preset's `mode_config` must round-trip through
  `ModeConfigAdapter.validate_python()` — the seeder does this at import
  time so a typo crashes the seeder, not production startup.
- Keep descriptions ≤ 2000 chars, instructions ≤ 10000 chars (matches
  the `Practice` column caps).
- Use the existing duration ladder for each stage as a default
  (stage 1 ≈ 3-5 min, stage 3 ≈ 10 min, stage 4 ≈ 15 min, stages 5-6 ≈
  20-30 min, stage 8 = `count_up` for open-ended).

## Mode selection guidance

| Source-row shape                                          | Mode             |
|-----------------------------------------------------------|------------------|
| Timed sit / breath / visualization with start/end bell    | `meditation_timer` |
| Long sit benefiting from a mid-bell                       | `meditation_timer` with `halfway_bell=True` |
| Open-ended journaling / drawing / walking                 | `count_up` |
| Single-act presence with a chooser (e.g. Touch Grass)     | `mindful_anchor` |

No source row in this epic requires `tarot`, `metronome`, `interval_bell`,
`rep_counter`, `tallied_grounding`, `card_meditation`, or
`random_interval_bell`. If a sub-issue author thinks a row really wants
one of those, surface the choice in the PR description instead of
silently switching — the bar for adding a different-mode alternative is
higher than just "it might work."

## References

- `backend/src/models/practice.py:20-58` — `Practice` model
- `backend/src/domain/practice_modes.py:15-28` — `PracticeMode` enum (closed)
- `backend/src/seed_practices.py:166-314` — canonical + alternative preset list
- `backend/src/seed_practices.py:316-358` — import-time validation + dedup guards
- `backend/src/seed_practice_copy.py` — `PRESET_COPY` table
- `backend/tests/test_seed_practices.py:233-313` — preset assertion test pattern
- `backend/tests/test_seed_practices.py:339-356` — global preset invariants
- `prompts/github-issues/grounding-techniques-03-presets-shapes-and-colors.md` — closest precedent
