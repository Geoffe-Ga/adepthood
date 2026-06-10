# Migrate site-resource ("free page") content into the repo

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `content`
**Epic:** adepthood#388 · **Depends on:** A (schema) · **Blocks:** adepthood#395 (site resources from local content)

## Role & context

The app's "From Aptitude Guru" chips (the only things currently rendering) map
to four public Squarespace pages: `liminal-creep` (Who Benefits?),
`archetypal-wavelength`, `aptitude-stages`, and `about`. To fully delete
Squarespace, these must also live here as Markdown and appear in
`manifest.json`'s `site_resources[]`.

## Goal

The four site-resource pages exist as clean Markdown in this repo with
frontmatter, and the manifest generator (D) emits them under `site_resources[]`
for the app (adepthood#395) to serve.

## Tasks

1. Author/port the four pages as Markdown (this repo already has
   `ArchetypalWavelengthIntroduction.md`, `APTITUDELandingPage.md`, etc. — reuse
   where they exist):
   - `liminal-creep` — "Who Benefits?"
   - `archetypal-wavelength` — "Archetypal Wavelength Intro"
   - `aptitude-stages` — "APTITUDE Stages"
   - `about` — "APTITUDE Intro"
2. Give each frontmatter with `content_type: essay` (or a `resource` type) and a
   `slug` matching the app's current `SITE_RESOURCES` slugs (so the app's
   public surface is unchanged).
3. Decide a location (e.g. `markdown/resources/`) and ensure the manifest
   generator (D) lists them under `site_resources[]`, not `chapters[]` (not
   stage-gated).

## Acceptance criteria

- All four resources are clean Markdown with valid frontmatter, slugs matching
  the app's existing list.
- `manifest.json` `site_resources[]` includes all four with correct
  slug/title/path.
- Bodies render with the same Markdown dialect as chapters.

## Constraints

- Keep the existing slugs stable — the app keys on them.
- Not stage-gated; do not give these a `release_day`/stage.
