# Build a `manifest.json` generator

**Repo:** `Geoffe-Ga/aptitude-course` · **Labels:** `tooling`
**Epic:** adepthood#388 · **Depends on:** C (frontmatter) · **Blocks:** E (CI), adepthood#391 (sync), adepthood#392 (seed)

## Role & context

The Adepthood app consumes a single machine-readable index, not 219 loose
files. `manifest.json` is the published contract
([adepthood#389](https://github.com/Geoffe-Ga/adepthood/issues/389) defines its
schema). It is **generated** from the per-file frontmatter so the files stay the
source of truth and the manifest never drifts by hand.

## Goal

`scripts/build_manifest.py` walks `markdown/**`, reads frontmatter, and emits a
schema-valid `manifest.json` at the repo root (plus `site_resources[]` from
issue G), with a `schema_version` matching adepthood#389.

## Tasks

1. Implement `scripts/build_manifest.py`: collect every chapter's frontmatter +
   relative `path`, sort by (`stage`,`order`), and assemble `chapters[]` and
   `site_resources[]`.
2. Emit `schema_version` (semver) aligned with adepthood#389's
   `manifest.schema.json`; validate the output against that schema (vendor or
   fetch the schema; document which).
3. Fail loudly on duplicate `id`/(`stage`,`chapter`), missing required fields,
   or `slug`/filename mismatch.
4. Make output deterministic (stable key order) so manifest diffs are clean.
5. Commit the generated `manifest.json` (the app vendors a pinned commit that
   must include it).

## Acceptance criteria

- `python scripts/build_manifest.py` produces a deterministic, schema-valid
  `manifest.json` covering all stages.
- Re-running with no content change yields a byte-identical manifest.
- Duplicate/invalid frontmatter aborts with a precise error.

## Constraints

- Generator is pure/deterministic; no network.
- Schema version is the coordination point with the app — bump it deliberately.
