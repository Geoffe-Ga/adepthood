# Ralph Label Quick Reference

Source of truth for how the picker (`scripts/ralph/pick-next.sh`) interprets
labels. Always run `gh label list` first and reuse an existing label — only
create a new one if nothing fits. There's no bulk label-listing MCP tool; if
`gh` isn't available, use `mcp__github__get_label` to check a specific
candidate name (`mcp__github__list_issue_types` is GitHub's separate "Issue
Types" feature, not labels — it won't help here).

## Type

- `bug` — behavior contradicts spec/expectation
- `feature` — net-new capability or enhancement to existing behavior

## Priority (either vocabulary is honored — prefer the short form)

| Short | Long form | Tier | Use for |
|-------|-----------|------|---------|
| `P0`  | `priority-critical` | 0 | Crash, data loss, security hole, broken auth, prod-down |
| `P1`  | `priority-high`     | 1 | Core user flow broken, no workaround |
| `P2`  | `priority-medium`   | 2 | Degraded behavior with a workaround; well-scoped feature |
| `P3`  | `priority-low`      | 3 | Cosmetic, minor, nice-to-have |

An issue with no priority label defaults to tier 1 (P1) in the picker — so
always apply one explicitly rather than relying on the default.

## Readiness

- `agent-ready` — every template section (`references/report-template.md`)
  is filled with real content; the picker can hand this straight to a Ralph
  worker.
- `needs-spec` — something is missing (reproduction failed, ambiguous scope,
  unverifiable claim). Apply this, not `needs-triage`, when the issue must
  not be auto-picked: `needs-spec` is the label `pick-next.sh`'s default
  `RALPH_EXCLUDE_LABELS` actually excludes. A human or a grooming pass
  finishes it, then relabels `agent-ready`.
- `needs-triage` — informational only. It is NOT in the picker's default
  exclude set, so an issue carrying `needs-triage` alone (without
  `needs-spec`) remains pickable by default. Don't rely on it to keep an
  incomplete issue out of the fleet.

## Decomposition

- `epic:<slug>` — applied to an epic issue and every one of its sub-issues.
  The picker's same-epic guard prevents two sub-issues of the same epic from
  running in parallel unless also labeled `parallelizable`. Epics themselves
  should NOT carry `agent-ready` — they aren't directly implementable; the
  picker isn't meant to pick them (exclude via not tagging `agent-ready`, or
  add `epic` to `RALPH_EXCLUDE_LABELS` if the repo's picker config requires
  it).
- `parallelizable` — overrides the same-epic guard; only apply when repo
  research (Step 2 in SKILL.md) confirms the sub-issues don't touch
  overlapping files, tables, or migrations.

## Coordination

- `solo` — issue must run alone, never alongside any other active worker.
  Use sparingly: migrations, shared-config changes, anything where parallel
  writes would conflict.
- `in-progress` — set by the fleet when work starts; `flare` should never
  apply this manually.

## Labels flare should never apply

`wontfix`, `duplicate`, `invalid`, `question`, `blocked`, `future-work`,
`do-not-auto-merge` — these are triage/lifecycle labels applied by humans or
the backlog-grooming skill after the fact, not at filing time.
