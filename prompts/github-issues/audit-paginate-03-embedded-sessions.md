# audit-paginate-03: Cap/paginate the embedded UserPractice session history

**Labels:** `audit-paginate`, `backend`, `performance`, `priority-high`
**Epic:** Pagination & Response Contracts
**Estimated LoC:** ~260  (hard cap 700)

## Problem

Three UserPractice responses embed the caller's **entire** practice-session history inline on every
call: `get_user_practice` (`routers/user_practices.py:510-532`), `customize_user_practice`
(`user_practices.py:561-609`), and `apply_recipe_to_user_practice` (`practice_recipes.py:381-406`).
Each runs an unbounded
`select(PracticeSession).where(user_practice_id == …).order_by(timestamp.desc())` and serialises the
whole result into `sessions[]`, bypassing the already-paginated `list_sessions` endpoint. Current
state: this is an §5.3 **pagination** finding (§4, "unbounded embed", High). A user with months of
history pays the full history cost on every detail GET, customize PATCH, and recipe-apply POST.

## Scope

**Covers:** bounding the embedded `sessions[]` in all three responses so a single GET/PATCH/POST never
materialises more than a fixed cap of the most recent sessions, with the page metadata the client needs
to fetch older sessions via the existing paginated `list_sessions` endpoint. The embedded query must
order newest-first (as today) and apply the cap in SQL (`LIMIT`), not in Python after a full fetch.

**Does NOT cover:** the standalone `list_sessions` endpoint (already paginated), the practice-tags /
recipes list endpoints (issues 01/02), or removing the embedded `sessions[]` entirely (the frontend
store merges it back — see the comment at `practice_recipes.py:377-380`, so it must stay present but
bounded). The typed-contract rebuild of these three dicts is issue 05; this issue keeps them returning
their current shape, only bounded.

## Tasks

1. **Add a shared "recent sessions" loader** — in `backend/src/routers/user_practices.py` (or a small
   shared helper imported by `practice_recipes.py`), add one function that takes
   `(session, user_practice_id, pagination)` and returns the newest-first session slice plus its
   `total`/`has_more`, applying `LIMIT`/`OFFSET` in SQL via `paginate_query`. A named constant
   `EMBEDDED_SESSIONS_DEFAULT_LIMIT` (no magic numbers) caps the embed when the caller does not opt in.
2. **Wire all three call sites** — replace the unbounded
   `select(PracticeSession)…order_by(timestamp.desc())` + `list(...)` blocks at
   `user_practices.py:519-524`, `user_practices.py:590-595`, and `practice_recipes.py:381-386` with the
   shared loader so each embeds at most the cap. Accept `PaginationParams` so a client can page the
   embed (or, minimally, accept a `sessions_limit`/`sessions_offset` query pair) — choose the form that
   keeps the `UserPracticeDetail`/`sessions[]` contract backward compatible (still a JSON array under
   `sessions`).
3. **Expose embed page metadata** — surface `sessions_total` / `sessions_has_more` (or an equivalent
   nested page block) so the frontend knows older sessions exist and can fetch them through the
   paginated `list_sessions` endpoint. Document the chosen shape in the endpoint docstrings.
4. **Tests** — for each of the three endpoints: history larger than the cap returns exactly the cap of
   newest sessions, the newest-first ordering is preserved, the older sessions are reachable via the
   paging params, and `sessions_total`/`has_more` are correct. Confirm a user with ≤ cap sessions sees
   an unchanged `sessions[]` (backward compatibility).

## Acceptance Criteria

- [ ] None of `get_user_practice`, `customize_user_practice`, `apply_recipe_to_user_practice` embeds
      more than `EMBEDDED_SESSIONS_DEFAULT_LIMIT` sessions in a single response; the cap is applied in
      SQL (`LIMIT`), not by slicing a full fetch.
- [ ] Embedded `sessions[]` stays newest-first and present (not `[]`); a user with ≤ cap sessions sees
      the same `sessions[]` as today (backward-compatible with the bare path).
- [ ] Page metadata (`sessions_total` / `sessions_has_more` or nested page block) lets the client reach
      older sessions via the existing paginated `list_sessions` endpoint.
- [ ] All three call sites use one shared loader — the unbounded `select(PracticeSession)` block is
      gone from each.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/user_practices.py` | Modify (`get_user_practice`, `customize_user_practice`; add shared bounded-sessions loader + constant) |
| `backend/src/routers/practice_recipes.py` | Modify (`apply_recipe_to_user_practice`: use shared loader) |
| `backend/src/schemas/practice.py` | Modify (add `sessions_total`/`sessions_has_more` or nested page block to `UserPracticeDetail`) |
| `backend/tests/test_user_practices.py` | Modify (cap + ordering + page-metadata cases) |
| `backend/tests/test_practice_recipes.py` | Modify (apply-to embed cap cases) |
