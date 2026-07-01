# Creek Vault MCP contract (adepthood's required surface)

- **Status:** Draft — pending cross-repo agreement with Creek Vault (epic
  [#949](https://github.com/Geoffe-Ga/adepthood/issues/949))
- **Contract version:** 0.1.0-draft
- **Date:** 2026-07-01
- **Issue:** [#950](https://github.com/Geoffe-Ga/adepthood/issues/950) (epic
  [#949](https://github.com/Geoffe-Ga/adepthood/issues/949); boundary
  [#927](https://github.com/Geoffe-Ga/adepthood/issues/927))

## Purpose

This document is adepthood's *required* Model Context Protocol (MCP)
surface for Creek Vault: the capabilities adepthood will call, and the
guarantees adepthood expects Creek Vault to uphold, in order to build
its client side of the vault seam. Creek Vault implements against this
contract; nothing here is binding on either repository until both sides
ratify it — see "Versioning and ratification" below. This document
follows on from [ADR 0002](adr/0002-intimate-content-local-routing.md),
whose "Open question — intimate transit across the seam" section this
contract resolves.

## Shared ontology and tier mapping

Adepthood's **Aspects**, Creek's **Frequencies**, and the **Wavelength
phases** are one vocabulary under three names. Adepthood's concrete
shapes are `WheelAspect` / `WheelBalanceResponse`
(`backend/src/schemas/wheel.py`) and `FrequencyResponse`
(`backend/src/schemas/frequency.py`, fields including `stage_number`,
`color`, `aspect`, `practice_name`). Any capability that classifies or
reflects on content in Frequency/Wavelength-phase terms is describing
the same ten-Aspect ontology adepthood already renders locally.

Adepthood's privacy tiers (`JournalClassification`,
`backend/src/models/journal_entry.py`) map onto Creek's tier ceiling
enum (`TierCeiling`) as follows. Note the `PUBLIC`/`OPEN` name
mismatch — the two repositories chose different words for the same
tier:

| Adepthood `JournalClassification` | Creek `TierCeiling` |
| --- | --- |
| `PUBLIC` | `OPEN` |
| `PERSONAL` | `PERSONAL` |
| `INTIMATE` | `INTIMATE` |

Adepthood's client owns this mapping and applies it before every call
into the vault; it is not something Creek Vault is expected to infer.
Ontology version (the Aspect/Frequency vocabulary itself, independent
of tier naming) is negotiated during `creek.handshake`, so either side
can evolve the ten-Aspect model without breaking the other.

## Capability surface

Adepthood identifies itself to Creek Vault as `CREEK_MCP_CONSUMER`.
The full set of capabilities a given vault supports is advertised via
`creek.handshake`; adepthood must not assume a capability exists
without first seeing it in a handshake response.

### Handshake and availability — creek.handshake

Direction: adepthood -> vault. The first call adepthood makes to a
configured vault. Establishes whether a vault is present and reachable
at all, returns the list of capabilities that vault supports, and
negotiates both contract-version and ontology-version compatibility.
Also returns whatever attestation evidence adepthood needs to decide
whether the vault's confidential-compute enclave is trustworthy for
the write-path guarantees in "Decision (b)" below. Tier semantics: the
handshake itself carries no tiered content, so it is safe to call at
any privacy tier. If `creek.handshake` fails or times out, adepthood
falls back fully to the local pipeline — see "Graceful degradation."

### Ingest and store — creek.ingest + creek.save

Direction: adepthood -> vault. Hands a piece of writing, together with
its source and metadata (tier, timestamp, Aspect/Frequency tags where
already known), to the vault for durable storage. Tier semantics:
callable for any tier, but INTIMATE-tier calls are permitted only
under the attestation-gated conditions in "Decision (b)" below; OPEN
and PERSONAL calls carry no such precondition. If these capabilities
are absent from the handshake, adepthood does not ingest into the
vault at all and the operator's own Postgres remains the sole system
of record for that content.

### Classification — creek.classify

Direction: adepthood -> vault, vault -> adepthood. Requests
Frequency and Wavelength-phase tags for a piece of content, or for the
user's corpus as a whole (per-content and per-corpus classification
are both in scope). Tier semantics: classification of INTIMATE content
follows the same attestation-gated write path as ingest. The existing
`creek.link` and `creek.report` tools are adjacent to classification
but are not required capabilities under this contract — they are
mentioned here only because a vault that implements `creek.classify`
is likely to expose them too. If `creek.classify` is absent, adepthood
continues to rely on its own local Aspect/Frequency assignment.

### Reflection — creek.reflect

Direction: adepthood -> vault, vault -> adepthood. Produces the Higher
Self voice: an anchored note or short essay grounded in retrieval over
the user's *own* corpus, never another user's. Tier semantics:
reflections grounded in INTIMATE content inherit the INTIMATE tier on
output — see "Decision (c)" below for the full handling rule. If
`creek.reflect` is absent, adepthood does not attempt a Higher Self
reflection for that call; it does not substitute a cloud-LLM call in
its place for INTIMATE-tier content (per ADR 0002 Decision 3).

### Wheel and balance read — creek.wheel

Direction: vault -> adepthood. Optional. Returns a Wheel-of-Wholeness
balance read (the same shape as adepthood's local
`WheelBalanceResponse`) computed from the fuller corpus the vault
holds. Advertised via `creek.handshake` like every other capability.
Tier semantics: a wheel read never exposes INTIMATE plaintext itself,
only aggregate fullness values. If `creek.wheel` is absent from the
handshake, adepthood falls back to computing `WheelBalanceResponse`
locally from the entries it already has.

## Guarantees adepthood enforces before calling

| Gate | Owner | When |
| --- | --- | --- |
| Care gate | Adepthood (pre-call) | Before every `creek.reflect` call |
| Medication guardrail | Both (adepthood pre-call, vault as defense in depth) | Every reflection prompt, in-app and vault-side |
| Privacy tier labeling | Adepthood | Before every vault call |
| Privacy tier routing enforcement | Creek `ModelRouter` | At the transport boundary |
| BYOK key use | Adepthood | OPEN/PERSONAL only |

**Care gate — adepthood owns this, pre-call.** Before any
`creek.reflect` call, adepthood runs `domain.safety.assess_distress`
on the content in question. On an acute ("elevated") signal, adepthood
serves `build_care_payload` — `CARE_MESSAGE` plus `CARE_RESOURCES`
(each a `CareResource`, together a `CarePayload`) — and does not call
the vault for a reflection on that content. `MEDICATION_GUARDRAIL` (no
medication advice) is enforced pre-call on adepthood's side; this
contract additionally *requires* `creek.reflect` to honor the same
guardrail vault-side, as defense in depth rather than as the only
line.

**Privacy gate — split ownership.** Adepthood owns honest tier
labeling via `JournalClassification` and the tier mapping in "Shared
ontology and tier mapping" above. Creek's `ModelRouter` owns routing
enforcement and the `TierCeiling` check at the transport boundary. Per
ADR 0002 Decision 3, adepthood builds no second routing gate of its
own; it passes the tier through honestly and trusts the vault's router
to enforce it.

**BYOK — OPEN/PERSONAL only.** Bring-your-own-key reflection, via the
user's own Anthropic/OpenAI/Gemini key, continues to use the existing
`ApiKeySettings` pattern (`resolve_chat_api_key` in
`backend/src/services/botmason.py`; `ApiKeySettingsScreen` and
`frontend/src/storage/llmKeyStorage.ts` on the frontend). BYOK is never
used for INTIMATE-tier content; that content only ever reaches a model
through the attested vault path in "Decision (b)" below.

## Decision: the intimate-transit rule

ADR 0002 named four sub-questions about intimate content crossing the
adepthood-to-vault seam and deferred them to this contract. This
section settles all four.

### (a) Transit topology: yes, ciphertext only.

Intimate content may cross the seam through adepthood's backend, but
only as client-side-encrypted ciphertext under a key held by the user,
not the operator. The operator backend is a blind relay: it cannot
decrypt the content in transit. Plaintext exists only inside the TEE,
after attestation-gated key release (ADR 0002 Decision 2).

**Rejected —** plaintext through the backend. This would make the
content operator-visible in transit, exactly the trust boundary ADR
0002 exists to remove.

**Rejected —** forbidding intimate transit entirely. This contradicts
#927's TEE rationale: the Higher Self voice is generated *inside* the
enclave, so the encrypted entry must arrive there somehow.

### (b) Write-vs-read asymmetry: writes under attestation; read ceiling stands.

`creek.ingest`, `creek.save`, and any reflection-compute call on
intimate content are permitted only after the vault's enclave has
successfully completed remote attestation. This is a write-path rule
and does not touch #927's read-path guarantee: `TierCeiling` still
means no remote read of INTIMATE plaintext, and the vault never
returns intimate corpus content on any read path — only tier-labeled
reflection output, per (c) below.

### (c) Reflection-output provenance: INTIMATE, and it may return.

A reflection grounded in the intimate corpus carries the INTIMATE tier
on its way back out. It returns to the app only over the same
end-to-end-encrypted channel used for ingest — ciphertext to the
operator, decrypted client-side — and once in-app it inherits full
intimate handling: never linked into the usage log, never sent to a
cloud LLM, and never re-ingested at a lower tier. This mirrors the
shipped skip-only intimate exclusions already in
`backend/src/routers/journal.py`, `backend/src/domain/resonance.py`,
and `backend/src/domain/detection.py`.

**Rejected —** vault-side-only reflections that never return to the
app. This would defeat the Higher Self product for intimate writing
entirely.

**Rejected —** tier downgrade on the way back. An intimate reflection
that lost its tier label on return would silently bypass every
downstream intimate guarantee.

### (d) Custody end-state: dual-homed for v1.

Operator Postgres remains the system of record for v1: continuity,
offline behavior, and graceful degradation all depend on that data
being locally available regardless of vault reachability. Once an
entry's vault write has been attested (per (b) above), intimate
entries are *additionally* ingested into the vault as ciphertext, so
reflection compute has something to work from. This is a deliberate
custody-inversion follow-up, recorded here explicitly and left
unresolved: a post-v1 decision about whether the vault should become
the sole intimate home, with operator Postgres no longer holding
intimate content at all.

**Rejected —** immediate migration to vault-only custody. A vault
outage would break the journal floor, which must keep working with no
vault present at all (see "Graceful degradation").

**Rejected —** local-only intimate content for v1, with no vault
ingest path. This nullifies intimate reflection entirely and
contradicts ADR 0002 Decision 2's TEE rationale for building
confidential compute in the first place.

## Graceful degradation

If `creek.handshake` is absent, unreachable, or fails, adepthood falls
back fully to its current local pipeline: the journal floor stays
fully functional, the shipped skip-only intimate behavior persists
unchanged, and the Wheel of Wholeness is served from local
`WheelBalanceResponse` computation. No feature adepthood ships today
depends on a vault being present.

Degradation is also per-capability, not all-or-nothing. A vault that
implements `creek.handshake`, `creek.ingest`, `creek.save`, and
`creek.classify` but not `creek.wheel` still gets used for everything
it supports; adepthood simply keeps computing the wheel locally for
that user. Capabilities are re-probed on the next handshake, so a
vault that adds a capability later is picked up automatically without
any client-side migration.

No data is lost in either direction: content written locally while a
vault is unavailable is not silently dropped when the vault reappears,
and content already in the vault is never required for the local
journal to keep working.

## Versioning and ratification

The contract version at the top of this document follows semantic
versioning and is negotiated during `creek.handshake`, alongside the
ontology version described in "Shared ontology and tier mapping."
Breaking changes to the required capability surface bump the major
version; new optional capabilities (like `creek.wheel`) bump the
minor version.

This document tracks epic [#949](https://github.com/Geoffe-Ga/adepthood/issues/949)
and Creek's routing chokepoint, `ModelRouter` (creek-vault#642). Its
Status field flips from Draft to Accepted only once both the adepthood
and Creek Vault repositories have signed off on this surface.
