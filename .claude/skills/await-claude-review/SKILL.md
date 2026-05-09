---
name: await-claude-review
description: >-
  Subscribe to GitHub PR activity and wait — without polling — for the
  Claude reviewer's verdict comment on the current HEAD. Use when a PR
  has just been pushed and you need to know the verdict
  (LGTM / CHANGES_REQUESTED / COMMENTS) before merging, addressing
  feedback, or declaring work done. Wraps
  `mcp__github__subscribe_pr_activity`, which delivers comments and CI
  failures (NOT CI passes) as `<github-webhook-activity>` events. The
  verdict comment itself is a comment event, so the bot's post wakes
  the session directly — no need to proxy through CI status. After
  subscribing, end the turn; events resume the session.

  Called by `address-feedback`, `stay-green`, and
  `comprehensive-pr-review`.

  Do NOT use for waiting on arbitrary CI success (not deliverable by
  the webhook), general PR babysitting unrelated to the verdict gate,
  debugging CI failures themselves (use `ci-debugging`), or one-off
  status polling (use `pull_request_read` directly).

metadata:
  author: Geoff
  version: 1.0.0
---

# Await Claude Review

Wait for the Claude reviewer's `Verdict:` comment on the current HEAD via PR webhook events. No polling, no `sleep`, no CI-pass proxy.

## What the Subscription Actually Delivers

`mcp__github__subscribe_pr_activity` says, verbatim:

> Once subscribed comments and CI failures will be delivered into this conversation as `<github-webhook-activity>` messages.

So the deliverable set is:

| Event | Delivered? | Notes |
| --------------------------------------------- | ---------- | -------------------------------------------------------------- |
| Top-level PR comment (incl. reviewer verdict) | Yes | This is the wake signal you want. |
| Line-level review comment / thread reply | Yes | Treated as a comment event. |
| CI **failure** (any required check failing) | Yes | Triage on receipt — may indicate the reviewer action failed. |
| CI **success / pass** | **No** | Do not write logic that waits on this — it never arrives. |
| Successful workflow_run completion | **No** | Same as above. |
| PR merge / close | Implicit | You should `unsubscribe_pr_activity` on these from the caller. |

**Implication.** Don't treat "CI green" as a proxy for "review posted." The verdict comment is itself a delivered event — wait for it directly.

## Canonical Verdict Line

The reviewer (see `comprehensive-pr-review`) ends its top-level comment with a line matching, case-insensitive:

```
^\s*(?:##\s+|\*\*)?Verdict[:*\s]+(LGTM|CHANGES_REQUESTED|COMMENTS)
```

`comprehensive-pr-review` is the canonical source for this format; this skill is the parser side of that contract.

Examples that match:

- `## Verdict: LGTM`
- `**Verdict:** CHANGES_REQUESTED`
- `Verdict: COMMENTS`

If the regex does not match, treat the comment as malformed: do **not** infer a verdict from prose ("looks good to me" is not a verdict). Surface to the user.

## Instructions

### Step 1: Pin the HEAD You're Waiting For

Before subscribing, record what "current" means so you can later distinguish a fresh verdict from a stale one.

1. `mcp__github__pull_request_read` with `method: "get"` → record `head.sha`.
2. `mcp__github__get_commit` with `sha: head.sha` → record `commit.committer.date` as `headPushedAt` (proxy for the latest push time). Note: `committer.date` does not change under a no-op force-push of the same SHA, so prior verdicts on that exact commit remain "current" by this check — acceptable in practice but worth knowing.

### Step 2: Subscribe, Set the Fallback Expectation, and End the Turn

```
mcp__github__subscribe_pr_activity
owner: <owner>
repo: <repo>
pullNumber: <N>
```

Then **stop**. Do not poll. Do not `sleep`. Do not call `pull_request_read get_comments` in a loop. Webhook events arrive as `<github-webhook-activity>` messages and resume the session on their own.

**Wake delivery is best-effort, not guaranteed.** Some environments suppress comment-event wakes whose author identity overlaps with the session's own identity (e.g., a session running as Claude Code on web may not receive wake events for comments authored by `claude[bot]`, even though the comment exists on GitHub). The webhook delivery system is fire-and-forget — there is no retry queue and no backfill. To stay recoverable:

1. End the turn with a one-sentence note to the user: "If I don't wake within ~5 minutes after the reviewer Action completes, prompt me to check status."
2. On manual re-engagement, **immediately re-run Step 4** (re-fetch comments + currency check + parse). Do not re-subscribe and wait again — that won't backfill the missed event.
3. Treat repeated wake failures in the same environment as a stable property of that environment, not a transient bug to retry against. Document the actual deliverable behavior for that workspace alongside this skill if needed.

### Step 3: On Wake — Classify the Event

When a `<github-webhook-activity>` message arrives, decide what kind of event it is:

- **Top-level PR comment from a reviewer bot** (`claude[bot]`, `github-actions[bot]`, or whichever account posts reviews on this repo) → go to Step 4.
- **Line-level review comment** → not a verdict. If `address-feedback` is the caller, log it in that skill's triage table for the current pass; otherwise stay subscribed and wait for the next event.
- **CI failure event** → go to Step 5.
- **Anything else** → stay subscribed; wait for the next event.

### Step 4: Validate Currency and Parse Verdict

Re-fetch the comments to read the full body (the webhook payload may be truncated):

