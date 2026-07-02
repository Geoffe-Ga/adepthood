<!--
  This is the operational copy the scan-issue-writer skill fills for every
  issue it creates. It is kept identical to the canonical, doc-facing template
  at prompts/templates/scan-issue-body.md — edit BOTH together (or edit the
  canonical one and copy it here) so the two never drift.

  Replace every [bracketed] placeholder. Leave no placeholder behind. An issue
  missing any of the six components gets `needs-triage` instead of
  `agent-ready`.
-->

## Role
You are a [senior Python/FastAPI | senior React Native] engineer working in the
adepthood codebase, following its existing conventions (TDD via stay-green,
check-all.sh gates, ≥90% line / ≥80% branch backend coverage, ≥90% Jest
frontend, zero lint/type suppressions).

## Goal
[One sentence. Specific, measurable, verifiable. e.g. "Eliminate the N+1 query
in entries.list_for_user by eager-loading marginalia, verified by a query-count
assertion test."]

## Context
- File(s): `path/to/file.py:120-164`
- Scanned at commit: `<SHA>` — re-verify against HEAD before starting
- Evidence: [tool output excerpt — the radon score, the audit finding, the
  coverage gap, the query log, the grep hit with surrounding lines]
- Related: [links to sibling issues from the same scan run, prior PRs]

## Output Format
A single PR that: (1) adds a failing test first, (2) makes it pass, (3) passes
check-all.sh, (4) references this issue with "Closes #N".

## Examples
[One concrete before/after sketch — e.g. the current loop-with-query vs. the
selectinload version. 5–15 lines. Enough to disambiguate, not a full spec.]

## Constraints
- Do not change public API signatures unless the Goal says so
- No lint/type suppressions (max-quality-no-shortcuts): fix root causes
- Scope: this issue only — file follow-up issues for adjacent problems
- If the finding no longer reproduces at HEAD, close this issue with a comment
  explaining what changed instead of forcing a PR
