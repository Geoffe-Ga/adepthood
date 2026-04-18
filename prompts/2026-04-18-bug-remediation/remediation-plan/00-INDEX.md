# Adepthood Bug Remediation Plan — Execution Index

**Source audit:** `prompts/2026-04-18-bug-remediation/` (18 reports, **281 bugs: 32 Critical / 126 High / 107 Medium / 16 Low**).
**This directory:** 15 executable prompts (Wave 1 → Wave 4). Each prompt is self-contained, bounded for Stream-Idle safety, and uses the 6-component format from the `prompt-engineering` skill.

## How to use this directory

1. Pick a prompt file (`NN-*.md`).
2. Hand the **whole file** to a fresh Claude Code session — it already contains role, goal, context refs, output format, examples, and requirements.
3. The prompt will tell Claude how many commits to produce and which BUG-IDs each commit closes.
4. Do NOT paste the audit reports inline — the prompts reference them by path and BUG-ID so the implementation session only reads the blocks it needs.

## Wave ordering and parallelism

```
Wave 1 (serial, must ship first)
  └─ 01-unblock-auth-nav-flash.md ...................... unblocks the app

Wave 2 (serial after Wave 1, each atomic)
  ├─ 02-close-credit-minting-chain.md .................. admin + wallet
  └─ 03-close-stage-skip-chain.md ...................... stages + practice + prompts

Wave 3 (parallel after Wave 2; separate branches OR sequential on one)
  ├─ 04-centralize-sanitize-user-text.md ............... T6 XSS/prompt-injection
  ├─ 05-centralize-date-utils-tz.md .................... T4 timezone
  ├─ 06-db-unique-constraints-toctou.md ................ T5 TOCTOU (should precede 07+12)
  ├─ 07-normalize-idor-ordering.md ..................... T7 404→403
  ├─ 08-optimistic-mutation-hook.md .................... T3 rollback (should precede 14)
  ├─ 09-server-derived-timestamps.md ................... T9 client timestamps
  └─ 10-observability-e2e.md ........................... T10 Sentry + Decimal + audit

Wave 4 (parallel; separate branches)
  ├─ 11-backend-auth-models-schemas-cors.md ............ reports 01, 05, 06, 07 remainders
  ├─ 12-backend-feature-routers.md ..................... reports 09-15 remainders (split 12A/12B)
  ├─ 13-frontend-api-client.md ......................... report 04 remainders
  ├─ 14-frontend-feature-screens.md .................... reports 16, 17 remainders (split 14A/14B)
  └─ 15-frontend-design-state-tests.md ................. report 18 remainders
```

### Dependency graph

```
01 ──▶ 02 ──▶ 03
 │             │
 ▼             ▼
(Wave 3 opens after 03)
 │
 ├─▶ 04 ─┐
 ├─▶ 05 ─┤
 ├─▶ 06 ─┼─▶ 12 (Wave 4)
 ├─▶ 07 ─┤
 ├─▶ 08 ─┼─▶ 14 (Wave 4)
 ├─▶ 09 ─┤
 └─▶ 10 ─┘
 │
 └─▶ 11, 13, 15 (independent of Wave 3 hooks — can start after Wave 2)
```

- **Hard serial**: 01 → 02 → 03 (they share the auth + progression surface).
- **Soft serial within Wave 3**: 06 should land before 12 (unique constraints affect router commits); 08 should land before 14 (feature screens import `useOptimisticMutation`).
- **Parallel-safe**: 04, 05, 07, 09, 10 touch disjoint files across backend/frontend and can run simultaneously.
- **Wave 4 fan-out**: 11, 13, 15 depend on Wave 2 only. 12 depends on 06. 14 depends on 05 + 08.

## Concurrency recipe (recommended)

```
Day 0            : run 01 (solo, merge, smoke test)
Day 1 morning    : run 02 and 03 back-to-back on one branch
Day 1 afternoon  : fan out 04, 05, 06, 07, 09, 10 on 6 branches in parallel
                   (10 is least risky to land first; 06 must finish before 12 starts)
Day 2            : run 08 (solo — feature-screen branches wait for it)
                   + 11, 13, 15 in parallel on 3 more branches
Day 3            : 12A + 12B in parallel; 14A + 14B in parallel
Day 4            : rebase, resolve residual conflicts, ship.
```

