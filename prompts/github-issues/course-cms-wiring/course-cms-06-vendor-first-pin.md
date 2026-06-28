# course-cms-06: Activate — vendor the first real content pin (chapters + site resources) + verify

**GitHub:** #722 · **Labels:** `backend`, `enhancement`
**Epic:** #716 · **Depends on:** #717..#721 (code in place); content repo already ships chapters + site_resources today
**Estimated LoC:** ~120 (code/tests) + vendored content (generated)

## Problem

`backend/content/` holds only `manifest.schema.json` + `manifest.example.json` —
**no real content has ever been vendored**, so the seeder writes zero
`StageContent` rows and the Course screen shows "No Content Yet." The
`aptitude-course` repo already publishes a schema-valid `manifest.json` with
chapters and site resources, so this step lights up the existing pipeline for
the Markdown tier and the overview pages.

> **Operator note.** This is an activation/ops step. An operator can run it
> directly with `make sync-content REF=<tag-or-sha>` and commit the result. A
> Ralph worker may perform it too; **if the environment has no outbound network
> to `codeload.github.com`, comment that and self-apply `blocked`** rather than
> faking content.

## Tasks

1. **Pick a pin.** Choose a concrete `aptitude-course` ref — prefer the latest
   `content-vYYYY.MM.DD` release tag (per its `CONSUMPTION.md`); fall back to the
   current `main` SHA. Record the chosen ref in the PR description.
2. **Vendor.** Run `make sync-content REF=<ref>` (i.e.
   `python -m scripts.sync_content --ref <ref>`). This stages + validates +
   stamps `CONTENT_VERSION` and atomically swaps `backend/content/` (manifest +
   `markdown/**`), preserving the schema/example.
3. **Verify locally.**
   - `make sync-content-check` (the CI drift gate) is clean.
   - Seeding produces non-zero `StageContent` rows across stages (add/extend a
     test in `backend/tests/test_seed_content.py` that seeds from the vendored
     manifest and asserts chapters exist for ≥1 stage and site resources list).
   - `/health` reports a non-`none` content `sha`.
4. **Commit the vendored tree.** `backend/content/` is committed (it is
   `linguist-vendored` per `.gitattributes`); the pin bump is a reviewable diff.

## Acceptance criteria

- `backend/content/manifest.json`, `markdown/**`, and `CONTENT_VERSION` are
  vendored and committed; `make sync-content-check` passes (no drift).
- Seeding the vendored manifest yields real chapters + site resources (asserted
  by a test).
- `./scripts/backend/check-all.sh` exits 0; CI (incl. `content-drift`) green.
- The Course screen renders real chapter Markdown and the "From Aptitude Guru"
  pages against the vendored pin (note manual verification in the PR).

## Files to modify

| File | Action |
|------|--------|
| `backend/content/manifest.json` | Vendored (generated) |
| `backend/content/markdown/**` | Vendored (generated) |
| `backend/content/CONTENT_VERSION` | Vendored (generated) |
| `backend/tests/test_seed_content.py` | Assert seeding from the vendored manifest |

## Constraints

- Pin to a **concrete tag/SHA**, never a moving branch, in `CONTENT_VERSION`.
- Do not hand-edit vendored files — only `sync_content.py` writes them.
- If `aptitude-course`'s published manifest does not validate against the app
  schema, do **not** weaken the schema — file a content-repo issue and `blocked`
  this one.
