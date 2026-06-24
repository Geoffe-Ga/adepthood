# audit-ci-04: Stop the branch-coverage gate swallowing pytest crashes

**Labels:** `audit-ci`, `ci`, `infra`, `priority-high`
**Epic:** CI, Infra & Docs Truth
**Estimated LoC:** ~10  (hard cap 700)

## Problem

`.github/workflows/backend-ci.yml:62` runs the coverage producer as
`pytest --cov=src --cov-report=xml --cov-branch -q --no-header 2>/dev/null || true`.
The `2>/dev/null` hides every error and `|| true` forces exit 0, so a pytest crash
(collection error, import failure, plugin breakage) is silently swallowed. The next
step then parses whatever `coverage.xml` happens to be on disk — possibly stale from a
prior run or partially written — and computes a `branch-rate` that has nothing to do
with the current code. The 80% branch-coverage gate therefore cannot fail for the one
reason it most needs to: a broken test run.

**Current state:** CI/infra — non-gating gate. High per audit §9 (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:146`).

## Scope

**Covers:** Removing the error suppression on the pytest invocation in the
`Branch coverage ≥80%` step so a pytest failure fails the job.

**Does NOT:** Change the 80% threshold, the `coverage.xml` parsing Python, or any other
job. Does not alter what tests run — only stops their crashes from being hidden.

## Tasks

1. **Remove `2>/dev/null` and `|| true`** from the pytest line in `backend-ci.yml:62` so the command becomes `pytest --cov=src --cov-report=xml --cov-branch -q --no-header`. A non-zero pytest exit now fails the step before the parser ever runs.
2. **Keep the job fail-fast** — ensure the step still runs under the default `set -e` behaviour (each `run:` block is its own shell) so a pytest failure short-circuits the subsequent `coverage.xml` parse rather than reaching it with a stale file.
3. **Guard against a missing artifact (defensive)** — optionally have the parser exit non-zero with a clear `::error::` if `coverage.xml` is absent, so a future change that drops the report fails loudly instead of `FileNotFoundError`-ing opaquely. Keep this minimal and within the existing inline Python.

## Acceptance Criteria

- [ ] `backend-ci.yml` has no `2>/dev/null` or `|| true` on the branch-coverage pytest line — grep clean.
- [ ] A pytest failure in the branch-coverage step fails the `backend-quality` job (the parser never runs against stale coverage).
- [ ] The 80% branch-coverage threshold and parsing logic are unchanged.
- [ ] No existing tests break; coverage ≥ 90% where applicable.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `.github/workflows/backend-ci.yml` | Modify (lines 56-72, the branch-coverage step) |
