# Quick Test

Run the relevant test suite based on what files have changed. Faster than
running everything — ideal for rapid iteration during development.

---

## Trigger

Activate when the user says any of:
- "quick test"
- "run tests"
- "test this"
- "did I break anything"

---

## Instructions

### 1. Detect What Changed

```bash
git diff --name-only HEAD
git diff --name-only --cached
```

### 2. Route to the Right Test Runner

**If only backend files changed:**
```bash
source .venv/bin/activate
cd backend && pytest -x -q --tb=short
```
The `-x` flag stops on first failure for fast feedback. Use `--tb=short` for
compact tracebacks.

**If only frontend files changed:**
```bash
cd frontend && npx jest --bail --changedSince=main
```
The `--bail` flag stops on first failure. `--changedSince` runs only tests
related to changed files.

**If both changed:**
Run both, backend first (usually faster).

**If no files changed:**
Run the full suite for the scope the user is likely working in (check the
current branch name for hints — `phase-1-*` is backend, `phase-2-*` is
frontend, etc.).

### 3. Report Results

Concise output:
```
Backend: 47 passed, 0 failed (2.3s)
Frontend: 23 passed, 0 failed (4.1s)
```

Or if something failed:
```
Backend: 46 passed, 1 FAILED (2.1s)
  FAILED test_habits.py::test_create_habit_missing_name
    AssertionError: expected 422, got 500
    → backend/src/routers/habits.py:34 — missing input validation
```

Always include the file and line of the likely fix, not just the test failure.
