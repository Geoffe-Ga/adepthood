# Epic: Generalize grounding techniques (Find Shapes, Find Colors, Touch Grass, Mindful Eating)

**Labels:** `epic`, `backend`, `frontend`, `feature`
**Scope:** Backend (2 new practice modes + presets) + Frontend (2 new ritual views)
**Estimated total LoC:** ~1,100

## Role

You are a full-stack engineer extending Adepthood's mode-discriminated
practice engine. You preserve existing contracts (`sense_grounding` is
not refactored), and add new modes by following the established
discriminated-union pattern.

## Goal

Add four new grounding techniques to the practice catalog by generalizing
the data models and UX flows that today drive the 5-4-3-2-1 sense-grounding
ritual. After this epic ships, users can complete: **Find Shapes**, **Find
Colors**, **Touch Grass**, and **Mindful Eating** — all stage-aligned, all
session-logged, all using the same `Practice` / `PracticeSession` tables.

## Context

The practice engine is already mode-discriminated (see
`backend/src/domain/practice_modes.py:15-28`,
`backend/src/schemas/practice_mode_config.py:144-156`,
`backend/src/schemas/practice_session_metadata.py:94-106`). Each mode adds:

1. A value to `PracticeMode` (StrEnum) + a `CHECK` constraint migration
2. A `*Config` model in `practice_mode_config.py` (authoring input)
3. A `*Metadata` model in `practice_session_metadata.py` (runtime output)
4. Entries in the two `Annotated[... Field(discriminator="mode")]` unions
5. A frontend view component in `frontend/src/features/Practice/views/`
6. A dispatcher case in
   `frontend/src/features/Practice/components/ActiveRitualSession.tsx`
7. Engine type entries in `frontend/src/features/Practice/engine/types.ts`
8. (Optional) Preset rows in `backend/src/seed_practices.py`

Today the only "step-based" grounding mode is `sense_grounding`, with
**hard-coded** 5-4-3-2-1 counts in
`frontend/src/features/Practice/views/SenseGroundingView.tsx:24-30`.
The four new techniques cluster into two patterns:

| Technique         | Pattern                                                       | New mode             |
|-------------------|---------------------------------------------------------------|----------------------|
| Find Shapes       | 3 rounds × [squares×3, triangles×3, circles×3]                | `tallied_grounding`  |
| Find Colors       | 3 rounds × [red×1, orange×1, …, violet×1] (7 colors)          | `tallied_grounding`  |
| Touch Grass       | One mindful act on a chosen surface (grass/soil/sand/stone)   | `mindful_anchor`     |
| Mindful Eating    | One mindful act on a chosen grounding food                    | `mindful_anchor`     |

We deliberately introduce **two** new modes rather than four, because
shapes/colors share a "rounds × categories × target_count" data shape,
and touch-grass/eating share a "single mindful act with chooser + soft
duration floor" data shape. `sense_grounding` is left untouched so this
epic carries zero migration risk to existing seeded data.

## Output Format

Six sub-issues, each shippable independently. Backend modes ship first
(unblock presets and views). Presets and views can land in parallel once
the mode lands. The dependency graph:

```
01 tallied-mode-backend ──┬── 03 tallied-presets
                          └── 05 tallied-view-frontend

02 mindful-anchor-mode ───┬── 04 mindful-anchor-presets
                          └── 06 mindful-anchor-view-frontend
```

## Sub-issues

| # | Title                                                          | Scope    | LoC |
|---|----------------------------------------------------------------|----------|-----|
| 01 | [Add `tallied_grounding` mode](grounding-techniques-01-tallied-mode-backend.md) | Backend  | ~250 |
| 02 | [Add `mindful_anchor` mode](grounding-techniques-02-mindful-anchor-mode-backend.md) | Backend  | ~200 |
| 03 | [Seed Find Shapes + Find Colors presets](grounding-techniques-03-presets-shapes-and-colors.md) | Backend  | ~100 |
| 04 | [Seed Touch Grass + Mindful Eating presets](grounding-techniques-04-presets-touch-grass-and-mindful-eating.md) | Backend  | ~100 |
| 05 | [Build `TalliedGroundingView`](grounding-techniques-05-tallied-view-frontend.md) | Frontend | ~250 |
| 06 | [Build `MindfulAnchorView`](grounding-techniques-06-mindful-anchor-view-frontend.md) | Frontend | ~200 |

## Acceptance Criteria (epic-level)

- [ ] All four techniques are seeded presets, browsable in the catalog
- [ ] Each completes end-to-end: start → step through → save → session row written
- [ ] `sense_grounding` behavior is unchanged (regression tests still green)
- [ ] `pre-commit run --all-files` green on every sub-issue PR
- [ ] Coverage thresholds (90% line, 80% branch, 85% docstring) unchanged

## Constraints

- Do **not** refactor `sense_grounding` into `tallied_grounding`. They
  stay parallel. A future migration epic can fold them if desired.
- Each `*Config` and `*Metadata` model must be a discriminated `_ConfigBase`
  / `_MetadataBase` subclass with `mode: Literal["..."]` and `extra="forbid"`.
- Each new mode value requires an Alembic migration that drops + recreates
  the `practice.mode` CHECK constraint with the expanded `ALL_MODES` tuple.
- Frontend views dispatch off `effectiveConfig.mode` in `ActiveRitualSession`.
  Do not introduce any other mode-branching site.
- Soft duration gating on `mindful_anchor` (encourage, don't enforce) —
  surface elapsed time and a gentle nudge if `duration_seconds <
  min_duration_seconds`, but allow save anyway.

## References

- `backend/src/models/practice.py:20-58` — `Practice` table with `mode` / `mode_config`
- `backend/src/models/practice_session.py:14-61` — `PracticeSession` with `mode_metadata`
- `backend/src/domain/practice_modes.py:15-28` — `PracticeMode` enum
- `backend/src/schemas/practice_mode_config.py` — discriminated config union
- `backend/src/schemas/practice_session_metadata.py` — discriminated metadata union
- `backend/src/seed_practices.py:54-98` — preset seeding pattern
- `frontend/src/features/Practice/engine/types.ts:55-65` — frontend mode types
- `frontend/src/features/Practice/views/SenseGroundingView.tsx` — reference view
- `frontend/src/features/Practice/components/ActiveRitualSession.tsx:26-100` — dispatcher
