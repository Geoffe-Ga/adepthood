# audit-paginate-02: Paginate the practice-recipes list endpoint

**Labels:** `audit-paginate`, `backend`, `performance`, `priority-high`
**Epic:** Pagination & Response Contracts
**Estimated LoC:** ~170  (hard cap 700)

## Problem

`GET /practice-recipes` (`routers/practice_recipes.py:186-199`) returns **every** recipe visible to the
caller — all system recipes plus all of the caller's personal recipes — as an unbounded
`list[PracticeRecipeOut]` with no `limit`/`offset`; the `mode` query param only filters, it does not
bound. Current state: this is an §5.3 **pagination** finding (§4, "unbounded list", High). The picker
fires this endpoint every time its sheet opens, so the payload and the batched-step hydration cost
(`_hydrate_recipes_with_steps`, line 171) grow with library size. The `Page[T]` envelope and the
habits wiring (`routers/habits.py:220-243`) already model the fix.

## Scope

**Covers:** adding `PaginationParams` + the `?paginate=true` `Page[PracticeRecipeOut]` envelope to
`list_practice_recipes`, preserving the existing `mode` filter and the single-`IN` step hydration so
hydration still applies only to the page slice (not the full library).

**Does NOT cover:** the recipe create/get/patch/delete routes, the `apply-to` endpoint's embedded
`sessions[]` (issue 03), or frontend consumption. The bare-list default stays.

## Tasks

1. **Add `PaginationParams` to the endpoint** — in `backend/src/routers/practice_recipes.py`, import
   `Page`, `PaginationParams`, `build_page` from `schemas` and `paginate_query` from
   `schemas.pagination`. Change `list_practice_recipes` to take
   `pagination: Annotated[PaginationParams, Depends()]`, set `response_model=None`, and return
   `Page[PracticeRecipeOut] | list[PracticeRecipeOut]`.
2. **Paginate before hydration** — pass the existing `_build_recipe_list_query(user_id, mode)` to
   `paginate_query` so the `OFFSET`/`LIMIT` (and `COUNT(*)`) run on the recipe rows, then call
   `_hydrate_recipes_with_steps` on the **page slice only** so the `WHERE recipe_id IN (...)` step
   lookup stays bounded to the current page. Return `build_page(hydrated, total, pagination)` when
   `pagination.paginate`, else the bare hydrated list.
3. **Tests** — add cases: bare list unchanged (default), `?paginate=true` returns the envelope, default
   `limit` applied, `offset` skips, `total`/`has_more` correct across >1 page, `mode` filter composes
   with pagination (filter applied before count + slice), and each returned recipe still carries its
   hydrated steps.

## Acceptance Criteria

- [ ] `GET /practice-recipes` paginates: under `?paginate=true` it returns a `Page` envelope with the
      default `limit` from `PaginationParams`; steps are hydrated for the page slice only.
- [ ] The `mode` filter and pagination compose: `total`/`has_more` reflect the filtered set, not the
      whole library.
- [ ] Backward-compatible with the existing bare-list path: omitting `?paginate=true` returns the same
      `list[PracticeRecipeOut]` (with steps) as today.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/practice_recipes.py` | Modify (`list_practice_recipes`: add `PaginationParams`, paginate before hydration, return `Page \| list`) |
| `backend/tests/test_practice_recipes.py` | Modify (add pagination + mode-compose cases; keep bare-list assertion) |
