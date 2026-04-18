# Adepthood Bug Remediation Audit — 2026-04-18

A fresh QA-grade audit of the Adepthood codebase (React Native + FastAPI), sliced into 18 scoped reports that can each be worked by a single bounded subagent. Supersedes the 2026-04-14 audit (which bundled components too coarsely, producing Stream Idle timeouts).

**Audit scope:** every feature surface in `backend/src/**` and `frontend/src/**`, plus cross-cutting infrastructure (CORS, DB, observability, design tokens, state, storage, test config).

**Triggered by:** user report that signing up, then pressing a bottom-nav tab, kicked them back to the sign-up screen. That single symptom turned out to be the visible edge of a much wider pattern (auth-persistence races, state bleed, Zustand never-reset-on-logout, optimistic-write-without-rollback).

## Totals

**281 bugs across 18 reports — 32 Critical / 126 High / 107 Medium / 16 Low**

| # | Report | Bugs | C | H | M | L |
|---|--------|-----:|--:|--:|--:|--:|
| 01 | [Auth — signup / login / JWT / lockout](01-auth-signup-login.md) | 19 | 4 | 8 | 6 | 1 |
| 02 | [Frontend AuthContext & token persistence](02-frontend-auth-context.md) | 19 | 2 | 9 | 6 | 2 |
| 03 | [Frontend navigation (tab → signup bug)](03-frontend-navigation.md) | 14 | 3 | 6 | 5 | 0 |
| 04 | [Frontend API client](04-frontend-api-client.md) | 20 | 3 | 9 | 8 | 0 |
| 05 | [Backend app / CORS / middleware](05-backend-app-cors.md) | 10 | 2 | 6 | 2 | 0 |
| 06 | [Backend database & migrations](06-backend-database-migrations.md) | 10 | 2 | 5 | 3 | 0 |
| 07 | [Backend models & schemas](07-backend-models-schemas.md) | 15 | 2 | 6 | 6 | 1 |
| 08 | [Backend observability & admin](08-backend-observability-admin.md) | 10 | 1 | 5 | 4 | 0 |
| 09 | [Habits & streaks](09-habits-streaks.md) | 10 | 1 | 4 | 4 | 1 |
| 10 | [Goals, completions, groups](10-goals-completions-groups.md) | 10 | 3 | 5 | 2 | 0 |
| 11 | [Practices & sessions](11-practices-sessions.md) | 10 | 0 | 5 | 4 | 1 |
| 12 | [Journal](12-journal.md) | 10 | 1 | 4 | 5 | 0 |
| 13 | [BotMason / wallet / LLM](13-botmason-wallet-llm.md) | 15 | 2 | 10 | 3 | 0 |
| 14 | [Course, stages & progression](14-course-stages-progression.md) | 10 | 1 | 4 | 4 | 1 |
| 15 | [Weekly prompts](15-weekly-prompts.md) | 10 | 0 | 2 | 6 | 2 |
| 16 | [Frontend — Habits + Journal screens](16-frontend-features-habits-journal.md) | 36 | 2 | 17 | 17 | 0 |
| 17 | [Frontend — Practice / Course / Map](17-frontend-features-practice-course-map.md) | 29 | 1 | 11 | 12 | 5 |
| 18 | [Frontend — design / state / storage / tests](18-frontend-design-state-tests.md) | 24 | 2 | 10 | 10 | 2 |
| **Total** | | **281** | **32** | **126** | **107** | **16** |

## Top Suspects for the User's Reported 10 Bugs

The user signed up, hit ~10 UX failures, and decided to halt new work and pay down tech debt. The biggest single symptom — **tab-press bounces to sign-up** — is most likely a combination of:

