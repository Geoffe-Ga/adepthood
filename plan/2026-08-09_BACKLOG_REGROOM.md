# 2026-08-09 — Cross-repo backlog re-groom: refilling P0/P1

Scope: `adepthood`, `creek-vault`, `windbreak`. 373 open issues total
(adepthood 70, windbreak 88, creek-vault 215).

## The problem this fixes

The absolute-severity P0/P1 pool had been worked to empty. What remained:

| Repo | Open | P0 | P1 | Pickable P0/P1 |
|---|---|---|---|---|
| adepthood | 70 | 3 | 8 | **0** |
| windbreak | 88 | 0 | 0 | **0** |
| creek-vault | 215 | 0 | 3 | 3 |

Every adepthood P0/P1 carried `epic`, `blocked`, or `needs-spec` — all three in
`pick-next.sh`'s default `RALPH_EXCLUDE_LABELS`. So tiers 0 and 1 were
*structurally* empty.

The consequence is not that the fleet starves — it still picks P2s. It is that
**the ordering signal is dead**. `pick-next.sh` walks candidates by
`[priority tier, number ascending]`. With ~everything at P2/P3, that degenerates
to "oldest issue number first", which is uncorrelated with value. The fleet was
choosing work essentially at random.

Two structural causes, both fixed here:

1. **Epics carried the priority; their children did not.** `epic:integration-testing`
   is P1, `epic:dast` is P1, `epic:gumroad-access` is P1, `epic:vault-http-cutover`
   is P0 — and every implementable child of all four was filed P2. The tier lived
   on the one issue the picker is guaranteed to skip.
2. **Absolute severity was applied to pre-launch systems.** "Prod-down" never
   happens to a product with no production, so nothing could ever earn P0 and
   everything compressed into P2.

## The re-scaled rubric

The house rubric (`.claude/skills/flare/references/label-guide.md`) is kept
verbatim; what changes is what counts as "critical" *for each system's actual
promise*:

- **P0 — invalidates the system's core promise, or blocks everything else.**
  A privacy vault that leaks tier-gated content. A trading system whose money
  invariants breach. A merge gate that can be forged. Anything blocking an
  already-P0 epic.
- **P1 — core flow broken with no workaround, or directly unblocks a P0.**
  Includes cross-repo dependencies of a P0 epic, shipped-but-dead features, and
  children of P1 epics.
- **P2 — degraded with a workaround; well-scoped feature.** Unchanged.
- **P3 — hygiene.** Unchanged: the `scan:coverage` / `scan:deps` / `de-slop`
  pools stay here. They are the bulk of all three backlogs and correctly so.

Two inheritance rules applied throughout:

- **A child inherits its epic's tier** unless it is explicitly a follow-on
  extension rather than part of the epic's core deliverable.
- **A cross-repo blocker inherits the tier of what it blocks**, one step down.
  creek-vault's `epic:adepthood-http-api` children gate adepthood's P0 epic
  #2043, so they are P1 in creek-vault.

---

## adepthood — APPLIED

### → P0 (2 new; joins existing #2043, #2073, #2166)

Both are sub-problems of the **P0 throughput epic #2073**, and both corrupt the
gate every other issue depends on:

- **#2138** — the pre-push backend suite calls `pytest` inline, bypassing the
  exclusive whole-suite lock `scripts/backend/test.sh` takes. The lock exists
  because a second concurrent whole-suite run produces a "core-contended,
  untrustworthy" result; the hook that runs on every push evades it.
- **#2126** — `pick-next.sh` reads in-flight work from open PR bodies' `Closes #N`
  lines, which Dependabot regenerates and erases. A bridge issue whose PR is open
  reads as available, so the fleet picks work already in flight.

### → P1 (10 new)

