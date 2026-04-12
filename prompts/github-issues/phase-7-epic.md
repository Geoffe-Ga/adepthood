# Phase 7 — Architecture Cleanup & Code Quality

Refactoring epic from the 2026-04-12 full-stack architecture review. All issues are pure cleanup — no new features, no behavior changes. Every issue should be invisible to users but makes the codebase dramatically easier to maintain, extend, and scale.

**Total estimated scope**: ~2,800 LoC across 10 issues
**Priority**: Schedule immediately after launch — before any new feature work
**Prerequisite**: Phases 1–5 complete

## Issues

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
