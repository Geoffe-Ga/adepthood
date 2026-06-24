# audit-ci-05: Add pip/uv caching to backend CI jobs

**Labels:** `audit-ci`, `ci`, `infra`, `priority-medium`
**Epic:** CI, Infra & Docs Truth
**Estimated LoC:** ~40  (hard cap 700)

## Problem

Every backend CI job reinstalls Python dependencies from scratch on every run. The
`backend-quality`, `backend-compat` (2-leg matrix), `migration-drift`, and
`content-drift` jobs in `.github/workflows/backend-ci.yml` each call
`uv pip install --system …` against `requirements-lock.txt` / `requirements.txt` /
`requirements-dev.txt` (e.g. lines 29-33, 97-100, 143-146) with no cache layer, so the
full dependency tree is re-resolved and re-downloaded ~5 times per push. The frontend
already caches npm via `setup-node`'s built-in cache, so the backend is the outlier and
the slowest part of the pipeline.

**Current state:** CI/infra — no dep cache. Medium per audit §9 (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:150`).

## Scope

**Covers:** Adding a dependency cache (uv cache and/or `~/.cache/pip`) keyed on the
requirements lockfiles to each backend job that installs Python deps, so repeat runs
restore from cache instead of redownloading.

**Does NOT:** Change which dependencies are installed, pin versions, alter test/gate
logic, or touch the frontend workflow. Does not change the `setup-uv` or `setup-python`
SHA pins (those stay as-is).

## Tasks

1. **Enable uv caching** — prefer `astral-sh/setup-uv`'s built-in cache inputs (e.g. `enable-cache: true` with `cache-dependency-glob` covering `backend/requirements*.txt`) on each `Install uv` step, or add an `actions/cache` step (already SHA-pin per AGENTS.md §6) keyed on the hash of the relevant requirements files. Verify the chosen `setup-uv` version supports the cache inputs at implementation time.
2. **Apply to every install site** — `backend-quality` (lines 26-33), `backend-compat` matrix (lines 94-100), `migration-drift` (lines 140-146), and `content-drift` (lines 221-226). Use a cache key that includes the runner OS, Python version (for the matrix legs), and a hash of the requirements files so the matrix legs don't collide.
3. **Keep restore correctness** — ensure the cache key changes whenever any `requirements*.txt` changes so a stale cache never masks a dependency update; include a `restore-keys` fallback for partial hits.

## Acceptance Criteria

- [ ] Each backend job that installs Python deps has a cache layer keyed on the requirements lockfile hash (+ OS + Python version for matrix legs).
- [ ] A second CI run with unchanged requirements restores from cache (verifiable as a cache hit in the Actions logs).
- [ ] Any added `actions/cache` usage is SHA-pinned with a version comment, consistent with AGENTS.md §6 and the rest of the workflow.
- [ ] Cache keys invalidate when any `requirements*.txt` changes.
- [ ] No existing tests break; coverage ≥ 90% where applicable.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `.github/workflows/backend-ci.yml` | Modify (add caching to all 4 backend jobs) |
