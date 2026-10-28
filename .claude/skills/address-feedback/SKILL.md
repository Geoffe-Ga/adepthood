---
name: address-feedback
description: >-
  Iterate on Claude PR review feedback intelligently and merge when ready.
  Use when the user asks to "address feedback", "respond to Claude's review",
  "iterate on the PR", "fix review comments", or "merge if Claude said LGTM".
  The Claude reviewer publishes a top-level PR comment via GitHub Action
  ending in a `Verdict:` line (LGTM / CHANGES_REQUESTED / COMMENTS) — it is
  NOT a formal GitHub approval. This skill locates the most recent such
  comment via GitHub MCP, parses the verdict, triages blockers/problems/nits
  into a TDD-driven local fix loop, replies and resolves threads. On
  `CHANGES_REQUESTED` it loops until LGTM; on `COMMENTS` it never iterates —
  it files each actionable item as a follow-up issue with a P0–P3 label
  matched to its severity (or defers loop-tooling rows per the backlog
  inflow moratorium) and then merges; on `LGTM` it merges. Merging always
  requires the verdict to postdate the current HEAD and green checks.
  Do NOT use for giving a review (use comprehensive-pr-review), debugging CI
  failures themselves (use ci-debugging), general TDD work outside review
  context (use stay-green), bug RCA (use bug-squashing-methodology), or
  issue/branch/PR creation (use git-workflow).
metadata:
  author: Geoff
  version: 1.2.0
---

# Address Feedback

Close the loop on a Claude PR review: find the latest verdict comment, iterate locally with TDD on `CHANGES_REQUESTED`, push once, and merge when the verdict for the current HEAD is `LGTM` (merge directly) or `COMMENTS` (file a prioritized follow-up issue for each actionable item instead of iterating, then merge) with green CI.

## How the Claude Review Surfaces

The Claude reviewer runs as a GitHub Action on each push. It posts its findings as a **top-level PR comment** authored by a bot account (e.g. `claude[bot]`, `github-actions[bot]`). The comment follows the `comprehensive-pr-review` format and ends with a line like:

```
## Verdict: LGTM
```

Possible verdicts: `LGTM`, `CHANGES_REQUESTED`, `COMMENTS`. There is **no formal GitHub approval** to read — `state == "APPROVED"` will not be set. Treat the comment body as the source of truth.

## Prompt-Engineering Tactics (Brief)

Before touching code, restate each review item as a 6-component micro-prompt so the fix is precise instead of sprawling:

- **Role** — "Engineer addressing a single review comment."
- **Goal** — the exact change requested (one sentence).
- **Context** — `file:line`, the surrounding 5-10 lines, the reviewer's quote.
- **Format** — minimal diff; no drive-by refactors.
- **Examples** — if the reviewer suggested code, paste it verbatim.
- **Constraints** — keep blast radius small; preserve public API; add a regression test.

If a comment is ambiguous on any component, reply asking for clarification rather than guessing. See `prompt-engineering` for the full framework.

## Instructions

### Step 1: Locate the Latest Claude Verdict Comment

Use the GitHub MCP tools — never `gh` CLI. The goal is to determine whether a Claude review comment exists for the current HEAD push, and what its verdict is.

1. Get HEAD SHA and the push timestamp:
   - `mcp__github__pull_request_read` with `method: "get"` → record `head.sha`.
   - `mcp__github__get_commit` with `sha: head.sha` → record `commit.committer.date` (proxy for the latest push time).
2. List **top-level PR comments** (not line-level review comments):
   - `mcp__github__pull_request_read` with `method: "get_comments"` (paginate if the PR is long-running).
3. Filter the comments:
   - **Author** is a bot matching the Claude reviewer (`claude[bot]`, `github-actions[bot]`, or whichever account posts the review on this repo). When in doubt, also require the body to contain a `Verdict:` line.
   - **`created_at >= head commit's committer.date`** — the currency check. Comments posted before the latest push describe an earlier state and are stale.
4. Sort matching comments by `created_at` desc; the first is the **current** Claude review.
5. Parse the verdict from that comment's body. Look for a line matching (case-insensitive):

   ```
   ^\s*(?:##\s+|\*\*)?Verdict[:\*\s]+(LGTM|CHANGES_REQUESTED|COMMENTS)
   ```

