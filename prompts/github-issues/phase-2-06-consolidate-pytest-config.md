# phase-2-06: Consolidate duplicate pytest/coverage configuration

**Labels:** `phase-2`, `backend`, `cleanup`, `priority-medium`
**Epic:** Phase 2 — Decompose the Monolith
**Estimated LoC:** ~30

## Problem

pytest and coverage are configured in **three places** with conflicting settings:

**`pytest.ini`:**
```ini
addopts = --cov=src --cov-report=term-missing --cov-fail-under=90
testpaths = tests
pythonpath = .
```

**`pyproject.toml` [tool.pytest.ini_options]:**
```toml
addopts = "-q --strict-markers --strict-config --cov=backend --cov-report=xml --cov-report=term-missing"
testpaths = ["tests"]
```

**`pyproject.toml` [tool.coverage.run]:**
```toml
source = ["backend"]
```

**`.coveragerc`:**
```ini
[run]
source = backend/src
omit = */__init__.py, */settings.py, */config.py
```

**Conflicts:**
- `pytest.ini` says `--cov=src`, `pyproject.toml` says `--cov=backend` — different source paths
- Both files define `testpaths` and `addopts` — `pytest.ini` takes precedence over `pyproject.toml` (pytest resolution order), so the `pyproject.toml` settings are silently ignored
- `.coveragerc` says `source = backend/src`, `pyproject.toml` says `source = ["backend"]`
- `.coveragerc` omits `*/__init__.py` but `models/__init__.py` contains real import logic

## Scope

Single source of truth: `pyproject.toml`. Delete the other two.

## Tasks

1. **Merge all settings into `pyproject.toml`**
   - Combine `addopts` from both files: `-q --strict-markers --strict-config --cov=src --cov-report=term-missing --cov-fail-under=90 --cov-report=xml`
   - Keep `pythonpath = ["."]` (from pytest.ini)
   - Move `.coveragerc` omit patterns to `[tool.coverage.run]` in pyproject.toml
   - Remove `*/__init__.py` from omit list (it contains real code)

2. **Delete `pytest.ini`**

3. **Delete `.coveragerc`**

4. **Verify**: Run `pytest` and confirm coverage source, omit patterns, and fail-under all work as expected

## Acceptance Criteria

- `pytest.ini` deleted
- `.coveragerc` deleted
- `pyproject.toml` is the sole configuration source
- `pytest` runs correctly with all options applied
- Coverage threshold (90%) still enforced

## Files to Modify/Delete

| File | Action |
|------|--------|
| `backend/pyproject.toml` | Modify (merge all config) |
| `backend/pytest.ini` | **Delete** |
| `backend/.coveragerc` | **Delete** |
