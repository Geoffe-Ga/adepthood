# GitHub Issues — Adepthood Refactor Roadmap

Generated from a comprehensive codebase review. Each phase is an epic with atomized sub-issues (~300 LoC each).

## Phase 1 — Make It Real (Critical)
Wire up database, auth, API integration, and persistence. Without this, the app is an interactive mockup.

| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [Database setup + Alembic](phase-1-01-database-setup.md) | Backend | ~250 |
| 02 | [Habits router → DB](phase-1-02-habits-router-to-db.md) | Backend | ~225 |
| 03 | [Auth router → DB + JWT](phase-1-03-auth-router-to-db.md) | Backend | ~275 |
| 04 | [Practice router → DB](phase-1-04-practice-router-to-db.md) | Backend | ~175 |
| 05 | [Goal completions → DB](phase-1-05-goal-completions-to-db.md) | Backend | ~175 |
| 06 | [Energy idempotency TTL](phase-1-06-energy-idempotency-fix.md) | Backend | ~100 |
| 07 | [Consolidate API clients](phase-1-07-consolidate-api-clients.md) | Frontend | ~225 |
| 08 | [Connect Habits to API](phase-1-08-connect-habits-to-api.md) | Frontend | ~250 |
| 09 | [AsyncStorage persistence](phase-1-09-async-storage-persistence.md) | Frontend | ~225 |
| 10 | [Auth context + screens](phase-1-10-auth-context-and-screens.md) | Frontend | ~300 |
| 11 | [Align Habit types](phase-1-11-align-habit-types.md) | Full-stack | ~175 |

## Phase 2 — Decompose the Monolith (High)
Restructure HabitsScreen, add state management, clean up dead code. Pure refactoring, no behavior changes.

| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [Extract useHabits hook](phase-2-01-extract-habits-hook.md) | Frontend | ~300 |
| 02 | [Mode enum](phase-2-02-mode-enum.md) | Frontend | ~90 |
| 03 | [Global state (Zustand)](phase-2-03-global-state-layer.md) | Frontend | ~225 |
| 04 | [Delete dead files](phase-2-04-delete-dead-files.md) | Frontend | ~-50 |
| 05 | [Unify design constants](phase-2-05-unify-design-constants.md) | Frontend | ~225 |
| 06 | [Consolidate pytest config](phase-2-06-consolidate-pytest-config.md) | Backend | ~30 |
| 07 | [Consistent error responses](phase-2-07-consistent-error-responses.md) | Backend | ~125 |

## Phase 3 — Build Missing Features (Medium)
Implement the 3 placeholder screens and connect the Map to real data.

| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [Journal feature](phase-3-01-journal-feature.md) | Full-stack | ~600 |
| 02 | [Practice screen](phase-3-02-practice-screen.md) | Frontend | ~300 |
| 03 | [Course feature](phase-3-03-course-feature.md) | Full-stack | ~500 |
| 04 | [Map → real progress](phase-3-04-map-real-progress.md) | Frontend | ~175 |
| 05 | [Stages backend](phase-3-05-stages-backend.md) | Backend | ~225 |

## Phase 4 — Polish & Harden (Lower)
Type safety, security hardening, test coverage, documentation.

| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [UUID IDs](phase-4-01-uuid-ids.md) | Frontend | ~50 |
| 02 | [Eliminate @ts-ignore](phase-4-02-eliminate-ts-ignore.md) | Frontend | ~125 |
| 03 | [Auth security hardening](phase-4-03-auth-security-hardening.md) | Backend | ~175 |
| 04 | [Notification persistence](phase-4-04-notification-persistence.md) | Frontend | ~175 |
| 05 | [Type-safe navigation](phase-4-05-type-safe-navigation.md) | Frontend | ~100 |
| 06 | [Integration + E2E tests](phase-4-06-integration-e2e-tests.md) | Full-stack | ~300 |
| 07 | [Document magic numbers](phase-4-07-document-magic-numbers.md) | Full-stack | ~65 |
| 08 | [CORS production fix](phase-4-08-cors-production-fix.md) | Backend | ~40 |

## Dependency Graph

```
phase-1-01 (DB setup)
  ├── phase-1-02 (Habits → DB)
  │     └── phase-1-05 (Goals → DB)
  ├── phase-1-03 (Auth → DB)
  │     └── phase-1-04 (Practice → DB)
  ├── phase-1-06 (Energy TTL)
  └── phase-1-11 (Type alignment)

phase-1-07 (API consolidation)
  └── phase-1-08 (Habits ↔ API)
        └── phase-1-09 (AsyncStorage)

phase-1-03 + phase-1-07 + phase-1-09
  └── phase-1-10 (Auth screens)

Phase 2 can start after Phase 1 core (01-03, 07)
Phase 3 can start after Phase 1 complete
Phase 4 can run in parallel with Phase 3
```

## Total Estimated Scope

- **31 issues** across 4 phases
- **~5,000 LoC** of changes (net, including deletions)
- Phase 1 is the critical path — everything else depends on it
