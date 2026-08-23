<!--
  A manually-run prompt, deliberately NOT a registered scan.

  It lived in `prompts/scans/` and failed `scripts/graph/test_scan_graph_preamble.sh`
  on four assertions, because everything in that directory is expected to be a scan
  definition the `_claude-scan.yml` core can drive.

  It is not one, and the mismatch is semantic rather than cosmetic. That core hands
  its findings to the scan-issue-writer skill, whose job is to *file* issues. This
  audit's primary action is the opposite: it EDITS issues that already exist, and
  files a new one only for work it uncovers along the way. Adding the preamble
  headings would have satisfied the linter while leaving the harness unable to
  execute the thing correctly.

  Registering it properly would need two changes, both larger than this move:

    1. An audit mode in `_claude-scan.yml` that permits editing existing issues
       rather than only creating them.
    2. An exemption from that workflow's `BACKLOG_MAX: "50"` stand-down. That gate
       exists to stop scans piling findings onto a bloated backlog — but this
       audit's output IS backlog reduction, so gating it on backlog size is
       backwards, and it would stand down exactly when it is most needed.

  Run it by hand until then.
-->

# Backlog contract-drift audit

Audit open issues against the code and the ratified contracts they depend on, and
**edit the issues** so their descriptions are true. This is not a build task. Do
not implement anything.

## Why this exists

On 2026-08-08 one session picked up four issues in a row whose premises were
false. Every one was labelled `agent-ready`:

- **#1930** asked the client to parse `related_praxis` / `related_eddies` from a
  reflect response. The vendored `/v1` `ReflectionResponse` schema sets
  `additionalProperties: false` and publishes neither — a conformant vault **may
  not send them**. The issue said "do not block on upstream, build against the
  documented optional shape", written when the contract doc was a hand-maintained
  mirror, before ADR 0004 replaced it with upstream's digest-verified bytes.
- **#1924**'s acceptance criteria described `McpCreekVaultClient.reflect`
  returning a bare `str`. That client was retired by ADR 0004.
- **#1946** declared "do not start until #1942 and #1945 are merged". Both had
  already merged.
- **#1932** and **#1633** both looked closeable from their own trackers. Both
  close-claims were refuted against the code.

**The danger is that the wrong build still goes green.** A parser for a forbidden
field, tested against synthetic payloads, passes every gate and ships dead code.
That happened: an entire HTTP upload client was built against `/v1/uploads/`, a
route Creek has never served, and CI passed because the tests ran against a fake
— and a fake answers any URL it is given.

## Sources of truth, in priority order

Trust these over any issue body, in this order:

1. **`backend/tests/fixtures/creek_v1/`** — Creek's published `/v1` contract,
   vendored byte-for-byte and digest-verified. `CapabilitiesResponse.schema.json`
   publishes a **closed** four-name capability enum (`capabilities`,
   `journal-upsert`, `reflections`, `wheel`) under `additionalProperties: false`,
   identical across every supported minor. Several response schemas are likewise
   `additionalProperties: false`. **Never edit this directory.**
2. **`docs/adr/`** — especially ADR 0004: HTTP/JSON is the sole application
   boundary, adepthood's MCP client is retired, and Decision 6 governs intimate
   transit (amended 2026-08-08 for uploads).
3. **The code at HEAD** — symbols, signatures, `path:line`.
4. **`../creek-tools/docs/`** — upstream's decisions and contract bundle, if
   present locally. Upstream may be *ahead* of what adepthood vendors; the
   vendored copy is what adepthood must conform to.
5. The issue body — **last**, and always suspect.

## For each open issue, check

- Do the files, symbols and `path:line` references still exist?
- Does its "current behavior in code" block match reality?
- Is what it asks for still **possible**? Closed enums, `additionalProperties:
  false`, retired components, ratified decisions that forbid it.
- Are its stated dependencies still open?
- Does the repo already have a convention that changes how it should be done?
  (Example: PyYAML is deliberately absent from every requirements file, so two
  test modules parse YAML as text; importing it turns a guard into a collection
  error on the 3.11 compat job.)
- For an **epic**: is it already substantially shipped? Epics here go stale —
  they stay open after their children merge.

## What to do with each finding

Edit the issue. Do not merely comment and move on.

| Finding | Action |
| --- | --- |
| Premise impossible under a ratified contract | Add `blocked`, comment with the schema evidence (quote the JSON), state precisely what would unblock it |
| Stale file/symbol/line references | **Edit the body** to point at the real code, and say what moved |
| Dependencies already merged | Strike the "do not start until…" line from the body |
| Already implemented | Verify in code with `path:line`, then close as completed citing the PR |
| Epic whose children all shipped | Tick the checklist; close only if **every** stated goal is verifiably shipped |
| Counts/baselines wrong | Correct them in the body and say how you measured |

Always cite `path:line`, a schema excerpt, or a PR number. An assertion without
evidence is the thing this audit exists to remove.

## Rules

- **Do not implement anything.** If an issue is fine, say so and move on.
- **Do not close an epic on a close-claim you have not tried to refute.** Wrongly
  keeping one open costs a line in a list; wrongly closing one silently discards
  tracked work.
- **Do not invent wire names, routes, or payload shapes** to make an issue
  buildable. If the contract does not publish it, the issue is blocked.
- **Do not edit** `backend/tests/fixtures/creek_v1/` — two checksum gates verify it.
- Prefer editing an existing issue over filing a new one; file new only for
  genuinely new work the audit uncovers.

## Report

A table: issue, verdict (`fine` / `edited` / `blocked` / `closed` /
`needs-owner`), one-line reason. Then state plainly how much of the backlog was
actually true as written — including if the answer is "most of it", which is a
real and useful result.
