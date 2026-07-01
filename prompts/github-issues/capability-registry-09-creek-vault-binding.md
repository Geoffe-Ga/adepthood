# capability-registry-09: Creek Vault MCP binding + external capability

**Labels:** `enhancement`, `architecture`, `backend`, `frontend`, `mcp`, `capability-registry`, `blocked`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** 08
**Blocked on:** `geoffe-ga/creek-vault` repository access (not in this session's GitHub scope)
**Estimated LoC:** ~300

## Role

You are a full-stack engineer wiring the first **remote** MCP server — the Creek
Vault — as a capability source, realizing the seam `NORTH-STAR.md:70` promises
and the shared ontology it names (Adepthood's Aspects = Creek's Frequencies =
the Wavelength phases). This is also the template for future outbound plugins
(Apple Shortcuts, other apps).

## ⚠️ Blocked — read first

The `geoffe-ga/creek-vault` repo is **not configured for this session's GitHub
scope** (verified: `Access denied … Allowed repositories: geoffe-ga/adepthood`).
Its MCP server framework, transport (stdio vs HTTP/SSE), exposed tools/resources,
auth model, and the concrete shared-ontology representation are therefore
**unconfirmed**. Before implementing:

1. Add `geoffe-ga/creek-vault` to the environment's allowed repositories and
   resume the session.
2. Pin this issue's tool names, input schemas, transport, and auth to the Vault's
   **actual** MCP manifest — do not invent them.

Everything below is design-complete against the *general* MCP shape and must be
reconciled with the real manifest at implementation time.

## Goal

Register a `creek_vault` capability (and/or context source) backed by the remote
Vault MCP server: (a) pull shared-ontology context (the Aspect/Frequency/
Wavelength mapping and any user-scoped Vault notes) to enrich the Higher Self
reflection, and (b) expose one round-trip write/read verb (e.g. "save this
reflection to the Vault" / "recall my Vault note on <Aspect>") as a **confirmed**
capability action. Off by default; consent-gated per action.

## Context

08 built the MCP client seam and local tools. This issue connects the first
remote server through that seam and adds an external-capability example so the
"talk to other apps" story is demonstrated end to end while honouring the privacy
floor.

## Tasks (reconcile with the real manifest)

1. **Vault connection:** configure the Vault MCP server in `mcp_client.py`
   (transport + auth from env/secret, never hard-coded); health-check at startup
   with a loud-but-non-fatal log (mirror `_log_content_status` /
   `_log_botmason_provider`).
2. **Shared-ontology mapping:** a typed mapping module asserting Adepthood stage
   ↔ Aspect ↔ Frequency ↔ Wavelength phase, sourced from / validated against the
   Vault's representation. Add a drift test.
3. **Context source:** allow the resonance/Higher-Self pass to *optionally*
   include Vault-sourced context for the current Aspect — read-only, and only
   when the user has enabled the Vault ring (02) and consented.
4. **Outbound capability:** a `creek_vault` capability with a verb like
   `save_reflection` whose `execute` (05) calls the Vault MCP tool. It surfaces
   as a normal confirmable `ActionSuggestion` in the inbox (07). **Privacy:** the
   payload contains only what the user confirmed in the proposal — never raw
   journal text implicitly; encrypted/intimate entries are never forwarded.
5. **Frontend:** a Vault feature manifest entry (06) + a settings toggle; the
   capability's proposals render in the existing inbox with no inbox changes.
6. **Tests:** ontology drift test; Vault client mocked for save/recall round-trip;
   capability disabled → no candidates, no context, no outbound calls; consent
   gate enforced.

## Acceptance Criteria

- [ ] Tool names/schemas/transport/auth match the **actual** creek-vault manifest (not invented).
- [ ] Vault is **off by default**; enabling is opt-in and per-action consent-gated.
- [ ] The shared ontology (Aspect = Frequency = Wavelength phase) is represented once, validated against the Vault, drift-tested.
- [ ] An outbound Vault action flows through the standard proposal→confirm→execute path and inbox.
- [ ] Privacy floor holds: no journal text (esp. encrypted entries) is sent to the Vault without explicit per-action consent.
- [ ] `pytest backend/` + frontend suite + `pre-commit run --all-files` green.

## Files (indicative — confirm against manifest)

| File | Action |
|------|--------|
| `backend/src/services/mcp_client.py` | Modify (remote Vault connection) |
| `backend/src/domain/ontology.py` | **Create** (shared mapping + drift test) |
| `backend/src/domain/capability_defs.py` | Modify (register `creek_vault`) |
| `backend/src/routers/journal.py` | Modify (optional Vault context in resonance) |
| `frontend/src/features/manifest.ts` | Modify (Vault entry + settings toggle) |
| `backend/tests/test_creek_vault_binding.py` | **Create** |

## Constraints

- Do not implement until the creek-vault manifest is in scope and pinned.
- Remote calls are consent-gated and minimal-payload; the privacy floor is a hard
  gate, not a preference.
- This is the reference implementation for future outbound plugins (Apple
  Shortcuts, etc.) — keep the remote-capability shape generic enough to reuse.

## Future (out of scope, noted for the roadmap)

- **Apple Shortcuts capability:** a `shortcut` capability whose `run` verb invokes
  a Shortcut (via an MCP bridge or a deep link), letting the journal drive other
  apps — the same proposal→confirm→execute path, a different `execute` handler.
- Dropping the legacy depth-preference boolean columns once nothing reads them (02).
- Community-shared capability plugins (leaning on the `approved` column pattern
  already in `Practice`).
