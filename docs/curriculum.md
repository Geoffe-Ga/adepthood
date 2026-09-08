# The Archetypal Wavelength curriculum dataset

The per-Stage and per-phase copy of *The Archetypal Wavelength* — the ten
APTITUDE Stages and their six-phase manifestations (integrated `Rx` and shadow
`OD` expressions) — is **vendored** into this repo as a single source of truth
at `backend/src/curriculum/archetypal_wavelength.json`. Every consumer reads it
through the typed loader in `backend/src/curriculum/__init__.py`; nothing
hand-duplicates the prose. This mirrors the vendoring precedent set for course
content (ADR 0001, `docs/content.md`): a checked-in, diff-reviewable data file
refreshed by an explicit, documented step — never fetched at runtime.

## Why one vendored file

The same wavelength is described by three apps — adepthood,
[`wavelength-demo`](https://github.com/Geoffe-Ga/wavelength-demo) (its
`src/data/modes.ts`), and
[`WavelengthWatch`](https://github.com/Geoffe-Ga/WavelengthWatch) (CSV/JSON
fixtures under its `backend/data/`). If adepthood re-authored the manifestation
copy by hand, the three would **drift** — the same Stage saying different things
in different places. Vendoring the curriculum once and reading it everywhere
removes that risk. (Decision recorded on issue #1021: option 1 — a checked-in
data file with a strict loader — for the same reasons ADR 0001 chose vendoring
over a submodule or a runtime fetch: deterministic, offline, diff-reviewable, no
credentials surface.)

## Where things live

| What | File |
| ---- | ---- |
| Vendored dataset (10 Stages × 6 phases, integrated + shadow) | `backend/src/curriculum/archetypal_wavelength.json` |
| Typed loader (validated, frozen dataclasses) | `backend/src/curriculum/__init__.py` |
| Stage seeder (reads the dataset) | `backend/src/seed_stages.py` |
| Loader + dataset tests | `backend/tests/test_curriculum.py` |
| Seeder golden-value tests | `backend/tests/test_seed_stages.py` |

## Provenance

The dataset's top-level `provenance` block records where its copy came from,
split into two keys because the Stage-identifying attributes and the
per-phase manifestation copy are pulled from two different sources:

