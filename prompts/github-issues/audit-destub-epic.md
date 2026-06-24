# EPIC: De-Stub: Make Aspirational Features Real

**Labels:** `epic`, `full-stack`, `priority-high`

## Summary

The 2026-06-24 full-stack audit (`prompts/github-issues/2026-06-24_ADEPTHOOD_FULL_AUDIT.md` §6)
catalogued a cluster of **honest-but-hollow** capabilities: features that present a real
surface to the user (or to ops) but are backed by a placeholder, a mock, or a contract
that is read but never honoured. Each one either ships a stub where users expect real
behaviour (78 tarot cards → one placeholder PNG; a "Start from a preset" button wired
to `goBack`), trusts data it must not trust (the energy planner reads client-supplied
costs), or advertises a guarantee it does not keep (`ENCRYPTION_AT_REST_ENABLED` read
but never applied; allowlisted LLM models with no pricing row).

This epic replaces each placeholder with **real behaviour** or **honestly removes** the
hollow surface — no feature is allowed to keep claiming something it does not do.

This epic supersedes and extends `phase-7-05-complete-stubs.md`, which scoped three of
these (stage-progress divisor, energy persistence, LLM error mapping) at a high level.
Those three are re-issued here with file:line evidence and TDD acceptance criteria
(`audit-destub-04`, `-07`, `-08`); the older issue should be closed as superseded once
this epic is scheduled. Sentry wiring (§6, "Maybe") and custom-deck photo upload
(`pickCardPhoto.ts`, §6, "Maybe") are intentionally **out of scope** here — they are
tracked separately under `audit-ux` / observability.

## Success Criteria

- [ ] No user-facing Practice surface resolves to `_placeholder.png` for a card that has
      real public-domain artwork available (`audit-destub-01`).
- [ ] Every CTA and configurator entry point in the Create-Practice wizard reaches a real
      destination — no button silently dismisses the flow, no mode shows a dead-end notice
      (`audit-destub-02`, `-09`).
- [ ] The energy planner derives `energy_cost` / `energy_return` from server-owned `Habit`
      rows and ignores any client-sent costs (`audit-destub-03`); plans persist across
      restarts and workers (`audit-destub-04`).
- [ ] No security or pricing contract is *read but unhonoured*: the journal encryption flag
      is either implemented or removed (`audit-destub-05`), and every allowlisted LLM model
      has a pricing row or is gated out (`audit-destub-06`).
- [ ] Stage overall-progress folds in course completion and adapts its divisor to the
      components that have data (`audit-destub-07`).
- [ ] BYOK users receive friendly mapped errors on both the streaming and non-streaming
      chat paths (`audit-destub-08`).
- [ ] Every issue lands with tests; backend coverage stays ≥ 90%, all pre-commit hooks pass.

## Sub-Issues

| # | Issue | Scope | Est. LoC | Priority |
|---|-------|-------|----------|----------|
| 01 | [Ship real tarot artwork + resolver](audit-destub-01-tarot-artwork.md) | Frontend | ~650 | Critical |
| 02 | [Wire "Start from a preset" CTA to the picker](audit-destub-02-wizard-preset-cta.md) | Frontend | ~180 | High |
| 03 | [Load energy costs server-side (BUG-PRACTICE-010)](audit-destub-03-energy-server-costs.md) | Backend | ~300 | High |
| 04 | [Persist energy plans to a table](audit-destub-04-persist-energy-plans.md) | Backend | ~380 | High |
| 05 | [Resolve the journal encryption flag](audit-destub-05-journal-encryption-flag.md) | Backend | ~120 | High |
| 06 | [Reconcile BotMason allowlist ↔ pricing](audit-destub-06-botmason-pricing-reconcile.md) | Backend | ~150 | High |
| 07 | [Fold course completion into stage progress](audit-destub-07-stage-progress-course.md) | Backend | ~160 | Medium |
| 08 | [Map provider errors on the non-stream chat path](audit-destub-08-botmason-error-mapping.md) | Backend | ~180 | Medium |
| 09 | [Build the missing configurator forms](audit-destub-09-practice-configurator-forms.md) | Frontend | ~420 | Medium |

**Dependency note:** `audit-destub-04` (persist plans) builds on `audit-destub-03`
(server-side costs) — land `-03` first so the persisted plan records real, trusted inputs.
The rest are independent and can be parallelised.
