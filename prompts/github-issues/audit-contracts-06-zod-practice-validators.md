# audit-contracts-06: Replace hand-rolled practice validators with Zod

**Labels:** `audit-contracts`, `frontend`, `bug`, `priority-medium`
**Epic:** Data-Layer Contracts & Schema Drift
**Estimated LoC:** ~520  (hard cap 700)

## Problem

The practice client validates responses with hand-rolled `typeof` guards
(`frontend/src/api/index.ts:1899-2204`: `validatePracticeItem`,
`validatePracticeRecipe`, `validatePracticeRecipeStep`, and the `hasRecipe*`
helpers). These are *partial* guards — `validatePracticeItem`
(`index.ts:1899-1908`) only checks four of the item's fields — and, critically,
`practices.list` applies them as a **filter**: `return data.filter(validatePracticeItem)`
(`index.ts:1950`, repeated at `1982`). So when the backend renames a field the
guard checks, **every row silently fails the guard and is dropped** — the user
sees an empty catalog with no error, no log, no `ApiValidationError`. **Current
state:** validators that filter rather than raise, hiding drift as missing data
— §5.4 class: schema drift (audit §7).

## Scope

Covers: replacing the hand-rolled `typeof` guards for `PracticeItem` and
`PracticeRecipe` (+ its step) with Zod schemas that *parse and raise* on drift,
so a field rename surfaces as `ApiValidationError` instead of vanishing rows.
Reuses `practiceItemSchema` from issue 04 where available.

Does NOT cover: the paginated `loosePageSchema` double-casts (issue 04 owns
those; this issue handles the *bare-list* and *single-get* paths that use the
`typeof` guards).

## Tasks

1. **Reuse / define `practiceItemSchema`** — prefer the schema landed in issue
   04; if 04 has not merged, define it here and have 04 consume it. Cover the
   full `PracticeItem` shape, not just the four fields the old guard checked.
2. **`practiceRecipeStepSchema` + `practiceRecipeSchema`** — model
   `PracticeRecipeStep` (`index.ts:2162-2171`: `position`, `tag_slug`,
   `tag_label`, `prompt_label`, `target_count`) and `PracticeRecipe`
   (`index.ts:2194-2204`: `id`, `rounds`, slug/name/description/created_at,
   `owner_user_id` nullable, `mode` enum, `steps[]`).
3. **Replace the filter with a parse** — change `practices.list`
   (`index.ts:1949-1950`) and `listAll` (`index.ts:1982`) from
   `data.filter(validatePracticeItem)` to validating the array through
   `z.array(practiceItemSchema)` so a drifted row **raises** rather than being
   dropped. Same for `practices.get` (`index.ts:1984-1987`) and the recipe
   list/get paths.
4. **Delete the dead guards** — once nothing references
   `validatePracticeItem` / `validatePracticeRecipe` / `validatePracticeRecipeStep`
   / `hasRecipe*`, remove them.
5. **TDD** — a test that a practice list with one drifted row (renamed
   `default_duration_minutes`) now throws `ApiValidationError` instead of
   returning a silently shortened array.

## Acceptance Criteria

- [ ] `practices.list` / `listAll` / `get` and the recipe paths validate via
      Zod; no `data.filter(validate…)` remains in `index.ts`.
- [ ] A drifted practice row surfaces as `ApiValidationError` (not a dropped
      row), proven by a test asserting the throw and the un-shortened-intent.
- [ ] The hand-rolled `validatePracticeItem` / `validatePracticeRecipe` /
      `validatePracticeRecipeStep` / `hasRecipe*` functions are deleted.
- [ ] A valid practice/recipe list still round-trips with all rows intact.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/api/schemas.ts` | Modify — practice item + recipe + step schemas |
| `frontend/src/api/index.ts` | Modify — parse instead of filter; delete `typeof` guards |
| `frontend/src/api/__tests__/schemas.test.ts` | Modify — drift-raises + valid-round-trip cases |
</content>
