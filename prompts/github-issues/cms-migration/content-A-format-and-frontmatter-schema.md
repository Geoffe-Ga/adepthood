# Define canonical content format + frontmatter schema

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `spec`, `content`
**Epic:** adepthood#388 · **Depends on:** none (foundation) · **Blocks:** B, C, D, G

## Role & context

You are establishing the contract that the Adepthood app
([adepthood#389](https://github.com/Geoffe-Ga/adepthood/issues/389)) will
consume. Today this repo holds 219 Markdown files under
`markdown/<NN-stage>/<NN-slug>.md` (10 stages, `01-beige`…`10-clearlight`),
converted from Google Docs and **heavy with inline HTML**, with **no
frontmatter** and **no machine-readable index**. The app cannot reliably parse
this.

## Goal

Publish a written spec (`CONTENT_FORMAT.md`) defining (1) the canonical
Markdown dialect and (2) the per-file YAML frontmatter schema, agreed against
the app's manifest contract (adepthood#389). This is documentation only — no
file edits to the 219 chapters yet (that's B/C).

## Tasks

1. Specify the **Markdown dialect**: CommonMark + a small, safe feature set
   (headings, lists, emphasis, links, images, blockquotes, code, tables).
   Explicitly **disallow raw HTML** in the body (the app renders Markdown
   natively and will not execute HTML).
2. Define the **frontmatter schema** (YAML), aligned field-for-field with the
   app manifest in adepthood#389:

   ```yaml
   ---
   id: beige-1            # stable, unique across the repo
   stage: 1               # 1..10 (archetype index)
   chapter: 1             # 1-based within the stage
   order: 1               # display order within the stage
   slug: what-is-beige    # URL-safe; matches filename slug
   title: "What Is Beige?"
   content_type: chapter  # chapter | essay | prompt | video
   release_day: 0         # days after stage start (0 = unlocks immediately)
   summary: "One-line teaser."   # optional
   media: []              # optional; see issue I
   ---
   ```

3. State **uniqueness/identity rules**: `id` unique repo-wide; (`stage`,
   `chapter`) unique; `slug` matches the filename.
4. State the **stage-numbering reconciliation** agreement with adepthood#389
   (how content stages 1–10 map onto the app's stage model) so B/C and the
   app's seed agree.
5. Define `content_type` semantics and how `release_day` is authored.

## Acceptance criteria

- `CONTENT_FORMAT.md` merged, covering dialect + frontmatter + identity +
  stage-mapping + `content_type`/`release_day` semantics.
- Field names/types match adepthood#389's `manifest.schema.json` exactly
  (cross-link both).
- One worked example chapter shown end-to-end.

## Constraints

- Spec only; do not edit the 219 chapters here.
- Any later schema change is a versioned change coordinated with adepthood#389.
