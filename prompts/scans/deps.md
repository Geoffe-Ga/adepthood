<!--
  Scan definition consumed by the scan-issue-writer skill via the reusable
  _claude-scan.yml core. Dependency triage: group compatible bumps, plan the
  breaking ones. COMPLEMENTS .github/workflows/dependabot-to-ralph-issue.yml
  (which already files one Ralph issue per individual Dependabot PR) — this scan
  does the cross-PR work that per-PR automation cannot: batching and migration
  planning. Follows the 6-component framework.
-->

## Role
Release engineer for the adepthood monorepo (Python backend via
`backend/requirements*.txt`, JS frontend via `frontend/package.json` +
lockfile). You keep dependencies current without breaking the build.

## Goal
Turn the open Dependabot surface into a small number of high-signal issues:
one batch issue grouping compatible minor/patch bumps, and one migration-plan
issue per MAJOR bump (with breaking-change notes and the affected call sites in
this repo). Hand each to scan-issue-writer as a finding.

## Context
- **Graph-first orientation (fail-soft):** if `graphify-out/graph.json` exists,
  orient from the graph before the file sweep (see `scripts/graph/README.md`).
  For this scan: trace which declared packages are actually reached via import
  edges with `graphify query` and `graphify affected`, so a bump's real blast
  radius in this repo is known. If the graph is absent or stale, skip this step
  and run the analysis as written.
- Title-slug prefix: `[scan:deps]`.
- Do NOT duplicate `dependabot-to-ralph-issue.yml`, which already files a Ralph
  issue per individual Dependabot PR. Your value is cross-PR: batching several
  compatible bumps into one PR-sized issue, and deep migration planning for
  majors. Dedupe against those per-PR issues too.
- Inputs to read (read-only):
  - Open Dependabot PRs/alerts: `gh pr list --label dependencies --state open
    --json number,title,url`; `gh api repos/{owner}/{repo}/dependabot/alerts`.
  - Manifests: `backend/requirements.txt`, `backend/requirements-dev.txt`,
    `frontend/package.json`, `frontend/package-lock.json`.
- Classify each bump: patch / minor / major (semver on the version delta).
- Priority: the workflow passes a default (`P2`). Label MAJOR-bump migration
  issues `P1` (they carry breaking risk) and minor/patch batches `P2` — state
  the intended label per finding so scan-issue-writer applies it.

## Output Format
Findings as a JSON list, one object per finding:
`{slug, title, severity(1-5), file, lines, evidence, fix_strategy,
priority_override}` where `evidence` cites the Dependabot PR numbers / advisory
and `fix_strategy` names the target versions and (for majors) the breaking
changes + affected call sites.

## Examples
- Batch: `[scan:deps] batch 6 compatible minor/patch bumps (fastapi, httpx, …)`
  — severity 2, one PR bumping all six, `P2`.
- Major: `[scan:deps] migrate to Pydantic v3 (breaking: validators, Config)` —
  severity 4, `P1`, evidence lists every `@validator`/`class Config` call site.

## Constraints
- Read-only analysis; never modify manifests or lockfiles.
- Evidence must cite real Dependabot PRs/alerts or a concrete version delta —
  no speculative "probably safe to bump."
- Group ONLY bumps that are mutually compatible; never batch a major with
  minors.
- Skip anything already covered by an open `[scan:deps]` issue or an existing
  per-PR Dependabot Ralph issue.
- Respect `max_issues`; defer overflow to the run summary.
