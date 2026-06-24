# audit-contracts-04: Per-item Zod schemas for paginated endpoints

**Labels:** `audit-contracts`, `frontend`, `bug`, `priority-medium`
**Epic:** Data-Layer Contracts & Schema Drift
**Estimated LoC:** ~650  (hard cap 700)

## Problem

Every paginated endpoint **except habits** validates its items as
`z.record(z.unknown())` via the shared `loosePageSchema`
(`frontend/src/api/index.ts:923`, `const loosePageSchema = pageSchema(unknownRecord)`),
then double-casts the result back to the real item type with
`loosePageSchema as unknown as z.ZodType<Page<X>>`. This happens at four call
sites: goal-groups (`index.ts:1114`), stages (`index.ts:1591`), course content
(`index.ts:1669`), practices (`index.ts:1966`), user-practices
(`index.ts:2015`), and practice-sessions (`index.ts:2344`). The envelope is
validated, but the *items* are not — item-level drift (a renamed field, a
nulled-out value, a type flip) is completely invisible and resurfaces as a deep
`TypeError` in a screen. **Current state:** the Page envelope is checked but its
payload is `unknown` — §5.4 class: schema drift (contracts).

## Scope

Covers: writing real per-item Zod schemas for the four item types the audit
calls out — **Stage**, **PracticeItem**, **UserPractice**, and
**PracticeSessionResponse** — and replacing the corresponding `loosePageSchema`
double-casts with `pageSchema(<itemSchema>)`. The `ApiGoalGroup` and
`ContentItem` page casts may be migrated in the same pass if they fit under the
LoC cap; otherwise note them as a follow-up.

Does NOT cover: the hand-rolled `validatePracticeItem` / `validatePracticeRecipe`
`typeof` guards (issue 06 replaces those and should reuse the `PracticeItem`
schema landed here), or the bespoke non-`Page` envelopes (`journal.list`,
`prompts.history` — issue 03).

## Tasks

This is large but mechanical. Do it as ordered sub-tasks, one item schema at a
time, each TDD'd before the next — but keep it a single issue (≤700 LoC).

1. **`stageSchema`** — model `Stage` (`index.ts:1535+`: `id`, `title`,
   `subtitle`, `stage_number`, the spiral-dynamics / polarity string fields,
   `is_unlocked`, `progress`). Replace the cast at `index.ts:1591` with
   `pageSchema(stageSchema)`.
2. **`practiceItemSchema`** — model `PracticeItem` (the fields
   `validatePracticeItem` checks at `index.ts:1899-1908`: `id`, `name`,
   `stage_number`, `default_duration_minutes`, plus `description`,
   `instructions`, `mode`, `mode_config`, `approved`). Replace the cast at
   `index.ts:1966`. Export it for issue 06.
3. **`userPracticeSchema`** — model `UserPractice`. Replace the cast at
   `index.ts:2015`. Cap any embedded `sessions[]` per the backend contract.
4. **`practiceSessionResponseSchema`** — model `PracticeSessionResponse`.
   Replace the cast at `index.ts:2344`.
5. **Remove now-dead double-casts** — each replaced site should pass a true
   `z.ZodType<Page<X>>`, deleting the `as unknown as` escape hatch.
6. **TDD per schema** — for each, a `schemas.test.ts` case that a valid item
   parses and a drifted item (renamed/nulled required field) throws
   `ApiValidationError`.

## Acceptance Criteria

- [ ] `stageSchema`, `practiceItemSchema`, `userPracticeSchema`, and
      `practiceSessionResponseSchema` exist and are used via
      `pageSchema(<schema>)` at their four call sites.
- [ ] None of those four call sites still use
      `loosePageSchema as unknown as z.ZodType<…>`.
- [ ] For each item type, a drifted item (e.g. `stage_number: "1"` or a missing
      required field) surfaces as `ApiValidationError`, proven by a
      `schemas.test.ts` case.
- [ ] `practiceItemSchema` is exported so issue 06 can consume it.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/api/schemas.ts` | Modify — add 4 per-item schemas |
| `frontend/src/api/index.ts` | Modify — replace 4 `loosePageSchema` casts |
| `frontend/src/api/__tests__/schemas.test.ts` | Modify — valid + drift cases per item type |
</content>
