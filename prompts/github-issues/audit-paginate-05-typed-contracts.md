# audit-paginate-05: Typed response contracts for week-count and UserPractice detail

**Labels:** `audit-paginate`, `backend`, `contracts`, `priority-medium`
**Epic:** Pagination & Response Contracts
**Estimated LoC:** ~200  (hard cap 700)

## Problem

Several practice responses are untyped or hand-assembled, so the wire contract is not enforced by a
Pydantic model and drifts silently from the schema. `week_count` (`routers/practice_sessions.py:457-476`)
has no `response_model` and returns a raw `dict[str, int]`. Three endpoints build a `dict[str, Any]` by
hand, each duplicating the `UserPracticeDetail` keys: `get_user_practice` (`user_practices.py:510`),
`customize_user_practice` (`user_practices.py:561`), and `apply_recipe_to_user_practice`
(`practice_recipes.py:347`). Current state: these are §5.3 **response-contract** findings (§4 — untyped
contract / hand-built dicts, Medium). A field rename on `UserPracticeDetail` would not flag these
hand-rolled dicts, so they drift; the raw `week_count` dict has no OpenAPI schema at all.

## Scope

**Covers:** giving `week_count` a typed `response_model`, and rebuilding the three hand-rolled
UserPractice responses from `UserPracticeDetail` (e.g. `UserPracticeDetail(...)` /
`model_validate(...)`) so the keys live in exactly one place. The shapes on the wire stay identical;
this is a contract-tightening, not a behaviour change.

**Does NOT cover:** the embedded-sessions cap (issue 03 — land that first so this issue types the final
shape, including any `sessions_total`/`has_more` fields 03 adds), the list endpoints (issues 01/02/04),
or the dual-shape `Page[T] | list[T]` legacy-path removal (tracked separately).

## Tasks

1. **Type `week_count`** — in `backend/src/routers/practice_sessions.py`, add a small Pydantic response
   model (e.g. `WeekCountResponse(count: int)`) in `schemas/practice.py` (or alongside the existing
   session schemas), set it as the route's `response_model`, and return the model instance instead of
   `{"count": count}`.
2. **Build UserPractice detail from the schema** — replace the three hand-assembled `dict[str, Any]`
   returns with `UserPracticeDetail(...)` construction at `user_practices.py:527-532`,
   `user_practices.py:604-609`, and `practice_recipes.py:395-406`. Centralise the field mapping
   (the existing `_user_practice_payload` helper plus `effective_name`/`effective_config`/`sessions`)
   so all three build the model the same way; do not duplicate the key list per call site.
3. **Tests** — assert the `week_count` response validates against the new model (and OpenAPI exposes it),
   and that all three UserPractice endpoints still return the documented `UserPracticeDetail` fields
   (including `effective_name`, `effective_config`, `sessions`, and any session page metadata from
   issue 03). Add a regression that a stray/extra key is rejected by the typed model.

## Acceptance Criteria

- [ ] `GET /practice-sessions/week-count` declares a `response_model` and returns a typed model; the
      `{count}` shape is unchanged on the wire and appears in the OpenAPI schema.
- [ ] All three UserPractice responses are constructed from `UserPracticeDetail` — no remaining
      `-> dict[str, Any]` that duplicates the schema keys at `user_practices.py:510,561` /
      `practice_recipes.py:347`.
- [ ] The field mapping lives in one place; adding/renaming a `UserPracticeDetail` field flows to all
      three endpoints without per-site edits.
- [ ] Backward-compatible: the JSON shapes returned by all four endpoints are byte-for-key identical to
      today (plus any fields issue 03 already added).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/schemas/practice.py` | Modify (add `WeekCountResponse`; confirm `UserPracticeDetail` is constructable from the resolved fields) |
| `backend/src/routers/practice_sessions.py` | Modify (`week_count`: add `response_model`, return model) |
| `backend/src/routers/user_practices.py` | Modify (`get_user_practice`, `customize_user_practice`: build `UserPracticeDetail`) |
| `backend/src/routers/practice_recipes.py` | Modify (`apply_recipe_to_user_practice`: build `UserPracticeDetail`) |
| `backend/tests/test_practice_sessions.py` | Modify (assert typed week-count contract) |
| `backend/tests/test_user_practices.py` | Modify (assert typed detail contract) |
