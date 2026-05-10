# ritual-04: Session analytics + insights

**Labels:** `ritual-practice`, `backend`, `feature`, `priority-high`
**Epic:** Ritual Practice Screen
**Depends on:** ritual-01 (modes), ritual-03 (effective_config resolver)
**Estimated LoC:** ~500

## Problem

`PracticeSession` today stores `(user_practice_id, duration_minutes,
timestamp, reflection)` — fine for a generic timer, but blind to mode-specific
data: how many reps did the user log? Did the metronome run at the catalog
BPM or a customized one? Which tarot card was up? Did they finish or abort?

The product spec also says **"capture insights and analytics"** — we need a
rollup endpoint the screen can show ("you've meditated 4×/week for 3 weeks
running, average duration 18 minutes") without n-queries on the client.

## Scope

Extend `PracticeSession` with mode-aware metadata + an `insight` column,
expose `POST /practice-sessions/` to accept the new payload, and add a
`GET /practice-sessions/insights` rollup.

## Tasks

1. **Extend `PracticeSession` model**
   - Add nullable columns:
     - `mode: str` (the resolved mode at session time — denormalized so the
       rollup doesn't have to join through `Practice` on every query, and so
       a future catalog edit doesn't retro-rewrite history).
     - `mode_metadata: dict[str, Any]` (JSON, nullable). Stores e.g.
       `{rep_count: 108}`, `{bpm_used: 72}`, `{tarot_card_index: 5}`,
       `{intervals_struck: 4, total_intervals: 6}`,
       `{senses_completed: ["sight","touch"]}`.
     - `completed: bool = True` — false if the user cancelled before the
       target was reached.
     - `insight: str | None` (≤2k) — short user-captured takeaway,
     - distinct from the existing long-form `reflection`.
   - Migration: additive; backfill `mode='meditation_timer'`, `completed=true`,
     leave `mode_metadata` and `insight` null.

2. **Per-mode metadata schemas** in
   `backend/src/schemas/practice_session_metadata.py`
   - One Pydantic model per mode mirroring the engine outputs (e.g.
     `RepCounterMetadata { rep_count: int >= 0 }`,
     `MetronomeMetadata { bpm_used: int }`,
     `IntervalBellMetadata { intervals_struck: int, total_intervals: int }`,
     `TarotMetadata { card_index: int 0..21 }`,
     `SenseGroundingMetadata { senses_completed: list[Sense] }`,
     `MeditationTimerMetadata { /* empty by design */ }`,
     `CountUpMetadata { /* empty by design */ }`).
   - Discriminated union `SessionMetadata` keyed on `mode`.
   - Validator: `mode` must equal the parent session's `mode`.

3. **Update `SessionCreate`** in `backend/src/schemas/practice_session.py`
   - Accepts `mode_metadata: SessionMetadata | None`, `completed: bool =
     True`, `insight: str | None = None`.
   - Server-side derivation: if `mode_metadata` is provided, its
     discriminator must match the resolved practice mode (use
     `effective_config` from ritual-03). Otherwise `mode_metadata` stays
     null. Mismatch → 400 `mode_metadata_mismatch`.
   - The session's `mode` column is set from the resolved practice mode at
     write time (not from the client) — clients can't mislabel sessions.

4. **Insights rollup** — `backend/src/domain/practice_insights.py`
   - Pure-Python aggregator over a list of `PracticeSession` rows. Returns:
     - `weekly_counts: list[{week_start: date, count: int}]` — last 8 weeks.
     - `streak_weeks: int` — consecutive weeks meeting the 4×/week target.
     - `total_minutes_30d: float`.
     - `avg_duration_minutes_30d: float | None` (null if no sessions).
     - `per_mode_counts: dict[str, int]` — last 30 days, keyed by mode.
     - `last_insight: str | None` — most recent non-null `insight`.
   - Keep the date math in `domain/dates.py` helpers (already exist for
     `today_in_tz`); the rollup must respect the user's timezone.

5. **Endpoint** — `backend/src/routers/practice_sessions.py`
   - `GET /practice-sessions/insights` returns the rollup for the current
     user.
   - Single SQL query selects sessions in the last 60 days; aggregator does
     the rest in memory (cheap; max ~hundreds of rows per user).
   - Cache-control header set to `private, max-age=60` so the client can
     poll without hammering the DB.

6. **Tests** (`backend/tests/test_practice_session_metadata.py`,
   `test_practice_insights.py`, extend `test_practice_sessions.py`)
   - Each metadata model round-trips; mismatched discriminator rejected.
   - `POST /practice-sessions/` with rep counter metadata stores
     `mode_metadata` correctly; subsequent `GET /…?user_practice_id=X`
     echoes it back.
   - `POST` with `completed=false` is recorded and counted toward weekly
     totals iff `duration_minutes > 0` (decision: count partial sessions but
     flag them).
   - `POST` with `insight="..."` persists; `GET …/insights.last_insight` is
     the most recent non-null insight across all the user's practices.
   - Insights rollup: 5 sessions across 3 weeks → `weekly_counts` has 8
     entries, the most recent non-zero ones in the right buckets;
     `streak_weeks` reflects the 4×/week threshold correctly (test the
     boundary: exactly 4 counts, 3 doesn't).

## Acceptance Criteria

- Session POST accepts mode-specific metadata and an insight string.
- Insights endpoint returns the documented shape and respects the user's
  timezone.
- Existing session POST clients continue working (new fields are optional,
  backfill handled).
- Coverage targets met.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/models/practice_session.py` | Modify |
| `backend/alembic/versions/<rev>_practice_session_metadata.py` | **Create** |
| `backend/src/schemas/practice_session_metadata.py` | **Create** |
| `backend/src/schemas/practice_session.py` | Modify |
| `backend/src/domain/practice_insights.py` | **Create** |
| `backend/src/routers/practice_sessions.py` | Modify |
| `backend/tests/test_practice_session_metadata.py` | **Create** |
| `backend/tests/test_practice_insights.py` | **Create** |
| `backend/tests/test_practice_sessions.py` | Modify |

## If you blow the budget

Split as `04a` (model + migration + per-mode metadata schemas + POST
acceptance) and `04b` (insights rollup module + endpoint + tests). The POST
side blocks `ritual-12` (frontend insight capture); the rollup side blocks
`ritual-11` (weekly progress display).
