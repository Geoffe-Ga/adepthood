# EPIC: Test Quality & Green Baseline

**Labels:** `epic`, `backend`, `priority-critical`

## Summary

The baseline backend suite is currently **RED** due to a time-coupled test:
`tests/services/test_streaks.py::test_streak_uses_user_timezone_across_utc_midnight`
hardcodes goal completions on calendar date 2026-06-15, but
`compute_consecutive_streak` measures the chain against the real wall clock via
`today_in_tz` (`backend/src/domain/dates.py:91`). The chain is only "current"
inside a narrow window around mid-June; run on today's date (2026-06-24) the
most-recent-day recency gate fires and the streak no longer equals the asserted
value, so the assertion fails and the whole `pytest` run goes red
(`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:20`, `:143`). **The stay-green baseline is
not actually green** — every "all tests pass" claim downstream of this is
unverifiable until the test is made time-independent. That is issue 01 and it
lands first.

Beyond the red baseline, the audit's test-quality lens (§9, §5.4 "tests that
don't test") found three suites that pass for the wrong reason — they survive
almost any mutation to the code they nominally guard:

- `tests/test_models.py:35-56` asserts only "is a class / has `__name__` /
  count > 0" across 23 models (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:147`).
- `services/botmason.py:867,916` — the real production OpenAI/Anthropic
  streaming paths — ship behind `# pragma: no cover`, untested
  (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:148`).
- `OnboardingModal.step2.test.tsx:50` uses `toMatchSnapshot()` on a style object
  as its sole assertion (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:151`).

This epic makes the baseline green for real, then upgrades the hollow tests to
**mutation-grade** — every test must fail if the behavior it describes is
broken.

## Success Criteria

- [ ] `cd backend && pytest` passes deterministically **regardless of system
      date**, proven by running the suite with a faked clock set to a
      far-future date (e.g. 2099-01-01) and to a far-past date.
- [ ] No test in scope passes on identity-level facts alone; each asserts
      behavior, exact values, or concrete schema constraints (mutation-grade).
- [ ] The two `# pragma: no cover` markers on `_stream_openai` / `_stream_anthropic`
      are removed and the lines are covered by tests using a mocked SDK/transport
      (no live API key required).
- [ ] The frontend snapshot assertion is replaced by a behavioral assertion;
      its stale `.snap` file is deleted.
- [ ] Backend line coverage ≥ 90%, branch coverage ≥ 80%; frontend coverage not
      reduced. All pre-commit hooks pass on `--all-files`.

## Sub-Issues

| # | Issue | Scope | Est. LoC | Priority |
|---|-------|-------|----------|----------|
| 01 | [Un-flake the time-coupled streak test](audit-testq-01-unflake-streak-test.md) | Backend | ~120 | Critical |
| 02 | [Replace hollow model tests with real schema assertions](audit-testq-02-real-model-tests.md) | Backend | ~400 | High |
| 03 | [Cover BotMason streaming paths](audit-testq-03-cover-botmason-streaming.md) | Backend | ~280 | High |
| 04 | [Fix the hollow snapshot assertion](audit-testq-04-fix-hollow-snapshot.md) | Frontend | ~60 | Medium |

**Sequencing:** 01 lands **first** — it makes the baseline suite green so every
subsequent gate ("all tests pass") is meaningful. 02 and 03 are independent and
can run in parallel after 01. 04 is frontend-only and independent of all three.
