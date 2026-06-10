# CMS Migration — `aptitude-course` issue specs

These are **ready-to-file GitHub issues for the [`Geoffe-Ga/aptitude-course`](https://github.com/Geoffe-Ga/aptitude-course) content repository**, part of the
"Migrate course content CMS from Squarespace to a git-based content pipeline"
epic ([adepthood #388](https://github.com/Geoffe-Ga/adepthood/issues/388)).

## Why they live here

The session that generated this epic had write access only to `adepthood`.
The content-repo issues are captured here as spec files so nothing is lost and
they are reviewable in a PR. To file them on `aptitude-course`:

- **Option A (recommended):** add `Geoffe-Ga/aptitude-course` to a Claude Code
  session's repository scope, then ask Claude to file each `content-*.md` below
  as a GitHub issue (title = the `#` heading, body = the rest, labels as noted).
- **Option B:** copy each file's contents into a new issue manually.

## The adepthood side is already filed

The eleven app-side issues are live GitHub issues: #389–#399 (see the epic
checklist in #388). Only the content-repo issues (A–I) remain to be filed.

## Dependency order

```
A (format + frontmatter schema)
├─ B (normalize markdown)        ─┐
├─ C (add frontmatter)            ├─ depend on A's schema
├─ G (site-resource pages)       ─┘
└─ D (manifest generator)  ── depends on C ── feeds adepthood #391/#392
        └─ E (CI validation) ── depends on D
F (consumption contract/versioning)  ── pairs with adepthood #391/#397
H (authoring guide)  ── after A–E settle
I (media/assets)     ── pairs with adepthood #394 rendering
```

| Spec | Title | Suggested labels |
|------|-------|------------------|
| `content-A-format-and-frontmatter-schema.md` | Define canonical content format + frontmatter schema | `spec`, `content` |
| `content-B-normalize-markdown.md` | Normalize HTML-heavy Google-Docs Markdown → clean Markdown | `content` |
| `content-C-add-frontmatter.md` | Add per-chapter YAML frontmatter | `content` |
| `content-D-manifest-generator.md` | Build a `manifest.json` generator | `tooling` |
| `content-E-ci.md` | CI: frontmatter validation, uniqueness, lint, link-check, manifest build | `tooling`, `ci` |
| `content-F-consumption-contract-versioning.md` | Consumption contract + release versioning | `spec` |
| `content-G-site-resources.md` | Migrate site-resource pages into the content format | `content` |
| `content-H-authoring-guide.md` | Authoring guide (README/CONTRIBUTING) | `docs` |
| `content-I-media-assets.md` | Media/asset handling for chapters | `content`, `spec` |
