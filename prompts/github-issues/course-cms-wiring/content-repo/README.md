# Content-repo specs — stage introductions for `aptitude-course`

Ready-to-file GitHub issue specs for
[`Geoffe-Ga/aptitude-course`](https://github.com/Geoffe-Ga/aptitude-course),
the content half of the
[course-cms-wiring epic](../README.md). This session can only write to
`adepthood`, so — exactly as with [`../../cms-migration/`](../../cms-migration/)
(PR #405) — the content-repo work is captured here as spec files.

**To file them:** add `Geoffe-Ga/aptitude-course` to a Claude Code session's
repo scope and ask Claude to file each `CR-*.md` as an issue (title = the `#`
heading, body = the rest), or copy them in manually.

## Goal

Bring the **Google-Docs course introductions** (the per-stage "start here"
reading on <https://aptitude.guru>) into the **published contract** as clean
Markdown under a new `stage_intros[]` manifest tier, so the Adepthood app can
serve both tiers (intros + chapters). Today the intros live only as HTML/zip
exports under `google_docs/`, which `CONSUMPTION.md` explicitly marks as
internal / non-contracted, and only 4 of 10 are converted.

## Specs & dependency order

```
CR-A (convert 6 remaining intros → Markdown)  ─┐
CR-B (frontmatter + manifest stage_intros[])  ─┼─ CR-C (CI validation)
                                                └─ CR-D (release tag + CONSUMPTION update)
```

| Spec | Title | Pairs with (adepthood) |
|------|-------|------------------------|
| [CR-A](CR-A-convert-stage-intros-markdown.md) | Convert the Google-Docs stage introductions to clean Markdown (all 10 stages) | course-cms-07 (#723) |
| [CR-B](CR-B-frontmatter-and-manifest.md) | Add stage-intro frontmatter + emit `stage_intros[]` in `manifest.json` (schema 1.1.0) | course-cms-01 (#717) |
| [CR-C](CR-C-ci-validation.md) | CI: validate stage-intro frontmatter, slug/stage uniqueness, links, manifest build | course-cms-06/07 |
| [CR-D](CR-D-release-and-consumption.md) | Cut a `1.1.0` release tag and move intros into the published surface (`CONSUMPTION.md`) | course-cms-07 (#723) |
