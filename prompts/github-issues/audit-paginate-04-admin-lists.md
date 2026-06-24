# audit-paginate-04: Paginate the admin stage-gap and usage lists

**Labels:** `audit-paginate`, `backend`, `performance`, `priority-high`
**Epic:** Pagination & Response Contracts
**Estimated LoC:** ~220  (hard cap 700)

## Problem

Two admin endpoints materialise whole tables. `list_stage_progress_gaps`
(`routers/admin.py:191-193`) runs `select(StageProgress)` with no bound and pulls **every** row into
Python before filtering for non-contiguous gaps — a full-table scan that grows one row per user.
`get_usage_stats` (`routers/admin.py:89-126`) builds `per_user` as one `UserUsageBreakdown` per
token-using user (`group_by(user_id)`), also unbounded. Current state: these are §5.3 **pagination**
findings (§4 — `admin.py:191-193` "unbounded scan", High; `admin.py:89-126` "unbounded", Medium). On a
live database both responses scale linearly with the user base, on the admin dashboard surface.

## Scope

**Covers:** adding `limit`/`offset` to both admin lists. For `list_stage_progress_gaps`, push the cap
into the query so it stops materialising the whole `StageProgress` table; for `get_usage_stats.per_user`,
bound the per-user breakdown. Both reuse the shared `PaginationParams` / `Page[T]` primitives and the
`?paginate=true` opt-in so the existing admin clients keep their current shape.

**Does NOT cover:** `get_usage_stats` totals or `per_model` (bounded — one row per distinct model, not
per user), the `repair_stage_progress` POST, or non-admin endpoints. The bare path stays default.

## Tasks

1. **Paginate `list_stage_progress_gaps`** — in `backend/src/routers/admin.py`, add
   `pagination: Annotated[PaginationParams, Depends()]`. Apply `OFFSET`/`LIMIT` in SQL so only a page
   of `StageProgress` rows is materialised per request; keep `_detect_gap` filtering per row. Because
   the gap filter is post-query, document the contract clearly in the docstring (page over scanned
   rows, with `total` being the scanned-row count or — preferably — a `COUNT(*)` of the base table via
   `paginate_query`). Return the gap rows under `?paginate=true` as a `Page` envelope, falling back to
   the existing `StageProgressGapsResponse` shape on the bare path.
2. **Paginate `get_usage_stats.per_user`** — add `PaginationParams` and apply `OFFSET`/`LIMIT` to the
   `per_user_rows` query (the `group_by(user_id)` SELECT), preserving the existing
   `COALESCE(SUM(cost)).desc()` ordering. Surface a `per_user` page (or `per_user_total`/`has_more`)
   while leaving `totals` and `per_model` untouched. Keep the bare-path response shape backward
   compatible.
3. **Tests** — for both endpoints (admin-authed): default `limit` bounds the result, `offset` skips,
   `total`/`has_more` correct across >1 page, ordering preserved (stage gaps stable; usage
   highest-cost-first), and the bare path (no `?paginate=true`) returns the current shape. Add a case
   asserting `list_stage_progress_gaps` no longer loads the full table (e.g. seed more rows than one
   page and assert only a page is returned).

## Acceptance Criteria

- [ ] `GET /admin/stage-progress/gaps` paginates: under `?paginate=true` it returns a `Page` envelope,
      default `limit` applied, and the query no longer materialises the whole `StageProgress` table.
- [ ] `GET /admin/usage-stats` bounds `per_user`: under `?paginate=true` the per-user breakdown is a
      bounded page ordered highest-cost-first; `totals` and `per_model` are unchanged.
- [ ] Backward-compatible with the existing bare-list paths where applicable (omitting `?paginate=true`
      returns today's `StageProgressGapsResponse` / `UsageStatsResponse` shapes).
- [ ] Both endpoints stay admin-only (`require_admin` dependency unchanged).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/admin.py` | Modify (`list_stage_progress_gaps`, `get_usage_stats`: add `PaginationParams`, push bounds into SQL) |
| `backend/src/schemas/admin.py` | Modify (add page fields/envelope wiring for gaps + per_user) |
| `backend/tests/test_admin.py` | Modify (pagination + "not full-table" cases; keep bare-path assertions) |
