# Phase 5 — Test Coverage & Security Hardening

## Overview

Phase 5 addresses the two most critical gaps discovered during codebase triage:

1. **Backend test coverage is 52.9%** — far below the 90% threshold enforced by
   pre-commit and CI. Router modules range from 27–53% coverage.
2. **Zero frontend tests exist.** The `--passWithNoTests` flag silently passes CI.
3. **Multiple security issues**: unescaped LIKE wildcards in journal search,
   missing auth on energy endpoint, bot-response endpoint doesn't verify user_id
   ownership.
4. **OpenAPI `types.ts` is completely stale** — only contains 4 of ~20+ routes,
   causing a growing divergence between backend reality and frontend type defs.

This phase is the critical path for enabling safe, confident development of
future features. Without it, the codebase cannot pass its own quality gates.

## Estimated Scope

- **10 issues**, ~2,375 LoC total
- Primary focus: test coverage (issues 01–04, 08) and security (issue 05)
- Secondary focus: type alignment (06), startup optimization (07), auth UX (09),
  resilience (10)
