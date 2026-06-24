# audit-paginate-01: Paginate the practice-tags list endpoint

**Labels:** `audit-paginate`, `backend`, `performance`, `priority-high`
**Epic:** Pagination & Response Contracts
**Estimated LoC:** ~140  (hard cap 700)

## Problem

`GET /practice-tags` (`routers/practice_tags.py:64-80`) returns **every** tag the caller can see —
all system tags plus all of the caller's personal tags — in a single unbounded `list[PracticeTagOut]`
with no `limit`/`offset`. Current state: this is an §5.3 **pagination** finding (§4, "unbounded list",
High). As a user's personal tag library grows the payload and query cost grow with it, and unlike
habits/practices this endpoint never adopted the existing `Page[T]` envelope. The `Page[T]` /
`PaginationParams` machinery in `schemas/pagination.py` and the canonical wiring in
`routers/habits.py:220-243` already solve exactly this.

## Scope

**Covers:** adding `PaginationParams` + the `?paginate=true` `Page[PracticeTagOut]` envelope to the
`list_practice_tags` endpoint, matching the habits pattern, keeping the existing
`system-first / label` ordering authoritative through pagination.

**Does NOT cover:** the single-tag GET/POST/PATCH/DELETE routes (no list), the recipes list (issue 02),
embedded session lists (issue 03), or any frontend consumption of the new envelope. The bare-list path
stays the default; this issue does not remove it.

## Tasks

1. **Add `PaginationParams` to the endpoint** — in `backend/src/routers/practice_tags.py`, import
   `Page`, `PaginationParams`, `build_page` from `schemas` and `paginate_query` from
   `schemas.pagination`. Change `list_practice_tags` to take
   `pagination: Annotated[PaginationParams, Depends()]`, set `response_model=None`, and return
   `Page[PracticeTagOut] | list[PracticeTagOut]` — exactly as `routers/habits.py:220-243`.
2. **Route the existing query through `paginate_query`** — keep the current
   `or_(owner is None, owner == user_id)` filter and the
   `order_by(owner.nulls_first(), label)` ordering; pass that `select` to `paginate_query`, serialise
   the page slice to `PracticeTagOut`, and return `build_page(...)` when `pagination.paginate` is true,
   else the bare list. TDD-able against `tests/test_practice_tags.py` (or equivalent).
3. **Tests** — add cases: bare list unchanged (default), `?paginate=true` returns the envelope, default
   `limit` applied, `offset` skips, `total`/`has_more` correct across a tag set larger than one page,
   and ordering preserved (system tags first) through pagination.

## Acceptance Criteria

- [ ] `GET /practice-tags` paginates: under `?paginate=true` it returns a `Page` envelope
      (`{items, total, limit, offset, has_more}`) with the default `limit` from `PaginationParams`.
- [ ] Backward-compatible with the existing bare-list path: omitting `?paginate=true` returns the same
      `list[PracticeTagOut]` shape (system tags first, then label order) as today.
- [ ] `limit` / `offset` bounds are enforced by the shared `PaginationParams` validators (`ge`/`le`);
      no parallel validation is added.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/practice_tags.py` | Modify (`list_practice_tags`: add `PaginationParams`, return `Page \| list`) |
| `backend/tests/test_practice_tags.py` | Modify (add pagination cases; keep bare-list assertion) |
