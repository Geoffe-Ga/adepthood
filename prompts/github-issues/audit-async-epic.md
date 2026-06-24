# EPIC: Backend Async Correctness & Query Performance

**Labels:** `epic`, `backend`, `performance`, `priority-critical`

## Summary

The 2026-06-24 full-stack audit (§3, `2026-06-24_ADEPTHOOD_FULL_AUDIT.md:47-60`)
found a cluster of backend defects that make the API slower, less scalable, and
semantically incorrect under concurrency. This epic eliminates them:

- **Event-loop blocking** — synchronous bcrypt cost-12 hashing (~250ms) runs
  inside `async def` auth handlers, pinning the worker and serializing every
  concurrent login/signup/reset (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:51`).
  `services/energy.py` and `services/email.py` already offload with
  `asyncio.to_thread`; auth never did.
- **Missing indexes** — the highest-write table (`GoalCompletion`) and the chat
  read path (`JournalEntry.load_recent_conversation`) have no composite index
  covering their hot filters, so every streak/stats/chat query full-scans and
  sorts (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:52-53`).
- **N+1 loops** — `list_stages` calls `compute_stage_progress` once per stage in
  a Python loop, scaling to 36 stages on the primary course surface
  (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:54`).
- **GET-that-writes** — `list_goal_groups` runs a conditional INSERT + commit on
  every read, violating HTTP semantics (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:56`).
- **Redundant queries** — `compute_consecutive_streak` runs up to 3× per
  check-in (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:55`).
- **Broad excepts & CORS surface** — `except Exception` masks bugs in rate-limit
  and chat paths; `allow_credentials=True` is set for a cookieless Bearer API
  (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:58-60`).

All work is cleanup: no new features, no user-visible behavior change (beyond
latency and correctness under load). Every issue is TDD-first and traces to a
specific §3 row.

## Success Criteria

- [ ] No synchronous bcrypt call runs on the event loop; all hash/verify
      (including anti-enumeration dummies) are offloaded via `asyncio.to_thread`.
- [ ] `GoalCompletion` and `JournalEntry` each have a composite index covering
      their hot filters, declared on the model and created by a **reversible**
      Alembic migration that round-trips `alembic check`.
- [ ] `list_stages` issues ≤3 queries regardless of stage count.
- [ ] No GET endpoint performs an INSERT/commit.
- [ ] `compute_consecutive_streak` is computed at most once per check-in.
- [ ] No `except Exception` remains in the named rate-limit / chat-stream key
      paths; narrowed to `HTTPException` (or narrowed + re-raised).
- [ ] CORS `allow_credentials=False`.
- [ ] All existing tests pass; backend line coverage stays ≥ 90% and branch
      coverage ≥ 80%; all pre-commit hooks pass on `--all-files`.

## Sub-Issues

| # | Issue | Category | Priority |
|---|-------|----------|----------|
| 01 | [Offload synchronous bcrypt to a thread](audit-async-01-bcrypt-to-thread.md) | async-correctness | critical |
| 02 | [Add GoalCompletion composite index](audit-async-02-goalcompletion-index.md) | performance | high |
| 03 | [Add JournalEntry composite index](audit-async-03-journalentry-index.md) | performance | high |
| 04 | [Batch the per-stage progress N+1](audit-async-04-stages-n-plus-1.md) | performance | high |
| 05 | [Remove seeding write from list_goal_groups GET](audit-async-05-goalgroups-get-no-write.md) | correctness | medium |
| 06 | [Deduplicate compute_consecutive_streak per check-in](audit-async-06-streak-query-dedup.md) | performance | medium |
| 07 | [Narrow broad except in rate-limit & chat paths](audit-async-07-narrow-broad-except.md) | correctness | medium |
| 08 | [Disable CORS credentials for the Bearer API](audit-async-08-cors-credentials.md) | security | medium |