6. Classify and route:
   - `LGTM` → skip to Step 6 (merge gate).
   - `CHANGES_REQUESTED` → required fixes; continue to Step 2 with the **Security Concerns**, **Problems**, and any blocking items from the comment body.
   - `COMMENTS` → reviewer has signed off but raised non-blocking findings; run Step 1A (file each actionable item as a follow-up issue with a severity-matched P-label, or moratorium-defer it), then jump to Step 6. **Do not enter the TDD loop, push, or re-request review.**
   - **No qualifying comment** (none after the latest push) → wait for the next review run; do not merge. Optionally post `@claude please review` via `mcp__github__add_issue_comment` if the action did not run.
   - **Comment exists but no parseable Verdict line** → treat as malformed; ask the user before merging. Do not infer a verdict from prose.

### Step 1A: COMMENTS Verdict — File Prioritized Issues, Then Merge (Never Iterate)

Reached only when the current verdict is `COMMENTS`. **A `COMMENTS` verdict never starts another iteration**: no TDD loop, no code push, no `@claude please re-review`. The reviewer has signed off on what is in the PR; its non-blocking findings become tracked backlog work, prioritized by severity, and the PR proceeds to the merge gate. `iteration-trigger.yml`'s summary comment and `scripts/ralph/pr-ready.sh` (token `ready-comments`) both route `COMMENTS` here.

1. Build the same triage table as Step 2 from the comment body (Strengths / Security Concerns / Problems / Code Quality / Requests sections) **and** any unresolved line-level threads via `mcp__github__pull_request_read` with `method: "get_review_comments"`.
2. Drop rows that are factually wrong or already addressed — reply on the relevant thread/comment with a short justification instead of opening an issue.
   Also drop rows covered by the **backlog inflow moratorium** (2026-09-01, `CLAUDE.md`): rows about the development loop itself — `scripts/ralph/**`, `.github/workflows/**`, scan/lint/pre-commit tooling, dependency hygiene — are deferred, not filed, unless they break a required check on `main` or block a merge. Reply on the row's thread that it is deferred under the moratorium — the resolved thread is the durable record — and resolve it.