| # | Why |
|---|---|
| #2195 | `epic:integration-testing`. The remaining half of the seam: #2196 committed the OpenAPI doc, this asserts the Zod schemas conform to it. |
| #2038 | Same epic — the export + drift gate this pair rests on. |
| #2040 | Same epic — the journey coverage ledger + CI gate that keeps the gap from reopening. |
| #2128 | Four API wrappers call live backend routes no UI ever reaches. This is precisely the "shipped wired to nothing" failure #2035 exists to prevent, and it is the debt the guard's allowlist records. |
| #1922 | The app still rotates despite the `app.json` orientation setting. Every user, every screen, no workaround. |
| #2068 | Journal writes hold a pooled `AsyncSession` across a Creek Vault network round trip. Under concurrency this exhausts the pool — an availability defect, not a latency nit. |
| #2019, #2021, #2022 | `epic:dast` (P1) core deliverables: the contract-fuzz job, the nightly ZAP scan, and the wrapper that routes findings into Ralph. Without #2022 the epic produces findings nobody acts on. |
| #1946 | `epic:gumroad-access` (P1) — admin entitlement grants/revocations. |

`#2066` (extend the authz-matrix DAST check to body/query) stays P2: it is an
extension of the epic, not part of its core deliverable.

### Readiness fix

- **#2152** — `agent-ready` → `needs-spec`. Its own 2026-08-08 audit banner states
  that "two of the body's load-bearing claims are false" and that the option it
  frames as open is forbidden by the ratified contract. It was pickable as
  written and would have burned a tick on a wrong premise.

### Deliberately left alone

- **#2171** (P1, `needs-spec`) — `POST /journal/upload` ships, is rate-limited,
  validates filenames, and can never reach a vault, because the ratified `/v1`
  capability vocabulary is a closed four-name enum with no upload member. This is
  the single highest-value **human decision** open in adepthood; it cannot be
  promoted into the fleet's queue because it is a contract-version decision, not
  an implementation task.
- **#1331** (`priority-high`, `blocked`) — Return after Clear Light lands at
  Stage 11. Already tier 1; still blocked.

---

## creek-vault — NOT APPLIED (no write access; see script)

Creek-vault's core promise is that tier-gated content does not egress. Every
ceiling bypass is P0-class *for this repo*.

### → P0 (6)

| # | Now | Why |
|---|---|---|
| #1031 | P1 | `creek draft` resolves the classification stage with **no tier**, so the Intimate-never-cloud chokepoint (#647) is a no-op on this path. Intimate bodies egress to a cloud LLM under `--include-tier`. Verified against the router directly. |
| #1212 | P1 | At the default `ALL` ceiling the consent gate reads the validated model tier while the ceiling gate short-circuits — untiered fragments enter the voice corpus. |
| #1152 | P2 | The crawdad **LLM router** path can request `intimate`/`all` with nothing capping it. Every `ToolResult` body is relayed to a cloud LLM composer and then **posted into a Discord message**. The most severe egress path in the set, and its input is LLM-generated rather than operator-authored. |
| #1052 | P2 | Bot-capture bypasses both allowlists, the bot filter, *and* `channel_privacy_tiers` — the boundary `crawdad/CLAUDE.md` §2 names as the enforcement point. |
| #1106 | P1 | Vaults processed before #974 still hold fragments stamped `personal` + `voice_proxy_eligible: true` that should be `intimate` + `false`. They are admissible to PERSONAL-ceiling MCP callers **today** and still feeding voice generation. A live leak on existing data, with no visibility and no remediation path. |
| #1199 | P2 | `pr-ready.sh` honours a `Verdict: LGTM` from **any** comment author, with no author check. Any account that can comment can flip the gate the orchestrator merges on. `iteration-trigger.yml` has the same shape. This is arbitrary-code-into-main via the autonomous fleet. |

### → P1 (16)

