# Tracer phase — automated issue inflow is off

**Status:** active as of 2026-08-17. Owner: Geoff.

The backlog is no longer fed by machines. Every scheduled source that filed
issues into this repository has had its `schedule:` trigger commented out, and
new work now enters the backlog exactly one way: **a human or an autonomous
agent finds a real flaw while running a tracer bullet, and files it.**

This is a deliberate, temporary inversion of the Ralph model. The repository had
grown a large machine-generated backlog while the end-to-end path — the one
thing that proves the product works — had never been run once. Scans are good at
finding local defects and blind to that. So the scans stand down until the
vertical slice is proven.

## Why now

Epic #2043 records the close condition in its own words:

> **Not met, and not claimed as met:** nobody has run this client end-to-end
> against a real local Creek `/v1` server.

That run is the tracer bullet. It is a human action, not a Ralph task, and it
cannot happen while the queue keeps refilling with work that does not serve it.

## What was turned off

Each workflow keeps `workflow_dispatch:`, so any of them can still be fired by
hand from the Actions tab. Only the automatic cadence is gone.

| Workflow | Was | Role |
|---|---|---|
| `scan-bugs` | daily 07:00 | producer |
| `scan-security` | daily 05:00 | producer |
| `scan-deps` | daily 06:00 | producer |
| `scan-dead-code` | weekly Mon | producer |
| `scan-complexity` | weekly Tue | producer |
| `scan-coverage` | weekly Wed | producer |
| `scan-perf` | weekly Thu | producer |
| `scan-todo` | weekly Fri | producer |
| `scan-docs` | biweekly 1st/15th | producer |
| `scan-types` | biweekly 1st/15th | producer |
| `scan-mutation` | biweekly 8th/22nd | producer |
| `scan-a11y` | monthly 3rd | producer |
| `deslop` | weekly Mon | producer (matrix) |
| `weekly-playbook` | weekly Mon | producer (P0 playbook deltas) |
| `hopper` | **hourly** | dispatcher — refilled the queue off-schedule |
| `scan-groom` | daily 04:00 | consumer — closed/deduped/promoted issues |
| `graph-build` | nightly 04:40 | filed graph-staleness issues on the nightly tail |
| `dependabot-to-ralph-issue` | weekly + real-time | bridge — one backlog issue per Dependabot PR |

`hopper` is the one worth understanding: it measured queue depth hourly and
dispatched the most-stale producer scan whenever runway dropped below `MIN_QUEUE`,
with a raised issue cap. Leaving it on would have re-armed every scan above.

### Deliberately left running

- **`creek-contract-drift`** (weekly Sat) — fails a job when Creek's published
  `/v1` contract diverges from the bytes vendored under
  `backend/tests/fixtures/creek_v1/`. It files no issues, and during a phase
  whose entire purpose is exercising that contract, it is the only thing
  watching for silent upstream drift. Keeping it is the point.
- **`graph-federate`**, **`graph-semantic`** — graph maintenance, no issue
  writes.
- **`graph-build` on `push`** — the incremental rebuild still runs on every push
  to `main`, so `graphify query` stays fresh. Only the nightly tail that filed
  staleness issues is gone.

### Dependabot

Dependabot itself is untouched: it still opens PRs, so security advisories
remain visible. Only the *bridge* that minted a `dependencies` backlog issue per
PR is off — both its weekly backfill and its real-time `pull_request_target`
path. Merge those PRs directly.

## What this makes obsolete

Three open issues existed only to service the automation that is now off. They
have been demoted rather than closed, because they become live again the moment
the scans do:

- **#2259** — "all 12 producer scans have never run — every scheduled run is
  `startup_failure`". Notably, this means the producer scans were *already* not
  running. Turning them off changes less than it appears to.
- **#2264** — the playbook's WIP-limit-of-1 deadlock.
- **#2126**, **#2006** — Dependabot-bridge defects.

## Re-enabling

Un-comment the `schedule:` blocks; the crons are preserved verbatim behind `#`
with a `[tracer-phase]` marker. To find every one of them:

```bash
grep -rn "\[tracer-phase\]" .github/workflows/
```

Scheduled workflows run from the **default branch**, so a cron change takes
effect only once merged to `main`. Until then the old schedule is still live —
disable the workflows in the Actions UI if you need the shutoff immediately.

## The priority scheme while this is in force

- **P0** — on the tracer path, carrying the `tracer` label. Nothing else may
  hold P0 in adepthood. Creek Vault additionally keeps four tier-safety
  guardrails at P0 (#1031, #1106, #1212, #1529) because the tracer runs are what
  push real journal content across the boundary those issues protect.
- **P1** — has an open PR. Finish what is already in flight rather than
  stranding it.
- **P2** — real, hand-written work that is neither on the path nor in flight.
- **P3** — parked: scan-generated findings, deferred epics, and anything
  blocked on an upstream decision.

`scripts/ralph/pick-next.sh` orders by `[priority tier, issue number ascending]`,
so this puts the tracer path at the front of the queue by construction. Because
P0 and P1 together are small and the fleet is idle, nothing reaches the P2/P3
boundary during this phase — the distinction is kept because it carries real
signal about relative value, not because it changes what runs next.

Every open issue in both repositories now carries exactly one tier. The legacy
`priority-high` / `priority-medium` / `priority-low` labels are retired.

New issues are filed by hand, only from observed failures.
