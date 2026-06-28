# Epic: Wire the Course screen to live `aptitude-course` content (chapters + stage intros)

**GitHub issue:** #716 · **Labels:** `epic`, `frontend`, `backend`, `enhancement`
**Scope:** Full-stack (backend contract/serving + frontend reading), plus two
operator-run content-activation steps.
**Estimated total LoC:** ~1,100 (code) + vendored content (generated)

## Why

The git-content pipeline from epic
[#388](https://github.com/Geoffe-Ga/adepthood/issues/388) is fully built and
merged — `ContentRepository`, `scripts/sync_content.py`, the seeder, the
local-Markdown course router, the native-Markdown `ChapterReader`, ADR 0001, the
CI `content-drift` gate — **but no content was ever vendored**, so the Course
screen shows "No Content Yet" in production. Meanwhile the
[`Geoffe-Ga/aptitude-course`](https://github.com/Geoffe-Ga/aptitude-course)
repo is now "just about ready": clean Markdown chapters with frontmatter, a
generated `manifest.json`, and CI.

This epic finishes the wiring and surfaces **both** content tiers the product
wants:

- **Stage introductions** — the per-stage "course introductions" published on
  <https://aptitude.guru>, authored as **Google Docs**. One ungated
  "introductory reading" per stage (the "start here").
- **Course chapters** — the deep content, authored as **Markdown**, drip-fed by
  `release_day` exactly as today.

Plus the evergreen overview pages that already render in the "From Aptitude
Guru" panel (`site_resources[]`).

**Full gap analysis & content-repo coordination:** [`README.md`](README.md) in
this directory. Each sub-issue has its own self-contained spec file here.

## Design

The two tiers map onto the existing architecture with **no new runtime
dependency and no WebView** — the Google-Docs intros are converted to the same
clean Markdown dialect as the chapters and served through the same
`ContentRepository` → native-Markdown reader path.

- **Contract.** Add an **additive** `stage_intros[]` array to the manifest
  (`schema_version` → `1.1.0`, a minor bump the reader already tolerates because
  it only rejects a different *major*). Each entry:
  `{ stage, id, slug, title, path, summary? }`.
- **Storage.** Intros are **not** seeded into the database and **not**
  read-tracked or drip-gated — they mirror `site_resources[]`: served straight
  from `ContentRepository`, keyed by `stage`, available whenever the stage is
  unlocked. (Chapters keep their `StageContent` rows + `ContentCompletion`
  tracking + `release_day` gating, unchanged.)
- **API.** `GET /course/stages/{n}/intro` (metadata) and
  `GET /course/stages/{n}/intro/body` (Markdown), gated on stage-unlock, with
  the same 404-mask / `502 content_unavailable` semantics as the chapter-body
  endpoint.
- **UI.** A **stage-introduction card** above the drip-fed chapter list; tapping
  it opens the existing `ChapterReader` with a new `kind: 'intro'` source.

## Sub-issues (filed)

| File | GitHub | Scope |
|------|--------|-------|
| `course-cms-01-manifest-stage-intros-schema.md` | #717 | Backend |
| `course-cms-02-content-repository-intros.md` | #718 | Backend |
| `course-cms-03-course-api-intro-endpoints.md` | #719 | Backend |
| `course-cms-04-frontend-api-intro.md` | #720 | Frontend |
| `course-cms-05-course-screen-intro-card.md` | #721 | Frontend |
| `course-cms-06-vendor-first-pin.md` | #722 | Backend / ops |
| `course-cms-07-vendor-intros-pin.md` | #723 | Backend / ops (blocked) |

## Dependency graph

```
01 schema ─► 02 repository ─► 03 api ─► 04 client ─► 05 ui
01..05 (code, fixture-tested) ─► 06 vendor chapters+resources ─► 07 vendor intros
                                                                  (blocked: needs content-repo stage_intros)
```

## Epic-level acceptance criteria

- [ ] The manifest contract supports an optional `stage_intros[]` tier at
      `schema_version` `1.1.0`; the reader accepts 1.x manifests with or without
      it.
- [ ] `ContentRepository` exposes stage-intro listing + body reads with the
      traversal guard; absent `stage_intros` degrades to empty.
- [ ] `GET /course/stages/{n}/intro` and `/intro/body` return the intro for an
      unlocked stage and 404-mask for a locked or absent one.
- [ ] The Course screen shows a stage-introduction card above the chapters and
      opens it in the native reader; chapters, progress, drip-feed, and the
      "From Aptitude Guru" panel are unchanged.
- [ ] After 06, tapping a released chapter renders real vendored Markdown; after
      07, each stage shows its real Google-Docs-sourced intro.
- [ ] `./scripts/backend/check-all.sh` and `./scripts/frontend/check-all.sh`
      green on every code sub-issue; coverage thresholds unchanged.

## Constraints

- **No new schema major / no breaking change.** The `stage_intros` addition is
  additive (minor bump); coordinate the matching change in `aptitude-course`
  (content-repo specs CR-A…CR-D).
- **No runtime network, no WebView, no HTML rendering.** Intros are vendored
  clean Markdown served locally and rendered natively — same path as chapters.
- **Reuse, don't fork.** Extend `ContentRepository`, `ContentBodyResponse`, and
  `ChapterReader`; do not add a parallel content source.
- **Preserve chapter behaviour exactly** — drip-feed gating, the content-id
  404-mask (BUG-COURSE-004), and read-tracking are untouched.
- **TDD + thresholds** per `CLAUDE.md`; one logical change per PR; conventional commits.

## References

- ADR: `docs/adr/0001-git-content-pipeline.md`; editor guide: `docs/content.md`
- Contract: `backend/content/manifest.schema.json`, `manifest.example.json`
- Reader: `backend/src/services/content_repository.py`
- Seeder bridge: `backend/src/content_config.py`; seeder: `backend/src/seed_content.py`
- Router: `backend/src/routers/course.py`; schemas: `backend/src/schemas/course.py`
- Sync: `backend/scripts/sync_content.py`; `make sync-content` / `sync-content-check`
- Frontend: `frontend/src/features/Course/{CourseScreen,ChapterReader,SiteResourcesPanel}.tsx`, `frontend/src/api/index.ts` (`export const course`)
- CI gate: `.github/workflows/backend-ci.yml` (`content-drift` job)
- Content-repo coordination: `content-repo/`
