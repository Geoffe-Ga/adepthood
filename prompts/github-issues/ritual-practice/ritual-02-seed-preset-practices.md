# ritual-02: Seed 10 preset practices aligned to stages

**Labels:** `ritual-practice`, `backend`, `feature`, `priority-high`
**Epic:** Ritual Practice Screen
**Depends on:** ritual-01 (mode + mode_config columns exist)
**Estimated LoC:** ~300 (seed module + tests)

## Problem

The catalog needs 10 stage-aligned defaults so a user advancing through the
course always has a concrete recommended practice. The seed must be
**idempotent** (re-runnable without duplicates) and aligned to the existing
`seed_stages.py` conventions.

## Scope

Add a `seed_practices.py` module that inserts the 10 presets if missing,
mapped to stages 1–10, with mode-correct configs. The seed runs at app
startup behind the same flag as `seed_stages` (or whatever existing seeding
hook lives in `main.py` / `database.py`).

## Tasks

1. **Create `backend/src/seed_practices.py`**
   - Module-level constant `PRESET_PRACTICES: list[dict[str, Any]]`, one
     entry per stage. Each entry is plain JSON (no SQLModel imports at
     definition time) so it round-trips through the Pydantic validators.
   - Use the table below as the source of truth.

   | Stage | Name                       | Mode               | mode_config (key fields)                                            |
   |-------|----------------------------|--------------------|---------------------------------------------------------------------|
   | 1     | 5-4-3-2-1 grounding        | `sense_grounding`  | prompts: 5×Sight → 4×Touch → 3×Hearing → 2×Smell → 1×Taste          |
   | 2     | Tarot meditation           | `tarot`            | deck=major_arcana, per_card_minutes=5, hide_timer_during_meditation=true |
   | 3     | Belly breathing            | `meditation_timer` | duration_minutes=10, halfway_bell=false, end_bell=true              |
   | 4     | Metta                      | `meditation_timer` | duration_minutes=15, halfway_bell=true, end_bell=true               |
   | 5     | Wim Hof method             | `meditation_timer` | duration_minutes=20                                                  |
   | 6     | Shadow work                | `metronome`        | bpm=60, timer={duration_minutes=30, halfway_bell=true}              |
   | 7     | Blissy meditation          | `meditation_timer` | duration_minutes=45                                                  |
   | 8     | Dog Walkin' Shamanism      | `count_up`         | soft_cap_minutes=null                                                |
   | 9     | Concentration practice     | `meditation_timer` | duration_minutes=45, halfway_bell=true                              |
   | 10    | Insight practice           | `meditation_timer` | duration_minutes=45                                                  |

   - Each entry also carries `description` and `instructions` (≤2k / ≤10k
     chars per the model). Keep them tight; product copy can be edited later
     by amending the seed.
   - `submitted_by_user_id=None`, `approved=True`.

2. **`async def seed_practices(session: AsyncSession) -> int`**
   - Mirror `seed_stages`: `select(Practice.name, Practice.stage_number)`
     to find what's already there; insert only what's missing. Match by
     `(stage_number, name)` so a user with the same name as a preset doesn't
     collide.
   - Validate each preset through the new `ModeConfig` discriminated union
     before insert — a typo in the seed must crash the seeder, not the
     runtime.
   - Return the number of rows inserted (callers log it).

3. **Wire into the existing seed hook**
   - Find where `seed_stages` is invoked (likely `database.py` startup or a
     `seed_all` helper) and add `seed_practices` next to it. Keep the order:
     stages → practices, since the latter conceptually depends on stage
     numbers existing (though not via FK).

4. **Tests** (`backend/tests/test_seed_practices.py`)
   - `seed_practices` inserts 10 rows on an empty DB and returns 10.
   - Re-running on a populated DB inserts 0 rows and returns 0.
   - Each preset's `mode_config` round-trips through `ModeConfig`.
   - All 10 stage numbers (1..10) are covered exactly once.
   - Sense-grounding preset has exactly 5 prompts in 5/4/3/2/1 sense order.
   - Metronome preset's BPM is in [20, 240] and embedded timer
     `duration_minutes > 0`.

## Acceptance Criteria

- Fresh DB → 10 presets seeded after first startup.
- `pytest backend/tests/test_seed_practices.py -q` passes locally.
- Re-running the seeder is a no-op (no duplicates, no exceptions).
- The seeded rows are visible via `GET /practices/?stage_number=N`.
- Coverage on `seed_practices.py` ≥ 95% line.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/seed_practices.py` | **Create** |
| `backend/src/database.py` *(or wherever `seed_stages` is invoked)* | Modify |
| `backend/tests/test_seed_practices.py` | **Create** |

## If you blow the budget

The 10 preset definitions can grow large because of the `instructions` field.
Move long-form copy into `backend/src/seed_practice_copy.py` (a pure data
module imported by the seeder) so the seeder logic stays small and the copy
becomes diff-friendly for product edits.