- `stage_attributes_source` — the seven per-Stage identifying fields
  (`category`, `aspect`, `spiral_dynamics_color`, `growing_up_stage`,
  `divine_gender_polarity`, `relationship_to_free_will`,
  `free_will_description`) come from `APTITUDE Complete Map.csv` in the
  `aptitude-course` repository's `database_of_course_curriculum`, including
  the December 2025 supersessions recorded in that repository's `CLAUDE.md`
  (Stage 4 aspect "Community Love"; Stage 8 color "Teal", aspect "True Self
  Connection", free-will archetype "True Self Embodier"). This is the
  canonical APTITUDE ontology, not the *Archetypal Wavelength* spreadsheet.
- `manifestations_source` — the titles and six-phase `Rx` (integrated) / `OD`
  (shadow) manifestation copy come from *The Archetypal Wavelength*
  spreadsheet, "Expanded List" sheet (the same sheet `wavelength-demo` and
  `WavelengthWatch` quote verbatim). It does **not** source the subtitles.
- `subtitles_source` — the per-Stage `subtitle` comes from the `aptitude-course`
  repository's resource copy: the `#### ` stage headings in
  `markdown/resources/aptitude-stages.md` and the numbered item list in
  `markdown/resources/about.md`. The subtitles are *not* a mechanical
  `"<aspect> <category>"` join, and they are not the course's own wording
  verbatim either — the dataset and that item list agree exactly only for
  Stages 3, 5, 6 and 7 — so this key records where the editorial decision was
  sourced, not a rule you can re-derive the field from.
  **Known divergence:** Stage 8's subtitle is `"True Self Wisdom"`, following
  upstream commit `3bf0df5` (2026-07-31), which the vendored content pin at
  `backend/content/CONTENT_VERSION` does not yet carry. Until the re-pin
  (issue #2706) lands, the app's label deliberately leads the vendored course,
  whose About page still reads "Transcendent Wisdom".
- `extracted_from` — the in-repo vendored course markdown
  (`backend/content/markdown/backup/*` and the per-stage
  full-6-phase-wavelength-breakdown chapters), which already carries the
  `Rising Rx: … / OD: …` lines verbatim from the sheet.
- `refresh_doc` — a pointer back to this file.

The `Rx`/`OD` copy in the JSON is quoted from that vendored markdown so the
three apps stay in sync with the sheet without adepthood needing live access to
the spreadsheet (privacy posture, #893).

`dataset_version` is `2.1.0`. The `1.x` series shipped with a wrong,
non-canonical vocabulary for the seven stage-attribute fields; correcting
them to the `stage_attributes_source` above is a breaking data change, hence
the major bump to `2.0.0` rather than a patch or minor. The `2.0.0` → `2.1.0`
minor is the Stage 8 subtitle correction: it adds the `subtitles_source`
provenance key and moves the subtitles out of `manifestations_source`'s remit,
so a consumer reading provenance gets different *semantics*, not just a
different character — which is more than a patch, and less than a shape change.

## What the loader guarantees

`curriculum.load_curriculum()` (and the cached `all_stages()`) parse the JSON
into frozen dataclasses and reject anything malformed with a single typed
`CurriculumDataError` — never a raw `KeyError` or `json.JSONDecodeError`. The
dataset is invalid unless it defines **exactly ten Stages** (numbered 1–10, no
duplicates), each carrying **exactly the six canonical phases in order** (Rising
→ Peaking → Withdrawal → Diminishing → Bottoming Out → Restoration), with every
required string non-empty and each phase carrying a populated integrated and
shadow expression. `stage_curriculum(n)` and `manifestation(n, phase)` resolve a
single record; both raise `CurriculumDataError` for unknown keys.

## Refreshing the dataset from the sheet (manual)

The refresh is a deliberate, reviewable edit — there is no live pull:

1. Open *The Archetypal Wavelength* spreadsheet, "Expanded List" sheet. For the
   Stage(s) you are updating, read the per-phase `Rx` (integrated) and `OD`
   (shadow) name + description. Cross-check against the vendored course markdown
   under `backend/content/markdown/` so the wording matches what the reader
   ships.
2. Edit `backend/src/curriculum/archetypal_wavelength.json` in place, keeping
   the shape: each Stage carries its identifying attributes plus a
   `manifestations` array with the six phases **in canonical order**, each entry
   `{ "phase", "integrated": {name, description}, "shadow": {name, description} }`.
3. Bump `dataset_version` (semver: additive copy edits are a patch/minor;
   changing the Stage/phase shape is a major) and, if the extraction source
   changed, update the `provenance` block.
4. Run the dataset tests — they enforce the shape, the golden Stage attributes,
   and this doc's presence:

   ```bash
   cd backend && pytest tests/test_curriculum.py tests/test_seed_stages.py
   ```

5. **After any `make sync-content`** (which re-pins the vendored course tree
   under `backend/content/`), run
   `backend/tests/test_vendored_course_copy_pins.py`. It pins the course's own
   curriculum wording — the ten `aptitude-stages.md` stage headings and the ten
   `about.md` list items — as literals, so a re-pin cannot change curriculum
   copy silently. **A failure there is a decision, not a typo:** read the
   upstream diff and decide whether this dataset follows the new wording, or
   record the divergence deliberately (as `subtitles_source` does for Stage 8
   today). Never hand-edit `backend/content/**` to make it match — that tree is
   excluded from every pre-commit hook and its drift gate,
   `python -m scripts.sync_content --check`, runs only in CI.
6. Commit the JSON diff. Because the seeder derives `STAGE_DEFINITIONS` from the
   dataset at import time, no seeder code change is needed. Seeding is
   insert-plus-reconcile: on the next startup, `seed_stages()` inserts any
   Stage missing from the table and updates the curriculum-sourced fields of
   Stages already there that have drifted from the dataset, so a correction
   like this propagates to already-seeded databases without a migration. The
   seeder-owned `overview_url` is never touched by reconciliation and rows are
   never deleted. The golden-value test in `test_seed_stages.py` still flags
   any unintended change to a Stage's identifying attributes, so a copy
   refresh cannot silently alter seeded rows.

## Consumers

The Stage seeder (`seed_stages.py`) already reads its definitions from the
dataset. Downstream features that describe per-phase manifestations — medicinal
/ toxic expressions (#1018), chord-journal Aspect labels (#1020), and the
explainer (#948) — pull their copy from `curriculum` rather than re-authoring
it, so the manifestation prose lives in exactly one place.
