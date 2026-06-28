# Add stage-intro frontmatter + emit `stage_intros[]` in `manifest.json` (schema 1.1.0)

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `content`, `tooling`
**Epic:** adepthood course-cms-wiring (#716) · **Depends on:** CR-A · **Blocks:** CR-C, CR-D
**Mirrors:** adepthood course-cms-01 (#717 — the app's schema change)

## Role & context

The Adepthood app discovers content only through `manifest.json`. Adepthood
course-cms-01 (#717) adds an **optional, additive** `stage_intros[]` tier and
bumps the manifest contract to `schema_version` `1.1.0`. This repo's generator
must emit a matching `stage_intros[]`, generated from per-file frontmatter on
the intro Markdown from CR-A.

## Goal

`scripts/build_manifest.py` emits a schema-valid `stage_intros[]` and stamps
`schema_version: "1.1.0"`, with the field set agreed field-for-field with the
app schema.

## Tasks

1. Add YAML frontmatter to each intro file (CR-A), aligned with the app's
   `$defs/stage_intro`:
   ```yaml
   ---
   id: beige-intro          # stable, unique repo-wide
   stage: 1                 # 1..10, unique among intros
   slug: beige-introduction # URL-safe
   title: "Beige — Introduction"
   summary: "One-line teaser."   # optional
   ---
   ```
2. Extend `build_manifest.py` to collect intros into `stage_intros[]`
   (`{ stage, id, slug, title, path, summary? }`), sorted by `stage`, and set
   `schema_version` to `1.1.0`.
3. Fail loudly on a duplicate `id`, a duplicate `stage` among intros, or a
   `slug`/path mismatch. Keep output deterministic.
4. Update `schema/` (the manifest JSON Schema in this repo) to match the app's
   1.1.0 contract so this repo's CI validates the new tier.

## Acceptance criteria

- `manifest.json` is `1.1.0` and lists one `stage_intros[]` entry per stage,
  each pointing at a real Markdown file.
- Regenerating with no content change is byte-identical.
- Duplicate/invalid intro frontmatter aborts the build with a precise error.

## Constraints

- Additive change — `chapters[]` / `site_resources[]` are untouched; `1.1.0` is
  a minor bump (no breaking change for the app's `1.0.0` reader).
- Field names/types must match adepthood's `manifest.schema.json` `$defs/stage_intro`.