Ceiling / egress defense-in-depth: **#1054** (the FEAT-027 redaction gate is
advisory — un-scanned batches still reach `creek.ingest`), **#1213**
(`_eligible_register` omits the `author == SELF` half, so AI-authored prose can
enter the voice corpus, breaking a documented guarantee), **#971**
(`skills.refresh` never threads the ceiling), **#931** (above-ceiling parent
titles leak into the compile prompt), **#1036** (the read-gate canary probe
cannot see a prompt-side leak), **#1087** (the redaction scan walk follows
symlinks out of the scan root — reproduced against a real intimate fragment),
**#1088** (a configurable `staging_subpath` falls outside the scan's canonical
scope, silently disabling the safety pass).

Auth / destruction: **#914** (the purge gate — the check standing between a
caller and irreversible vault destruction — has no failed-attempt backoff),
**#895** (static non-rotating consumer tokens; the TTL bounds the in-memory
`AccessToken`, not the wire credential).

Data integrity: **#1120** (a failed mid-line `.id-index.jsonl` append corrupts
the *next* append too — both entries lost), **#1083** (`update_fragment`
rewrites the index's target without verifying the file's own id).

Fleet integrity: **#1200** (pairs with #1199 — `pr-ready.sh` cannot tell a failed
`claude-review` from a real CI failure, so a reviewer malfunction dispatches a
fix worker).

Cross-repo, gating adepthood's P0 epic #2043: **#1129**, **#1128**, **#1127**,
**#1130** (`epic:adepthood-http-api`). The docs-only children #1131, #1132 and
#1133 stay P2.

---

## windbreak — NOT APPLIED (no write access; see script)

Windbreak had **zero** P0 and **zero** P1 across 88 open issues, and is
pre-v1.0.0. Its core promise is that money invariants hold and risk controls
actually work.

### → P0 (2)

- **#423** — a resting order withholds collateral from `available` and no
  ledgered entry accounts for the reservation, so the **cash reconciliation
  dimension breaches** the moment an order rests (`cash_drift: 1_200_000` micros,
  measured on #422's fixture). Reconciliation is the risk kernel's safety spine;
  a permanently-breaching dimension means real drift cannot be distinguished from
  this artifact. #422's tests already had to narrow their assertions around it.
- **#413** — the kill-switch `AlertEmitted` ledger row proves *emission*, not
  *delivery*. If every sink fails, the row is byte-identical to the
  all-sinks-succeeded case: a post-incident audit can establish the kill switch
  fired and why, but not that anyone was told. A safety control that can silently
  not work.

### → P1 (6)

| # | Why |
|---|---|
| #265 | `build_vote_prompt` inlines `market.title` / `resolution_criteria` verbatim into the **trusted scaffold region** with no delimiter neutralization. Upstream-sourced text steering the component that decides trades. |
| #313 | Pubdate extraction is temporal-leakage-critical; a silent regression dates a source wrongly and leaks the future into a forecast — look-ahead bias invalidates the whole track record. |
| #318 | The egress allowlist is a security boundary and its production-vs-demo host branch is untested. A demo/prod host mixup on a live trading connector is a real-money event. |
| #387 | `PaperExchange.advance()` is never called in production, so an always-on PAPER run sits on replay step 0 forever. PAPER is the evidence source for the promotion gates — frozen replay makes promotion evidence bogus. |
| #252 | The WAL corruption guard (a journalled record re-deriving a different `client_order_id`) is untested. Order-gateway integrity, money path. |
| #122 | All 10 quality tiles on the live dashboard read N/A — the entire observability surface is dead. |

`#101` (widen sanitizer hidden-text coverage) stays P2 on the issue's own
assessment: "none of these is a bypass of the current defense". `#210` (widen
bandit to `scripts/`) stays P2.

---

## Resulting queue depth

| Repo | P0 | P1 | Pickable P0/P1 |
|---|---|---|---|
| adepthood | 5 | 18 | **12** |
| creek-vault | 6 | 19 | ~22 |
| windbreak | 2 | 6 | **8** |

Everything not named above keeps its current tier. The P3 hygiene pools
(`scan:coverage`, `scan:deps`, `scan:mutation`, `de-slop`) are untouched — they
are the majority of all three backlogs and are correctly ranked.
