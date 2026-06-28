# course-cms-01: Manifest contract — add a `stage_intros[]` tier (schema 1.1.0)

**GitHub:** #717 · **Labels:** `backend`, `enhancement`
**Epic:** #716 · **Depends on:** none — foundation for 02–07
**Estimated LoC:** ~150

## Problem

The manifest contract (`backend/content/manifest.schema.json`, frozen at
`schema_version` `1.0.0`) has `chapters[]` and `site_resources[]` but **no way
to represent a per-stage introduction** — the Google-Docs "course
introductions" the product wants surfaced alongside the Markdown chapters. We
need an additive contract change (a minor version bump) so both repos can agree
on the shape before any code reads it.

The reader (`content_repository.py`) only rejects a *different major* version,
so `1.1.0` is already accepted at runtime — but the JSON Schema must be widened
to permit the new key (it is `additionalProperties: false`), and the example +
docs must show it.

## Scope

Contract + docs only. No reader/router/UI changes (those are 02+). The change
is **purely additive and backwards-compatible**: a `1.0.0` manifest with no
`stage_intros` stays valid.

## Tasks (TDD)

1. **Schema.** In `backend/content/manifest.schema.json`:
   - Add an **optional** top-level `stage_intros` array (do **not** add it to
     `required`, so older manifests validate).
   - Define `$defs/stage_intro` with `additionalProperties: false` and required
     `["stage", "id", "slug", "title", "path"]`, plus optional `summary`:
     - `stage`: integer 1..10
     - `id`: string, non-empty, stable, unique repo-wide
     - `slug`: string, non-empty, URL-safe
     - `title`: string, non-empty
     - `path`: string, non-empty (Markdown path relative to the content root)
     - `summary`: string (optional)
   - Update the schema `description` to note the 1.1.0 additive change and
     cross-link the ADR.
2. **Example.** In `backend/content/manifest.example.json`: bump
   `schema_version` to `1.1.0` and add a representative `stage_intros` entry
   (e.g. `beige-intro`, stage 1, `path: markdown/01-beige/00-introduction.md`).
3. **Docs / ADR.** Document the new tier and the 1.1.0 bump in
   `docs/adr/0001-git-content-pipeline.md` (change-control note) and
   `docs/content.md` (what an intro is, that it's ungated and not seeded).
4. **Tests.** Extend `backend/tests/test_manifest_schema.py`:
   - a manifest **with** valid `stage_intros` validates;
   - a manifest **without** `stage_intros` still validates (back-compat);
   - an intro missing a required field (e.g. `path`) is rejected;
   - `stage` out of range (0 or 11) is rejected;
   - `manifest.example.json` validates against the schema and is `1.1.0`.

## Acceptance criteria

- `manifest.schema.json` permits an optional, fully-specified `stage_intros[]`;
  `manifest.example.json` is `1.1.0` and validates.
- A `stage_intros`-free manifest still validates (no breaking change).
- ADR 0001 + `docs/content.md` describe the tier and the minor bump.
- `./scripts/backend/check-all.sh` exits 0.

## Files to modify

| File | Action |
|------|--------|
| `backend/content/manifest.schema.json` | Add `stage_intros` + `$defs/stage_intro` |
| `backend/content/manifest.example.json` | Bump to 1.1.0, add an intro entry |
| `backend/tests/test_manifest_schema.py` | New validation cases |
| `docs/adr/0001-git-content-pipeline.md` | Change-control note for 1.1.0 |
| `docs/content.md` | Describe the stage-intro tier |

## Constraints

- Additive only — `stage_intros` is **optional**; never add it to `required`.
- Keep `additionalProperties: false` on the new `$defs/stage_intro`.
- This is the coordination point with `aptitude-course` (content-repo spec CR-B
  mirrors this schema). Bump the minor deliberately.
