# Model-Release Artifact Cleanup — audit charter

You are auditing this repository's **agent ecosystem** — the skills, subagents,
commands, hooks, config, and prompt scaffolding that shape how coding agents
behave here — immediately after a new Claude model or Claude Code release.

Your job is to find and delete everything the new release made obsolete.

## The governing principle: capability absorbs scaffolding

Every skill, subagent, and hook in this repo was written to compensate for
something a model or harness could not do at the time. When the model gets
better, or the harness ships the capability natively, the compensating artifact
does not become merely redundant — it becomes **actively harmful**:

- It burns tokens on every session that loads it, on every trigger evaluation.
- It over-triggers, because prompts written to overcome an older model's
  reluctance are too forceful for a model that follows instructions literally.
- It over-constrains, because step-by-step scripts written for a model that
  planned poorly now displace a better plan the model would have made itself.
- It drifts, because nothing re-verifies its factual claims as the codebase and
  the harness move underneath it.

So the measured wins from a cleanup are real and compounding: fewer tokens,
faster objectives, higher quality output, and less spend. **A leaner ecosystem
is the goal, not a side effect.**

## Burden of proof: deletion is the default

This is the single most important rule in this charter, and it inverts the
instinct you will otherwise have.

**An artifact must earn its continued existence. It is deleted unless you can
state a concrete reason it survives.** "It might still be useful", "it isn't
hurting anything", "someone put work into this", and "it could come back" are
not reasons — they are the exact reasoning that accreted this ecosystem in the
first place.

The safety net is not caution during the audit. The safety net is that **this
runs as a reviewable pull request, the git history is permanent, and the
retrospective loop refills whatever turns out to be genuinely necessary** based
on real coding pitfalls encountered afterwards. Deleting something needed costs
one retrospective cycle to restore. Keeping something unneeded costs tokens on
every session forever. These are not symmetric — bias hard toward deletion.

A cleanup run that removes a large fraction of the ecosystem is the expected
outcome, not a red flag. A run that removes almost nothing means you applied
the wrong burden of proof — re-audit before concluding the ecosystem is lean.

## Step 1 — Establish what the new release actually changed

Do this **before** reading a single repo artifact, so you audit against facts
rather than against your priors. Your training data is older than the release
you are auditing against; you cannot answer this from memory.

Fetch tactically — a small number of high-yield sources, then follow the
specific links that matter:

| Source | What to extract |
|---|---|
| `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` | Every entry since the previous cleanup. Native features, bundled skills, new hooks, new built-in commands, behaviors now automatic. **The highest-yield single fetch.** |
| `https://code.claude.com/docs/llms.txt` | The full Claude Code docs index. Use it to discover which capability pages exist now — a page that did not exist before is a capability that shipped. |
| `https://code.claude.com/docs/en/skills` | Bundled skills that ship with Claude Code, and the custom-commands-merged-into-skills model. |
| `https://code.claude.com/docs/en/commands` | Built-in commands and bundled skills (`/debug`, `/code-review`, …). Any local command duplicating one of these is dead. |
| `https://platform.claude.com/docs/en/about-claude/models/overview.md` | The current model line-up, IDs, and capability table. Confirms which model this cleanup is keyed to. |
| `https://platform.claude.com/docs/en/about-claude/models/migration-guide` | The per-model "Behavioral shifts" and breaking-change sections. **This is where obsolete prompt text is named explicitly.** |

Use `WebSearch` when a changelog entry is too terse to act on, or to find the
release announcement for the specific model named in this run.

Write down, as an explicit list, the **capability deltas**: each thing the new
release does natively that previously required scaffolding. Every deletion you
propose later must map to one of these deltas, to a named migration-guide
behavioral shift, or to a duplicate/dead-code finding you can prove locally.

## Step 2 — Inventory the ecosystem

Enumerate every artifact in scope. Do not sample; the whole surface is audited
every run.

- `.claude/skills/*/SKILL.md` (and their supporting files)
- `.claude/agents/*.md`
- `.claude/commands/*.md`
- `.claude/settings.json` — hooks, permissions, env
- `.claude/hooks/`
- `CLAUDE.md` and any nested `CLAUDE.md`
- `AGENTS.md`, and prompt scaffolding under `prompts/`
- Agent-facing sections of workflow files that carry prompt text

For each, record: what it does, what it was compensating for, and its size.
Size matters — a large artifact that survives should still be slimmed.

## Step 3 — Classify every artifact

Exactly one verdict each. Cite evidence for every verdict that is not `PURGE`.

### PURGE — delete the file outright

- The capability is now **native** to the model or harness. A local
  `code-review` skill against a bundled `/code-review`; a "think step by step"
  or planning-scaffold skill against a model that plans natively; a hook
  replicating a now-built-in lifecycle event.
