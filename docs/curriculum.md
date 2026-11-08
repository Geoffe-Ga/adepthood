# The Archetypal Wavelength curriculum dataset

The per-Stage and per-phase copy of *The Archetypal Wavelength* — the ten
APTITUDE Stages' titles, subtitles and Modes, and their six-phase manifestations
(integrated `Rx` and shadow `OD` expressions) — is **vendored** into this repo
as a single source of truth at
`backend/src/curriculum/archetypal_wavelength.json`. The seven per-Stage
correspondence fields are not in it: they are generated into
`backend/src/curriculum/stage_correspondence.json`, reconciled into the
`coursestage` table and served from there (see
[Updating stage correspondences](#updating-stage-correspondences)). Every consumer reads it
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
| Vendored dataset (10 Stages × 6 phases, integrated + shadow; titles, subtitles, Modes) | `backend/src/curriculum/archetypal_wavelength.json` |
| Typed loader (validated, frozen dataclasses) | `backend/src/curriculum/__init__.py` |
| Stage-correspondence artifact (generated, #2664; the only copy of the seven fields, #2666) | `backend/src/curriculum/stage_correspondence.json` |
| Artifact loader | `backend/src/curriculum/stage_correspondence.py` |
| Stage seeder (artifact + dataset titles) | `backend/src/seed_stages.py` |
| Loader + dataset tests | `backend/tests/test_curriculum.py` |
| No-copy gate + #1637 pins | `backend/tests/test_stage_correspondence.py` |
| Single-reader architecture guard | `backend/tests/architecture/test_stage_correspondence_single_source.py` |
| Seeder golden-value tests | `backend/tests/test_seed_stages.py` |
| Course-copy pins + archetype drift guard | `backend/tests/test_vendored_course_copy_pins.py` |
| Course completeness gate + inventory generator (#3070) | `backend/scripts/content_completeness.py` |
| Recorded Course content gaps (hand-reviewed) | `backend/src/curriculum/content_gaps.json` |
| External-link inventory (generated, not a bibliography) | `backend/src/curriculum/source_references.json` |
| Practice-recommendation inventory (generated, unreviewed) | `backend/src/curriculum/practice_recommendations.json` |

## Provenance

The dataset's top-level `provenance` block records where its copy came from.
It no longer describes the seven correspondence fields: since `dataset_version`
`3.0.0` the dataset carries none of them, and their provenance lives with the
generated artifact (its `source` block and echoed `supersessions`) and with
`backend/src/curriculum/stage_correspondence_supersessions.json`. The keys that
remain:

- `manifestations_source` — the titles and six-phase `Rx` (integrated) / `OD`
  (shadow) manifestation copy come from *The Archetypal Wavelength*
  spreadsheet, "Expanded List" sheet (the same sheet `wavelength-demo` and
  `WavelengthWatch` quote verbatim). It does **not** source the subtitles.
- `manifestation_names_source` — stages 1–9's `Rx`/`OD` names equal the
  vendored Modes of the Wavelength CSV, gated by
  `scripts/check_wavelength_terms.py` (#3135); Clear Light is the Neither/Both
  Mode and carries no pairs of its own.
- `subtitles_source` — the per-Stage `subtitle` comes from the `aptitude-course`
  repository's resource copy: the `#### ` stage headings in
  `markdown/resources/04-aptitude-stages.md` and the numbered item list in
  `markdown/resources/02-about.md`. The subtitles are *not* a mechanical
  `"<aspect> <category>"` join, and they are not the course's own wording
  verbatim either — the dataset and that item list agree exactly only for
  Stages 3, 5, 6, 7 and 8 — so this key records where the editorial decision
  was sourced, not a rule you can re-derive the field from. Stage 8's
  subtitle `"True Self Wisdom"` followed upstream commit `3bf0df5`
  (2026-07-31) ahead of the content pin; the re-pin to `9d0f896` (issue
  #2706) closed that gap, so the About page now reads "True Self Wisdom"
  too.
- `extracted_from` — the in-repo vendored course markdown
  (`backend/content/markdown/backup/*` and the per-stage
  full-6-phase-wavelength-breakdown chapters), which already carries the
  `Rising Rx: … / OD: …` lines verbatim from the sheet.
- `refresh_doc` — a pointer back to this file.

The `Rx`/`OD` copy in the JSON is quoted from that vendored markdown so the
three apps stay in sync with the sheet without adepthood needing live access to
the spreadsheet (privacy posture, #893).

`dataset_version` is `3.0.0`. The `1.x` series shipped with a wrong,
non-canonical vocabulary for the seven stage-attribute fields; correcting
them to the Complete Map CSV was a breaking data change, hence the major bump
to `2.0.0` rather than a patch or minor. The `2.0.0` → `2.1.0` minor is the
Stage 8 subtitle correction: it added the `subtitles_source` provenance key
and moved the subtitles out of `manifestations_source`'s remit, so a consumer
reading provenance got different *semantics*, not just a different character.
The `2.1.0` → `2.2.0` minor corrected Stage 2's free-will archetype and
description to the course (#2915). The later `2.x` releases up to `2.5.0`
changed manifestation copy (for example #3685) and added Clear Light's `mode`
(#3688), without touching the Stage shape. The `2.5.0` → `3.0.0` major is #2666: the seven correspondence fields and the
`stage_attributes_source`, `stage_2_free_will_source`,
`free_will_descriptions_source` and `supersessions` provenance keys are
removed. Dropping fields is a shape change, so it is a major.

## What the loader guarantees

`curriculum.load_curriculum()` (and the cached `all_stages()`) parse the JSON
into frozen dataclasses and reject anything malformed with a single typed
`CurriculumDataError` — never a raw `KeyError` or `json.JSONDecodeError`. The
dataset is invalid unless it defines **exactly ten Stages** (numbered 1–10, no
duplicates), each carrying **exactly the six canonical phases in order** (Rising
→ Peaking → Withdrawal → Diminishing → Bottoming Out → Restoration), with every
required string non-empty and each phase carrying a populated integrated and
shadow expression. `stage_curriculum(n)` and `manifestation(n, phase)` resolve a
single record; both raise `CurriculumDataError` for unknown keys. A Stage's
record carries its `title`, `subtitle`, `manifestations` and optional `mode`
only; a correspondence key left in the JSON is ignored, never surfaced as an
attribute.

## Refreshing the dataset from the sheet (manual)

The refresh is a deliberate, reviewable edit — there is no live pull:

1. Open *The Archetypal Wavelength* spreadsheet, "Expanded List" sheet. For the
   Stage(s) you are updating, read the per-phase `Rx` (integrated) and `OD`
   (shadow) name + description. Cross-check against the vendored course markdown
   under `backend/content/markdown/` so the wording matches what the reader
   ships.
2. Edit `backend/src/curriculum/archetypal_wavelength.json` in place, keeping
   the shape: each Stage carries its `stage_number`, `title` and `subtitle`
   plus a `manifestations` array with the six phases **in canonical order**,
   each entry
   `{ "phase", "integrated": {name, description}, "shadow": {name, description} }`.
   Do **not** add a correspondence field (category, aspect, colour, Growing Up
   stage, polarity, free-will archetype or description) here: those are
   generated, and `backend/tests/test_stage_correspondence.py` fails on any
   copy of them. Change them through
   [Updating stage correspondences](#updating-stage-correspondences).
3. Bump `dataset_version` (semver: additive copy edits are a patch/minor;
   changing the Stage/phase shape is a major) and, if the extraction source
   changed, update the `provenance` block.
4. Run the dataset tests — they enforce the shape, the golden Stage attributes
   (read from the artifact), and this doc's presence:

   ```bash
   cd backend && pytest tests/test_curriculum.py tests/test_seed_stages.py \
     tests/test_vendored_course_copy_pins.py
   ```

5. **After any `make sync-content`** (which re-pins the vendored course tree
   under `backend/content/`), run
   `backend/tests/test_vendored_course_copy_pins.py`. It pins the course's own
   curriculum wording — the ten `aptitude-stages.md` stage headings and the ten
   `about.md` list items — as literals, so a re-pin cannot change curriculum
   copy silently, and it compares every stage's `relationship_to_free_will`,
   as the generated `stage_correspondence.json` ships it, to its heading's
   archetype with no exemptions. **A failure there is a decision, not a
   typo:** read the upstream diff and decide whether this dataset (for the
   subtitles) or the artifact (for the archetype, through a regeneration or a
   chapter-cited supersession) follows the new wording, or record the
   divergence deliberately (as `subtitles_source` does for Stage 8 today). Never hand-edit `backend/content/**` to make it match — that tree is
   excluded from every pre-commit hook and its drift gate,
   `python -m scripts.sync_content --check`, runs only in CI.
6. Commit the JSON diff. The seeder reads titles and subtitles from this
   dataset on its first run (and the seven correspondence fields from the
   generated artifact), so no seeder code change is needed. Seeding is
   insert-plus-reconcile, keyed by the stable `stage_key`: on the next
   startup, `seed_stages()` inserts any Stage missing from the table and
   updates the sourced fields of Stages already there that have drifted, so a
   correction like this propagates to already-seeded databases without a
   migration. The
   seeder-owned `overview_url` is never touched by reconciliation and rows are
   never deleted. The golden-value test in `test_seed_stages.py` still flags
   any unintended change to a Stage's title, subtitle or correspondence
   fields, so a copy refresh cannot silently alter seeded rows.

## Updating stage correspondences

The seven per-Stage correspondence fields (category, aspect, Spiral Dynamics
colour, Growing Up stage, divine gender polarity, relationship to free will and
its description) are generated, never hand-edited. Their source is the
`APTITUDE Complete Map.csv` vendored at the `backend/content/CONTENT_VERSION`
pin, plus the adepthood-owned supersessions. The output is
`backend/src/curriculum/stage_correspondence.json`. The vendoring exception and
its exit plan are recorded in `docs/adr/0001-git-content-pipeline.md` (the
2026-09-25 note). This is the whole path for a change, from upstream to a
running database.

1. **Edit upstream.** Change the CSV or the chapter text in the
   `aptitude-course` repository and merge it there. Never edit
   `backend/content/**` by hand: it is excluded from every pre-commit hook, and
   its drift gate fails the next CI run.
2. **Re-pin.** Vendor the new upstream commit, which rewrites `backend/content/`
   and `CONTENT_VERSION` (sha, timestamp, tree digest), then confirm the tree
   matches the pin:

   ```bash
   make sync-content REF=<sha>      # or: cd backend && python -m scripts.sync_content --ref <sha>
   cd backend && python -m scripts.sync_content --check
   ```

3. **Regenerate.** Rebuild the artifact from the newly vendored CSV and the
   supersessions, then confirm it is current:

   ```bash
   cd backend && python -m scripts.build_stage_correspondence
   cd backend && python -m scripts.build_stage_correspondence --check
   ```

   CI runs that `--check` in the `content-drift` job of `backend-ci.yml`, right
   after `sync_content --check`, so a re-pin that skips this step fails there.
   If a supersession has gone stale, the generator refuses to build; see below.
   Regenerate the Course inventories too, and clear any gap the re-pin fixed
   (see [Course content completeness gate](#course-content-completeness-gate-3070)):

   ```bash
   cd backend && python -m scripts.content_completeness
   cd backend && python -m scripts.content_completeness --check
   ```

   Then confirm the Map's Rx/OD phase names still equal the vendored
   `The Archetypal Wavelength - Modes of the Wavelength.csv` (#3135). The
   re-pin also vendors that CSV, to
   `backend/content/curriculum/modes_of_the_wavelength.csv`:

   ```bash
   cd backend && python -m scripts.check_wavelength_terms
   ```

   It runs in the same `content-drift` job. A failure names each stage, phase
   and expression whose name in `archetypal_wavelength.json` differs from the
   CSV. It joins each stage to its CSV row by the colour
   `stage_correspondence.json` gives that stage (`--correspondence`, defaulting
   to the committed artifact), since the dataset carries no colour of its own.
   Fix a failure by carrying the CSV term into `archetypal_wavelength.json` and
   rewriting that phase's description. Never fix it by editing the CSV. A stage with no CSV
   row must mark each manifestation `"source": "app-authored"`. Clear Light
   has no row and carries no manifestations at all: it is the Neither/Both
   Mode (`"mode": {"holds_all_modes": true}`), and `GET /stages` serves its
   phases as a `chord` of stages 1-9's integrated names, composed by
   `curriculum.phase_chords`.
4. **Run the single-source and consumer tests.**
   `backend/tests/test_stage_correspondence.py` asserts that
   `archetypal_wavelength.json` carries no copy of the seven fields (#2666) and
   pins the #1637 stages literally; a red pin after a re-pin is a decision:
   update the literal or record a supersession.
   `backend/tests/architecture/test_stage_correspondence_single_source.py`
   asserts that `seed_stages.py` is the only backend module importing the
   artifact loader, so every other reader goes through `CourseStage`.
   `frontend/src/features/Map/__tests__/stageCanonDrift.test.ts` (run by
   backend CI through `scripts/frontend/cross-boundary-drift.sh`) holds the Map
   copy to the artifact.
5. **Commit** the `CONTENT_VERSION` bump, the vendored tree, the regenerated
   artifact and any dataset change together, so that `--check` holds at every
   commit.

### Supersessions

`backend/src/curriculum/stage_correspondence_supersessions.json` lists the
ratified departures from the CSV (chapter text wins over the CSV, owner ruling
2026-09-16). The generator enforces the rules for each entry:

- `stage_id` and `field` name a real stage and one of the seven fields;
- `csv_value` must equal the vendored CSV cell exactly. When upstream later
  edits that cell, the entry fails as stale and must be revisited, never
  silently reapplied;
- `value` must differ from `csv_value`. No-op entries are refused;
- `authority` must be contracted vendored markdown under `markdown/` (never
  `markdown/backup/`) that contains `value`.

To add a supersession, append an entry, regenerate and run `--check`. To retire
one (for example once upstream adopts the value in the CSV, which makes the
entry stale), delete it and regenerate. Either way, update the literal pins in
`test_stage_correspondence.py`, which exist so the change is a visible decision.

### What happens on deploy

On startup `seed_stages()` reconciles the `coursestage` table against the
artifact, keyed by the stable `stage_key` (the colour slug):

- a missing `stage_key` is inserted;
- a row whose artifact-sourced fields or provenance have drifted is updated in
  place, keeping its id and its seeder-owned `overview_url`. Its
  `reconciled_at` moves only when something actually changed;
- a row whose `stage_key` and `stage_number` disagree with the artifact raises
  before anything is written;
- a row whose `stage_key` the artifact no longer names is logged as an orphan
  and kept. Rows are never deleted.

No migration is needed for a data change.

**Verify** after deploy by reading `GET /stages/correspondence`. Each stage's
`provenance` names `source_repo`, `source_sha` (the new pin), `source_path`,
`source_sha256` and `schema_version`, and `reconciled_at` shows which rows
moved. Before merging, the four drift gates must all exit 0:

```bash
cd backend && python -m scripts.sync_content --check
cd backend && python -m scripts.build_stage_correspondence --check
cd backend && python -m scripts.content_completeness --check
python scripts/backend/export_openapi.py --check
```

The last one matters only if the response shape changed, which a data change
never does.

### Rollback

Re-pin the previous upstream SHA (step 2 with the old `REF`), regenerate
(step 3) and redeploy. The reconciler moves the rows back on the next startup
and stamps a fresh `reconciled_at` on each one that changed. Because no
migration is involved, there is nothing to downgrade. A supersession added or
removed in the bad change is reverted in the same commit.

### Correspondence consumers

Every reader of the seven fields, and which copy it reads. "Server" is the
`coursestage` table (via the ORM or `GET /stages` / `GET /stages/correspondence`);
"artifact" is `stage_correspondence.json` read directly; "pinned fallback" is a
literal held equal to the artifact by a test.

| Consumer | Reads | Path |
| -------- | ----- | ---- |
| `backend/src/seed_stages.py` | artifact (the only `src` reader) | `stage_correspondence()` → reconciles `coursestage` |
| `backend/src/routers/stages.py` (`GET /stages`, `GET /stages/correspondence`) | server | `CourseStage` columns |
| `backend/src/routers/user_practices.py` (frequency banner) | server | `CourseStage.spiral_dynamics_color`, `.aspect` |
| `backend/src/domain/wheel.py` (`aspect_labels_by_stage`) | server | `CourseStage.aspect` |
| `backend/src/services/corpus_store.py` (stage → frequency) | server | `CourseStage.spiral_dynamics_color` → `frequency_for_color` |
| `backend/src/domain/frequencies.py` `FREQUENCY_COLORS` | pinned fallback | literal; held to the artifact by `tests/services/test_frequency_classification.py` |
| `backend/scripts/check_wavelength_terms.py` | artifact (plain JSON) | `--correspondence`, colour per stage for the Modes CSV join |
| `backend/scripts/build_stage_correspondence.py` | writes the artifact | Complete Map CSV + supersessions |
| `backend/tests/e2e/stage_copy.py` (test-only) | server | reads and rewrites whitelisted `coursestage` columns for browser specs |
| `frontend/src/features/Map/stageVocabulary.ts` | server | `GET /stages` rows (stage store) |
| `frontend/src/features/Journal/useAspectOptions.ts` | server, then pinned fallback | stage store, then `GET /stages/correspondence`, then the stage colour name |
| `frontend/src/store/stageColorName.ts` (`stageColorName`, `storedStageColorName`, `useStageColorName(s)`) | server, then pinned fallback | the explicit served row or the stage store, else `STAGE_ORDER` — the one stage_number → colour-name resolver |
| `frontend/src/design/tokens.ts` `STAGE_ORDER` | pinned fallback | offline only; held to `stage_correspondence.json` by `stageOntologyDrift.test.ts`, and the only colour list (`stageCanonDrift` forbids a second) |
| `frontend/src/features/Map/services/stageService.ts` `toStageData` (tile colour) | server | the served `spiral_dynamics_color` |
| `frontend/src/features/Map/magnifierGeometry.ts` (spoken label) | server, then pinned fallback | explicit `VocabularySource.spiralDynamicsColor` |
| `Map/stageVocabulary.ts` fallback words, `Map/progress/progressPresentation.ts`, `Map/StageModeSection.tsx` | server, then pinned fallback | the stage store via the resolver |
| `Journal/AspectChordControl.tsx`, `Journal/JournalHero.tsx`, `Journal/reflectionCopy.ts` | server, then pinned fallback | the stage store via the resolver |
| `Practice/components/StageSelector.tsx`, `PracticeStorySection.tsx`, `utils/stageDisplayName.ts`, `data/colorPalette.ts` | server, then pinned fallback | the stage store via the resolver; swatch hexes are design data |
| `Habits/story/habitStoryPresentation.ts`, `Habits/ledger/ledgerPresentation.ts` | server, then pinned fallback | the stage store via the resolver |
| `frontend/src/features/Course/stageDisplay.ts` `getStageColor` | server, then pinned fallback | the explicit API stage's `spiral_dynamics_color`, else by position |
| `Habits/HabitUtils.ts` `stageAtIndex` | not a consumer | the pinned list used as habit identity keys for ring cycling, not a correspondence read |

`FREQUENCY_NAMES` (`domain/frequencies.py`) is not a consumer: it is Creek's
wire vocabulary (see "The vocabulary decision" in
`docs/creek-vault-mcp-contract.md`) and deliberately differs from the served
aspect at F5–F8.

## Course content completeness gate (#3070)

`sync_content --check` proves the vendored tree is the pinned commit, and
`build_stage_correspondence --check` proves the correspondence is generated
from it. Neither proves the Course a reader is served is complete.
`backend/scripts/content_completeness.py` does, over exactly the files the
manifest serves (chapters, stage intros and site resources; `backup/` and the
export tables of contents are not graded). Every stage intro shares its file
with chapter 1 upstream, so each file is graded once.

| Check | Fails when | Waivable? |
| ----- | ---------- | --------- |
| `stage_coverage` | a stage 1–10 lacks exactly one intro or any chapter, or a stage is out of range | no |
| `duplicate_ref` | a chapter id, per-stage chapter slug, intro id or resource slug repeats | no |
| `thin_chapter` | a chapter body has fewer than `MIN_CHAPTER_WORDS` (50) words | yes |
| `numbering_gap` | a stage's chapter numbers skip (`<stage>:<n>`) or repeat (`<stage>:<n>:duplicate`) | yes |
| `broken_relative_link` | a relative link or image leaves the content dir, is missing, or its `.md#fragment` names no heading | no |
| `broken_anchor` | an in-file `#anchor` names no heading of that file | no |
| `insecure_external_link` | an external link is plain `http` | no |
| `redirect_wrapper_link` | a link is a `google.com/url` redirect wrapper | no |

**Word floor.** Words are counted in the served body (frontmatter stripped
exactly as `services.content_repository` does, which a parity test pins) with
heading lines excluded. On the pinned tree teal-7 has 0, orange-7 has 29 and the
next-thinnest chapter (orange-13) has 75, so 50 separates a missing body from a
short one with room either side.

**Recording a gap.** Only content the owner writes upstream is waivable. A
thin chapter or numbering gap that cannot be fixed in the same change is
listed in `backend/src/curriculum/content_gaps.json` with `kind`, `key`,
`reason`, `owner_review: "pending"`, `upstream` and `issue`; the gate refuses
any other kind, a blank field, a duplicate or an unknown key. The generator
never writes this file. Fixing a gap means editing `aptitude-course`, re-pinning
(step 2 above), and deleting the entry in the same PR: a recorded gap that no
longer reproduces fails the gate as stale. The current record lists teal-7
(heading-only), orange-7 (a 29-word framing chapter), beige chapter 12
(missing), and the numbers upstream retired without reuse: beige chapter 8
(moved to the site resources as Energy Scaffolding) and orange chapters 26-28
(removed), all pending the owner.

**Inventories.** `python -m scripts.content_completeness` regenerates two files
and then runs the gate; `--check` writes nothing and also fails when either
committed file differs from a regeneration.

- `source_references.json` lists every external link in served content, keyed
  by file and the refs that serve it, with the pinned `CONTENT_VERSION` sha. It
  is **not a bibliography**: it carries no author, edition or rights status,
  and a link is not a citation. It is the input the owner's bibliography and
  rights review start from.
- `practice_recommendations.json` lists every chapter whose title names a
  practice or protocol (`id`, `stage`, `chapter`, `title`), each with status
  `unreviewed`. Regeneration overwrites the file, so reviewed mappings to
  practice presets (or an explicit "unsupported") belong in a separate,
  owner-reviewed sidecar keyed by chapter id, not in this file.

CI runs `content_completeness --check` in the `content-drift` job after the two
checks above; `tests/scripts/test_stage_correspondence_drift_gate.py` fails if
the step is removed, reordered, or allowed to swallow its exit code.

## Consumers

The Stage seeder (`seed_stages.py`) takes each Stage's title and subtitle from
this dataset, and since #2665 its seven correspondence fields from the
generated stage-correspondence artifact, stamping every `CourseStage` row with
that artifact's provenance (source repo, commit, CSV path and sha256, schema
version). `GET /stages/correspondence` serves those rows as the stable read
contract. Since #2666 the dataset carries no copy of those fields, so the
seeded rows are their only runtime source; the full list of readers is in
[Correspondence consumers](#correspondence-consumers). Downstream features that describe per-phase manifestations — medicinal
/ toxic expressions (#1018), chord-journal Aspect labels (#1020), and the
explainer (#948) — pull their copy from `curriculum` rather than re-authoring
it, so the manifestation prose lives in exactly one place.

On the frontend (#2666), the Map's stage words -- persona, descriptor (the
title), arrow label, the UNITY / EMPTINESS watermark and the row category --
are derived from the `GET /stages` rows by
`frontend/src/features/Map/stageVocabulary.ts`; `mapLayout.ts` keeps only each
stage's practice line and artwork colours. The Journal chord labels its Aspects
with the same persona through `useAspectOptions`: the stage store first, then
the visit-free `GET /stages/correspondence`, then the stage colour name.
