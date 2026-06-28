# course-cms-02: `ContentRepository` — parse & serve stage introductions

**GitHub:** #718 · **Labels:** `backend`, `enhancement`
**Epic:** #716 · **Depends on:** #717 (schema)
**Estimated LoC:** ~200

## Problem

`ContentRepository` (`backend/src/services/content_repository.py`) indexes
`chapters` and `site_resources` from the manifest but ignores the new
`stage_intros[]` tier (added in #717). The course router (#719) needs to read
intro metadata and bodies through the repository, with the same parse-once +
traversal-guard guarantees the other tiers have.

## Scope

Repository only. Mirror the existing `site_resources` handling (intros are not
seeded into the DB and not read-tracked — they are served straight from the
manifest, keyed by `stage`).

## Tasks (TDD)

1. **Dataclass.** Add `StageIntroMeta(stage, id, slug, title, summary | None)`.
   Deliberately omit `path` from the public dataclass (like `SiteResourceMeta`),
   resolving it internally for body reads.
2. **Index.** Add `_index_intros(raw_intros)` keyed by `stage`, rejecting a
   **duplicate `stage`** (at most one intro per stage) with a clear
   `ContentRepositoryError` (the schema can't express that). Read
   `manifest.get("stage_intros", [])` so a manifest without the key yields an
   empty index (back-compat with 1.0.0 pins).
3. **Reads.**
   - `list_stage_intros() -> list[StageIntroMeta]` ordered by `stage`.
   - `get_stage_intro(stage: int) -> StageIntroMeta | None` (optional lookup,
     `None` when absent — mirrors `get_chapter`).
   - `read_intro_body(stage: int) -> ContentBody` raising `ContentNotFoundError`
     for an unknown stage; body read goes through the existing `_read_markdown`
     traversal guard; `content_type` is a dedicated constant (e.g.
     `_INTRO_CONTENT_TYPE = "introduction"`, distinct from chapter enum values
     and from `_RESOURCE_CONTENT_TYPE`).
4. **Tests.** Extend `backend/tests/test_content_repository.py` and the fixture
   `backend/tests/fixtures/content/manifest.json` (+ a fixture intro `.md`):
   - intros parse and list in `stage` order;
   - `get_stage_intro` returns `None` for an unseeded stage;
   - `read_intro_body` returns the Markdown + title + `introduction` type;
   - `read_intro_body` for an unknown stage raises `ContentNotFoundError`;
   - a manifest with **no** `stage_intros` → `list_stage_intros() == []`;
   - a manifest with two intros for the same `stage` raises
     `ContentRepositoryError`;
   - an intro whose `path` escapes the content dir raises
     `ContentRepositoryError` (traversal guard).

## Acceptance criteria

- The four new symbols (`StageIntroMeta`, `list_stage_intros`,
  `get_stage_intro`, `read_intro_body`) exist and are covered.
- Absent `stage_intros` degrades to empty; duplicate-stage and path-escape are
  rejected.
- Existing chapter/resource behaviour and tests are unchanged.
- `./scripts/backend/check-all.sh` exits 0 (xenon A, mypy strict, ≥85% docstring).

## Files to modify

| File | Action |
|------|--------|
| `backend/src/services/content_repository.py` | Add intro dataclass, index, reads |
| `backend/tests/test_content_repository.py` | New cases |
| `backend/tests/fixtures/content/manifest.json` | Add `stage_intros[]` |
| `backend/tests/fixtures/content/**` | Add a fixture intro Markdown file |

## Constraints

- Read-only repository — never write to the content dir.
- Reuse `_read_markdown` for the traversal guard; do not reimplement it.
- Keep construction parse-once; no per-request file walks.
