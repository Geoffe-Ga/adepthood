# course-cms-03: Course API — stage-introduction endpoints

**GitHub:** #719 · **Labels:** `backend`, `enhancement`
**Epic:** #716 · **Depends on:** #718 (repository)
**Estimated LoC:** ~200

## Problem

The frontend needs to fetch a stage's introduction (the Google-Docs "start
here" reading) and its Markdown body. `ContentRepository` can now serve intros
(#718); expose them over the course API with the same auth + gating + error
semantics as the existing chapter-body endpoint.

## Scope

Two read endpoints on `routers/course.py` + one response schema. No DB changes
(intros aren't seeded). Intros are **ungated by `release_day`** but **gated by
stage-unlock**.

## Tasks (TDD)

1. **Schema.** In `backend/src/schemas/course.py` add `StageIntroResponse`
   `{ stage: int, id: str, slug: str, title: str, summary: str | None }`.
   Bodies reuse the existing `ContentBodyResponse`.
2. **Metadata endpoint.** `GET /course/stages/{stage_number}/intro` →
   `StageIntroResponse`:
   - require auth (`get_current_user`);
   - 404 (`not_found("stage")`) if no `CourseStage` row for the number — reuse
     `_get_stage_by_number`;
   - mask as `content_not_found` when the stage is locked for the user (reuse
     `_is_stage_unlocked_for_user`) — consistent with the content-id 404-mask;
   - mask as `content_not_found` when the repository has no intro for that stage
     (`get_stage_intro` is `None`).
3. **Body endpoint.** `GET /course/stages/{stage_number}/intro/body` →
   `ContentBodyResponse`, decorated with `@limiter.limit(_CMS_PROXY_RATE_LIMIT)`
   like the other body routes:
   - same stage-existence + unlock masking as above;
   - read via the shared `_read_local_body(lambda: get_content_repository().read_intro_body(stage_number), ...)`
     helper so `ContentNotFoundError` → 404 and `ContentRepositoryError` →
     `502 content_unavailable` are handled uniformly.
4. **Tests.** Extend `backend/tests/test_course_local_content.py` (and use
   `set_content_repository_for_tests` to inject a fixture repo):
   - unlocked stage with an intro → 200 + correct metadata / body;
   - locked stage → 404 `content_not_found` (no leak) on both endpoints;
   - stage with no intro in the manifest → 404;
   - unknown stage number → 404;
   - unauthenticated → 401;
   - body endpoint surfaces `502 content_unavailable` when the repo raises a
     non-NotFound `ContentRepositoryError` (e.g. missing file).

## Acceptance criteria

- Both endpoints exist, require auth, gate on stage-unlock, and ignore
  `release_day`.
- Locked / missing-intro / unknown-stage all return `content_not_found` (no
  oracle); broken content → `502 content_unavailable`.
- Existing course endpoints/tests unchanged.
- `./scripts/backend/check-all.sh` exits 0; route functions stay xenon rank A
  (extract helpers if needed).

## Files to modify

| File | Action |
|------|--------|
| `backend/src/schemas/course.py` | Add `StageIntroResponse` |
| `backend/src/routers/course.py` | Add the two intro endpoints (+ helpers) |
| `backend/tests/test_course_local_content.py` | New endpoint tests |

## Constraints

- Reuse `_get_stage_by_number`, `_is_stage_unlocked_for_user`,
  `_read_local_body`, and `_CMS_PROXY_RATE_LIMIT` — do not duplicate gating.
- Do not seed intros into the DB and do not add read-tracking (out of scope).
- Keep the 404-mask discipline (BUG-COURSE-004): a locked stage's intro must be
  indistinguishable from a nonexistent one.
