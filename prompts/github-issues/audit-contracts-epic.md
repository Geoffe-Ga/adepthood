# EPIC: Data-Layer Contracts & Schema Drift

**Labels:** `epic`, `frontend`, `priority-high`
**Slug:** `audit-contracts`
**Source:** `prompts/github-issues/2026-06-24_ADEPTHOOD_FULL_AUDIT.md` §7 (with cross-refs to §2, §4)

## Summary

The frontend defends its data layer with two parallel contracts: the
compile-time TypeScript interfaces in `frontend/src/api/index.ts` and the
runtime Zod schemas in `frontend/src/api/schemas.ts`. When either drifts from
the backend's actual response shape, the failure mode is the *worst* kind —
silent. The audit (§7) found seven concrete drifts where a mismatch does not
surface as the typed `ApiValidationError` the Zod layer was built to produce
(`schemas.ts:1-18`), but instead as **live data loss**, a deep `TypeError`
inside a screen, or rows that simply vanish with no error at all.

The headline is `audit-contracts-01`: `goalSchema` omits `days_of_week`, so
Zod's default strip-mode **deletes** a field that is on the wire
(`backend/src/schemas/goal.py:42`) and already typed in `ApiGoal`
(`index.ts:769-770`). Every weekly-cadence ("Mon/Wed") goal loses its schedule
on every refetch — a data-loss bug, not a cosmetic one.

This epic closes the gap so that backend/frontend drift always surfaces as a
clear, logged `ApiValidationError` at the HTTP-client edge — never as silent
data loss, a deep `TypeError`, or a quietly filtered-out row.

## Success Criteria

- [ ] No validated response silently drops a field that exists on the wire;
      `days_of_week` survives `goalSchema` validation end-to-end.
- [ ] Every list/paginated endpoint passes a real Zod schema (no
      `request<T>()` call without a `schema`, no `loosePageSchema` double-cast
      for item-level contracts that have a concrete shape).
- [ ] Nullable backend fields (`PromptListResponse.total`) are typed nullable
      on the frontend and guarded at every consumer.
- [ ] Hand-rolled `typeof` validators that *filter* or *strip* are replaced by
      Zod schemas that *raise* on drift, so a field rename surfaces an error
      instead of vanishing rows.
- [ ] Token refresh is deduped (single in-flight promise) and routed through
      the timeout/abort-aware `request()` / `fetchWithTimeout` path.
- [ ] The stale generated `types.ts` is regenerated from the live OpenAPI
      schema or its deprecated derived exports are deleted.
- [ ] No existing tests break; line coverage ≥ 90%; all pre-commit hooks pass.

## Sub-Issues

| # | Issue | Priority | Est. LoC |
|---|-------|----------|----------|
| 01 | [Restore `days_of_week` in `goalSchema`](audit-contracts-01-goal-days-of-week.md) | priority-critical | ~120 |
| 02 | [Make `PromptListResponse.total` nullable + guard consumers](audit-contracts-02-prompt-total-nullable.md) | priority-high | ~150 |
| 03 | [Validate `journal.list` & `prompts.history` responses](audit-contracts-03-validate-list-responses.md) | priority-high | ~220 |
| 04 | [Per-item Zod schemas for paginated endpoints](audit-contracts-04-per-item-page-schemas.md) | priority-medium | ~650 |
| 05 | [Harden token refresh (timeout + in-flight dedupe)](audit-contracts-05-token-refresh-hardening.md) | priority-medium | ~280 |
| 06 | [Replace hand-rolled practice validators with Zod](audit-contracts-06-zod-practice-validators.md) | priority-medium | ~520 |
| 07 | [Regenerate or delete stale OpenAPI `types.ts`](audit-contracts-07-regenerate-openapi-types.md) | priority-medium | ~200 |

**Recommended order:** 01 first (live data loss), then 02 → 03 (cheap,
high-leverage validation gaps), then 04 / 06 (the bulk per-item schema work),
then 05 and 07 (independent hardening / cleanup). Issues 04 and 06 both touch
the practice schemas and should land 04 before 06 to share the new per-item
schemas.
</content>
</invoke>
