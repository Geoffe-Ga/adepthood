---
name: bug-squashing-methodology
description: >-
  Structured 5-step bug fix process with root cause analysis and TDD.
  Use when fixing bugs, debugging failures, or investigating defects.
  Covers RCA documentation, reproduction, TDD fix cycle, and PR workflow.
metadata:
  author: Geoff
  version: 1.0.0
---

# Bug Squashing Methodology

Systematic process for fixing bugs: Document, Understand, Fix, Verify. Never skip straight to coding.

## Instructions

### Step 1: Root Cause Analysis (RCA)

Before writing any fix, understand what's actually broken. Create an RCA with:
- **Problem Statement**: Exact error message, reproduction steps, which test/endpoint fails
- **Root Cause**: Exact file, line, and logic causing the failure
- **Analysis**: Why it happens — trace the data flow, check schema mismatches, verify mocks
- **Impact**: What's broken, what depends on it, is it blocking other work?
- **Contributing Factors**: Why wasn't it caught? Missing test? Schema drift?
- **Fix Strategy**: Options with recommended approach

### Step 2: Reproduce First

```bash
# Backend: run the specific failing test
source .venv/bin/activate
cd backend && pytest tests/test_file.py::test_name -x -v

# Frontend: run the specific failing test
cd frontend && npx jest __tests__/file.test.tsx -t "test name"
```

If the test doesn't exist yet, write one that reproduces the bug before fixing anything.

**For 422/validation errors**: Always capture the response body:
```python
resp = await async_client.post("/endpoint", json=payload)
if resp.status_code != expected:
    print(f"Status: {resp.status_code}, Body: {resp.json()}")
```

**For mock-related failures**: Check that:
- Fixtures override the right dependencies
- Test DB session is properly injected
- Rate limiter is reset between tests
- Schema changes are reflected in test payloads

### Step 3: TDD Fix Cycle

1. **Red**: Write/update a test that reproduces the bug (confirm it fails)
2. **Green**: Write the minimal fix (test passes)
3. **Refactor**: Clean up while keeping tests green

### Step 4: Quality Gates

```bash
# Backend
source .venv/bin/activate
cd backend && pytest --cov=. --cov-report=term-missing --cov-fail-under=90

# Frontend
cd frontend && npm test -- --watchAll=false

# All hooks
pre-commit run --all-files
```

### Step 5: Commit and PR

Use conventional commit: `fix(component): brief description`

Include in commit body:
- What was broken and why (reference RCA)
- What the fix does
- Confirmation that both quality gates pass

## Troubleshooting

### Error: Can't reproduce locally
- Check if test fixtures properly override dependencies (get_session, rate limiter)
- Verify test database is SQLite in-memory (conftest.py)
- Check for environment-dependent behavior (timezone, locale)

### Error: Fix breaks other tests
- Run full suite, not just the failing test
- Check if other tests depended on buggy behavior
- Look for shared mutable state between tests

### Error: 422 from FastAPI endpoint in tests
- Capture `resp.json()` to see Pydantic validation details
- Compare test payload against the current Pydantic model
- Check if schema fields were added/renamed/required since the test was written
- Verify Content-Type header is correct (json= vs data=)
