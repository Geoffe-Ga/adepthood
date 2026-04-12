# Architecture Review — Executive Summary

**Date**: 2026-04-12
**Scope**: Full-stack audit of backend (FastAPI), frontend (React Native/Expo), and infrastructure
**Verdict**: Production-deployable with medium-term maintainability risks. Ship it, but schedule Phase 7 cleanup before scaling the team.

---

## Overall Grade: B+

| Area | Grade | Summary |
|------|-------|---------|
| **Security** | A | JWT + bcrypt + account lockout + rate limits + HSTS + atomic wallet. Audit complete. |
| **Backend Architecture** | B | Clean routing, good auth, but business logic leaks into routers and N+1 query problems |
| **Frontend Architecture** | B- | Good API layer, but state management is fragmented (Context + Zustand + useState) and `useHabits` is a 586-line god hook |
| **Infrastructure** | A- | Multi-stage Docker, pinned CI actions, comprehensive pre-commit. Minor redundancies. |
| **Test Coverage** | B+ | 90%+ backend, good fixture design. Frontend lacks integration tests for critical flows. |
| **Design System** | C+ | Tokens exist but aren't enforced — hardcoded colors/spacing throughout features |

---

## What's Strong

1. **Auth is solid**: JWT with 1hr TTL, bcrypt 12 rounds, account lockout (5 fails/15 min), timing-attack mitigation on signup, rate limiting on all auth endpoints.

2. **Atomic wallet metering**: The offering_balance race condition was fixed with `UPDATE ... WHERE balance > 0` + RETURNING. Monthly cap system with automatic reset is well-designed.

3. **API client design**: `frontend/src/api/index.ts` has clean token refresh retry logic, centralized header building, and elegant LLM key injection via getter pattern.

4. **CI/CD pipeline**: GitHub Actions with SHA-pinned actions, pip-audit for dependency security, pre-commit with 15+ hooks covering formatting, linting, typing, and security scanning.

5. **Docker builds**: Multi-stage (builder + runtime), non-root user, slim base images, proper .dockerignore files.

6. **Developer experience**: CLAUDE.md + AGENTS.md + DEPLOYMENT.md give a new developer everything they need. `scripts/dev-setup.sh` is idempotent.

---

## What Needs Work

### Backend — 3 Structural Issues

1. **Business logic in routers**: Metering (wallet reset, spend, balance check), streak calculation, and stage progress computation all live in router files instead of a service/domain layer. When a second endpoint needs similar logic, it will be copy-pasted.

2. **N+1 queries in stage progress**: `domain/stage_progress.py` runs 26 queries for what should be 2-3 JOINs. Each habit triggers individual queries for completions and goals.

3. **Incomplete features shipped as stubs**: `compute_stage_progress()` hardcodes `habits_progress = 0.0` and `course_items = 0`. Energy plans aren't persisted. Users see misleading progress percentages.

### Frontend — 3 Structural Issues

1. **Triple-layer state management**: Auth in Context, habits in Zustand, UI in useState — with no clear boundary. `useHabits` bridges all three, creating stale closures and redundant state.

2. **God hook**: `useHabits.ts` is 586 lines with 7 nested hooks returning 30+ properties. To understand habit selection, you trace 6 levels of indirection. This is the single biggest maintainability risk.

3. **Design tokens exist but aren't used**: `tokens.ts` defines colors, spacing, radii — but components hardcode `#c00`, `#4a90d9`, `borderRadius: 8` inline. No lint rule enforces token usage.

### Infrastructure — 2 Issues

1. **Redundant Python formatters**: Black + ruff --fix + ruff-format all run in pre-commit. They can fight each other. Pick one.

2. **Expensive hooks on pre-commit**: Full test suite + coverage + complexity analysis runs on every commit. Should be pre-push or CI-only for fast local feedback.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| God hook stale closure bug in production | High | Medium | Phase 7-02: decompose useHabits |
| N+1 queries slow down as data grows | Medium | High | Phase 7-04: optimize stage progress queries |
| New developer copies business logic from router | High | Low | Phase 7-01: extract service layer |
| Design inconsistency confuses users | Medium | Low | Phase 7-07: enforce design tokens |
| Pre-commit takes >60s, developers skip it | High | Medium | Phase 7-10: streamline hooks |

---

## Recommendation

**Ship to Railway now.** The security audit is complete, the wallet system prevents cost overruns, and the deployment infrastructure is solid.

**Then immediately schedule Phase 7** (cleanup epic) before adding features. The god hook and N+1 queries will compound into real bugs and performance issues as the user base grows. Estimated effort: ~2,800 LoC across 10 issues, all pure refactoring with no behavior changes.