1. `mcp__github__pull_request_read` with `method: "get_comments"`.
2. **Verify `author.login` matches the configured reviewer bot** (`claude[bot]`, `github-actions[bot]`, or whichever account the repo uses) — this is mandatory, not optional. The verdict regex alone is not a sufficient guard; any commenter can write a line that matches it.
3. Filter to bot author + body containing the verdict regex.
4. Sort by `created_at` desc; take the first.
5. **Currency check**: require `created_at >= headPushedAt`. A verdict posted before the latest push describes an earlier state; ignore and keep waiting.
6. Parse with the regex above. Return one of:
- `LGTM` → caller proceeds to merge gate.
- `CHANGES_REQUESTED` → caller enters fix loop.
- `COMMENTS` → caller decides (usually mergeable as-is).
- **Malformed** → surface to user; do not guess.

### Step 5: On CI Failure for Current HEAD

A CI failure event for `head.sha` may mean the reviewer action itself failed (timeout, rate limit, permissions) — in which case **the verdict comment will never arrive** and waiting is futile. Inspect the failed check:

1. `mcp__github__pull_request_read` with `method: "get_check_runs"` for `head.sha`.
2. If the failed run is the **review action** (look for the workflow that runs `@claude` review): post `@claude please review` via `mcp__github__add_issue_comment` to retrigger, then stay subscribed.
3. If the failed run is **other CI** (lint, tests, build): surface the failure to the user and recommend handing off to `ci-debugging`. Stay subscribed — the reviewer action may still post.

### Step 6: Cleanup

The caller should call `mcp__github__unsubscribe_pr_activity` once the PR merges, closes, or the verdict gate is no longer needed. This helper does not unsubscribe on its own — leave the lifecycle to the caller.

## Examples

### Example 1: Push, Subscribe, Wake on LGTM

1. Caller (`address-feedback` Step 5) finishes pushing fixes.
2. Pin HEAD: `head.sha = abc123`, `headPushedAt = 2026-05-08T11:00:00Z`.
3. `subscribe_pr_activity owner=acme repo=widgets pullNumber=42`. End turn.
4. Wake: `<github-webhook-activity>` for a comment by `claude[bot]`.
5. `get_comments` → latest matching at `2026-05-08T11:04:33Z`, body ends `## Verdict: LGTM`. `11:04:33Z >= 11:00:00Z` ✓.
6. Return `LGTM` to caller. Caller proceeds to merge gate.

### Example 2: Stale Verdict After Force-Push

1. Pin HEAD: `head.sha = def456`, `headPushedAt = 2026-05-08T12:00:00Z`.
2. Subscribe, end turn.
3. Wake on a comment event. `get_comments` → latest verdict `LGTM` at `11:55:00Z` — that's *before* `headPushedAt`. The push superseded the verdict.
4. Stay subscribed. Optionally post `@claude please re-review`. Return to waiting.

### Example 3: Reviewer Action Failed in CI

1. Subscribe after push, end turn.
2. Wake: `<github-webhook-activity>` for a CI failure on `head.sha`.
3. `get_check_runs` → the failing job is `claude-review` (timeout). No other failures.
4. Post `@claude please review` to retrigger the action. Stay subscribed.
5. Subsequent wake delivers the verdict comment normally.

### Example 4: Other CI Failed; Verdict May Still Come

1. Subscribe after push, end turn.
2. Wake: CI failure on `head.sha`. `get_check_runs` → `pytest` failed; `claude-review` is still in progress.
3. Surface the test failure to the user and recommend `ci-debugging` for that. Stay subscribed — the reviewer may still post a verdict (which the author will need to address regardless of test failures).

## Troubleshooting

### Error: Tempted to wait on "CI green" / `workflow_run.conclusion == success`

Don't. The subscription does not deliver CI passes. Wait on the comment event directly — that *is* the delivered signal.

### Error: Tempted to poll with `sleep` or `Bash run_in_background`

Don't. The session is woken by `<github-webhook-activity>`. Polling burns time and conflicts with the harness's wake mechanism. Subscribe and end the turn.

### Error: Webhook arrives but `get_comments` shows no matching verdict

Possible causes, in order of likelihood:

1. The event was a line-level review comment, not the top-level verdict. Stay subscribed.
2. The reviewer posted a non-verdict comment (e.g., a status ping). Stay subscribed.
3. The bot author login differs on this repo. Confirm the author and update the filter.

### Error: Multiple bot accounts post comments

Match by author login (`claude[bot]`, `github-actions[bot]`) AND require the body to contain the canonical Verdict regex. If still ambiguous, ask the user which account is authoritative — do not guess.

### Error: PR merged or closed while waiting

The caller should detect this and call `unsubscribe_pr_activity`. If you see no further events for a long time, ask the user before assuming the PR is still open.

### Error: Subscription confirmed, verdict was posted, but the session never woke

Confirmed real, observed in environments where the session and the reviewer share a bot identity (e.g., Claude Code on web subscribed to a PR where `claude[bot]` posts the verdict). Symptoms: `subscribe_pr_activity` returned success, the reviewer Action completed and posted a verdict comment, the comment is visible via `get_comments`, but no `<github-webhook-activity>` arrived in this conversation.

What to do:

1. On manual re-engagement, **do not re-subscribe and wait again** — the webhook system is fire-and-forget; there is no backfill. Re-subscribing won't replay the missed event.
2. Run Step 4 directly: `get_comments`, author-login check, currency check, parse the verdict. Proceed to the caller's next step (merge gate, fix loop, etc.) based on the verdict.
3. If this failure mode is reproducible in your environment, when calling this skill again, end the turn with an explicit fallback prompt to the user (Step 2 of Instructions) so they know to re-engage you after a reasonable wait.
4. Do **not** retry by re-subscribing in a loop. Repeated subscriptions in this failure mode produce repeated silence, not retries.

This is a delivery-layer property of the environment, not a bug in this skill.
