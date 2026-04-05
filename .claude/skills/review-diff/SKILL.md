# Review Diff

Perform a thorough self-review of the current branch's changes before opening a
PR. Catch issues that automated tools miss: logic errors, missing edge cases,
architectural misalignment, unclear naming, and incomplete implementations.

---

## Trigger

Activate when the user says any of:
- "review diff"
- "review my changes"
- "self review"
- "check my work"
- "am I ready for PR"

---

## Instructions

### 1. Gather the Diff

```bash
# What branch are we on?
git branch --show-current

# What's the full diff against main?
git diff main...HEAD

# What commits are included?
git log main..HEAD --oneline

# Any uncommitted changes?
git status
git diff
```

### 2. Read the Issue Specification

Identify which issue this branch implements from the branch name (e.g.,
`phase-1-03-auth-router-to-db`). Read the corresponding issue file:

```
prompts/github-issues/phase-X-NN-slug.md
```

Load the acceptance criteria. These are your review checklist.

### 3. Review Dimensions

Evaluate the diff across each of these dimensions. For each finding, note the
file, line number, and specific concern.

#### Correctness
- Does the code actually do what the issue asks for?
- Are there off-by-one errors, wrong comparisons, inverted conditions?
- Are error cases handled? What happens on empty input, None, 0, negative?
- Are async operations properly awaited?
- Are database transactions properly committed/rolled back?

#### Completeness
- Is every acceptance criterion addressed?
- Are there tasks in the issue that were skipped or partially done?
- Are there new code paths missing test coverage?
- If a new endpoint was added, is it mounted in `main.py`?
- If a new model was added, is it imported in `models/__init__.py`?

#### Types and Contracts
- Are function signatures fully typed (no implicit `Any`)?
- Do Pydantic schemas match the actual API contract?
- Are frontend TypeScript types aligned with backend response shapes?
- Are Optional fields handled correctly (not assumed to be present)?

#### Naming and Clarity
- Do variable and function names accurately describe their purpose?
- Would a new team member understand this code without explanation?
- Are there abbreviations or acronyms that should be spelled out?
- Are boolean variables named as questions (`is_active`, `has_completed`)?

#### Patterns and Consistency
- Does new code follow existing patterns in the codebase?
- Are imports organized the same way as neighboring files?
- Are error responses consistent with existing endpoint conventions?
- Is the test structure consistent with existing tests?

#### Security
- Is user input validated at the boundary?
- Are SQL queries parameterized (SQLModel handles this, but check raw queries)?
- Are JWT tokens validated correctly?
- Is authorization checked (not just authentication)?
- Are secrets kept out of code and test fixtures?

#### Performance
- Are there N+1 query patterns in new database code?
- Are list endpoints paginated?
- Are there unnecessary database round-trips?
- Are React components re-rendering more than necessary?

### 4. Check Test Quality

Read every new or modified test. For each test, verify:

- It tests behavior, not implementation details
- It would fail if the feature broke (not a tautology)
- Edge cases are covered (empty, null, boundary values, error states)
- Test names clearly describe what they verify
- Test data is minimal and purposeful (no copy-pasted blobs)

### 5. Verify Pre-commit Status

```bash
source .venv/bin/activate
pre-commit run --all-files
```

If it fails, invoke the `/preflight` skill to fix before continuing the review.

### 6. Present the Review

Structure your findings as:

#### Summary
One paragraph on the overall quality and completeness of the changes.

#### Acceptance Criteria Checklist
```
- [x] Criterion 1 — met (file:line)
- [x] Criterion 2 — met (file:line)
- [ ] Criterion 3 — NOT met, because...
```

#### Findings (if any)
Group by severity:

**Must fix** — Issues that would block a PR:
- Correctness bugs, missing acceptance criteria, security issues

**Should fix** — Issues worth addressing before merge:
- Missing edge case tests, unclear naming, minor type issues

**Consider** — Suggestions for improvement, not blockers:
- Style preferences, alternative approaches, future considerations

#### Verdict
One of:
- **Ready for PR** — all criteria met, no must-fix issues
- **Almost ready** — minor fixes needed, list them
- **Needs more work** — significant gaps, describe what's missing

---

## Rules

- Be honest. The point of self-review is to catch problems, not to rubber-stamp.
- Reference specific files and line numbers for every finding.
- If you find a bug, fix it — don't just report it.
- If the verdict is "Ready for PR," say so with confidence.
