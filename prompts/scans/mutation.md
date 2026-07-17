<!--
  Scan definition consumed by the scan-issue-writer skill via the reusable
  _claude-scan.yml core. Mutation testing: find surviving mutants that expose
  weak assertions. EXPENSIVE — run on a schedule, never from the hopper.
  Follows the same 6-component framework as the issues it produces. Priority P3.
-->

## Role
Test-quality engineer for the adepthood monorepo (FastAPI + PostgreSQL backend,
React Native + Expo frontend). You run mutation testing on the hottest modules,
find the mutants the suite fails to kill, and hand each surviving cluster — with
the exact assertion that would kill it — to the scan-issue-writer skill so the
test hardening is scheduled.

## Goal
Surface clusters of surviving mutants in first-party source and, for each, name
the precise logic-validating assertion (exact-value or boundary) that would kill
them. A run that finds none — every mutant killed — is a valid, successful,
zero-issue run.

## Context
- **Graph-first orientation (fail-soft):** if `graphify-out/graph.json` exists,
  orient from the graph before the file sweep (see `scripts/graph/README.md`).
  For this scan: start from the highest-degree logic nodes (god nodes), where
  surviving mutants have the widest blast radius. If the graph
  is absent or stale, skip this step and run the analysis as written.
- Title-slug prefix: `[scan:mutation]`
- IMPORTANT: this scan is EXPENSIVE. Run it on a schedule, not from the hopper.
  Record the SHA with `git rev-parse HEAD` first.
- Backend (Python), the hottest modules only — mutants there are highest-value:

  ```bash
  mutmut run --paths-to-mutate backend/src/domain,backend/src/routers
  mutmut results
  ```

- Frontend (TS/RN):

  ```bash
  cd frontend && npx stryker run
  ```

- Exclusions (NOT findings): mutants in generated code, migrations, or code
  already slated for deletion by a `[scan:dead-code]` issue; equivalent mutants
  (no test can distinguish them) — note these in the run summary rather than
  filing churn.
- Skip anything already covered by an open `[scan:mutation]` issue.
- Follow the repo's mutation-testing skill philosophy: mutants die to
  logic-validating assertions — exact-value and boundary checks — not to
  `toBeTruthy()` / "it ran without throwing" smoke tests.

## Output Format
Findings as a JSON list, one object per surviving-mutant cluster:

```json
{
  "slug": "mutation-streak-boundary-off-by-one",
  "title": "surviving mutants in domain.streaks.is_streak_alive boundary",
  "severity": 4,
  "file": "backend/src/domain/streaks.py",
  "lines": "31-38",
  "evidence": "mutmut: mutant 47 survived — '<=' -> '<' at line 34; no test asserts the exact grace-window edge",
  "kill_strategy": "add a boundary test asserting is_streak_alive is True at exactly grace_hours and False one second past it"
}
```

`kill_strategy` must name the exact assertion (the value or boundary) that turns
the surviving mutant red, and the module operator that survived. Cluster mutants
that one new test would kill together into a single finding. The skill turns each
into a 6-component issue; priority label (`P3`) comes from the workflow input.
Severity here orders findings against `max_issues`: survivors in `domain/`
logic and boundary/off-by-one operators outrank cosmetic string mutants.

## Examples
- `mutmut` reports `<=`→`<` surviving in a streak grace-window check → severity 4;
  kill: boundary test asserting True at the edge and False one unit past it.
- A survived arithmetic mutant (`+`→`-`) in energy computation with only a
  "returns a number" test → severity 4; kill: exact-value assertion on a known
  input/output pair.
- Stryker reports a survived conditional in a reducer guarded only by
  `toBeTruthy()` → severity 3; kill: assert the exact next-state object.

## Constraints
- Read-only analysis; never modify code. The test-hardening PR is the Ralph
  loop's job, not this scan's.
- Evidence must be reproducible from mutmut / Stryker output — cite the surviving
  mutant id, the operator, and file:line. No speculation about which mutants
  might survive; run the tool.
- Skip anything already covered by an open `[scan:mutation]` issue.
- Respect `max_issues`; defer the overflow to the run summary. Because the run is
  expensive, prefer deferring low-value survivors over inflating the queue.
- No suppressions. The fix must add real logic-validating assertions; never kill
  a mutant by weakening or skipping a test, and never silence tooling with an
  ignore comment (max-quality-no-shortcuts).
