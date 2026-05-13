# 2026-05-13 — Ritual Practice Epic: Backlog Grooming

**Scope:** All 12 ritual-practice issues are merged (PRs #307, #309–#315, #319, #324, #325, #326). This file consolidates reviewer-flagged debt, operational gaps, and prioritised follow-ups so a single ops/polish sweep can close out the epic.

## Status snapshot

- 12 / 12 issues merged.
- 4 PRs (#307, #313, #314, #325) were merged after the author addressed reviewer blockers but **without a fresh re-review comment** flipping the verdict from CHANGES_REQUESTED → LGTM. The fixes appear sound by inspection; the audit trail is incomplete.
- The hot path is wired end-to-end (`PracticeScreen` → `useRitualEngine` → mode views → adapters → backend session POST → insights), so a happy-path session can complete and persist on a database that has been manually seeded.

## Operational verification

| Check | State |
| --- | --- |
| `frontend/assets/sounds/bell-{start,half,end}.mp3` | ✅ present |
| `frontend/assets/sounds/metronome-tick.wav` | ❌ **missing** — adapter falls back to silent + warn-once |
| `expo-haptics`, `expo-keep-awake`, `expo-av`, `react-native-svg` | ✅ declared deps |
| Backend seeders (`seed_practices`, `seed_practice_copy`, `seed_stages`) | ⚠️ **not auto-invoked at startup** — fresh DB has no presets, no stage copy |
| Alembic graph | ⚠️ multi-head merged via `c5ed9dd1dabc`; CI downgrade exercises only one branch |
| Frontend `INSIGHT_MAX_LENGTH` vs backend `PRACTICE_INSIGHT_MAX_LENGTH = 2_000` | ⚠️ matched via "KEEP IN SYNC" comment; no automated cross-check |
| No `// @ts-ignore`, `// eslint-disable`, `# noqa`, `# type: ignore` introduced by ritual code | ✅ (pre-existing test-file import/order suppressions and two intentional backend noqa in `practices.py`) |

## P0 — blocks "fully operational"

1. **Bundle `metronome-tick.wav`** in `frontend/assets/sounds/` and wire it in `engine/adapters/audio.ts`. Today every metronome session loses its primary cue audio. The graceful fallback masks the gap — easy to ship and not notice in QA.
2. **Wire seeders into application startup** (FastAPI lifespan or a one-shot migration data step). `ritual-02`, `ritual-05`, and the stage-copy seeds are merged as scripts but nothing invokes them. On a fresh database the practice catalog and frequency banner are empty.

## P1 — launch-critical

3. **CI: downgrade smoke test for the ritual-04 branch of `c5ed9dd1dabc`.** Only the ritual-03 branch is currently exercised. A bad downgrade through ritual-04 ships undetected.
4. **Re-review or self-verify the four CHANGES_REQUESTED merges** (#307, #313, #314, #325). Confirm each blocker's fix actually matches the original concern — they were not re-reviewed before merge.
5. **`mode_config_override` JSON column size cap.** Unbounded today (flagged in #312). DoS / payload-bloat risk on a public endpoint.
6. **Migration round-trip test pattern.** #307 lacked one until reviewer flagged. Codify in `backend/tests/test_migrations.py` for every new revision (could be parametrised over the migrations directory).
7. **Insight-length cap sync.** Replace the comment-only cross-check between frontend `INSIGHT_MAX_LENGTH` and backend `PRACTICE_INSIGHT_MAX_LENGTH` with an OpenAPI-derived value or shared schema fetch (#324).
8. **Verify BUG-FE-PRACTICE-005 regression test is active.** Test was deleted in pre-#325 work and restored during review. Confirm CI runs it and that it still asserts the original failure mode (#325).
9. **Extract `backend/scripts/resolve_prev_revision.py`** from inline CI Python (#319). Today the merge-migration downgrade logic lives in a `.github/workflows/backend-ci.yml` heredoc — hard to test, hard to evolve.

## P2 — polish / tech debt

### Backend
- `MetronomeConfig.timer` requires redundant nested `mode:"meditation_timer"` discriminator (#307 ergonomics).
- `IntervalBellConfig.interval_minutes` has no upper bound (#307).
- Alembic revisions `f0a1b2c3d4e5`, `83b01b64cad3` etc. are monotone-hex, not random — convention drift (#311, #312).
- `HTTPException` raised directly in `_validate_override_against_catalog` bypasses error factories — inconsistent 422 envelope (#312).
- `_user_practice_payload` manually mirrors the SQLModel — staleness risk (#312).
- `_frequency_from_active` does two DB round-trips; `joinedload` candidate (#326).
- `FrequencyResponse.color` / `.aspect` should be `Literal` of Spiral Dynamics values (#326).
- `cast("int", ...)` string-form → `cast(int, ...)` (#326).
- `_DEFAULT_STAGE_NUMBER` duplicates private `domain.stage_progress._STAGE_1` — expose a public helper (#326).
- `_load_active_user_practice` could add `.limit(1)` to encode partial-unique-index invariant in SQL (#326).
- `test_frequency_practice_row_on_other_stage_ignored` doesn't assert POST `status_code == CREATED` (#326).
- `seed_practices` imported from production router code path — extract `STAGE_TO_PRESET_NAME` to shared constants (#326).
- Per-preset copy-length unit test (#319) — Pydantic enforces at write but explicit test missing.
- `effective_name: str | None` could tighten to `str` once orphan-FK case is handled consumer-side (#312).
- Multi-paragraph docstrings introduced in `user_practices.py` (#326) — CLAUDE.md violation.

### Frontend
- `cardForDayIndex` docstring inaccurate vs implementation (#313).
- `TarotMeditationView` save button lacks disabled visual state (#313).
- `IntervalBellForm` offset duplicates use array index as key (#314).
- `setItems([])` reset on `stageNumber` change in switcher sheet — currently unreachable but worth a guard (#315).
- `useMountedRef`'s `mountedRef.current = true` reassignment lacks Strict Mode comment (#315).
- `useFrequency` shipped at ~478% of LoC estimate (#315) — flag for planning calibration on future configurator-style features.

## Recommended next actions

1. **One ops PR** that lands P0-1, P0-2, P1-3, P1-9 together. These are operational, not feature work, and trying to split them invites further drift.
2. **One backlog-cleanup PR** that lands P1-5, P1-6, P1-7. These are small, schema-adjacent, and best landed before more consumers depend on them.
3. **One self-audit pass** (P1-4 + P1-8): walk each CHANGES_REQUESTED PR's blocker list against the merged diff; close the audit loop with comments on each PR.
4. Defer all P2 items to a dedicated `ritual-polish` follow-up issue with the per-PR breakdown above — most are 1–5 lines each and naturally batch.
