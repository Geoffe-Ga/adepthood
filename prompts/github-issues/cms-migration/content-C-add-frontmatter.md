# Add per-chapter YAML frontmatter

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `content`
**Epic:** adepthood#388 · **Depends on:** A (schema), B (clean bodies) · **Blocks:** D (manifest generator)

## Role & context

With bodies cleaned (B) and the schema fixed (A), each chapter needs the YAML
frontmatter block that makes the corpus machine-readable. This is what lets the
manifest generator (D) — and ultimately the app's seed
([adepthood#392](https://github.com/Geoffe-Ga/adepthood/issues/392)) — know
each chapter's stage, order, `release_day`, and `content_type`.

## Goal

Every chapter file under `markdown/**` opens with a valid frontmatter block
conforming to `CONTENT_FORMAT.md`, with correct `stage`/`chapter`/`order`,
unique `id`/`slug`, and an authored `release_day`.

## Tasks

1. Derive `stage`/`chapter`/`order`/`slug` from the existing folder + filename
   conventions (`<NN-stage>/<NN-slug>.md`) via a script to avoid manual error.
2. Set `id` = `"<stage-slug>-<chapter>"` (e.g. `beige-1`) — stable and unique.
3. Author `release_day` per stage's intended drip schedule (default: chapter
   `n` → `release_day = n - 1`, matching today's "daily" pattern; adjust where
   the curriculum intends otherwise).
4. Set `content_type` (default `chapter`; mark prompts/essays/videos).
5. Add a one-line `summary` where easy (optional field).

## Acceptance criteria

- Every `markdown/**` chapter has schema-valid frontmatter.
- `id` and (`stage`,`chapter`) are unique repo-wide (checked by a script;
  enforced by CI in E).
- `slug` matches the filename slug for every file.

## Constraints

- Generate mechanically where possible; hand-author only `release_day`,
  `content_type`, and `summary`.
- Don't touch body content here (that was B) — frontmatter only.
