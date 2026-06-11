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

## Phase 5 — Prompt Alignment & UX Refinement (Medium)
Discrepancies found between the original feature prompts and the shipped implementation, where the prompt's vision was stronger. All 7 issues are fully independent and can run in parallel.

| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [Greyed-out locked habits](phase-5-01-greyed-locked-habits.md) | Frontend | ~125 |
| 02 | [Milestone toasts (not alerts)](phase-5-02-milestone-toasts.md) | Frontend | ~150 |
| 03 | [Victory color system](phase-5-03-victory-color-system.md) | Frontend | ~100 |
| 04 | [Map stage history](phase-5-04-map-stage-history.md) | Full-stack | ~200 |
| 05 | [Journal tags enum](phase-5-05-journal-tags-enum.md) | Full-stack | ~225 |
| 06 | [Scaffolding reveal animation](phase-5-06-scaffolding-reveal-animation.md) | Frontend | ~100 |
| 07 | [Manual habit unlock](phase-5-07-manual-habit-unlock.md) | Frontend | ~125 |

## Dependency Graph (Phase 5)

```
All 7 issues are fully independent — no internal dependencies.
All assume Phases 1–4 are complete.

  phase-5-01 (Greyed tiles) — HabitsScreen + HabitTile
  phase-5-02 (Toasts) — useHabits + new Toast component
  phase-5-03 (Victory color) — HabitUtils + HabitTile
  phase-5-04 (Map history) — MapScreen + stages API
  phase-5-05 (Journal tags) — journal model + router + frontend (full-stack)
  phase-5-06 (Scaffolding reveal) — OnboardingModal
  phase-5-07 (Manual unlock) — HabitsScreen + useHabits
      └── optional enhancement if phase-5-01 is done first (per-habit unlock on locked tiles)
```

## Phase 7 — Architecture Cleanup & Code Quality
Refactoring epic from the 2026-04-12 full-stack architecture review. Pure cleanup — no new features. See [executive summary](../claude-comms/architecture-review-2026-04-12.md).

| # | Issue | Scope | Est. LoC | Priority |
|---|-------|-------|----------|----------|
| 01 | [Extract backend service layer](phase-7-01-extract-service-layer.md) | Backend | ~400 | Critical |
| 02 | [Decompose useHabits god hook](phase-7-02-decompose-use-habits.md) | Frontend | ~350 | Critical |
| 03 | [Unify frontend state management](phase-7-03-unify-state-management.md) | Frontend | ~300 | High |
| 04 | [Optimize N+1 queries](phase-7-04-optimize-n-plus-1-queries.md) | Backend | ~200 | High |
| 05 | [Complete stub implementations](phase-7-05-complete-stubs.md) | Backend | ~250 | High |
| 06 | [Centralize error handling](phase-7-06-centralize-error-handling.md) | Full-stack | ~200 | Medium |
| 07 | [Enforce design token usage](phase-7-07-enforce-design-tokens.md) | Frontend | ~250 | Medium |
| 08 | [Add frontend integration tests](phase-7-08-frontend-integration-tests.md) | Frontend | ~350 | Medium |
| 09 | [Shared data-loading pattern](phase-7-09-shared-data-loader.md) | Frontend | ~200 | Medium |
| 10 | [Streamline pre-commit and CI](phase-7-10-streamline-ci.md) | Infra | ~100 | Low |

## Dependency Graph (Phase 7)

```
All issues are independent — no internal dependencies.
Recommended execution order by priority:

  phase-7-01 (Service layer) — unblocks cleaner backend work
  phase-7-02 (useHabits) — biggest frontend risk
  phase-7-03 (State mgmt) — builds on 7-02
  phase-7-04 (N+1 queries) — performance, parallel with 7-02/7-03
  phase-7-05 (Stubs) — user-facing improvements
  phase-7-06 (Error handling) — cross-stack consistency
  phase-7-07 (Design tokens) — visual consistency
  phase-7-08 (Integration tests) — confidence for future refactors
  phase-7-09 (Data loader) — reduces duplication
  phase-7-10 (CI) — developer experience
```

