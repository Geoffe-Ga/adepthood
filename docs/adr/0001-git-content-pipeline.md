# ADR 0001: Git-based content pipeline for course material

- **Status:** Accepted
- **Date:** 2026-06-10
- **Issue:** [#389](https://github.com/Geoffe-Ga/adepthood/issues/389) (epic [#388](https://github.com/Geoffe-Ga/adepthood/issues/388))

## Context

Course content (219 Markdown files across 10 stages) lives in
[`Geoffe-Ga/aptitude-course`](https://github.com/Geoffe-Ga/aptitude-course).
Today the app reaches it through `services/squarespace.py` plus a
hardcoded `content_config.STAGE_PLANS` covering stage 1 only — a
scraping dependency on a CMS we are leaving. This ADR ratifies how the
app consumes the git-hosted content and freezes the manifest contract
every downstream cms-migration issue builds on.

## Decision 1 — The app gets content by vendoring a pinned commit

A sync script (`scripts/sync_content.py`, issue #391) copies a pinned
`aptitude-course` commit into `backend/content/`, which ships inside the
Railway image. Content updates are a pin bump: explicit, reviewable,
atomically deployed, and trivially rolled back with the image.

**Rejected — git submodule:** submodules are a recurring footgun for
both autonomous agents (clone-depth and init ordering) and Railway
builds (extra checkout configuration), and they pin via repo state that
tooling routinely fails to update consistently.

**Rejected — runtime fetch from `raw.githubusercontent.com`:** puts a
network dependency on every content read — precisely the failure mode
(remote CMS availability coupling) this migration exists to escape.

## Decision 2 — `manifest.json`, generated from per-file YAML frontmatter, is the source of truth

Each Markdown file in the content repo carries YAML frontmatter
(stage, chapter, slug, title, content type, release day, order); the
content repo generates `manifest.json` from it. The app treats the
manifest as the single index for stage → chapter → release-day data.

**Rejected — hardcoded `STAGE_PLANS`:** the thing being deleted; it
already drifted (stage 1 only) because editing app code to publish
content couples two release cadences that should be independent.

**Rejected — database-only:** loses git authorship, review, and history
for content metadata, and adds a write pipeline where a read-only file
suffices.

## Decision 3 — Raw Markdown plus metadata over the wire

Endpoints serve the Markdown body verbatim with manifest metadata; the
client renders natively (issue #394 removes the WebView).

**Rejected — server-rendered HTML:** reintroduces the
sanitising/scraping surface the Squarespace exit removes, and binds
client presentation to a server template cycle.

## Decision 4 — The content repo stays public

No token, no Railway secret, no auth failure mode in the sync script.

**Rejected — private + GitHub token:** more deployment configuration
and a new expiring credential, buying nothing for content that is
already published to end users.

## Stage-numbering reconciliation

**The mapping is identity: content-repo stage N is app stage N, for
N in 1..10.** The content repo's directories (`01-beige` …
`10-clearlight`) match the app's seeded `CourseStage` rows (1..10).
The historical confusion — the app's `TOTAL_STAGES` constant briefly
said 36 — was a week/stage conflation corrected in issue #386
(PR #432); the 36-week calendar is a *different axis* (see
`domain/constants.STAGE_DURATIONS_DAYS`: eight 21-day stages plus two
42-day stages = 252 days = 36 weeks). The manifest schema enforces
`stage ∈ [1, 10]`; weekly pacing never appears in the manifest.

## The manifest contract

`backend/content/manifest.schema.json` (JSON Schema draft 2020-12) is
the normative contract; `backend/content/manifest.example.json` is a
conforming sample used by downstream tests, and
`backend/tests/test_manifest_schema.py` pins both (the example must
validate; mutations must fail).

**Change control:** the schema is frozen at `schema_version 1.0.0`.
Additive optional fields bump the minor version; anything that breaks
an existing reader bumps the major version, and readers must reject a
manifest whose major version differs from theirs. Every bump gets a
dated note appended to this ADR.

## Consequences

- Issues #390–#399 implement against this contract without
  re-litigating the design.
- The content repo gains a frontmatter + manifest-generation
  requirement (tracked in the aptitude-course repo).
- Content freshness is bounded by pin bumps — an accepted trade
  against runtime coupling; #397 wires the bump into CI with a drift
  check.
