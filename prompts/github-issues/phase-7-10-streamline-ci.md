# Phase 6-10: Streamline Pre-Commit and CI

## Problem

1. **Redundant Python formatters**: Black + ruff --fix + ruff-format all run in pre-commit. They can produce conflicting output.

2. **Expensive hooks on pre-commit**: Full backend test suite with coverage + xenon complexity + radon maintainability run on every `git commit`. This takes 30-60 seconds, encouraging developers to skip hooks.

3. **npm cache key uses wrong file**: `frontend-ci.yml:26-27` caches on `package.json` instead of `package-lock.json`, causing cache misses.

4. **commitlint --cwd is wrong**: `.pre-commit-config.yaml:132` specifies `--cwd frontend` but commit messages are at repo root.

5. **bash -lc is fragile**: Pre-commit frontend hooks use `bash -lc` which sources `.bashrc` — fails in CI environments without shell profiles.

## Fix

### 1. Choose One Python Formatter
Remove black. Use ruff-format (modern, faster, single-tool ecosystem):

```yaml
# Remove:
- repo: https://github.com/psf/black
# Keep:
- repo: https://github.com/astral-sh/ruff-pre-commit
  hooks:
    - id: ruff
      args: [--fix]
    - id: ruff-format
```

### 2. Move Expensive Hooks to Pre-Push
```yaml
- id: backend-tests-coverage
  stages: [pre-push]  # was: [pre-commit, pre-push]

- id: xenon-complexity
  stages: [pre-push]

- id: radon-maintainability
  stages: [pre-push]
```

### 3. Fix CI Cache Key
```yaml
cache-dependency-path: "frontend/package-lock.json"  # was: package.json
```

### 4. Fix commitlint
```yaml
entry: bash -c 'cd frontend && npx commitlint --extends @commitlint/config-conventional --edit "$1"'
# Remove: --cwd frontend (commit messages are at repo root)
```

### 5. Remove -l from bash Invocations
```yaml
entry: bash -c 'cd frontend && npm run lint'  # was: bash -lc
```

## Acceptance Criteria

- [ ] Pre-commit runs in <10 seconds (formatting + linting only)
- [ ] Pre-push runs full test suite + complexity checks
- [ ] No conflicting formatters
- [ ] CI cache hit rate improves (verify in Actions logs)
- [ ] commitlint validates commit messages correctly
- [ ] All hooks work in both local and CI environments

## Estimated Scope
~100 LoC (config changes only)
