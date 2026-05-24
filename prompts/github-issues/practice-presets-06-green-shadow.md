# practice-presets-06: Seed GREEN (stage 6) alternative shadow-work presets

**Labels:** `backend`, `feature`, `practice`, `seeding`
**Epic:** [Spiral Dynamics practice-preset catalog expansion](practice-presets-epic.md)
**Depends on:** none
**Estimated LoC:** ~275

## Role

You are a backend engineer adding stage-6 alternative presets to the
catalog. You follow the existing seed-preset pattern in
`backend/src/seed_practices.py` and validate every payload at import
time via `ModeConfigAdapter`.

## Goal

Seed **eight** new GREEN-band shadow-work alternatives at stage 6 so
the catalog menu carries a deeper toolkit beyond canonical "Coal to
Gold" Shadow Work. The new presets are:

| Name                            | Mode               | Duration | Halfway bell | Source row                                                       |
|---------------------------------|--------------------|----------|--------------|------------------------------------------------------------------|
| Chair Work                      | `meditation_timer` | 30 min   | Yes          | "Chair work (self vs. shadow) alternating every 5 min"           |
| Wording Through It              | `meditation_timer` | 30 min   | Yes          | "Wording Through it" — speak the shadow content aloud            |
| Wilber 3-2-1                    | `meditation_timer` | 30 min   | Yes          | "Wilber's '3-2-1' Practice"                                      |
| Emotion Transmutation           | `meditation_timer` | 30 min   | Yes          | "Tibetan Buddhist emotion transmutation"                         |
| Pain Body Meditation            | `meditation_timer` | 30 min   | Yes          | "Meditating on the Pain Body a la Eckhart Tolle"                 |
| Letter to the Repressed Self    | `count_up`         | —        | —            | "Stream of consciousness quick-write of a letter to your most repressed self" |
| Shadow Drawing                  | `count_up`         | —        | —            | "Drawing your shadow self and holding eye contact with it"       |
| REACH Inward                    | `meditation_timer` | 30 min   | Yes          | "REACH directed inward (From Rise Above)"                        |

## Context

Stage 6's canonical preset is `Shadow work` (`metronome`, 30 min). The
new alternatives mostly hold to a 30-minute sit consistent with the
stage. **Two** of the alternatives are open-ended creative practices —
`Letter to the Repressed Self` and `Shadow Drawing` — and use
`count_up` mode so the user can take as long as the practice asks for.

The `count_up` mode is already exercised by the canonical
`Dog Walkin' Shamanism` preset
(`seed_practices.py:230-236`). Use the same shape:
```python
mode="count_up",
mode_config={"mode": "count_up", "soft_cap_minutes": None},
default_duration_minutes=_COUNT_UP_NOMINAL_DURATION_MINUTES,
```
The `_COUNT_UP_NOMINAL_DURATION_MINUTES` constant is already defined
at `seed_practices.py:46` — reuse it; do not introduce a per-issue
duplicate.

For `Chair Work`: the source row says "alternating every 5 min."
Encode the cadence in the instructions ("every five minutes, swap
chairs"), not in the engine. A `metronome` or `interval_bell`
implementation might be a nicer fit later, but is out of scope for
this content-only issue.

## Tasks

1. **Add `(description, instructions)` tuples to `seed_practice_copy.py`**
   - One constant per preset, suffixed with the slug.
   - For `Chair Work`: explain the two-chair / inner-critic technique
     and tell the user to physically switch seats every five minutes.
   - For `Wilber 3-2-1`: name the three steps (face it / talk to it /
     be it) so a first-timer can perform the practice without a
     reference.
   - For `Pain Body Meditation`: include the Tolle framing — observe
     the pain body as a distinct presence rather than identifying
     with it.
   - For the two `count_up` practices: tell the user they can stop
     when the practice feels complete and mark the session done.
   - Append entries to `PRESET_COPY`.

2. **Append `_build_preset(...)` rows to `_ALTERNATIVE_PRESETS` in `seed_practices.py`**
   - Six entries use `_meditation_timer(30, halfway_bell=True)`.
   - Two entries (`Letter to the Repressed Self`, `Shadow Drawing`)
     use the `count_up` shape above.
   - Group under a `# Stage 6 alternatives — shadow work.` comment.

3. **Tests in `backend/tests/test_seed_practices.py`**
   - One assertion test per preset. For the `count_up` presets,
     verify `mode == "count_up"` and `mode_config["soft_cap_minutes"]
     is None` (matching the canonical Dog Walkin' Shamanism test).
   - Bump `EXPECTED_PRESET_COUNT` by +8.

## Acceptance Criteria

- [ ] `pytest backend/tests/test_seed_practices.py` green.
- [ ] All eight rows present after `seed_practices(session)`.
- [ ] `STAGE_TO_PRESET_NAME[6]` is still `"Shadow work"`.
- [ ] `GET /practices?stage=6` returns 9 rows.
- [ ] Re-running the seeder is a no-op.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/seed_practices.py` | Modify — append 8 entries to `_ALTERNATIVE_PRESETS` |
| `backend/src/seed_practice_copy.py` | Modify — add 8 copy tuples + `PRESET_COPY` entries |
| `backend/tests/test_seed_practices.py` | Modify — add 8 assertion tests, bump expected count |

## Constraints

- Names must be unique across `PRESET_COPY`.
- Do not change the canonical `Shadow work` entry.
- Do not introduce new modes; the two `count_up` presets reuse the
  already-validated shape from Dog Walkin' Shamanism.
- Shadow-work copy should warn that strong emotion is possible and
  invite the user to pause / journal rather than push through — match
  the careful voice of the canonical entry at
  `seed_practice_copy.py:64-70`.
