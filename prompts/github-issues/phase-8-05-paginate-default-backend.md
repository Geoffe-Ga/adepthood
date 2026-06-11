# phase-8-05: Make paginate=true the default and remove the bare-list branches

**Labels:** `phase-8`, `backend`, `pagination`, `priority-medium`
**Epic:** Phase 8 — Post-Drain Hardening
**Depends on:** phase-8-04 (every frontend caller must be on the envelope first)
**Estimated LoC:** ~250 (significant deletions)

## Problem

Issue #221's end state — "make `paginate=true` the default and drop the
bare-list branch" — was explicitly deferred until the frontend was fully
migrated (#408's final checklist bullet). After phase-8-04, every frontend
caller uses the `Page` envelope, so the seven list endpoints still carrying
the dual-response branch (`paginate` query param toggling between a bare
array and the envelope) can be simplified to envelope-only.

Current state: each affected router (`habits`, `goal_groups`, `practices`,
`user_practices`, `practice_sessions`, `stages`, `course` stage-content)
has an `if paginate:` branch and duplicate response-model plumbing.

## Scope

Backend-only contract flip. The `paginate` query parameter is accepted but
ignored (always envelope) for one deprecation window, so any stale client
keeps functioning — the bare-array shape disappears.

## Tasks

1. **Flip the seven endpoints**
   - Always return the `Page` envelope; delete the bare-list branch and its
     response-model union.
   - Keep accepting `paginate` as a no-op query param (documented
     deprecation note in the docstring) so old clients don't 422.

2. **Frontend cleanup ride-along**
   - Delete the now-redundant bare `list()` client methods whose call sites
     phase-8-04 removed; `listAll`/`listPaginated` remain.

3. **Tests**
   - Update backend list-endpoint tests to expect the envelope
     unconditionally; add one regression test per endpoint asserting
     `?paginate=false` still returns the envelope (deprecation semantics).
   - Frontend: remove tests of the deleted bare methods.

## Acceptance Criteria

- No `if paginate` branch remains in any router
  (`grep -rn 'paginate' backend/src/routers/` shows only the no-op param).
- All list endpoints return `Page<T>` regardless of query params.
- Coverage and docstring gates hold without threshold changes.
- No existing tests break (beyond the intentional contract updates).

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/routers/{habits,goal_groups,practices,user_practices,practice_sessions,stages,course}.py` | Modify |
| `backend/tests/test_*api*.py` (affected list tests) | Modify |
| `frontend/src/api/` (delete orphaned bare `list()` methods) | Modify |
