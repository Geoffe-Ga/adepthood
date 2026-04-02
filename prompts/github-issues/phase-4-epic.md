# EPIC: Phase 4 — Polish & Harden

**Labels:** `epic`, `phase-4`, `priority-lower`

## Summary

With the app functional (Phase 1), well-structured (Phase 2), and feature-complete (Phase 3), this phase addresses code quality, type safety, test coverage, security hardening, and developer experience issues found during the code review. These are not blockers but accumulate into technical debt if left unaddressed.

## Success Criteria

- Zero `@ts-ignore` or `as never` type casts in the frontend
- `Math.random()` replaced with proper UUID generation
- Backend has rate limiting on auth endpoints
- Integration and E2E tests exist
- Notification scheduling is resilient to app restarts
- Navigation is fully type-safe

## Sub-Issues

1. `phase-4-01` — Replace Math.random() IDs with UUID generation
2. `phase-4-02` — Eliminate all @ts-ignore and type-unsafe casts
3. `phase-4-03` — Add rate limiting and security hardening to auth
4. `phase-4-04` — Fix notification persistence and lifecycle
5. `phase-4-05` — Add type-safe navigation throughout the app
6. `phase-4-06` — Add integration and E2E test coverage
7. `phase-4-07` — Document magic numbers and add missing comments
8. `phase-4-08` — Fix CORS production configuration