With 8-10 parallel Claude Code sessions, the plan lands in ~4 working days.

## Why 15 prompts and not 1 or 50

- **Stream Idle budget.** Each prompt targets ≤20 files and ≤5 commits so the implementation session finishes before the API's idle-timeout window tightens.
- **Reviewability.** A human must still review each PR; ~4-6 commits per branch keeps the diff narrative coherent.
- **Theme-first, not report-first.** The source audit is sliced by component; the fixes are sliced by theme (chain, TOCTOU, TZ, rollback, timestamps, observability) so cross-cutting work lands as one diff, not 7.
- **Dependency honesty.** Serial prompts explicitly depend on earlier prompts; parallel prompts explicitly declare non-overlap. No prompt pretends it can ship standalone when it cannot.

## What each prompt contains (6-component format)

Per the `prompt-engineering` skill:

1. **Role** — specific engineer persona + bias.
2. **Goal** — measurable success criteria.
3. **Context** — BUG-IDs by report path; file list with a cap on how many to touch.
4. **Output format** — explicit commit count and message shape.
5. **Examples** — 2-4 concrete code sketches so Claude does not freestyle the pattern.
6. **Requirements** — process guardrails: `bug-squashing-methodology` (RCA first), `stay-green` (TDD), `max-quality-no-shortcuts` (no `# noqa` / `# type: ignore`), `pre-commit run --all-files` before every commit, coverage floor, "do not read reports end-to-end — grep for BUG-IDs".

## Cross-referenced skills

Every prompt assumes these skills are available in `.claude/skills/` on the implementation session:

- `bug-squashing-methodology` — 5-step RCA + TDD bug-fix.
- `stay-green` — 2-gate TDD workflow.
- `max-quality-no-shortcuts` — anti-bypass philosophy.
- `preflight` — run pre-commit, iterate to green.
- `testing` — AAA pattern + fixtures.
- `security` — FastAPI + React Native security patterns.
- `concurrency` — async patterns (relevant in 10, 12).
- `frontend-aesthetics` — design-token + a11y (relevant in 14, 15).
- `error-handling` — fail-fast + clear diagnostics (relevant in 10, 13).
- `git-workflow` — branch + commit hygiene.
- `vibe` — naming + structural consistency.

## Bug coverage map

| Prompt | Closes (count) | Notes |
|--------|---------------:|-------|
| 01 | ~15 Critical/High | Wave 1 unblock |
| 02 |  3 | Credit-minting chain |
| 03 |  9 | Stage-skip chain |
| 04 |  5 | T6 sanitization |
| 05 |  7 | T4 timezone |
| 06 | 10 | T5 TOCTOU |
| 07 |  7 | T7 IDOR |
| 08 |  6 | T3 optimistic |
| 09 |  7 | T9 timestamps |
| 10 | 10 | T10 observability |
| 11 | ~18 | Backend foundations remainder |
| 12 | ~30 | Backend features remainder (split) |
| 13 | ~12 | Frontend API client remainder |
| 14 | ~25 | Frontend screens remainder (split) |
| 15 | ~15 | Frontend design/state/tests remainder |
| **Total Critical+High closed** | **~158 / 158** | Medium/Low triaged within each prompt |

Approximate counts — each prompt enumerates exact BUG-IDs it owns and which it defers.

## Not-goals of this plan

- **Not a refactor.** Where the audit suggests architectural cleanup beyond bug fix (e.g., replace Zustand with TanStack, migrate to session cookies), prompts treat that as out-of-scope and leave a follow-up note.
- **Not a test-coverage crusade.** Each prompt adds tests for its BUG-IDs; it does not pursue 100% coverage of untouched areas.
- **Not a perf pass.** Except where a bug is a perf bug (BUG-FE-STATE-002), perf-adjacent items defer.
- **Not a docs pass.** Doc updates land only where the bug report called for them (e.g., BUG-FE-AUTH-007 XSS README note).

## Related

- **Source audit:** `prompts/2026-04-18-bug-remediation/00-INDEX.md` (themes, severity totals, symptom narrative).
- **Prior audit (superseded):** `prompts/2026-04-14-bug-remediation/`.
- **Project guardrails:** `CLAUDE.md`, `AGENTS.md`, `.pre-commit-config.yaml`.
- **Roadmap:** `prompts/github-issues/README.md`.
