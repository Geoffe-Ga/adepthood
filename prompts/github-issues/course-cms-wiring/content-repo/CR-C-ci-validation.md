# CI: validate stage-intro frontmatter, slug/stage uniqueness, links, manifest build

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `tooling`, `ci`
**Epic:** adepthood course-cms-wiring (#716) · **Depends on:** CR-B

## Role & context

The existing CI validates chapter frontmatter, uniqueness, markdown lint, link
check, and the manifest build. The new `stage_intros[]` tier (CR-B) needs the
same guarantees so a bad intro can't ship to the app's pinned consumer.

## Goal

CI fails on any malformed stage intro and proves the generated `manifest.json`
(including `stage_intros[]`) is schema-valid and drift-free.

## Tasks

1. Extend frontmatter validation to cover intros: required fields present,
   `stage` in 1..10, `id` unique repo-wide, `stage` unique among intros, `slug`
   URL-safe.
2. Run the markdown lint + link check over the intro files (no raw HTML, links
   resolve).
3. Validate the built `manifest.json` against the `1.1.0` schema and assert
   no drift between the committed manifest and a fresh build.

## Acceptance criteria

- CI rejects a malformed/duplicate intro and any manifest drift.
- A green pipeline guarantees the published surface (incl. `stage_intros[]`) is
  valid for the app to vendor.

## Constraints

- Reuse the existing CI jobs/scripts; add intro coverage rather than a parallel
  pipeline.