3. Assign each remaining row a priority from its severity (the same P-tiers `flare` and Ralph's picker use):

   | Priority | The finding is… |
   |---|---|
   | `P0` | a security hole, data loss or corruption, a crash, broken auth, or a privacy leak |
   | `P1` | a correctness bug on a reachable path (wrong result, unhandled error), or a core flow broken with no workaround |
   | `P2` | degraded behavior with a workaround, a missing test on a real path, a maintainability or performance cost with a concrete consequence, or a `Requests` item |
   | `P3` | a nit, naming, style, docs polish, or an optional refactor |

   Use the reviewer's own severity words when they give one (`blocker`/`high`/`major` → at least `P1`; `nit`/`minor`/`optional` → `P3`). When a row sits between two tiers, take the higher. A `P0` row is filed like any other — it does not reopen the loop — but name it to the user in your report so a human sees it before Ralph picks it up.
4. Dedupe before filing: `mcp__github__search_issues` for the cited `file:line` and the title's key nouns. If an open issue already covers the row, reply on the thread linking it (and raise its P-label if this row is more severe) instead of filing a duplicate.
5. For every remaining row, file a follow-up issue via `mcp__github__issue_write` with `method: "create"`:
   - **Title** — imperative summary derived from the reviewer's quote (e.g. "Extract magic numbers in `parser.py`").
   - **Body** — the 6-component structure the rest of the backlog uses (see `flare`): the reviewer's verbatim quote, the `file:line` citation, the requested change, the test idea from the triage table, acceptance criteria, and a back-link to the source PR (`Follow-up from #<N> — <comment URL>`).
   - **Labels** — the P-label from item 3, the type (`bug` or `enhancement`/`tech-debt`), the area label, and `agent-ready` when every body section is filled with real content.
6. For each line-level thread that produced an issue, post a reply via `mcp__github__add_reply_to_pull_request_comment` linking the new issue number, then `mcp__github__resolve_review_thread`.
7. Post a single summary reply on the top-level Claude comment via `mcp__github__add_issue_comment` listing every follow-up filed with its priority (e.g. `Follow-ups filed: #142 (P2), #143 (P3), #144 (P3)`).
8. Continue to Step 6. The merge gate accepts `COMMENTS` once every actionable item has a tracking issue, a duplicate link, or a moratorium-deferral reply.

### Step 2: Triage the Comment Body into a Fix Plan

The Claude review is a single comment with sections (Strengths / Security Concerns / Problems / Code Quality / Requests / Verdict). Extract each actionable item into a row:

| id | section | file:line (if cited) | quote | requested change | test idea | severity |

Also pull any **line-level** review threads via `mcp__github__pull_request_read` with `method: "get_review_comments"` and merge them into the same table — these come back with `isResolved` metadata so you can ignore already-resolved threads.

Apply the prompt-engineering framing above. Drop or push back on items that are out of scope, factually wrong, or already addressed — reply with a short justification instead of changing code.

### Step 3: Fix Locally with TDD — Never Push to Probe CI

For each row, smallest unit first:

1. **Red** — write a test that fails because of the bug the reviewer flagged.
2. **Green** — make the minimal change; the test passes.
3. **Refactor** — only within the same file, only if it stays green.

Then run the full local gate before any push:

```bash
# Whatever the project uses; pick the equivalents:
pre-commit run --all-files
./scripts/test.sh --all      # or pytest / npm test / go test ./... / cargo test
./scripts/typecheck.sh       # or mypy / tsc --noEmit / etc.
```

If a check fails, fix it locally and re-run. **Do not push to use CI as your test runner.** See `stay-green` for the gates and `ci-debugging` only if a local-green change later fails in CI.

### Step 4: Reply, Resolve, Re-Request

For each item, after the fix lands locally:

1. **Line-level threads** — `mcp__github__add_reply_to_pull_request_comment` with a short reply (what changed, where: `src/x.py:42`, and the commit SHA once pushed), then `mcp__github__resolve_review_thread`.
2. **Top-level Claude review comment** — there is no thread to resolve. Post a single summary reply via `mcp__github__add_issue_comment` listing each addressed item and the SHA(s) that fixed it.
3. After pushing, request a fresh review by posting `@claude please re-review` via `mcp__github__add_issue_comment`. The GitHub Action runs again and writes a new verdict comment — that becomes the comment you parse on the next pass.

### Step 5: Push Once and Await the Next Verdict

Push the branch (single push, not one per fix). Then delegate the wait to `await-claude-review` — it pins the new HEAD, calls `mcp__github__subscribe_pr_activity`, and ends the turn so the session wakes on the bot's verdict comment via `<github-webhook-activity>`. **Do not poll** with `sleep` or repeated `get_comments` calls, and do not wait on CI passes — the webhook does not deliver them; only the comment event is the wake signal.

When the helper wakes the session:

- Verdict `LGTM` for the current HEAD → continue to Step 6.
- Verdict `CHANGES_REQUESTED` → loop back to Step 2 with the new comment body.
- Verdict `COMMENTS` → run Step 1A (file or moratorium-defer a prioritized follow-up for every actionable item), then Step 6. Never loop back to Step 2.
- CI failure event for the current HEAD → if the failing job is the reviewer action, the helper retriggers it and stays subscribed; if it's other CI, hand off to `ci-debugging` and keep the subscription open. Either way, do not advance to merge.

Note: wake delivery is best-effort. If the session sits for longer than the reviewer Action's typical runtime (~5 min) without waking, re-engage manually and run `await-claude-review` Step 4 directly — re-subscribing will not backfill a missed event. Once the PR is merged or closed (or the verdict gate is no longer needed), call `mcp__github__unsubscribe_pr_activity` to clean up.

### Step 6: Merge Gate — All Must Hold

Merge only when **every** condition is true. If any fails, stop and explain which one.

- Latest qualifying Claude review comment has `Verdict: LGTM`, **or** `Verdict: COMMENTS` with every actionable item filed, duplicate-linked, or moratorium-deferred per Step 1A.
- That comment's `created_at >= head commit's committer.date` (verdict is for the current HEAD, not a pre-push state).
- All required check runs are `success`:
  - `mcp__github__pull_request_read` with `method: "get_status"` (combined commit status), and
  - `mcp__github__pull_request_read` with `method: "get_check_runs"` (per-job detail).
- No unresolved line-level review threads (`mcp__github__pull_request_read` with `method: "get_review_comments"` — each thread has `isResolved`). For a `COMMENTS` verdict, threads are resolved by linking the follow-up issue or by the moratorium-deferral reply (Step 1A), not by code change.
- The PR is `mergeable` and not `draft` (from the `get` response).
- For a `COMMENTS` verdict: the PR carries no `do-not-auto-merge` label, and the compare API reports `behind_by == 0` against its base. If it is behind, sync it and wait for the fresh review on the new HEAD instead of merging.

Then:

```
mcp__github__merge_pull_request
  pull_number: <N>
  merge_method: "squash"   # or whatever the repo standard is
```

Confirm the merge succeeded; do not delete the remote branch unless the user asks.

## Examples

### Example 1: Current `Verdict: LGTM`, Green CI — Merge

1. `pull_request_read get` → `head.sha = abc123`. `get_commit abc123` → `committer.date = 2026-05-01T10:00:00Z`.
2. `pull_request_read get_comments` → latest bot comment by `claude[bot]` at `2026-05-01T10:04:33Z`, body ends with `## Verdict: LGTM`.
3. `10:04:33Z >= 10:00:00Z` → comment is current.
4. `get_status` and `get_check_runs` → all `success`. `get_review_comments` → no unresolved threads. PR `mergeable: true`, `draft: false`.
5. `merge_pull_request` with `squash`. Report merge URL.

### Example 2: Verdict Comment Predates the Latest Push (Stale)

1. `head.sha = abc123`, `committer.date = 11:30:00Z`.
2. Latest Claude comment is `Verdict: LGTM` but `created_at = 09:15:00Z` — before the push that produced `abc123`.
3. The verdict reflects an earlier HEAD. State that the LGTM is stale, post `@claude please re-review` via `add_issue_comment`, and **do not merge**.

### Example 3: `Verdict: CHANGES_REQUESTED` with Two Blockers and a Nit

1. Parse the comment body: two **Problems** (file:line cited) and one **Code Quality** nit. Build the triage table.
2. Decide the nit is out of scope for this PR — reply on the top-level Claude comment justifying the deferral.
3. For the two blockers: Red-Green-Refactor locally, then `pre-commit run --all-files` + full test suite + typecheck. All green.
4. Single `git push`. Post a summary reply via `add_issue_comment` listing the addressed items and the SHA. Then post `@claude please re-review`.
5. New Claude comment arrives with `Verdict: LGTM` after the new push timestamp → re-enter Step 6.

### Example 4: `Verdict: COMMENTS` — File Prioritized Follow-ups and Merge

1. `pull_request_read get` → `head.sha = def456`. `get_commit def456` → `committer.date = 2026-05-24T09:00:00Z`.
2. Latest reviewer comment at `2026-05-24T09:06:12Z` ends with `## Verdict: COMMENTS`. Body has one Problem (an unhandled `None` on a reachable path, `habits.py:88`) and two Code Quality nits (`habits.py:142`, `tests/test_habits.py:30`).
3. Step 1A — no TDD loop, no push. Triage, dedupe with `search_issues`, then file:
   - `#142 Handle missing streak in habits.py` — `P1`, `bug`, `agent-ready`.
   - `#143 Rename ambiguous variable in habits.py:142` — `P3`, `tech-debt`, `agent-ready`.
   - `#144 Add boundary test for empty habit list` — `P2`, `tech-debt`, `agent-ready`.
4. Resolve the line-level threads with replies linking each issue. Post `Follow-ups filed: #142 (P1), #143 (P3), #144 (P2)` on the Claude comment.
5. Step 6 gate: `09:06:12Z >= 09:00:00Z` ✓, all checks `success` ✓, no unresolved threads ✓, `mergeable: true`, `draft: false`. Squash-merge.

## Troubleshooting

### Error: Cannot tell which comment is "Claude's"

Match by author login first (`claude[bot]`, `github-actions[bot]`); fall back to `user.type == "Bot"` plus a body that contains a `Verdict:` line. If still ambiguous, ask the user which bot to treat as authoritative — do not guess.

### Error: Verdict line not found or malformed

The reviewer is supposed to end with a `## Verdict:` line containing exactly one of `LGTM`, `CHANGES_REQUESTED`, or `COMMENTS`. If the regex does not match, do not infer the verdict from prose ("looks good to me" is not a verdict). Surface the malformed comment to the user, optionally re-request the review, and **do not merge**.

### Error: Verdict comment exists but predates the HEAD push

The LGTM was for an earlier commit. Any push, even a docs-only one, supersedes it. Re-request a review (`add_issue_comment` with `@claude please re-review`), wait for the new comment, and re-enter Step 6 only after a current `Verdict: LGTM` arrives.

### Error: Reviewer's suggestion would break tests or public API

Do not silently ignore. Reply on the relevant thread (or the top-level comment) with the conflict (failing test name, API consumer, or constraint), propose an alternative, and pause until the user or reviewer agrees. Never bypass with `--no-verify` or skip checks; see `max-quality-no-shortcuts`.

### Error: Tempted to push to "see what CI says"

Stop. Reproduce the check locally first (`pre-commit run --all-files`, full test suite, typecheck). Pushing speculatively burns minutes per round trip and trains a sloppy loop. Only push when local gates are green.

### Error: Merge gate passes but `mergeable` is `false`

Conflicts with the base branch. Rebase or merge `main` locally, resolve, re-run local gates, push. The new commit supersedes the LGTM verdict — request a fresh review before re-entering the merge gate.
