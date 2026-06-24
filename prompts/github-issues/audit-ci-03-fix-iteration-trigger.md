# audit-ci-03: Fix the dead `workflows: ["CI"]` name match in iteration-trigger

**Labels:** `audit-ci`, `ci`, `infra`, `priority-high`
**Epic:** CI, Infra & Docs Truth
**Estimated LoC:** ~5  (hard cap 700)

## Problem

`.github/workflows/iteration-trigger.yml:16` subscribes to `workflow_run` with
`workflows: ["CI"]`, but no workflow in this repo is named `CI`. The real names are
`Backend CI` and `Frontend CI` (`backend-ci.yml:1`, `frontend-ci.yml:1`). GitHub matches
`workflow_run.workflows` against the `name:` of the upstream workflow, so the trigger
**never fires** — the executive-summary nudge that is supposed to wake the mobile Claude
loop after CI goes green + a review is posted is silently dead.

**Current state:** CI/infra — dead workflow. High per audit §9 (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:145`).

## Scope

**Covers:** Correcting the `workflows:` list in `iteration-trigger.yml` so it matches the
actual CI workflow names.

**Does NOT:** Change the nudge job logic, the 10-post cap, the PAT handling, the verdict
parsing, or the permissions. Does not rename any workflow.

## Tasks

1. **Replace the name match** in `.github/workflows/iteration-trigger.yml:16` — change `workflows: ["CI"]` to `workflows: ["Backend CI", "Frontend CI"]` so the trigger fires when either real CI workflow completes. Confirm the exact names against the `name:` lines in `backend-ci.yml` and `frontend-ci.yml` at implementation time.
2. **Sanity-check the downstream guard** — the job's `if:` already filters on `conclusion == 'success'` and `event == 'pull_request'`; verify no other line hardcodes the string `"CI"` such that the two-workflow match would double-fire incorrectly (the 10-post cap already protects against runaway posts).

## Acceptance Criteria

- [ ] `iteration-trigger.yml` `workflows:` list contains the exact `name:` values of the real CI workflows (`Backend CI`, `Frontend CI`) and no longer references `"CI"` — grep clean for `"CI"` as a standalone workflow name.
- [ ] The matched names are verified against the live `name:` lines in `backend-ci.yml` and `frontend-ci.yml`.
- [ ] No existing tests break; coverage ≥ 90% where applicable.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `.github/workflows/iteration-trigger.yml` | Modify (line 16) |