## Phase 8 — Post-Drain Hardening (Medium)
Platform debt, decomposition, and deferred follow-ups collected after the 2026-06-10/11 autonomous backlog drain (issues #261–#429, PRs #410–#455). See [phase-8-epic.md](phase-8-epic.md) for the audit findings.

| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [API module split — core domains](phase-8-01-api-module-split-core.md) | Frontend | ~350 |
| 02 | [API module split — remainder + barrel](phase-8-02-api-module-split-remainder.md) | Frontend | ~350 |
| 03 | [Decompose GoalModal](phase-8-03-goal-modal-decomposition.md) | Frontend | ~300 |
| 04 | [Page envelope — finish deferred screens](phase-8-04-page-envelope-completion.md) | Frontend | ~150 |
| 05 | [Make paginate=true the backend default](phase-8-05-paginate-default-backend.md) | Backend | ~250 |
| 06 | [Offline check-in polish](phase-8-06-offline-checkin-polish.md) | Frontend | ~175 |
| 07 | [BotMason streaming unit tests](phase-8-07-botmason-stream-tests.md) | Backend | ~225 |
| 08 | [Serve chapter media assets](phase-8-08-content-asset-serving.md) | Full-stack | ~275 |
| 09 | [Theme context + dark-mode pilot](phase-8-09-theme-context-dark-pilot.md) | Frontend | ~300 |
| 10 | [Toolchain version parity](phase-8-10-toolchain-version-parity.md) | Tooling | ~100 |
| 11 | [Jest hygiene: resetMocks + jsdom opt-in](phase-8-11-jest-hygiene-resetmocks-jsdom.md) | Frontend | ~200 |

Dependency graph (Phase 8):

```
phase-8-01 (api split core) ──→ phase-8-02 (api split remainder + barrel)
phase-8-04 (envelope completion) ──→ phase-8-05 (paginate default flip)
phase-8-03, 06, 07, 08, 09, 10, 11 — independent, parallelizable
```

## Total Estimated Scope

- **~76 issues** across 8 phases
- Phases 1–7 complete (the 2026-06 autonomous drain finished phases 6–7 plus the cms-migration and BotMason epics)
- Phase 8 is hardening + deferred follow-ups; issues 03/06–11 are independent and can run in parallel

## Feature Epics (outside the numbered phases)

Feature work that extends the catalog or product surface, not part of the
refactor roadmap. Each epic owns its own sub-issues and can ship
independently.

### Customizable practices, catalog browse, and share links

Two new modes (`random_interval_bell`, `card_meditation`) round out the engine to 11; users can browse a global catalog, create custom practices in any mode, assign customs to any stage, and share a practice via private link. Rider-Waite-Smith deck content ships bundled.

| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| — | [Epic tracker](custom-practices-epic.md) | — | — |
| 01 | [Add `random_interval_bell` mode](custom-practices-01-random-interval-bell-backend.md) | Backend | ~200 |
| 02 | [Add `card_meditation` mode](custom-practices-02-card-meditation-backend.md) | Backend | ~250 |
| 03 | [Practice share-link feature](custom-practices-03-share-link-feature.md) | Full-stack | ~400 |
| 04 | [Ship RWS deck content + asset folder](custom-practices-04-rws-deck-content.md) | Frontend | ~200 |
| 05 | [Build `RandomIntervalBellView` + form](custom-practices-05-random-interval-bell-frontend.md) | Frontend | ~250 |
| 06 | [Build `CardMeditationView` + image picker](custom-practices-06-card-meditation-frontend.md) | Frontend | ~350 |
| 07 | [Catalog browse + Create-custom flow](custom-practices-07-catalog-and-create-flow.md) | Frontend | ~450 |

### Spiral Dynamics practice-preset catalog expansion

Seed ~60 alternative presets across stages 1-8 (BEIGE through TEAL) so each
Spiral Dynamics frequency band offers a deeper menu of practices alongside
its canonical stage practice. Pure content: no new modes, no migrations,
no frontend work. Each sub-issue handles one color/stage and is fully
independent of the others.

| # | Issue | Stage | New presets | Est. LoC |
|---|-------|-------|-------------|----------|
| — | [Epic tracker](practice-presets-epic.md) | — | — | — |
| 01 | [Seed BEIGE alternatives](practice-presets-01-beige-grounding.md)        | 1 | 7  | ~250 |
| 02 | [Seed PURPLE alternatives](practice-presets-02-purple-divination.md)     | 2 | 8  | ~275 |
| 03 | [Seed RED alternatives](practice-presets-03-red-energy.md)               | 3 | 10 | ~325 |
| 04 | [Seed BLUE alternatives](practice-presets-04-blue-heart.md)              | 4 | 10 | ~325 |
| 05 | [Seed ORANGE alternatives](practice-presets-05-orange-activation.md)     | 5 | 8  | ~275 |
| 06 | [Seed GREEN alternatives](practice-presets-06-green-shadow.md)           | 6 | 8  | ~275 |
| 07 | [Seed TEAL alternatives](practice-presets-07-teal-integration.md)        | 8 | 9  | ~300 |

Stages 7 (YELLOW), 9 (ULTRAVIOLET), and 10 (CLEAR LIGHT) carry no
alternatives in the source table and are not part of this epic. All seven
sub-issues are fully independent — they touch the same three files but at
disjoint locations and can ship in any order or in parallel.

### Generalize grounding techniques

Add **Find Shapes**, **Find Colors**, **Touch Grass**, and **Mindful
Eating** by extending the mode-discriminated practice engine with two
new modes (`tallied_grounding`, `mindful_anchor`). Existing
`sense_grounding` (5-4-3-2-1) is untouched.

| # | Issue | Scope | Est. LoC |
|---|-------|-------|----------|
| — | [Epic tracker](grounding-techniques-epic.md) | — | — |
| 01 | [Add `tallied_grounding` mode](grounding-techniques-01-tallied-mode-backend.md) | Backend | ~250 |
| 02 | [Add `mindful_anchor` mode](grounding-techniques-02-mindful-anchor-mode-backend.md) | Backend | ~200 |
| 03 | [Seed Find Shapes + Find Colors presets](grounding-techniques-03-presets-shapes-and-colors.md) | Backend | ~100 |
| 04 | [Seed Touch Grass + Mindful Eating presets](grounding-techniques-04-presets-touch-grass-and-mindful-eating.md) | Backend | ~100 |
| 05 | [Build `TalliedGroundingView`](grounding-techniques-05-tallied-view-frontend.md) | Frontend | ~250 |
| 06 | [Build `MindfulAnchorView`](grounding-techniques-06-mindful-anchor-view-frontend.md) | Frontend | ~200 |

Dependency graph:

```
01 tallied-mode-backend ──┬── 03 tallied-presets
                          └── 05 tallied-view-frontend

02 mindful-anchor-mode ───┬── 04 mindful-anchor-presets
                          └── 06 mindful-anchor-view-frontend
```
