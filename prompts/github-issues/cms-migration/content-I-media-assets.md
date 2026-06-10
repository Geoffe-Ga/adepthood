# Media / asset handling for chapters

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `content`, `spec`
**Epic:** adepthood#388 · **Depends on:** A (schema) · **Pairs with:** adepthood#394 (native Markdown rendering)

## Role & context

Chapters reference images and (per the original spec) videos. Under Squarespace
these were remote URLs on the site. With local Markdown rendered natively
(adepthood#394), the app needs a defined, stable way to resolve assets — ideally
without a runtime network dependency, consistent with the "ships in the image"
architecture.

## Goal

A documented, enforced convention for where assets live and how chapters
reference them, so the app can resolve every image/video deterministically.

## Tasks

1. Decide asset storage:
   - **Option A (recommended for images):** commit assets under
     `markdown/<stage>/assets/` and reference them with **repo-relative paths**
     in Markdown, so they vendor into the app image with the content.
   - **Option B (video / large media):** reference a stable external/CDN URL in
     frontmatter `media[]`; the app streams it. Document size thresholds for A
     vs B.
2. Specify the Markdown reference convention (relative image links) and the
   `media[]` frontmatter shape for non-inline media (type, url/path, poster,
   caption).
3. Ensure `build_manifest.py` (D) includes/validates `media[]` and that the
   link-check (E) verifies relative asset paths resolve.
4. Define how the app maps a relative asset path to a served URL (coordinate
   with adepthood#394) — e.g. backend exposes `backend/content/**` assets under
   a static route.

## Acceptance criteria

- Asset convention documented in `CONTENT_FORMAT.md`; chapters follow it.
- Relative image paths resolve in CI link-check; `media[]` validated by the
  manifest build.
- The app-side resolution rule is agreed and cross-linked to adepthood#394.

## Constraints

- Prefer in-repo committed images (no runtime fetch) over external URLs except
  for large video.
- Keep asset paths repo-relative and stable.
