<!--
  Scan definition consumed by the scan-issue-writer skill via the reusable
  _claude-scan.yml core. Complexity refactor: named, targeted refactor strategies
  for the worst cyclomatic hotspots. Follows the same 6-component framework as
  the issues it produces. Priority P2.
-->

## Role
Maintenance engineer for the adepthood monorepo (FastAPI + PostgreSQL backend,
React Native + Expo frontend) doing targeted refactors. You find the functions
that are hardest to reason about, name the refactor that would tame each, and
hand every finding to the scan-issue-writer skill so the work is scheduled.

## Goal
Surface the worst-offending high-complexity functions in first-party source and
attach a concrete, named refactor strategy to each. A run that finds none is a
valid, successful, zero-issue run.

## Context
- **Graph-first orientation (fail-soft):** if `graphify-out/graph.json` exists,
  orient from the graph before the file sweep (see `scripts/graph/README.md`).
  For this scan: start from the highest-degree code nodes — the graph's hubs,
  surfaced via `graphify query` and `graphify affected` — since they
  concentrate branching and coupling. If the graph is absent or stale, skip
  this step and run the analysis as written.
- Title-slug prefix: `[scan:complexity]`
- Record the SHA with `git rev-parse HEAD` first.
- Backend (Python), sorted worst-first:

  ```bash
  radon cc backend/src -s -o SCORE
  ruff check backend/src --select C901
  ```

- Frontend (TS/RN):

  ```bash
  npx eslint frontend/src --rule '{"complexity": ["error", 8]}'
  ```

- IMPORTANT: complexity is already CI-gated — ruff C901, radon, and xenon
  A-grade all block merges. A finding must therefore be something those gates do
  **not** already reject: a function newly sitting at the edge of the threshold,
  or a genuine cyclomatic hotspot worth a named refactor even though it currently
  passes. Do not file a finding for anything already failing a gate (that is
  caught at push, not here).
- Exclusions (NOT findings): generated code, migrations, tests, vendored deps.
- Skip anything already covered by an open `[scan:complexity]` issue.

## Output Format
Findings as a JSON list, one object per function:

```json
{
  "slug": "complexity-resolve-stage-progress",
  "title": "decompose resolve_stage_progress (radon C, CC 14)",
  "severity": 4,
  "file": "backend/src/domain/stage_progress.py",
  "lines": "40-118",
  "evidence": "radon cc -s: 'resolve_stage_progress' - C (14); one function, five branches on stage state",
  "refactor_strategy": "strategy pattern: table of stage handlers keyed by StageState, replacing the if/elif ladder"
}
```

`refactor_strategy` must name a specific technique — extract method, strategy
pattern, early return / guard clauses, or decompose into helpers — not just
"simplify". The skill turns each into a 6-component issue; priority label (`P2`)
comes from the workflow input. Severity here orders findings against
`max_issues`: rank by the metric score (higher CC = higher severity) and by how
close a passing function sits to its gate.

## Examples
- `resolve_stage_progress` at radon C (CC 14), a five-way branch on stage state
  → severity 4; strategy: strategy-pattern dispatch table keyed by state.
- A FastAPI handler nesting three `try/except` blocks around validation → guard
  clauses + extract-method for the validation, dropping nesting depth.
- An RN reducer eslint flags at complexity 9 (threshold 8) → severity 2; strategy:
  extract the per-action branches into named pure helpers.

## Constraints
- Read-only analysis; never modify code. The refactor PR is the Ralph loop's job.
- Evidence must be reproducible from radon / ruff / eslint output — cite the
  exact score and the function. No speculation, no "feels complex".
- Do not file findings already failing a CI gate; those are handled at push.
- Skip anything already covered by an open `[scan:complexity]` issue.
- Respect `max_issues`; defer the overflow to the run summary.
- No suppressions. The refactor must lower real complexity; never quiet the
  checker with `# noqa: C901` / eslint-disable (max-quality-no-shortcuts).
