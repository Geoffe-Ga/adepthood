# EPIC: CI, Infra & Docs Truth

**Labels:** `epic`, `ci`, `priority-high`

## Summary

The 2026-06-24 full-stack audit (§9, `prompts/github-issues/2026-06-24_ADEPTHOOD_FULL_AUDIT.md:138-153`)
found that the CI/infra/docs layer — normally this repo's strongest discipline — has
a concentrated cluster of "truth drift": gates that look like they gate but don't,
workflows that look wired but never fire, supply-chain `uses:` pins that look pinned
but float on mutable tags, and operator docs that confidently describe a system that
no longer exists.

This epic does three things, in priority order:

1. **SHA-pin actions** — close the supply-chain hole where two write-perm + OIDC
   workflows (`claude.yml`, `claude-code-review.yml`) consume `actions/checkout@v6`
   and `anthropics/claude-code-action@v1` on mutable tags, violating `AGENTS.md §6`.
2. **Make gates actually gate** — the branch-coverage step swallows pytest crashes
   (`backend-ci.yml:62` `… 2>/dev/null || true`) and parses stale coverage; the
   iteration-trigger workflow listens for a workflow name (`"CI"`) that does not
   exist, so it never fires. Both are dead controls masquerading as live ones.
3. **Fix docs that lie about the system** — `DEPLOYMENT.md:271-326` tells operators
   Alembic is "not yet configured" and walks them through `alembic init` /
   `create_all()` that would clobber the real, CI-gated migration tree (35 versions,
   `alembic.ini` present). Plus a sweep of smaller stale claims (Node/Python
   versions, model count, formatter names, a broken REPL snippet).

The audit explicitly carves the test-quality findings from §9 into a separate epic
(`audit-testq`); this epic owns the CI/infra/docs rows only.

## Success Criteria

- [ ] No workflow `uses:` references a mutable tag — `grep -REn 'uses:.*@(v[0-9]+|main|master|latest)' .github/workflows/` is clean; every action is pinned to a full 40-char SHA with a version comment.
- [ ] `DEPLOYMENT.md` describes the real Alembic setup (env-driven `alembic.ini`, autogenerate flow, the migration-drift CI gate); the `alembic init` and `create_all()` instructions are gone.
- [ ] The iteration-trigger workflow fires on the real CI workflow names (`Backend CI`, `Frontend CI`) and no longer references the non-existent `"CI"` workflow.
- [ ] The branch-coverage step fails loudly on a pytest crash — no `2>/dev/null`, no `|| true` — so the 80% gate can never parse stale `coverage.xml`.
- [ ] Backend CI jobs cache their Python dependency installs (uv/pip) the way the frontend already caches npm.
- [ ] Every stale doc claim called out in `audit-ci-06` is corrected against the live tree.
- [ ] The frontend `npm audit` advisory count (36: 1 critical, 18 high) is triaged and reduced via upgrades, with any residual suppression justified per the `cve-remediation` skill.
- [ ] All pre-commit hooks pass on `--all-files`; backend coverage stays ≥ 90% where touched.

## Sub-Issues

| # | Issue | Priority |
|---|-------|----------|
| 01 | `audit-ci-01-sha-pin-claude-workflows.md` — SHA-pin the 4 mutable-tag actions in the Claude workflows | priority-critical |
| 02 | `audit-ci-02-deployment-alembic-truth.md` — Rewrite the false Alembic section in DEPLOYMENT.md | priority-high |
| 03 | `audit-ci-03-fix-iteration-trigger.md` — Fix the dead `workflows: ["CI"]` name match | priority-high |
| 04 | `audit-ci-04-branch-coverage-gate.md` — Stop the branch-coverage gate swallowing pytest crashes | priority-high |
| 05 | `audit-ci-05-backend-ci-caching.md` — Add pip/uv caching to backend CI jobs | priority-medium |
| 06 | `audit-ci-06-docs-truth-pass.md` — Correct stale claims across README/CLAUDE/scripts/AGENTS/runbook | priority-medium |
| 07 | `audit-ci-07-frontend-cve-triage.md` — Triage the 36 frontend npm advisories | priority-medium |

**Sequencing:** 01 first (supply-chain, blast radius is every Claude run). 03/04 next
(dead controls). 02/06 (docs truth) and 05 (caching) are independent and parallelizable.
07 is independent and can run any time. Every issue traces to a row in §9 of the audit.
