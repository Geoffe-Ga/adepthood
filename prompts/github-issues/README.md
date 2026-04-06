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
Implement the 3 placeholder screens, connect the Map, and build the deep-link ecosystem between features. **Expanded from 5 → 14 issues** after cross-referencing the project spec documents (`AdepthoodAppPrompt-2025-04-06.md`, `AdepthoodAppPrompt-2025-04-01.md`).

### Backend Infrastructure
| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [Stages + progress backend](phase-3-01-stages-backend.md) | Backend | ~275 |
| 02 | [Course backend: drip-feed content](phase-3-02-course-backend.md) | Backend | ~225 |
| 03 | [Journal backend: chat, tags, search](phase-3-03-journal-backend.md) | Backend | ~275 |
| 04 | [Practice backend: UserPractice + sessions](phase-3-04-practice-backend.md) | Backend | ~275 |
| 05 | [Weekly prompts backend](phase-3-05-weekly-prompts-backend.md) | Backend | ~175 |

### Frontend — Journal (Chat with BotMason)
| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 06 | [Journal chat UI + message history](phase-3-06-journal-chat-ui.md) | Frontend | ~300 |
| 07 | [BotMason AI + offering_balance](phase-3-07-botmason-ai.md) | Full-stack | ~350 |
| 08 | [Journal search + tagging UI](phase-3-08-journal-search-tags.md) | Frontend | ~200 |

### Frontend — Practice
| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 09 | [Practice screen: selection + timer + sound](phase-3-09-practice-screen.md) | Frontend | ~300 |
| 10 | [Post-practice → Journal linking](phase-3-10-practice-journal-link.md) | Frontend | ~125 |

### Frontend — Course
| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 11 | [Course screen: drip-feed + CMS URLs](phase-3-11-course-screen.md) | Frontend | ~300 |
| 12 | [Course → Journal reflection deep links](phase-3-12-course-journal-deeplink.md) | Frontend | ~90 |

### Frontend — Map & Goals
| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 13 | [Map: real progress + rich metadata](phase-3-13-map-real-progress.md) | Frontend | ~225 |
| 14 | [GoalGroup support](phase-3-14-goal-groups.md) | Full-stack | ~225 |

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
| 09 | [Complexity & maintainability linters](phase-4-09-complexity-maintainability-linters.md) | Full-stack | ~175 |
| 10 | [Railway deployment setup](phase-4-10-railway-deployment-setup.md) | Full-stack | ~350 |

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
phase-4-09 (Complexity linters) independent — can start anytime
phase-4-08 (CORS fix) → phase-4-10 (Railway deployment)

Phase 3 internal dependencies:
  phase-3-01 (Stages backend)
    ├── phase-3-02 (Course backend)
    │     └── phase-3-11 (Course screen) → phase-3-12 (Course→Journal)
    ├── phase-3-13 (Map real progress)
    └── phase-3-04 (Practice backend)
          └── phase-3-09 (Practice screen) → phase-3-10 (Practice→Journal)

  phase-3-03 (Journal backend)
    └── phase-3-06 (Journal chat UI)
          ├── phase-3-07 (BotMason AI)
          ├── phase-3-08 (Search + tags)
          ├── phase-3-10 (Practice→Journal)
          └── phase-3-12 (Course→Journal)

  phase-3-05 (Weekly prompts) → phase-3-06 (Journal chat UI)
  phase-3-14 (GoalGroups) independent, can start after phase-1
```

## Phase 5 — Test Coverage & Security Hardening (Critical)
Backend test coverage is 52.9% (vs 90% required). Zero frontend tests. Multiple security gaps. Stale OpenAPI types.

### Backend Test Coverage
| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [Test auth + habits routers](phase-5-01-test-auth-habits-routers.md) | Backend | ~300 |
| 02 | [Test journal, botmason, prompts routers](phase-5-02-test-journal-botmason-prompts.md) | Backend | ~300 |
| 03 | [Test practices, stages, course, goals routers](phase-5-03-test-practices-stages-course-goals.md) | Backend | ~300 |
| 04 | [Test services + seed scripts](phase-5-04-test-services-seeds.md) | Backend | ~200 |

### Security & Types
| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 05 | [Security hardening: LIKE injection, authz, auth gaps](phase-5-05-security-hardening.md) | Backend | ~175 |
| 06 | [Regenerate OpenAPI types + align frontend](phase-5-06-regenerate-openapi-types.md) | Full-stack | ~200 |
| 07 | [Move seed templates to app startup](phase-5-07-seed-templates-startup.md) | Backend | ~125 |

### Frontend & Auth
| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 08 | [Frontend test coverage for core screens](phase-5-08-frontend-test-coverage.md) | Frontend | ~300 |
| 09 | [JWT refresh token flow](phase-5-09-jwt-refresh-token.md) | Full-stack | ~275 |
| 10 | [React error boundary](phase-5-10-react-error-boundary.md) | Frontend | ~200 |

## Phase 5 Dependency Graph

```
phase-5-01 (auth+habits tests)  ─┐
phase-5-02 (journal+bot tests)  ─┼─→ phase-5-05 (security fixes, needs tests first)
phase-5-03 (practices+stages)   ─┘
                                      phase-5-01 → phase-5-09 (refresh tokens, needs auth tests)
phase-5-04 (services+seeds)     independent

phase-5-06 (OpenAPI types)      → phase-5-08 (frontend tests, needs aligned types)
phase-5-07 (seed startup)       independent
phase-5-10 (error boundary)     independent
```

## Total Estimated Scope

- **52 issues** across 5 phases (11 + 7 + 14 + 10 + 10)
- **~10,400 LoC** of changes (net, including deletions)
- Phase 1 is the critical path — everything else depends on it
- Phase 3 is the largest phase, reflecting 4 features + cross-feature deep links
- **Phase 5 is the current priority** — test coverage and security block safe development
