# audit-testq-01: Un-flake the time-coupled streak test

**Labels:** `audit-testq`, `backend`, `testing`, `priority-critical`
**Epic:** Test Quality & Green Baseline
**Estimated LoC:** ~120  (hard cap 700)

## Problem

`tests/services/test_streaks.py::test_streak_uses_user_timezone_across_utc_midnight`
(`backend/tests/services/test_streaks.py:181-232`) hardcodes both completions on
calendar date 2026-06-15, but `compute_consecutive_streak` measures the chain's
recency against the real wall clock — it walks backwards from `today_in_tz(...)`
(`backend/src/services/streaks.py:118,225`), which resolves to
`datetime.now(...)` in `backend/src/domain/dates.py:88,91`. Once "today" drifts
more than the one-day grace window past 2026-06-15, the recency gate zeroes the
streak and the `== 1` / `== 2` assertions fail. **Current state:** the test is a
§5.4 "time-coupled test" (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:143`) — it passes
only inside a narrow date window and is red today (2026-06-24), which turns the
entire `pytest` run red and means the stay-green baseline is not actually green
(`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:20`).

## Scope

**Covers:** making `test_streak_uses_user_timezone_across_utc_midnight`
time-independent; auditing every other test in `test_streaks.py` (and the streak
service) for the same wall-clock coupling and converting them to relative dates
or a frozen clock; adding one shared, reusable fixture/helper to freeze or
inject "now" for streak tests.

**Does NOT cover:** changing the behavior of `compute_consecutive_streak`,
`compute_habit_streak`, or `today_in_tz`; touching the model tests, BotMason
tests, or any frontend test (those are issues 02–04).

## Tasks

1. **Identify the single clock seam** — confirm `today_in_tz` /
   `now_in_tz` in `backend/src/domain/dates.py` are the only wall-clock entry
   points the streak service reads (`grep` for `datetime.now`, `date.today`,
   `utcnow` under `src/services/streaks.py` and `src/domain/dates.py`). Freeze
   at that seam, not at scattered call sites.
2. **Add a clock-freezing fixture** in `backend/tests/services/test_streaks.py`
   (or `conftest.py` if shared) — monkeypatch the `datetime`/`now` source used
   by `domain.dates` to a fixed instant, e.g. `freeze_now(datetime(2026, 6, 15,
   20, 0, tzinfo=UTC))`. Prefer `monkeypatch.setattr` on the `dates` module's
   clock over hardcoding a third-party library unless one is already a dep.
3. **Rewrite `test_streak_uses_user_timezone_across_utc_midnight`** to run under
   the frozen clock so the hardcoded 2026-06-15 completions are always "current"
   relative to the frozen "today" — the UTC-vs-Pacific divergence (1 vs 2)
   stays asserted exactly, independent of the system date.
4. **Audit and harden the rest of the file** — tests that already use
   `_utc_dt_n_days_ago` / `datetime.now(UTC)` (e.g. lines 278-487) are
   relative-to-now and robust; verify each, and pin any that implicitly assume a
   particular weekday/month boundary under the frozen clock. Leave the
   `to_user_date` direct assertions (lines 236-272) as-is — they are clock-free.

## Acceptance Criteria

- [ ] `cd backend && pytest tests/services/test_streaks.py` passes
      deterministically regardless of system date — proven by running with a
      faked clock / `faketime` set to **2099-01-01** and again to **2000-01-01**.
- [ ] `cd backend && pytest` (full suite) is green — the baseline is no longer
      red.
- [ ] Tests assert exact streak counts (1, 2, 3, 0, 6, ...), not "streak is an
      int" or "streak ≥ 0" — mutation-grade against off-by-one changes to the
      recency gate.
- [ ] No existing streak test is deleted or weakened; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|---|---|
| `backend/tests/services/test_streaks.py` | Modify — add clock-freezing fixture; rewrite the time-coupled test; harden remaining tests |
| `backend/conftest.py` | Modify (optional) — host the shared clock-freeze fixture if reused beyond this file |
