# EPIC: Pagination & Response Contracts

**Labels:** `epic`, `backend`, `performance`, `priority-high`
**Epic slug:** `audit-paginate`
**Drives findings from:** `2026-06-24_ADEPTHOOD_FULL_AUDIT.md` §4 (Pagination & response contracts, §5.3)

## Summary

A real `Page[T]` envelope already exists (`backend/src/schemas/pagination.py`) and is wired into
habits/practices/goal_groups/user_practices/practice_sessions/stages/course via an opt-in
`?paginate=true` query parameter (see `routers/habits.py:220-243` for the canonical pattern). The
audit found a cluster of list and embed endpoints that never adopted it: they still materialise and
serialise unbounded collections on every request, so their payloads and query cost grow without bound
as a user's library and history accumulate.

This epic closes that gap. The job is to **bound every unbounded list/embed and tighten the response
contracts**, reusing the existing `Page[T]` / `PaginationParams` / `build_page` / `paginate_query`
primitives and the established `?paginate=true` opt-in so every change is backward compatible with the
clients built against the current bare-list shape. Three secondary contract fixes ride along: add a
`response_model` to the one untyped dict endpoint, build the three hand-rolled `dict[str, Any]`
responses from the existing `UserPracticeDetail` schema instead of duplicating its keys, and replace
the in-process idempotency dict with a DB-backed store modelled on `services/chat_idempotency.py`.

The audit evidence rows this epic discharges:

| file:line | finding | sub-issue |
|---|---|---|
| `routers/practice_tags.py:64-80` | unbounded list | 01 |
| `routers/practice_recipes.py:186-199` | unbounded list | 02 |
| `routers/user_practices.py:510-532,561-609`, `practice_recipes.py:381-406` | unbounded embed | 03 |
| `routers/admin.py:191-193`, `admin.py:89-126` | unbounded scan / list | 04 |
| `routers/practice_sessions.py:457-476`; hand-built dicts in `user_practices.py:510,561` / `practice_recipes.py:347` | untyped / drift-prone contracts | 05 |
| `routers/practice_sessions.py:185-218` | in-process idempotency | 06 |

## Success Criteria

- [ ] No backend list or embed endpoint returns an unbounded collection: every list named in §4
      accepts `PaginationParams` and emits a `Page[T]` envelope under `?paginate=true`, and every
      embedded `sessions[]` is capped or paginated.
- [ ] Every new/changed list endpoint is **backward compatible**: omitting `?paginate=true` returns
      the same bare-list shape clients use today.
- [ ] The `Page[T]` / `PaginationParams` / `build_page` / `paginate_query` primitives are reused as-is;
      no parallel pagination machinery is introduced.
- [ ] `GET /practice-sessions/week-count` and the three hand-rolled UserPractice detail responses have
      typed `response_model`s; no route returns a raw `dict[str, Any]` that duplicates schema keys.
- [ ] Practice-session idempotency survives a process restart and is correct across multiple workers
      (no duplicate sessions), backed by a DB table with a reversible Alembic migration.
- [ ] Backend coverage stays ≥ 90% (line) / ≥ 80% (branch); docstring coverage ≥ 85%; all pre-commit
      hooks pass on `--all-files`; no existing tests break.

## Sub-Issues

| # | Issue | Priority | Est. LoC |
|---|-------|----------|----------|
| 01 | [Paginate practice-tags list](audit-paginate-01-practice-tags.md) | priority-high | ~140 |
| 02 | [Paginate practice-recipes list](audit-paginate-02-practice-recipes.md) | priority-high | ~170 |
| 03 | [Cap/paginate embedded UserPractice sessions](audit-paginate-03-embedded-sessions.md) | priority-high | ~260 |
| 04 | [Paginate admin stage-gap & usage lists](audit-paginate-04-admin-lists.md) | priority-high | ~220 |
| 05 | [Typed response contracts for week-count & UserPractice detail](audit-paginate-05-typed-contracts.md) | priority-medium | ~200 |
| 06 | [DB-backed practice-session idempotency](audit-paginate-06-db-idempotency.md) | priority-high | ~340 |

**Suggested order:** 01 → 02 establish the list pattern; 03 reuses the embedded-session cap built on
that pattern; 04 is independent (admin surface); 05 depends on the hand-rolled dicts touched by 03
(land 03 first, then 05 retypes what remains); 06 is independent and carries a migration, so it can run
in parallel. Critical/high finalisers (01–04, 06) front-loaded; the medium contract tidy-up (05) lands
last so it can retype the final shape of the responses 03 leaves behind.