1. **BUG-NAV-*** (Report 03) — conditional mount of `AuthStack` vs `BottomTabs` re-evaluates on every re-render; any transient `token == null` observation unmounts the tab tree and remounts auth.
2. **BUG-FE-AUTH-001 / -002** (Report 02) — `AuthContext` bootstrap reads `token` asynchronously; between `null` (initial) and the resolved token, the conditional navigation flips.
3. **BUG-FE-API-*** (Report 04) — any 401 on first-paint API calls (stale token, clock skew) triggers a global logout.
4. **BUG-FE-STATE-001** (Report 18) — Zustand stores are never reset on logout, so the stale store + cleared token produces a half-authenticated UI that the navigator then decides is "logged out."
5. **BUG-AUTH-*** (Report 01) — signup endpoint contract drift (duplicate signup returning a success the client can't parse, or emitting a token with a malformed `sub`).
6. **BUG-FE-AUTH-010** (Report 02) — token not restored on cold-start race.

**Recommended reproduction:** clear AsyncStorage, sign up, press the BotMason tab immediately. Watch the network tab for a 401 on the first journal/wallet fetch; watch Redux/Zustand for a transient `token == null`.

## Cross-Cutting Themes

### Theme 1 — The "skip to stage 36" chain
Five bugs across three reports combine to let a fresh user skip the 36-stage curriculum in a single request:

- **BUG-SCHEMA-006** (Report 07) — `StageProgressUpdate.current_stage` is unbounded and client-writable.
- **BUG-STAGE-001** (Report 14) — `is_stage_unlocked` only checks `N-1 in completed_stages`, not the full chain.
- **BUG-PROMPT-001** (Report 15) — `_get_user_week = max(week_number)+1` + no unlock gate on `/respond`.
- **BUG-PRACTICE-004** (Report 11) — `stage_number` on practice create is not validated against user progression.
- **BUG-FE-MAP-002 / BUG-FE-COURSE-002** (Report 17) — frontend derives stage from `max(stage_number)` rather than backend truth.

Fixes must land together or the chain stays open.

### Theme 2 — The "credit minting" chain
- **BUG-BM-010** (Report 13) — `POST /user/balance/add` is unauthenticated.
- **BUG-SCHEMA-009** (Report 07) — `BalanceAddRequest.amount` is unbounded.
- **BUG-ADMIN-001** (Report 08) — no `is_admin` field on `User`; the admin router relies on a shared env-var secret.

A single unauthenticated request can mint unlimited credits. Fix BUG-ADMIN-001 first, then gate BUG-BM-010 behind the admin check, then clamp BUG-SCHEMA-009.

### Theme 3 — Optimistic writes that don't roll back
Pervasive across frontend features:

- **BUG-FE-HABIT-001 / -205** (Report 16) — habit logUnit optimistic write; store reverts but disk/queue don't.
- **BUG-FE-JOURNAL-002** (Report 16) — orphaned optimistic user message on stream error.
- **BUG-FE-PRACTICE-005** (Report 17) — weekly count not rolled back.
- **BUG-FE-MAP-005** (Report 17) — no retry/rollback on stage advance failure.
- **BUG-FE-STORAGE-002** (Report 18) — `savePendingCheckIn` read-modify-write race.

Factor a reusable `useOptimisticMutation` hook; standardize rollback.

### Theme 4 — UTC / local timezone drift
A single class of bug appears five times in streaks and date math alone:

- **BUG-STREAK-002** (Report 09) — backend streak computed in UTC while the user lives locally.
- **BUG-FE-HABIT-002 / -006 / -206 / -207** (Report 16) — off-by-one streak drift, wrong unlock countdown near midnight, wrong calendar day in negative-offset TZ, streak never updated against "today."

Centralize a single `dateUtils` module that owns "today in user's TZ."

### Theme 5 — Check-then-insert races without DB-level uniqueness
- **BUG-COURSE-002** (Report 14) — `mark_content_read` check-then-insert.
- **BUG-GOAL-001** (Report 10) — duplicate daily completion TOCTOU.
- **BUG-STAGE-003** (Report 14) — first-advance create path not row-locked.
- **BUG-PRACTICE-005** (Report 11) — single-active-practice TOCTOU.
- **BUG-PROMPT-004** (Report 15) — inconsistent 400/409 split on duplicate prompt response.

Fix pattern: add a DB-level unique constraint, drop the pre-check, rely on `IntegrityError` → 409.

### Theme 6 — Stored XSS / prompt injection
Any free-text user input reaches either the journal render or the LLM context with no sanitization:

- **BUG-JOURNAL-003** (Report 12) — journal messages stored raw, fed to BotMason.
- **BUG-PROMPT-003** (Report 15) — weekly-prompt responses stored raw AND mirrored into journal.
- **BUG-BM-004** (Report 13) — history replay enables system-prompt exfiltration.

Centralize `sanitize_user_text()` and apply at every insertion point — not at render time.

### Theme 7 — IDOR oracles via 404-before-403
- **BUG-COURSE-004** (Report 14) — `mark_content_read` returns 404 before 403.
- **BUG-JOURNAL-002** (Report 12) — same pattern on journal entries.
- Probably more across routers not flagged individually.

Normalize ordering: always resolve row, then authorize; return 403 for any cross-user access.

### Theme 8 — Session hygiene / state bleed
- **BUG-FE-STATE-001** (Report 18, Critical) — Zustand stores never reset on logout.
- **BUG-FE-AUTH-*** (Report 02) — token-only logout; AsyncStorage residue persists.
- **BUG-FE-STORAGE-004** (Report 18) — whitespace credentials persisted.

User A logs out, User B logs in, User B sees User A's habits until manual reload.

### Theme 9 — Client-trusted timestamps / durations
- **BUG-PRACTICE-005 / -006** (Report 11) — backend trusts client duration and timestamp on session submit.
- **BUG-FE-PRACTICE-101 / -105** (Report 17) — frontend sends wall-clock-blind `setInterval` elapsed + `Date.now()`.
- **BUG-FE-JOURNAL-003** (Report 16) — `Date.now()` as message id → collisions on retry.

Server-derived timestamps everywhere; `startedAt`/`endedAt` ISO from client.

### Theme 10 — Observability gaps end-to-end
- **BUG-OBS-001** (Report 08) — `X-Request-ID` log injection.
- **BUG-OBS-003** (Report 08) — no global exception handler.
- **BUG-FE-UI-101 / -102** (Report 18) — ErrorBoundary logs to console only.
- **BUG-ADMIN-004** (Report 08) — `estimated_cost_usd` as float, not Decimal.

Wire frontend + backend to the same Sentry project; adopt Decimal for all money.

## Recommended Remediation Order

### Stage 1 — Unblock the user (1-2 days)
Fix the navigation flash to signup so the app is usable:

1. **BUG-NAV-*** (Report 03) — stabilize the `AuthStack` vs `BottomTabs` conditional so it doesn't flicker on re-render.
2. **BUG-FE-AUTH-001 / -002 / -010** (Report 02) — bootstrap auth synchronously from persisted storage; gate the navigator on `hydrated === true`, not `token === null`.
3. **BUG-FE-API-*** (Report 04) — stop global-logout on every 401; add a refresh flow (or at minimum a 401 backoff).
4. **BUG-FE-STATE-001** (Report 18) — wire store resets into `logout`.

### Stage 2 — Close the credit-minting + skip-to-36 chains (1-2 days)
Each chain fix requires a small, coordinated diff across 3-5 files.

5. **BUG-ADMIN-001 + BUG-BM-010 + BUG-SCHEMA-009** — admin identity + authenticated `/user/balance/add` + amount clamp.
6. **BUG-SCHEMA-006 + BUG-STAGE-001 + BUG-PRACTICE-004** — server-derived stage + chain-validated unlock + stage/practice pair validation.
7. **BUG-PROMPT-001 / -002** — gate `/respond` and `/prompts/{week}` on current week.

### Stage 3 — Systematic cross-cutting patterns (1 week)
8. **TOCTOU family** (Theme 5) — add DB unique constraints, drop pre-checks. One PR per table.
9. **Timezone family** (Theme 4) — centralize `dateUtils`; migrate backend streak computation to stored user TZ.
10. **Optimistic-write family** (Theme 3) — factor `useOptimisticMutation`; standardize rollback.
11. **XSS / prompt-injection family** (Theme 6) — centralize `sanitize_user_text()`; apply at every insertion point.

### Stage 4 — Feature-specific High-severity (1 week)
Remaining items from reports 09-18 — feature owners can pick these up in parallel now that the infrastructure is stable.

### Stage 5 — Design / a11y / polish (ongoing)
12. Contrast + touch-target tokens (Report 18); a11y pass on every feature surface (Reports 16-17 Medium/Low items); test-config fixes (Report 18 BUG-FE-TEST-*).

## How This Audit Was Produced

- **18 scoped reports**, each a single bounded subagent job (1-3k LOC of scope).
- **Fragment-based parallel pattern** for reports exceeding ~1k LOC: splits the scope into 2-3 subagents writing `_fragment-NN{a,b,c}-*.md`; assembler writes scaffold + TOC, concatenates fragments, appends remediation + cross-refs.
- **Format template** derived from `prompts/2026-04-14-bug-remediation/00-INDEX.md`: severity tiers (Critical/High/Medium/Low), stable `BUG-<AREA>-NNN` IDs, Component (file:line), Symptom (user-facing), Root cause (code excerpt), Fix (concrete).
- **Individual commits** for each report so the git log reads as a timeline of findings rather than a single monolithic dump.

## Related Documents

- **Prior audit (superseded):** `prompts/2026-04-14-bug-remediation/` — 7 reports, 146 bugs. Retained for historical comparison; the 2026-04-18 numbering supersedes it.
- **Project guardrails:** `CLAUDE.md`, `AGENTS.md`, `.pre-commit-config.yaml`.
- **Roadmap:** `prompts/github-issues/README.md`.
