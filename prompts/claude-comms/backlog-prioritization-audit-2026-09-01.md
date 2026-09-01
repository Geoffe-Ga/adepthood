# Backlog Prioritization Audit — 2026-09-01

Audit of both backlogs (adepthood: 110 open issues; Creek-Vault: 217 open
issues), the sources that populate them, and the mechanism that decides what
the Ralph fleet works on. Triggered by the observation that PR titles were
dominated by environment/CI/deps work while feature shortfalls sat idle.

## Root cause

The fleet picker (`scripts/ralph/pick-next.sh`) walks candidates by
`[priority tier, issue number ascending]` and requires `agent-ready`
(fully specified, unblocked). The critical path to the MVP is almost
entirely **not in that pool**:

- Every adepthood P0 is an `epic`, a `[HUMAN ACTION]`, `blocked`, or
  `needs-spec` — none is `agent-ready`, so tier 0 is empty for the picker.
- Creek-Vault had **zero** P0/P1 issues at all.
- The P2 tier — the first tier with a deep `agent-ready` pool — was
  dominated by infra, CI-tooling, dependency-adoption, scan-generated,
  and test-lane work.

So the fleet did exactly what it was told: it drained the P2 chore pool,
oldest first. That is why the PR feed read as "nothing but environment."

A second finding: adepthood's True-Voice epic (#2569) — the product's core
loop — was blocked on Creek-Vault provisioning infrastructure that **had no
open issue in Creek-Vault**. The closed epics #748/#757 ratified the
architecture (ADR-0005/6/7) but nothing tracked building the surface.

## Inflow sources (audited)

The 2026-08-26 pause (Creek-Vault PR #1675 and the adepthood equivalent)
already disabled the scheduled producers: all `scan-*` producers, `deslop`,
`hopper`, `weekly-playbook`, and the Dependabot→issue bridge's
`pull_request_target` trigger. Still-active schedules are consumers or
monitors (scan-groom, graph builds, issue-evidence — advisory comments only,
scheduled-health, creek-contract-drift) plus `dast-deep` (nightly, added
deliberately post-pause in PR #2565).

Residual inflow therefore comes from:

1. **The loop's own exhaust** — review follow-ups, flare-filed findings, and
   ralph/CI self-maintenance issues filed by working sessions (~8 filed on
   2026-09-01 alone), mostly landing at P2 where the picker eats them next.
2. **Manual `workflow_dispatch` of paused scans** (the 2026-08-31 Dependabot
   backfill batch, the 2026-09-01 scan:complexity/scan:deps filings).
3. **Monitors** filing tracking issues (e.g. #2579 "scan-groom is failing").

Recommendation: when filing follow-ups from working sessions, default them
to P3 unless they block a user journey; the pause on scheduled producers is
working and should hold until the MVP ships.

## Actions taken (2026-09-01)

### Deprioritized — adepthood, P2 → P3 (or unprioritized → P3)

Ralph/infra tooling: #2594, #2551, #2559, #2579, #2165 ·
test-lane/e2e-infrastructure: #2543, #2536, #2408, #2324, #2317, #2568 ·
DAST expansion: #2469, #2022, #2018 · lint/deps future-proofing: #2437,
#2336 · Dependabot-adoption chores: #2553, #2554, #2555, #2556.

Kept at P1 despite being "environment": #2590 (`expo install --check` fails
on main) — it breaks the frontend gate for every branch, so it genuinely
blocks all other work.

### Deprioritized — Creek-Vault, P2 → P3 (or unlabeled → P3)

Ralph/CI self-maintenance: #1718, #1713, #1708, #1685, #1521, #1201 ·
scan-generated: #1447, #1391, #1389, #1388, #1386, #1385, #1719, #1720,
#1714 · non-seam features: #1220, #1204, #1069, #1014 · DAST expansion:
#1008.

### Prioritized — the Adepthood↔Creek-Vault seam (Creek-Vault)

- **#1724 (new, P1, needs-spec)**: provisioning surface for per-user vaults
  — the missing upstream blocker of adepthood #2575/#2569. Names the three
  owner decisions (hosting shape/cost, key ceremony, control-plane owner).
- **#1605 → P1 + agent-ready**: async job surface for `/v1`, without which
  LLM classification and embeddings linking are unreachable over the
  network (direct blocker of adepthood #2570).
- **#874 → P1**: per-entry classification capability for the Adepthood
  contract.
- **#1606** left at P2 per the owner's written "why this is P2" rationale.

### Not touched

P3s (already bottom tier), `blocked`/`needs-spec`/`[HUMAN ACTION]` items
(picker-invisible by design), privacy-correctness P2s in Creek-Vault
(product-core, not chores), and all workflow schedules (the 08-26 pause
posture was a deliberate owner decision and is still in effect).

## What unblocks the showstoppers now

The picker's reachable front of queue after this audit:

- **adepthood**: P1 `agent-ready` — #2571, #2570 (True-Voice), #955 (vault
  connect UI); then the P2 feature epics (rescaffold, journal-writing-timer,
  practice features, seeding).
- **Creek-Vault**: P1 — #874, #1605 (`agent-ready`); #1724 once specced.
- **Human-gated** (no agent can move these): #2243/#2234 store/legal,
  #2032 OAuth credentials, #1940 Gumroad setup, #2329 EAS build,
  #2319 Postgres backups — plus the three owner decisions in
  Creek-Vault #1724. These are the true critical path of the MVP.
