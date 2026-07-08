# Decomposing an Oversized Ask into an Epic

Trigger: Step 3 in SKILL.md estimates the request exceeds ~300 LoC, or spans
more than one clearly separable concern (e.g. new DB model + API endpoint +
two frontend screens). This mirrors the sizing convention already used across
`prompts/github-issues/` (each phase issue is atomized to ~100–350 LoC).

## Process

1. **Identify the seams.** From Step 2's repo research, split along natural
   architectural boundaries — backend model/migration, backend router,
   frontend hook/state, frontend screen, navigation wiring. Each sub-issue
   should be independently completable and independently testable.

2. **Write the epic issue first.** Title: `epic: <capability name>`. Body:
   the overall Goal and Context (why this matters, what the finished feature
   looks like end-to-end), plus a checklist linking each sub-issue once
   created. No `agent-ready` label — an epic isn't a directly implementable
   unit of work, it's a tracking/coordination issue. It must also carry the
   bare `epic` label (not just `epic:<slug>` — see step 5): that's the
   literal token `pick-next.sh`'s default exclude list matches, and its
   label filtering is exact-match, not prefix-match.

3. **Write each sub-issue** using the full `report-template.md` (Role /
   Goal / Context / Output Format / Examples / Constraints), scoped to one
   seam. Each must be independently `agent-ready` — a Ralph worker picking
   it up should never need to read the epic or a sibling sub-issue to
   understand what to do.

4. **Order dependencies explicitly.** If sub-issue B needs sub-issue A's
   migration to exist first, say so in B's Context ("Depends on #<A>; do not
   start until merged") rather than relying on label ordering alone — the
   picker's epic guard prevents same-epic issues running in parallel by
   default, but does not enforce ordering among them.

5. **Label everything**: `epic:<slug>` on the epic and every sub-issue, PLUS
   the bare `epic` label on the epic issue only (never on sub-issues — a
   sub-issue carrying the bare `epic` label would itself be excluded from
   the picker). Backend/frontend split sub-issues that verifiably don't
   touch the same files may add `parallelizable` to let them run
   concurrently despite sharing the `epic:<slug>` label — only do this when
   Step 2's research confirmed no file/table overlap.

6. **Link sub-issues to the epic.** Prefer `mcp__github__sub_issue_write`
   (action `add_sub_issue`) so GitHub's native sub-issue relationship shows
   the hierarchy. If unavailable, reference the epic number in each
   sub-issue's Context and list each sub-issue number in the epic's body.

## Sizing rule of thumb

| Scope | Action |
|-------|--------|
| Single file, single concern, < ~150 LoC | One issue |
| One backend OR one frontend concern, < ~300 LoC | One issue |
| Crosses backend + frontend, or > ~300 LoC, or > 1 independent concern | Epic + sub-issues |

When in doubt, decompose — an oversized `agent-ready` issue that a Ralph
worker can't finish in one PR is worse than a well-split epic.
