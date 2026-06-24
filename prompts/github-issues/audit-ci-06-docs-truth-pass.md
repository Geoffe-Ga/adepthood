# audit-ci-06: Correct stale claims across README / CLAUDE / scripts / AGENTS / runbook

**Labels:** `audit-ci`, `ci`, `docs`, `priority-medium`
**Epic:** CI, Infra & Docs Truth
**Estimated LoC:** ~30  (hard cap 700)

## Problem

Several docs assert facts that no longer match the codebase, eroding trust in the rest
of the documentation: `README.md:39-40` claims Node `v18+` / Python `3.10+` while CI
runs Node 20 and Python 3.11/3.12/3.13 (`backend-ci.yml` matrix); `CLAUDE.md`'s
architecture block says `models/` holds "14 SQLModel ORM classes" when there are 23
(`backend/src/models/` has 24 `.py` files including `__init__.py`); `scripts/README.md:16`
documents `format.sh` as "black + isort" though the repo standardised on ruff-format
(per `phase-7-10-streamline-ci.md`); `AGENTS.md:6` instructs `bash /scripts/dev-setup.sh`
with a leading-slash absolute path that doesn't resolve (should be repo-relative,
matching `README.md:36`); and `RECOVERY-RUNBOOK.md:167` uses `select(User)` in its REPL
snippet without importing `select`, so the documented recovery path raises `NameError`.

**Current state:** docs drift. Medium per audit §9 (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:149,153`).

## Scope

**Covers:** Correcting each specific stale claim listed below against the live tree.

**Does NOT:** Rewrite the Alembic section of `DEPLOYMENT.md` (that is `audit-ci-02`).
Does not restructure any doc or change behaviour — verify-then-correct only.

## Tasks

1. **README versions** — `README.md:39-40`: update Node to the version CI uses (read it from `frontend-ci.yml` / `setup-node`) and Python to `3.11+` (cross-check the `backend-ci.yml` matrix `["3.11", "3.13"]` plus the `3.12` quality job). State the real supported range, not a guess.
2. **CLAUDE.md model count** — `CLAUDE.md` architecture block: change "14 SQLModel ORM classes" to the real count. Confirm by counting `backend/src/models/*.py` excluding `__init__.py` (23 at audit time) rather than trusting this issue's number.
3. **scripts/README.md formatter** — `scripts/README.md:16`: change `format.sh  # black + isort` to reflect ruff-format. Verify against the actual `scripts/backend/format.sh` contents before writing the new description.
4. **AGENTS.md setup path** — `AGENTS.md:6`: change `bash /scripts/dev-setup.sh` to the repo-relative `bash scripts/dev-setup.sh` (matching `README.md:36`).
5. **RECOVERY-RUNBOOK REPL import** — `RECOVERY-RUNBOOK.md` (snippet at line ~157-171): add `from sqlalchemy import select` (or the import path the codebase actually uses for `select`) so the snippet runs without `NameError`. Verify the correct import source from the backend code.

## Acceptance Criteria

- [ ] `README.md` Node/Python versions match the versions CI actually runs.
- [ ] `CLAUDE.md` states the real model count (verified by counting `backend/src/models/*.py` minus `__init__.py`).
- [ ] `scripts/README.md` describes `format.sh` as ruff-format, matching the real script.
- [ ] `AGENTS.md` setup command is repo-relative and runnable from the repo root.
- [ ] The `RECOVERY-RUNBOOK.md` REPL snippet imports `select` and would execute without `NameError`.
- [ ] No existing tests break; coverage ≥ 90% where applicable.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `README.md` | Modify (Node/Python versions, ~line 39-40) |
| `CLAUDE.md` | Modify (model count in architecture block) |
| `scripts/README.md` | Modify (format.sh description, line 16) |
| `AGENTS.md` | Modify (dev-setup path, line 6) |
| `RECOVERY-RUNBOOK.md` | Modify (add `select` import to REPL snippet) |