- It **duplicates** another artifact in this repo. Two subagents differing only
  by a filter or a payload field are one subagent.
- It is a **workaround for a fixed defect** — a prompt patching a behavior the
  migration guide now lists as changed, or scaffolding for a model that is
  retired.
- It is **unenforced and unused**: nothing invokes it, no workflow references
  it, and git history shows it has not been touched or triggered.
- Its instructions are **actively counterproductive** on the new model. The
  migration guide names these directly — e.g. verification/self-check
  scaffolding on a model that verifies its own work, "delegate more" guidance
  on a model that already over-delegates, `CRITICAL:`/`MUST` pressure language
  on a model that follows plain instructions literally.

### SLIM — keep the artifact, cut the dead weight

The artifact has a genuine remaining purpose, but carries text written for an
older model. Cut: pressure language, step-by-step choreography for judgment
calls, prohibition lists, restatements of trained defaults, worked examples the
model no longer needs, and progress-narration scaffolding. Keep the parts only
this repo's authors could know.

### KEEP — survives untouched

Only three things reliably earn this:

1. **Repo-specific domain knowledge** — the architecture, the invariants, the
   quality gates, the product vocabulary, the "why". No model knows this.
2. **Fragile mechanics** — exact commands, destructive-operation guardrails,
   auth and compliance steps where precisely one sequence is safe.
3. **Genuinely enforced automation** — hooks and settings that run and matter.

If your reason for keeping something is not one of those three, it is not a
KEEP. Re-classify it.

## Step 4 — Verify before you cut

For each `PURGE` and `SLIM`, do the work that makes the verdict falsifiable:

- **Name the replacement.** Quote the changelog line, docs page, or
  migration-guide section that makes it obsolete. A deletion with no cited
  replacement is not a finding — downgrade it to `SLIM` or `KEEP`.
- **Grep for references.** Workflows, other skills, `CLAUDE.md`, scripts, and
  docs may name the artifact. A deletion is incomplete until every reference to
  it is removed in the same change. Leaving a dangling `/some-command` mention
  is worse than leaving the artifact.
- **Do not break the gates.** Nothing here may weaken tests, coverage
  thresholds, lint config, or CI. If an artifact is load-bearing for a quality
  gate, it is a `KEEP`.

## Step 5 — Apply, in `purge` mode

Make the edits in the working tree: delete `PURGE` files, apply `SLIM` cuts,
and remove every dangling reference you found. Do not reformat, reword, or
"improve" anything you were not deleting or slimming — the diff must contain
only the audit's findings, so a reviewer can read it as a list of decisions.

In `report` mode, change nothing on disk. The report alone is the deliverable.

## Deliverables

Write exactly two files under `/tmp` (never in the repo):

- **`/tmp/cleanup-title.txt`** — one line:
  `chore(agents): purge artifacts obsoleted by <release> (YYYY-MM-DD)`
- **`/tmp/cleanup-report.md`** — the PR body:
  - **Release audited** — the model/harness version and the date.
  - **Capability deltas** — the list from Step 1, each with its source link.
  - **Purged** — one row per deleted artifact: what it was, the delta that
    replaces it, and the citation.
  - **Slimmed** — one row per artifact, with what was cut and why.
  - **Kept** — one line each, with which of the three KEEP reasons applies.
    This section is the audit's own accountability: a long Kept list with weak
    reasons means the burden of proof slipped.
  - **Before/after counts** — artifacts and approximate token weight, by
    category, with the reduction percentage.
  - **Watch list** — anything you deleted that you consider a genuine judgment
    call, so the retrospective knows what to watch for. Naming these is
    encouraged; it is what makes aggressive deletion safe.

If the audit finds nothing to purge or slim, write neither file and say so
plainly. A genuinely lean ecosystem is a valid outcome — but re-read the burden
of proof in Step 3 before concluding that, because it is the rarer result.

Append a concise run summary to `$GITHUB_STEP_SUMMARY`: release audited,
counts by verdict, reduction percentage, and anything you could not verify.

## Hard limits

These override everything above.

- **Never delete** `CLAUDE.md`, `AGENTS.md`, `README.md`, `LICENSE`, this
  charter, or the workflow that runs it. `CLAUDE.md` may be *slimmed*; it may
  not be removed.
- **Never touch** application source, tests, migrations, lockfiles, CI quality
  gates, or anything outside the ecosystem surface listed in Step 2.
- **Never weaken** a quality threshold, and never add a suppression
  (`# noqa`, `# type: ignore`, `// eslint-disable`) to make anything pass.
- **Never delete based on a guess about the release.** Every purge cites a
  fetched source. If the fetches failed, the run reports that and purges
  nothing.
