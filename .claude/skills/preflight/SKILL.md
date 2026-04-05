# Preflight

Run the full pre-commit suite, diagnose every failure, fix the root causes, and
iterate until all hooks pass green. This is the "make it clean" skill — invoke
it before committing, before opening a PR, or anytime you want confidence that
the codebase is healthy.

---

## Trigger

Activate when the user says any of:
- "preflight"
- "run pre-commit"
- "fix lint"
- "make it green"
- "clean up"

---

## Instructions

### 1. Activate the Environment

```bash
source .venv/bin/activate
```

This is non-negotiable. Many hooks (mypy, pytest, bandit) resolve imports from
the venv's site-packages. Running pre-commit without the venv active will
produce false failures.

### 2. Run the Full Suite

```bash
pre-commit run --all-files 2>&1
```

Capture the full output. Parse it to identify which hooks passed and which
failed.

### 3. Triage Failures

For each failing hook, categorize the failure:

| Category | Example | Action |
|----------|---------|--------|
| Auto-fixable | black, isort, prettier reformatted files | Stage the changes, re-run |
| Code error | ruff lint violation, mypy type error | Fix the code, re-run the hook |
| Test failure | pytest assertion error, jest failure | Fix the test or the code under test |
| Config issue | hook can't find a file, wrong Python version | Fix the config, re-run |
| False positive | detect-secrets flagging a test fixture | Update `.secrets.baseline`, never suppress real findings |

### 4. Fix in Priority Order

Fix failures in this order to avoid cascading issues:

1. **Formatting** (black, isort, prettier) — auto-fixers may resolve other issues
2. **Imports** (ruff, isort) — unused imports cause downstream lint noise
3. **Lint** (ruff, eslint) — fix code quality issues
4. **Types** (mypy, tsc) — fix type errors after code changes are stable
5. **Security** (bandit, pip-audit, detect-secrets) — address real findings
6. **Tests** (pytest, jest) — fix after all code changes are done
7. **Coverage** (pytest-cov) — add tests if below 90% threshold

### 5. Iterate

After fixing a batch of issues, re-run the full suite:

```bash
pre-commit run --all-files 2>&1
```

Repeat until every hook passes. If a fix for one hook breaks another, resolve
the conflict — do not oscillate between fixes.

### 6. Specific Hook Commands

For targeted re-runs during iteration:

```bash
# Python
pre-commit run black --all-files
pre-commit run ruff --all-files
pre-commit run mypy --all-files
pre-commit run isort --all-files
pre-commit run bandit --all-files

# Frontend
pre-commit run frontend-eslint --all-files
pre-commit run frontend-prettier --all-files
pre-commit run frontend-typecheck --all-files
pre-commit run frontend-tests --all-files

# Tests + coverage
pre-commit run backend-tests-coverage --all-files
```

### 7. Report Results

When all hooks pass, tell the user:

> "Preflight complete. All hooks pass green. [N] files were modified by
> auto-formatters. [Summary of manual fixes if any]. Ready to commit."

If you cannot resolve a failure after 3 attempts, explain the issue and ask the
user for guidance rather than applying a workaround.

---

## Rules

- **Never** add `# noqa`, `# type: ignore`, `// @ts-ignore`, or
  `// eslint-disable` to silence legitimate errors
- **Never** modify `.pre-commit-config.yaml` to weaken or skip hooks
- **Never** reduce coverage thresholds
- **Never** comment out failing tests
- Auto-formatter changes (black, prettier, isort) are always correct — stage
  them without question
- If ruff `--fix` auto-fixes something, verify the fix is correct before
  staging
- If detect-secrets flags something, check if it's a real secret before
  updating the baseline

---

## Pre-commit Hook Reference

The project's `.pre-commit-config.yaml` runs these hooks:

**General:** check-ast, check-yaml, check-toml, check-json, detect-private-key,
end-of-file-fixer, mixed-line-ending, trailing-whitespace, check-added-large-files

**Python:** black, ruff, ruff-format, mypy (strict), isort, bandit, pip-audit,
detect-secrets

**Frontend:** eslint, prettier (write), tsc --noEmit, jest

**Cross-cutting:** backend-tests-coverage (90% minimum), commitlint
(conventional commits, commit-msg stage)
