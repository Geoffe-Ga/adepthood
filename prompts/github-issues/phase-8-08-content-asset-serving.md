# phase-8-08: Serve chapter media assets from vendored content

**Labels:** `phase-8`, `frontend`, `backend`, `content`, `priority-medium`
**Epic:** Phase 8 — Post-Drain Hardening
**Depends on:** None (works against the test fixture tree; real assets arrive with a content pin)
**Estimated LoC:** ~275

## Problem

PR #438 (#394) deliberately drops images whose source is not an absolute
web URL: `ChapterReader.tsx`'s `markdownRules.image` returns `null` for
repo-relative paths "until the media-serving decision in the content epic
lands". The manifest contract has carried a `media` field per chapter since
#389 (`backend/content/manifest.schema.json` `$defs.chapter.media`), but no
app-side consumer exists — a chapter shipping `![diagram](assets/x.png)`
renders without its figure.

## Scope

Backend endpoint serving files from the vendored content directory (same
traversal guard discipline as `ContentRepository._read_markdown`), and the
reader resolving relative image sources against it. Same drip-feed gating
as the body endpoint — assets of a locked chapter must not leak.

## Tasks

1. **Backend: `GET /course/content/{content_id}/assets/{asset_path:path}`**
   - Reuse `_resolve_released_content_ref` so gating and the BUG-COURSE-004
     404-mask apply identically (locked/unreleased/unknown → 404).
   - New `ContentRepository.read_asset(chapter_id, asset_path)`: resolve
     the path relative to the chapter's directory, enforce
     `is_relative_to(content_dir)`, restrict to an image-extension
     allowlist (`.png .jpg .jpeg .gif .webp`), return bytes + guessed
     content type. `FileResponse`/`Response` with long-lived cache headers
     (content is immutable per pin).
   - Apply the existing `_CMS_PROXY_RATE_LIMIT`.

2. **Frontend: resolve relative images**
   - In `ChapterReader.tsx`'s image rule, map a relative `src` to
     `${API_BASE_URL}/course/content/{id}/assets/{src}` (needs the
     content id — thread it through `ChapterReaderSource`); keep rendering
     absolute https sources as today and keep rejecting other schemes.
   - Note: RN `Image` cannot send the auth header — pass the bearer token
     via the existing authenticated-image pattern if one exists, otherwise
     accept a short-lived signed query param designed in this issue.

3. **Tests**
   - Backend: fixture tree gains `markdown/01-beige/assets/diagram.png`;
     tests for released-chapter asset 200 + content type, locked/unknown
     404-mask parity, traversal rejection, extension rejection.
   - Frontend: image rule resolves relative src to the assets URL for a
     `content` source and still drops non-http schemes.

## Acceptance Criteria

- A released chapter's relative image renders end-to-end against the
  fixture tree; locked chapters' assets 404 with `content_not_found`.
- Traversal and non-image extensions are rejected (tested).
- Both suites green; coverage thresholds hold.
- No existing tests break.

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/src/services/content_repository.py` | Modify (`read_asset`) |
| `backend/src/routers/course.py` | Modify (assets endpoint) |
| `backend/tests/test_course_body_endpoints.py` + fixture tree | Modify |
| `frontend/src/features/Course/ChapterReader.tsx` | Modify |
| `frontend/src/features/Course/__tests__/ChapterReader.test.tsx` | Modify |
