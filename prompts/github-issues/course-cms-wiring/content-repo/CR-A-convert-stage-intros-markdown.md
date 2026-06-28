# Convert the Google-Docs stage introductions to clean Markdown (all 10 stages)

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `content`
**Epic:** adepthood course-cms-wiring (#716) · **Depends on:** none · **Blocks:** CR-B

## Role & context

The per-stage "course introductions" published on <https://aptitude.guru> are
authored as Google Docs and currently live here only as HTML/zip exports under
`google_docs/` (`1.BEIGE.html`, `2.PURPLE.html`, `3.RED.html`, `4.BLUE.html` —
**4 of 10**). The Adepthood app renders **clean Markdown natively** (no HTML, no
WebView), so these intros must be converted to the same CommonMark dialect the
chapters use (`CONTENT_FORMAT.md`) before they can ship in the contract.

## Goal

One clean Markdown introduction per stage (10 total), authored in the canonical
dialect, ready for frontmatter (CR-B). Use the existing `convert_docs.sh` /
`google_docs/` exports as the source where available; author the missing six
from the docs on aptitude.guru.

## Tasks

1. Convert the 4 existing exports (BEIGE, PURPLE, RED, BLUE) to clean Markdown,
   stripping inline HTML, fixing headings/lists/links/images per
   `CONTENT_FORMAT.md`.
2. Produce the remaining 6 stage intros (stages 5–10) from their aptitude.guru
   Google Docs.
3. Place them predictably, e.g. `markdown/<NN-stage>/00-introduction.md` (a
   `00-` prefix so an intro sorts before the stage's chapters), or a dedicated
   `markdown/intros/` folder — decide and document.
4. No raw HTML in the bodies; images use repo-relative asset paths (see the
   media handling from the original migration, cms-migration issue I).

## Acceptance criteria

- 10 stage-introduction Markdown files exist, one per stage, in the canonical
  dialect with no raw HTML.
- Location/naming is consistent and documented for CR-B's manifest generator.

## Constraints

- Match `CONTENT_FORMAT.md` exactly; these render through the same path as
  chapters.
- Do not delete the `google_docs/` sources — they remain the authoring origin.
