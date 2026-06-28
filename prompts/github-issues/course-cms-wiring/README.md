# Course CMS Wiring — make the Course screen functional on live `aptitude-course` content

Follow-on to the [CMS migration epic (#388)](https://github.com/Geoffe-Ga/adepthood/issues/388),
which built the whole git-content pipeline but **never vendored real content**.
This epic finishes the job and adds the second content tier the product needs:
the **Google-Docs course introductions** (the per-stage "start here" reading
published on <https://aptitude.guru>) alongside the **Markdown course
chapters** (the deep content).

> **TL;DR** — Two content tiers, both surfaced in-app:
> 1. **Stage introductions** (origin: the Google Docs on aptitude.guru) — one
>    ungated "introductory reading" per stage.
> 2. **Course chapters** (origin: Markdown) — the drip-fed deep content.
>
> Plus the evergreen overview pages that already render in the "From Aptitude
> Guru" panel (`site_resources[]`).

---

## Gap analysis (state as of this epic)

### `Geoffe-Ga/aptitude-course` (content repo) — *mostly ready*

Done and usable today:

- `markdown/` — 219 sections across 10 stages (`01-beige`…`10-clearlight`),
  each with YAML frontmatter.
- `manifest.json` (generated; `schema_version` `1.0.0`), `schema/`,
  `scripts/build_manifest.py`, `scripts/check_links.py`.
- `CONTENT_FORMAT.md`, `CONSUMPTION.md`, `CONTRIBUTING.md`, `CLAUDE.md`, CI.
- `google_docs/` — HTML/zip exports of the **stage introductions**
  (`1.BEIGE.html`, `2.PURPLE.html`, `3.RED.html`, `4.BLUE.html` — **4 of 10**)
  and the overview pages (`APTITUDELandingPage`, `ExtendedInvitation`,
  `APTITUDEStagesDeepDive`, `ArchetypalWavelengthIntroduction`,
  `LiminalCreepIntroduction`), plus the curriculum CSV database.

**Gaps that block "both google_docs AND markdown":**

1. **The Google-Docs intros are outside the published contract.**
   `CONSUMPTION.md` states *"Everything else—Google Docs, scripts, backup
   directories… constitutes internal implementation that may change without
   notice."* The app may not consume them as-is.
2. **They are raw HTML, not the clean Markdown dialect** the app renders
   natively (the migration deleted the WebView/HTML path on purpose). They must
   be converted, like the chapters were.
3. **Only 4 of 10 stage intros exist.** Six stages have no converted intro.
4. **The manifest has no `stage_intros[]` tier**, and `build_manifest.py` does
   not emit one. There is no frontmatter schema or CI validation for intros.
5. **Overview pages need confirming in `site_resources[]`** with slugs matching
   the app's existing keys (`about`, `aptitude-stages`, `archetypal-wavelength`,
   `liminal-creep`); "Extended Invitation" / "Landing" may be added there.

These are captured as ready-to-file content-repo issue specs in
[`content-repo/`](content-repo/) (this session can only write to `adepthood`;
see that folder's README for how to file them — same precedent as
[`../cms-migration/`](../cms-migration/) / PR #405).

### `Geoffe-Ga/adepthood` (this app) — *pipeline built, not activated*

Done (epic #388, all merged): `ContentRepository`, `scripts/sync_content.py`
(+ `make sync-content`/`sync-content-check`), `content_config.py`,
`seed_content.py`, `routers/course.py` (serves chapter + site-resource bodies
from local Markdown), the native-Markdown `ChapterReader`, ADR 0001,
`docs/content.md`, the **CI `content-drift` gate**, and `/health` reporting the
content pin.

**Gaps:**

1. **No content is vendored.** `backend/content/` holds only the schema +
   example — there is no `manifest.json` / `markdown/**` / `CONTENT_VERSION`, so
   the seeder writes zero rows and the Course screen shows **"No Content Yet."**
   This is the headline gap: the pipeline has never been pointed at real content.
2. **No stage-introduction tier.** The contract, `ContentRepository`, the API,
   the frontend API client, and the Course UI have no concept of the per-stage
   Google-Docs intros.

---

## What this epic does

Adds a **stage-introduction tier** end-to-end (contract → repository → API →
client → UI), tested against fixtures, then **activates the pipeline** by
vendoring a real content pin so both tiers render live in the app.

| # | Spec | Scope | Ralph | Est. LoC |
|---|------|-------|-------|----------|
| 01 | [Manifest contract: add a `stage_intros[]` tier (schema 1.1.0)](course-cms-01-manifest-stage-intros-schema.md) | Backend | eligible | ~150 |
| 02 | [`ContentRepository`: parse & serve stage introductions](course-cms-02-content-repository-intros.md) | Backend | eligible | ~200 |
| 03 | [Course API: stage-introduction endpoints](course-cms-03-course-api-intro-endpoints.md) | Backend | eligible | ~200 |
| 04 | [Frontend API client + `ChapterReader` intro source](course-cms-04-frontend-api-intro.md) | Frontend | eligible | ~150 |
| 05 | [Course screen: render the stage-introduction card](course-cms-05-course-screen-intro-card.md) | Frontend | eligible | ~220 |
| 06 | [Activate: vendor the first real content pin + verify](course-cms-06-vendor-first-pin.md) | Backend / ops | eligible¹ | ~120 |
| 07 | [Bump the pin to include stage introductions](course-cms-07-vendor-intros-pin.md) | Backend / ops | **blocked**² | ~80 |

¹ Operator may prefer to run `make sync-content REF=<tag>` directly; a worker
without network self-marks `blocked`.
² Depends on the content-repo specs in [`content-repo/`](content-repo/) shipping
`stage_intros[]`. Carries the `blocked` label so Ralph's picker skips it; remove
the label once the content tag exists.

### Dependency graph

```
01 schema ──► 02 repository ──► 03 api ──► 04 client ──► 05 ui
                                                   │
                              (06 needs the code above; 06 ──► 07)
06 vendor chapters+resources ──► 07 vendor intros (blocked on content-repo)
```

Sub-issues are filed in this order, so Ralph's lowest-number-first picker walks
the graph naturally. Each spec is self-contained for a Ralph worker.

**Filed as GitHub issues:** epic #716 · #717 (01) · #718 (02) · #719 (03) ·
#720 (04) · #721 (05) · #722 (06) · #723 (07, blocked).
