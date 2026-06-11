# phase-8-10: Toolchain version parity — pin ruff/mypy to one version everywhere

**Labels:** `phase-8`, `tooling`, `dx`, `priority-medium`
**Epic:** Phase 8 — Post-Drain Hardening
**Depends on:** None
**Estimated LoC:** ~100 (config + the lint/type fixes the upgrade surfaces)

## Problem

Three different ruff/mypy versions currently gate the same code:

- `.pre-commit-config.yaml` pins `ruff-pre-commit rev: v0.12.9` and
  `mirrors-mypy rev: v1.17.1`.
- The project venv (what `scripts/backend/{lint,typecheck}.sh` run) has
  **ruff 0.15.16** and **mypy 2.1.0** because `backend/requirements-dev.txt`
  lists both *unpinned*.

The drift already bit during #423: the venv's newer ruff enforced PLC0207
and RUF059, which the pre-commit hook silently didn't — local Gate 2 and
the commit hook disagreed about whether the tree was clean. Every future
ruff/mypy release widens the gap.

## Scope

One version per tool, asserted everywhere: pin `requirements-dev.txt`,
bump the pre-commit revs to match, fix whatever the newer hook versions
flag, and add a guard that fails fast on future drift.

## Tasks

1. **Pin and align**
   - `backend/requirements-dev.txt`: `ruff==<chosen>` and `mypy==<chosen>`
     (current venv versions are the natural choice — newest rules already
     satisfied locally).
   - `.pre-commit-config.yaml`: bump `ruff-pre-commit` and `mirrors-mypy`
     revs to the same versions; keep the mypy hook's
     `additional_dependencies` in sync with requirements-dev's stub list.

2. **Absorb new findings**
   - Run `pre-commit run --all-files` and the backend scripts; fix any
     findings the bumped hook versions surface (no suppressions — same
     anti-bypass rules as always).

3. **Drift guard**
   - Add a small check (a pytest in `backend/tests/scripts/` or a
     pre-commit `language: system` hook) that parses
     `.pre-commit-config.yaml` revs and `requirements-dev.txt` pins and
     fails with a clear message when they diverge.

## Acceptance Criteria

- `ruff --version` in the venv equals the pre-commit hook's pinned rev;
  same for mypy.
- The drift guard fails when either side is bumped alone (demonstrated in
  its test).
- `pre-commit run --all-files` and `./scripts/backend/check-all.sh` both
  green on a clean tree.
- No existing tests break.

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/requirements-dev.txt` | Modify (pins) |
| `.pre-commit-config.yaml` | Modify (revs) |
| `backend/tests/scripts/test_toolchain_parity.py` | **Create** |
| Any files the bumped linters flag | Modify |
