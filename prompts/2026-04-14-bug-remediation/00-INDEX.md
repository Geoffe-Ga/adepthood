# Adepthood — "Pay the Debts" Bug Remediation Initiative

**Kicked off:** 2026-04-14
**Branch:** `claude/code-review-bug-analysis-BvOHp`
**Scope:** Comprehensive self-review of the Adepthood codebase across every feature surface.

## Why this exists

The user tried to sign up. Hit ~5 bugs. Never made it through the door. That was enough signal to stop shipping features and take stock. This initiative is the audit, broken into per-component bug reports written like a senior QA engineer's findings — each bug has a severity, file:line reference, symptom, root cause with code excerpt, and a concrete fix.

Total findings across all reports: **146 bugs** (20 Critical, 34 High, 69 Medium, 23 Low).

## Reports

| File | Component | Bugs | Crit | High |
|---|---|---:|---:|---:|
| [`01-auth-and-signup-bugs.md`](./01-auth-and-signup-bugs.md) | Auth, signup, login, JWT, lockout | 14 | 2 | 2 |
| [`02-habits-bugs.md`](./02-habits-bugs.md) | Habits, goals, streaks, milestones | 20 | 0 | 6 |
| [`03-practice-sessions-bugs.md`](./03-practice-sessions-bugs.md) | Practices, timers, sessions | 17 | 2 | 4 |
| [`04-journal-botmason-bugs.md`](./04-journal-botmason-bugs.md) | Journal entries, BotMason LLM, weekly prompts | 18 | 4 | 6 |
| [`05-course-stages-goals-bugs.md`](./05-course-stages-goals-bugs.md) | Course content, stage progression, goals | 25 | 5 | 6 |
| [`06-backend-infrastructure-bugs.md`](./06-backend-infrastructure-bugs.md) | FastAPI app, DB, CORS, migrations, obs | 27 | 3 | 9 |
| [`07-frontend-infrastructure-bugs.md`](./07-frontend-infrastructure-bugs.md) | API client, nav, state, storage, a11y | 25 | 2 | 1 |

(Counts approximate — classifications occasionally blur; severity is a prioritization hint, not a contract.)

## Top suspects for "the 5 bugs during signup"

From the auth report:

1. **BUG-AUTH-003** — email lookups are case-sensitive (`Alice@Example.com` ≠ `alice@example.com`).
2. **BUG-AUTH-010** — whitespace not stripped from the email field.
3. **BUG-AUTH-004** — no client-side email validation; the user sees a generic 422 instead of a field error.
4. **BUG-AUTH-002** — `AuthResponse.user_id` optional in TS but required on the server (may crash the post-login screen).
5. **BUG-AUTH-001 / 005** — `saveToken` / `clearToken` not awaited; a quick kill/restart after signup logs you back out.

Fix those five first; you'll walk through the door.

## How to use these reports

- Each file stands alone and can be handed to a single engineer or to `/continue-epic`.
- Each bug has a stable ID (`BUG-AUTH-003`, `BUG-HABITS-017`, …) — reference it in commit messages, PR titles, and the issue tracker.
- Severity is Critical/High/Medium/Low; reports group the Critical/High near the top plus a suggested remediation order at the bottom.
- The "Suggested remediation order" section of each report minimizes rework (e.g., "land the unique-per-day constraint + the race fix together; they're the same change").

## Cross-cutting themes

Patterns that recur across reports, worth solving once rather than N times:

1. **Async hygiene** — many fire-and-forget writes, missing `await`s, misplaced `await`s. An RN/FastAPI lint pass catches the bulk.
2. **No runtime validation at API boundaries** — Zod on the client, stricter Pydantic on the server, and regenerated shared types.
3. **Authorization is per-handler** rather than per-resource — locked-stage content, other users' histories, and the `bot-response` endpoint all leak because the stage/user check is a snowflake each time. Consider a `require_access_to_stage` dep.
4. **Timezone handling is inconsistent** — pick UTC-everywhere for storage and aggregation, render user-local at the edge.
5. **Pagination missing on every list endpoint** — add a single `PaginationParams` dep and fix them all in one PR.
6. **Observability is thin** — no correlation IDs, most endpoints don't log, LLM stream errors are swallowed. This blocks diagnostic work on everything else.
7. **Idempotency is ad hoc** — goal completions, prompt responses, practice sessions all have their own race/duplicate stories. A `(user, resource, day)` uniqueness pattern and `Idempotency-Key` header support covers most of them.

## Recommended next steps

1. **Ship fixes for the 5 top suspects above** on a dedicated PR so you can sign up and log in.
2. **Triage this index into GitHub issues** — one issue per report, with the bug IDs as task-list checkboxes. That makes it easy to run `/continue-epic`.
3. **Pick two reports per sprint**, starting with infra (06/07) so the fixes for feature reports land on stable ground.
4. **Add regression tests alongside every fix.** No bug gets fixed without a test that fails before the fix.

## Maintenance note

These reports are point-in-time (2026-04-14). If a bug is fixed, strike it through or delete it from the file and note the fixing commit. When adding new findings, append them with a fresh ID rather than renumbering.
