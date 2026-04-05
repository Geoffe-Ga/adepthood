# Triage and Plan

Perform a deep analysis of the Adepthood codebase and generate a structured epic
of GitHub-style issue files in `prompts/github-issues/`, ready to be worked
through with `/continue-epic`.

---

## Trigger

Activate when the user says any of:
- "triage"
- "plan the next epic"
- "what needs work"
- "build out the next set of issues"
- "analyze the codebase"

---

## Instructions

### 1. Understand What Exists

Before proposing new work, understand what's already been built and what's been
planned.

#### Read the current roadmap
```
prompts/github-issues/README.md
prompts/github-issues/phase-*-epic.md
```

#### Read the project spec and philosophy
```
CLAUDE.md
AGENTS.md
```

#### Survey the git history
```bash
git log --oneline -60
git branch -a
```

Identify: which issues have been completed, which are in progress, which phases
are done.

### 2. Deep Codebase Analysis

Perform a systematic audit across multiple dimensions. For each dimension,
take notes on specific files, line numbers, and concrete observations.

#### Architectural Health
- Are there circular dependencies between modules?
- Are concerns properly separated (routing vs. business logic vs. data access)?
- Are there god objects or god functions that do too much?
- Is the data flow clear and traceable from request to response?

#### Code Quality
- Dead code: unused imports, unreachable branches, commented-out blocks
- Duplication: copy-pasted logic that should be extracted
- Naming: inconsistent or misleading names
- Complexity: functions with too many branches, deep nesting
- Magic numbers: hardcoded values without explanation

#### Type Safety
- Python: mypy strictness violations, `Any` types, missing annotations
- TypeScript: `@ts-ignore` comments, `any` types, loose type assertions
- Schema mismatches between frontend types and backend response shapes

#### Test Coverage and Quality
- Run coverage reports and identify gaps
- Check for tests that don't assert meaningful behavior
- Look for missing edge case coverage
- Verify integration test coverage for critical paths

#### Security
- Authentication/authorization gaps
- Input validation missing at system boundaries
- Hardcoded secrets or credentials
- CORS configuration issues
- SQL injection or XSS vectors

#### Performance
- N+1 query patterns
- Missing database indexes
- Unnecessary re-renders in React components
- Large bundle size contributors
- Missing pagination on list endpoints

#### Developer Experience
- Missing or outdated documentation
- Confusing error messages
- Gaps in the development toolchain
- CI/CD pipeline improvements needed

### 3. Prioritize Findings

Group findings into priority tiers:

| Priority | Criteria |
|----------|----------|
| Critical | Blocks users, causes data loss, security vulnerability |
| High     | Significant UX degradation, architectural debt, test gaps |
| Medium   | Code quality, missing features from spec, DX improvements |
| Lower    | Polish, documentation, nice-to-haves |

### 4. Generate the Epic

Create a new phase directory structure following the established pattern.

#### Create the README update

Add a new phase section to `prompts/github-issues/README.md` with:
- Phase table (issue number, title, scope, estimated LoC)
- Dependency graph showing issue ordering
- Updated total scope counts

#### Create individual issue files

Each issue file must follow the established format exactly:

```markdown
# phase-N-NN: [Concise imperative title]

**Labels:** `phase-N`, `[scope]`, `[category]`, `priority-[level]`
**Epic:** Phase N — [Epic Title]
**Estimated LoC:** ~NNN

## Problem

[2-3 sentences describing what's wrong or missing. Reference specific files
and line numbers. Include "Current state:" with concrete observations.]

## Scope

[1-2 sentences bounding what this issue covers and what it doesn't.]

## Tasks

1. **[Task title]**
   - [Specific, actionable subtask]
   - [Another subtask with file paths]

2. **[Task title]**
   - [...]

## Acceptance Criteria

- [Testable, binary criterion]
- [Another criterion]
- No existing tests break

## Files to Create/Modify

| File | Action |
|------|--------|
| `path/to/file.py` | **Create** or Modify |
```

#### Issue sizing rules

- Target ~200-300 LoC of changes per issue (net, including deletions)
- Each issue should be completable in a single focused session
- Issues must be atomic: they either ship completely or not at all
- No issue should require more than ~5 files to change

#### Dependency ordering

- Issues within a phase should have a clear dependency ordering
- Draw the dependency graph in the README
- Earlier issues should unblock later ones
- Independent issues can be worked in parallel

### 5. Validate the Plan

Before presenting to the user:

- [ ] Every issue references specific files and line numbers
- [ ] Estimated LoC is realistic (not aspirational)
- [ ] Dependency graph has no cycles
- [ ] No issue is too large (>400 LoC) or too small (<50 LoC)
- [ ] Acceptance criteria are testable, not vague
- [ ] The plan addresses the highest-priority findings first
- [ ] Each issue file follows the exact format of existing issues

### 6. Present to the User

Summarize the epic with:
- How many issues, total estimated LoC
- The top 3-5 most impactful changes
- Any decisions that need user input (e.g., "should we migrate to X?")
- Recommended order of execution

---

## Output Location

All generated files go in `prompts/github-issues/`:
- Update `README.md` with the new phase
- Create `phase-N-epic.md` for the epic overview
- Create `phase-N-NN-slug.md` for each issue

---

## Quality Bar

The issue files you generate will be consumed by `/continue-epic`, which
expects precise, actionable specifications. Vague issues produce vague code.
Every issue should be specific enough that a skilled developer could implement
it without asking a single clarifying question.
