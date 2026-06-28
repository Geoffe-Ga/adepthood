# Cut a `1.1.0` release tag and move intros into the published surface

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `spec`, `content`
**Epic:** adepthood course-cms-wiring (#716) · **Depends on:** CR-B, CR-C
**Pairs with:** adepthood course-cms-07 (#723 — pin bump)

## Role & context

`CONSUMPTION.md` currently states the Google Docs are *internal* and may change
without notice. Once intros ship as contracted `stage_intros[]` Markdown
(CR-A…CR-C), the document must be updated and a release cut so the app
(course-cms-07) can pin a concrete tag.

## Goal

A tagged release whose `manifest.json` is `1.1.0` with `stage_intros[]`, and a
`CONSUMPTION.md` that promotes intros into the published surface.

## Tasks

1. Update `CONSUMPTION.md`: add `stage_intros[]` (and its referenced Markdown
   bodies/assets) to the published surface; note the `1.0.0` → `1.1.0` minor
   bump and that `1.0.0` consumers remain compatible (additive).
2. Cut a release tag (`content-vYYYY.MM.DD`) once CI is green.
3. Hand the tag to adepthood course-cms-07 (#723) for the pin bump.

## Acceptance criteria

- `CONSUMPTION.md` lists `stage_intros[]` as contracted; the minor-bump policy is
  explicit.
- A `1.1.0` release tag exists and is referenced by adepthood course-cms-07.

## Constraints

- Never break the existing published surface — this is additive.
- Pin coordination: the app pins the tag/SHA, not a moving branch.
