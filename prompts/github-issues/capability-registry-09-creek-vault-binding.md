# capability-registry-09: Creek Vault MCP binding (client of `creek-tools-mcp`)

**Labels:** `enhancement`, `architecture`, `backend`, `frontend`, `mcp`, `capability-registry`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** 08
**Estimated LoC:** ~300

## Role

You are a full-stack engineer implementing the **client** side of an integration
whose server side already exists: the Creek Vault ships an MCP server,
`creek-tools-mcp`, that explicitly names Adepthood as a consumer — its
`creek.journal` tool docstring reads *"Ingest one Adepthood journal entry as a
vault fragment (idempotently)."* Your job is to honour that contract, not
design a new one.

## The contract (verified 2026-07-01 from `geoffe-ga/creek-vault` @ `main`, `creek-tools/creek_mcp/`)

- **Server:** `creek-tools-mcp`, built on the official `mcp` Python SDK
  (`mcp.server.fastmcp.FastMCP`). 31 tools named `creek.{action}`.
- **Transports:** `stdio` (default) and `streamable-http` (default bind
  `127.0.0.1:8000`) with **bearer-token auth** (`ConsumerTokenVerifier`).
- **Tier model (aligns with Adepthood #895):** tiers `open / personal /
  intimate`; `TierCeiling` enum `OPEN < PERSONAL < INTIMATE < ALL` with rank
  admission. **Remote callers are capped:** `_REMOTE_ADMITTED_CEILINGS =
  {OPEN, PERSONAL}` — intimate content is unreachable over the network, and the
  handshake advertises an "intimate never egresses" policy. Every tool takes
  `privacy_tier_ceiling` + a free-form `consumer` audit id; writes above the
  ceiling are **refused, never downgraded**; calls land in a hash-chained audit
  log.
- **Tools relevant to v1:**
  - `creek.handshake(vault_path, capabilities, server_name, privacy_tier_ceiling, consumer)`
    → `{available, contract_version, ontology_version, tiers, tier_model, capabilities, …}`.
    Must be called first; gate everything on `contract_version` / `ontology_version`.
  - `creek.journal(vault_path, content, external_id, timestamp?, tier="open", privacy_tier_ceiling, consumer)`
    → `{status, external_id, fragment_id, action ∈ created|updated|unchanged, tier}` or a
    structured refusal. `external_id` is the idempotency key **Adepthood supplies**.
  - `creek.wheel(vault_path, privacy_tier_ceiling, consumer)` → per-frequency
    balance map `{F1..F10: {name, count, share}, total_classified, unclassified}`.
  - (Later reads: `creek.reflect`, `creek.state.read` — out of v1 scope.)
- **Precedent consumer:** `crawdad/` (Discord bot) already consumes
  `creek-tools-mcp`; Adepthood is the second client, not the first.

## Goal

Bind the Vault through the MCP client seam (08) as an opt-in capability:
(a) **outbound** — a `creek_vault` capability with verb `save_to_vault` whose
`execute` (05) calls `creek.journal`, surfaced as a normal confirmable
`ActionSuggestion`; (b) **inbound context** — read `creek.wheel` to show
corpus-side Wavelength balance alongside Adepthood's engagement-side wheel.
Off by default; consent-gated; tier-mapped.

## Tasks

1. **Handshake + config:** connect via `streamable-http` + bearer token (env:
   `CREEK_VAULT_URL`, `CREEK_VAULT_TOKEN`, `CREEK_VAULT_PATH`); call
   `creek.handshake` with `consumer="adepthood"` at startup (health-check style:
   loud-but-non-fatal log, mirroring `_log_content_status`). Refuse to enable
   the capability if `contract_version`/`ontology_version` are unknown.
2. **Tier mapping module** (`backend/src/domain/ontology.py`): map
   `JournalClassification` ↔ Creek tiers. **Note the naming mismatch:**
   Adepthood `public` ↔ Creek `open`; `personal`/`intimate` map 1:1. Also map
   Adepthood's 10 stages/Aspects ↔ Creek's `F1..F10` frequencies (validate
   canonical names against the `creek.wheel` response; drift test).
3. **Outbound capability:** register `creek_vault` (flag `creek_vault`, verb
   `save_to_vault`). Execute calls `creek.journal` with
   `external_id=f"adepthood-journal-{entry_id}"` (idempotent — safe to re-accept),
   `tier` from the entry's **persisted** classification, `timestamp` from the
   entry. Handle `action` (created/updated/unchanged) and structured refusals
   (surface, don't retry-downgrade). **Intimate entries are never offered this
   verb at all** — enforce client-side from the persisted classification (the
   exact pattern of `routers/journal.py`'s #895 gates), on top of the server's
   remote ceiling cap. Defense in both directions.
4. **Inbound context:** a read path that fetches `creek.wheel` (ceiling
   `PERSONAL`) and exposes corpus balance to the Map/wheel view as a clearly
   labelled second series — Adepthood's wheel measures *engagement fullness*
   (`domain/wheel.py`), Creek's measures *corpus share*; never conflate them.
5. **Frontend:** Vault entry in the feature manifest (06) + settings toggle;
   proposals render in the existing inbox (07) with no inbox changes.
6. **Tests:** handshake gating (unknown contract version → capability disabled);
   tier mapping incl. `public→open`; idempotent double-accept (`unchanged`);
   refusal handling; intimate entries excluded from candidates and from
   `save_to_vault`; wheel mapping drift test. Mock the MCP client; do not
   require a live vault in CI.

## Deployment topology — decide before implementing

`creek-tools-mcp` is **local-first** (default bind `127.0.0.1:8000`); the
Adepthood backend is cloud-deployed. A cloud backend cannot reach a laptop's
loopback. Options (pick one in the PR, document in `docs/`):
- **(a) Self-hosted vault endpoint:** user exposes the vault server (tailscale /
  reverse proxy) and pastes URL + bearer token into Adepthood settings. Simplest
  server-side; per-user config.
- **(b) Device-mediated sync:** the *frontend* (on the user's machine/phone)
  performs the MCP calls to the local vault, pulling confirmed suggestions from
  the backend. No cloud→home connectivity needed; more moving parts.
- **(c) Outbox queue:** backend queues confirmed `save_to_vault` actions; a
  small local agent (or the CLI) drains the queue into the vault.

v1 recommendation: (a), since bearer auth + `streamable-http` already exist
server-side; (b)/(c) are follow-ups if (a)'s setup burden proves too high.

## Acceptance Criteria

- [ ] `creek.handshake` is called first; capability auto-disables on contract/ontology version mismatch.
- [ ] Tier mapping is exact (`public→open`), drift-tested, and **intimate entries never leave the app** — excluded from candidates, verbs, and context reads (client-side, on top of the server's remote ceiling).
- [ ] `save_to_vault` flows proposal→confirm→execute through the standard pipeline and is idempotent via `external_id`.
- [ ] Refusals surface as structured errors; the client never downgrades a tier to force a write.
- [ ] `consumer="adepthood"` on every call (Creek's audit log requirement).
- [ ] Vault is off by default; enabling is an explicit settings action.
- [ ] `pytest backend/` + frontend suite + `pre-commit run --all-files` green.

## Files (indicative)

| File | Action |
|------|--------|
| `backend/src/services/mcp_client.py` | Modify (vault connection + handshake) |
| `backend/src/domain/ontology.py` | **Create** (tier + frequency mapping, drift tests) |
| `backend/src/domain/capability_defs.py` | Modify (register `creek_vault`) |
| `backend/src/routers/journal.py` or map router | Modify (wheel context read) |
| `frontend/src/features/manifest.ts` | Modify (Vault entry + settings toggle) |
| `backend/tests/test_creek_vault_binding.py` | **Create** |

## Constraints

- The contract is Creek's; do not fork it. If a needed field is missing,
  change `creek-tools-mcp` first (it versions via `contract_version`).
- Remote calls are consent-gated and minimal-payload; the privacy floor is a
  hard gate enforced from the **persisted** classification, never client input.
- This is the reference remote-MCP integration; keep the client shape generic
  enough that a second remote server is config, not code.
