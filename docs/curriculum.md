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
- `manifestations_source` — the titles, subtitles, and six-phase `Rx`
  (integrated) / `OD` (shadow) manifestation copy come from *The Archetypal
  Wavelength* spreadsheet, "Expanded List" sheet (the same sheet
  `wavelength-demo` and `WavelengthWatch` quote verbatim).
- `extracted_from` — the in-repo vendored course markdown
  (`backend/content/markdown/backup/*` and the per-stage
  full-6-phase-wavelength-breakdown chapters), which already carries the
  `Rising Rx: … / OD: …` lines verbatim from the sheet.
- `refresh_doc` — a pointer back to this file.

The `Rx`/`OD` copy in the JSON is quoted from that vendored markdown so the
three apps stay in sync with the sheet without adepthood needing live access to
the spreadsheet (privacy posture, #893).

`dataset_version` is `2.0.0`. The `1.x` series shipped with a wrong,
non-canonical vocabulary for the seven stage-attribute fields; correcting
them to the `stage_attributes_source` above is a breaking data change, hence
the major bump rather than a patch or minor.

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

5. Commit the JSON diff. Because the seeder derives `STAGE_DEFINITIONS` from the
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
