# Normalize HTML-heavy Google-Docs Markdown → clean Markdown

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `content`
**Epic:** adepthood#388 · **Depends on:** A (format spec) · **Blocks:** D (manifest), adepthood#394 (rendering)

## Role & context

The 219 chapter files were converted from Google Docs and carry inline HTML
(spans, styled tables, `&nbsp;`, font tags, anchor cruft). The app will render
**Markdown natively** and disallows raw HTML, so the body of every file must be
reduced to the clean dialect defined in A. GitHub reports this repo as ~99.9%
HTML — that is the mess this issue removes.

## Goal

Every file under `markdown/**` contains clean CommonMark per `CONTENT_FORMAT.md`
— no raw HTML, normalized headings/lists/links/images — with content meaning
preserved.

## Tasks

1. Write a normalization script (`scripts/normalize_markdown.py` or a `pandoc`
   pipeline in `convert_docs.sh`) that: strips/down-converts inline HTML to
   Markdown, collapses `&nbsp;`/smart-quote noise, normalizes heading levels
   (one H1 = title, sections start at H2), and fixes list/table syntax.
2. Run it across all stages; commit the result in reviewable batches (per
   stage) so diffs are auditable.
3. Add a "no raw HTML" check (regex/`remark-lint`) to be enforced later by CI
   (issue E).
4. Manually spot-check the worst offenders (tables, embedded media) and record
   any that need hand-editing.

## Acceptance criteria

- No file under `markdown/**` contains disallowed raw HTML (verified by the
  check from task 3).
- A diff review per stage confirms no content was lost (headings, links,
  images, lists intact).
- The normalization is reproducible via a committed script, not a one-off.

## Constraints

- Preserve authored meaning and structure; this is reformatting, not rewriting.
- Do not add frontmatter here — that is issue C (keep the two diffs separate).
