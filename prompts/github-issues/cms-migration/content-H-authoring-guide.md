# Authoring guide (README / CONTRIBUTING)

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `docs`
**Epic:** adepthood#388 · **Depends on:** A–E settled

## Role & context

Once the format, frontmatter, manifest, and CI exist, contributors (human or
Claude) need one page that says how to add or change content correctly so the
app picks it up. The existing `CLAUDE.md`/`README.md` predate this pipeline.

## Goal

A `CONTRIBUTING.md` (and refreshed `README.md`) that makes "add a chapter",
"edit a chapter", and "schedule a release" unambiguous and CI-passable on the
first try.

## Tasks

1. Document the workflow: create `markdown/<stage>/<NN-slug>.md` → add
   frontmatter (link the schema) → run `build_manifest.py` → CI green.
2. Explain `release_day` semantics (days after stage start; 0 = immediate) with
   examples, and the `content_type` values.
3. Explain the **stage-numbering** mapping and identity rules (`id`,
   (`stage`,`chapter`), `slug`↔filename).
4. Explain the release/handshake from issue F (how a content change reaches the
   app: tag → app pins SHA → deploy).
5. Add a short "editing with Claude" section: the corpus is plain Markdown
   files; an agent can edit them directly and run `build_manifest.py` +
   `content-ci` locally.

## Acceptance criteria

- A new contributor can add a valid chapter using only `CONTRIBUTING.md` and
  pass CI on first push.
- `release_day`, `content_type`, identity rules, and the release handshake are
  all documented with examples.
- `README.md` points to `CONTENT_FORMAT.md`, `CONSUMPTION.md`, and
  `CONTRIBUTING.md`.

## Constraints

- Docs must match the actual scripts/CI (no aspirational instructions).
