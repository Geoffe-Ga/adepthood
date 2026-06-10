# CI: frontmatter validation, uniqueness, lint, link-check, manifest build

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `tooling`, `ci`
**Epic:** adepthood#388 · **Depends on:** D (manifest generator) · **Blocks:** F (contract), adepthood#397 (build wiring)

## Role & context

This repo currently has **no CI**. Since the app pins and ships a commit of this
repo, a malformed chapter or a drifted manifest would break the live Course
screen. CI here is the first line of defense — broken content never reaches a
pinned SHA.

## Goal

A GitHub Actions workflow that, on every PR/push, validates the content corpus
and the generated manifest, failing the build on any violation.

## Tasks

1. Add `.github/workflows/content-ci.yml` running:
   - **Frontmatter schema validation** for every `markdown/**` file (against
     `CONTENT_FORMAT.md`/the schema).
   - **Uniqueness checks**: `id`, (`stage`,`chapter`), `slug`↔filename.
   - **Markdown lint** (`remark-lint`/`markdownlint`) incl. the "no raw HTML"
     rule from issue B.
   - **Link check** (internal links + images resolve; external optional/soft).
   - **Manifest build + schema validation** (`scripts/build_manifest.py`) and a
     **drift check**: committed `manifest.json` matches a fresh build.
2. Cache tooling for fast runs; keep the workflow self-contained (no secrets).
3. Document required status checks for branch protection.

## Acceptance criteria

- CI fails on: invalid/missing frontmatter, duplicate id/slug, raw HTML in
  body, broken internal link/image, or a stale committed manifest.
- A clean corpus passes end-to-end.
- The manifest drift check guarantees `manifest.json` is always current.

## Constraints

- No secrets/tokens (public repo).
- Keep checks fast enough to run on every push.
