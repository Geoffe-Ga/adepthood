# course-cms-07: Activate — bump the content pin to include stage introductions

**GitHub:** #723 · **Labels:** `backend`, `enhancement`, `blocked`
**Epic:** #716 · **Depends on:** #722 (first pin) **and** `aptitude-course` shipping `stage_intros[]` (content-repo specs CR-A…CR-D)
**Estimated LoC:** ~80 (code/tests) + vendored content (generated)

> **Blocked** until the `aptitude-course` repo publishes a release whose
> `manifest.json` includes `stage_intros[]` (Google-Docs intros converted to
> clean Markdown for all 10 stages). Carries the `blocked` label so Ralph's
> picker skips it. **Remove `blocked` only once that content tag exists.**

## Problem

After #717..#722, the app *can* serve stage introductions, but the vendored pin
(from #722) predates the content repo's `stage_intros[]` tier, so every stage's
intro 404s. This step bumps the pin to a content release that carries the intros
and verifies them end-to-end.

## Tasks

1. **Confirm the content tag.** Verify the chosen `aptitude-course` release's
   `manifest.json` is `schema_version` `1.1.0` and contains `stage_intros[]`
   covering all 10 stages (CR-A…CR-D done).
2. **Re-vendor.** `make sync-content REF=<intro-release-tag>`; ensure
   `make sync-content-check` is clean and `CONTENT_VERSION` records the new pin.
3. **Verify.** A test asserts the vendored manifest exposes ≥1 stage intro and
   `read_intro_body` succeeds for it; manually confirm each stage shows its real
   intro card in-app.

## Acceptance criteria

- `backend/content/` is re-vendored to a `1.1.0` pin with `stage_intros[]`;
  drift gate clean.
- Each unlocked stage renders its real Google-Docs-sourced introduction in the
  Course screen.
- `./scripts/backend/check-all.sh` exits 0; CI green.

## Files to modify

| File | Action |
|------|--------|
| `backend/content/manifest.json` + `markdown/**` + `CONTENT_VERSION` | Re-vendored (generated) |
| `backend/tests/test_seed_content.py` / `test_content_repository.py` | Assert intros present in the vendored pin |

## Constraints

- Do not remove `blocked` until the content release with `stage_intros[]` is
  cut. Pin to a concrete tag/SHA.
- No schema changes here — the contract work is #717; this is pure activation.
