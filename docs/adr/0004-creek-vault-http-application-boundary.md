# ADR 0004: Creek Vault application boundary moves to HTTP/JSON; MCP retained for agents

- **Status:** Accepted
- **Date:** 2026-07-31
- **Issue:** [#2044](https://github.com/Geoffe-Ga/adepthood/issues/2044)
  (epic [#2043](https://github.com/Geoffe-Ga/adepthood/issues/2043))
- **Pinned contract version:** 0.2.0 (tracks Creek's published
  constant; /v1 PENDING creek-vault#1072)

## Context

Adepthood's Creek Vault client and Creek's actual published surface
have drifted in five concrete places, discovered while auditing the
seam for this ADR:

1. `reflect` is registered on Creek's server as three positional
   parameters — `(content, entry_ref, privacy_tier_ceiling)`
   (`creek-tools/creek_mcp/server.py:332-346`) — while adepthood's
   `_content_params` sends only `{consumer, body, tier_ceiling}`
   (`backend/src/services/creek_vault_client.py:277-279`). There is no
   `entry_ref` on our side and no `consumer` on Creek's.
2. `wheel` accepts `privacy_tier_ceiling` only
   (`server.py:349-358`), while adepthood sends
   `{"consumer": CONSUMER_ID}` (`creek_vault_client.py:426`) — the
   opposite mismatch.
3. Creek's `reflect` returns `{status, tool, tier_ceiling, routed_tier,
   notes[], essay_grounded, essay?}`, each note exactly `{quote, kind,
   note}` (`creek-tools/creek_mcp/tools/reflect.py:479-490`), while
   adepthood's client reads a bare scalar `payload["reflection"]`
   (`creek_vault_client.py:406-407`) and never touches `notes`,
   `essay`, or `essay_grounded`.
4. Creek's `wheel` returns `{status, tool, tier_ceiling,
   total_classified, unclassified, wheel: {F1..F10: {name, count,
   share}}}` (`creek-tools/creek_mcp/tools/wheel.py:95-110`), while
   adepthood validates against its own `WheelBalanceResponse{aspects:
   [{stage_number, aspect, fullness}]}` (`backend/src/schemas/wheel.py`)
   — a different shape entirely, not a renamed field.
5. Adepthood's version gate compares `_CONTRACT_MAJOR` only
   (`creek_vault_client.py:79`, applied at `:242`). On a pre-1.0
   contract the major component is pinned at `0` by definition, so
   this comparison can never observe a minor bump — and on a pre-1.0
   contract a minor bump *is* the breaking change (semver makes no
   compatibility promise below 1.0.0 at any granularity finer than the
   whole number before the first dot). A major-only gate on this
   contract is therefore a no-op by construction: it will pass every
   version pair adepthood could ever see until Creek ships 1.0.0,
   which defeats the entire purpose of a compatibility check.

None of this is new tension so much as unfinished business: #950 drew
the first machine-readable draft of this contract, and creek-vault#1072
is the tracking issue for a canonical, ratified `/v1` contract on
Creek's side. As of this writing creek-vault#1072 is **open and has
shipped nothing** — `docs/contracts/` does not exist in creek-vault,
and `docs/decisions/` there holds only
`2026-05-23-frequency-naming.md` and
`2026-06-30-adepthood-creek-mcp-contract.md`. Creek's actually-running
server publishes `CONTRACT_VERSION = "0.2.0"` and `ONTOLOGY_VERSION =
"aptitude-wavelength/2026-05-23"` today
(`creek-tools/creek_mcp/contract.py:18`), and that published pair is
what this ADR pins against — not a guess at what `/v1` will eventually
say. Issue #1939 (open, unmerged) is the companion document that will
record Adepthood's current-state MCP integration; it is cited here by
number only, since it has not shipped any file this ADR can point to.

The five divergences above are not visible to an operator today
because every one of them currently normalizes to the same
`CreekVaultUnavailableError` (`backend/src/domain/creek_vault.py:115`)
— a malformed reflect response, a rejected wheel payload, and a
genuinely offline vault all present identically. A misconfigured
integration is indistinguishable from an absent one, which is exactly
why this ADR treats "the version gate does nothing" as a defect worth
fixing rather than a cosmetic detail.

## Decision 1 — HTTP/JSON `/v1` is the application boundary; MCP remains Creek's agent adapter

Adepthood's backend is a deterministic consumer: it knows at build
time that it needs exactly four operations — capability discovery,
journal upsert, reflection, and wheel/balance read. It never needs to
*discover* a tool at runtime, never prompts a human through Creek,
and never receives a sampling or elicitation request. Every property
MCP adds beyond request/response — tool discovery, prompts, resources,
sampling, elicitation, agent-to-agent interop — solves a problem
adepthood's backend does not have, at the cost of a heavier client
(session/framing, `tools/call` indirection) for a caller who already
knows exactly which four calls it will make and when.

MCP is not going away: CrawDad, Claude Code, and Hermes are genuine
agents that benefit from tool discovery and the rest of the protocol,
and they keep talking to Creek over MCP exactly as they do today. Both
adapters — the new HTTP/JSON `/v1` boundary and the existing MCP
surface — call into one behavioral Creek; this is a second front door,
not a fork of Creek's logic.

**Rejected — staying on MCP for the application boundary:** MCP's
session/tools-call indirection buys agent ergonomics adepthood's
backend never uses, while adding transport surface the version-drift
bugs above already show is easy to get wrong twice. Reopen this if
adepthood's backend itself becomes an agent host that needs runtime
tool discovery against Creek — it does not today.

**Rejected — a custom JSON-RPC surface:** reinvents versioning,
error-shape, and content-negotiation conventions that plain HTTP/JSON
with a versioned path prefix already gives us for free, for no
capability gain. Reopen only if Creek's own `/v1` design commits to
JSON-RPC and it is cheaper to follow than to diverge.

**Rejected — gRPC:** buys strict schemas and streaming neither side
needs yet, at the cost of codegen tooling in two languages and a
protobuf contract to keep in lockstep with the same `/v1` surface this
ADR is already pinning in JSON. Reopen if wheel/reflect payloads grow
large enough that JSON's overhead becomes the bottleneck, or if Creek
adopts gRPC as its canonical transport.

## Decision 2 — The domain seam is retained; this is an adapter swap, not a rewrite

`domain/creek_vault.py`'s `CreekVaultClient` protocol, its value
objects (`VaultIngestRequest`, `VaultClassification`,
`VaultWheelBalance`, `HandshakeResult`, …), the fail-closed
`tier_ceiling_for` (raises rather than defaulting to `OPEN` on an
unrecognized classification), and the `CreekVaultError` /
`CreekVaultUnavailableError` / `CreekCapabilityUnsupportedError`
hierarchy all stay exactly as they are. Only the adapter underneath —
today `McpCreekVaultClient` in `services/creek_vault_client.py` — gets
an HTTP/JSON sibling implementing the same protocol. Every caller
(`creek_vault_write.py`, `creek_vault_reflect.py`,
`creek_vault_wheel.py`) is unaffected, because none of them import the
transport directly.

**Rejected — rewriting the seam alongside the transport:** the domain
protocol was already deliberately transport-agnostic (see its module
docstring: "no FastAPI, no SQLModel/DB, no `httpx`"); touching it at
the same time as the transport would conflate two independent risks
and make it impossible to tell whether a regression came from the new
wire format or from a seam redesign.

## Decision 3 — Pin the advertised version to Creek's published 0.2.0

`CONTRACT_VERSION` in `domain/creek_vault.py` moves to `"0.2.0"`
(matching `creek-tools/creek_mcp/contract.py:18` exactly) alongside
this ADR and the contract doc rewrite, and
`backend/tests/test_contract_version_docs.py` enforces that all three
— the constant, the ADR's pinned-version bullet, and the contract
doc's version bullet — agree.

**Rejected — keeping the old draft string
(`"0.1.0-draft"`):** no server, past or present, ever published that
string; it was a placeholder from the pre-implementation contract
draft (#950) and is not meaningfully comparable to a real semver —
there is no "0.1.0-draft" to be exact-minor-compatible *with*. It is
retired as of this ADR and must not reappear in the contract doc.

**Rejected — guessing the number creek-vault#1072 will bless for
`/v1`:** creek-vault#1072 has shipped nothing; asserting a `/v1`
version now would be exactly the failure mode this ADR exists to end
— a mirrored shape or number nobody on the other side ratified. Every
`/v1` payload shape in this ADR and its companion doc is marked
`PENDING creek-vault#1072` for that reason, and the pin above tracks
only what Creek has actually published.

## Decision 4 — Exact-minor compatibility while pre-1.0

The ratified rule, quoted verbatim: "While the contract is pre-1.0,
client and server must match on **exact `major.minor`**. At 1.0 and
beyond, the rule relaxes to major-match with forward-compatible
minors."

Two worked examples, both explicit because off-by-one bugs live in the
boundary case: a client pinned to `0.2.x` talking to a server
advertising `0.3.0` **must be rejected** — that minor bump is,
pre-1.0, the breaking change the exact-match rule exists to catch. A
client pinned to `0.2.1` talking to a server advertising `0.2.7`
**must be accepted** — same minor, patch is free to vary.

A version-mismatch handshake failure during this pre-1.0 window is the
gate *working*, not a regression to chase down as a bug. The only
correct remedy is to align the two versions — bump adepthood's pin, or
wait for Creek to align — never to widen the comparison back toward
major-only or drop the check. Widening the comparison is exactly the
mistake Decision 3 above is retiring.

Runtime consequence: a version mismatch degrades to the local fallback
exactly like any other unavailable vault, but it must raise a
*distinguishable* signal rather than folding into the generic
unavailable path — telemetry counts it as `vault_incompatible_version`
(#2049) so a version-skew incident is visible separately from a vault
that is simply unreachable. The comparison code itself — replacing
`_CONTRACT_MAJOR` with an exact-minor check and wiring the distinct
counter — lands in #2045; this ADR fixes the rule the code must
implement, not the code.

**Rejected — the major-only comparison:** shown above (Context, point
5) to be a no-op on a contract whose major is pinned at `0` — it
cannot detect the very drift class (minor-version breakage) that
matters most before 1.0.

## Decision 5 — Supersede the draft contract doc

Creek's published contract (its `contract.py` constants today; its
ratified `/v1` document once creek-vault#1072 ships) becomes the
single source of truth for wire shapes. `docs/creek-vault-mcp-contract.md`
is trimmed to hold only a pointer to that source of truth, the pinned
version, and the material Creek does not and should not own —
adepthood's tier-name mapping, its Aspect/Frequency projection, its
marginalia-kind mapping, and its shipped fallback behavior.

The filename `docs/creek-vault-mcp-contract.md` is retained
deliberately, for two reasons: link stability — five inbound
references would otherwise need updating and re-reviewing, several of
them backend source docstrings that cross-reference it by path
(`domain/creek_vault.py`, `services/creek_vault_client.py`,
`services/creek_vault_write.py`) plus `docs/adr/0002` and
`graph/ontology-spine.md` — and because the shipped transport genuinely
is still MCP until the HTTP cutover in Decision 1 lands; renaming a
doc titled "MCP contract" while MCP is still the live transport would
be premature.

**Rejected — deleting or renaming the file:** breaks five live inbound
references for no reader benefit; nothing about the filename is wrong
while MCP remains the shipped transport.

**Rejected — keeping the full mirror of Creek's shapes in our doc:** a
second, independently-editable copy of the wire contract is exactly
what produced the five divergences in the Context section above. One
authoritative source, one pointer, is the fix.

## Decision 6 — The intimate-transit rule is carried forward, and is entirely unshipped

The four intimate-transit sub-decisions ratified via #927/#950 move
into this ADR in condensed form. **Every one of them is entirely
unshipped**; the owning issues are #958 (frontend vault key setup) and
creek-vault#757 (Creek's confidential-compute epic). Today's shipped
behavior remains ADR 0002 / #895's skip-only mode: an `intimate`
classification short-circuits before any vault call at all, not even a
handshake (`services/creek_vault_write.py:17-24`).

- **(a) Transit topology — ciphertext only.** Intimate content may
  cross the seam through the operator's backend, but only as
  client-side-encrypted ciphertext under a user-held key; the operator
  is a blind relay. **Rejected — plaintext through the backend**
  (operator-visible in transit); **Rejected — forbidding intimate
  transit entirely** (the TEE reflection rationale in (c) requires the
  entry to arrive inside the enclave somehow).
- **(b) Write-vs-read asymmetry — writes under attestation, read
  ceiling stands.** Intimate writes and reflection-compute require a
  successfully attested enclave first; the read-path guarantee (no
  remote read of INTIMATE plaintext) is untouched and does not inherit
  from the write rule.
- **(c) Reflection-output provenance — INTIMATE, and it may return.**
  A reflection grounded in intimate content keeps the INTIMATE tier on
  the way back, over the same encrypted channel. **Rejected —
  vault-side-only reflections** (defeats the Higher Self product for
  intimate writing); **Rejected — tier downgrade on return** (silently
  bypasses every downstream intimate guarantee).
- **(d) Custody end-state — dual-homed for v1.** Operator Postgres
  stays system of record; attested intimate entries are additionally
  ingested as ciphertext once the write path exists. **Rejected —
  immediate vault-only custody** (a vault outage would break the
  journal floor); **Rejected — no vault ingest path at all** (nullifies
  intimate reflection and contradicts the TEE rationale for building
  confidential compute in the first place).

Moving the application boundary to HTTP/JSON delivers **no
confidential-compute guarantee whatsoever** — not end-to-end
encryption, not TEE trust, not key custody, not attestation. HTTP/JSON
versus MCP is a statement about request/response ergonomics for a
deterministic caller; it says nothing about what travels over that
transport or who can read it in flight. No reader of this ADR should
infer that the transport decision in Decision 1 advances, defers, or
otherwise touches the confidential-compute build-out — that work is
entirely (a)-(d) above, entirely unshipped, and entirely owned by #958
and creek-vault#757.

See [ADR 0002](0002-intimate-content-local-routing.md) and
creek-vault#757 for the fuller intimate-routing history. **ADR 0002
stands unchanged in substance** — this ADR relocates where the
intimate-transit sub-decisions are recorded; it does not revise any of
them.

## Divergence table

| What adepthood ships | What Creek publishes | Resolution | Owning repo / issue |
| --- | --- | --- | --- |
| `reflect` params `{consumer, body, tier_ceiling}` (`backend/src/services/creek_vault_client.py:277-279`) | `reflect(content, entry_ref, privacy_tier_ceiling)` (`creek-tools/creek_mcp/server.py:332-346`) | PENDING creek-vault#1072 for the ratified `/v1` shape | adepthood #2047 |
| `wheel` params `{"consumer": CONSUMER_ID}` (`creek_vault_client.py:426`) | `wheel(privacy_tier_ceiling)` only (`server.py:349-358`) | PENDING creek-vault#1072 for the ratified `/v1` shape | adepthood #2047 |
| `reflect` result read as scalar `payload["reflection"]` (`creek_vault_client.py:406-407`) | `{status, tool, tier_ceiling, routed_tier, notes[{quote, kind, note}], essay_grounded, essay?}` (`creek-tools/creek_mcp/tools/reflect.py:479-490`) | PENDING creek-vault#1072 for the ratified `/v1` shape | adepthood #1936 |
| `wheel` result validated as `WheelBalanceResponse{aspects:[{stage_number, aspect, fullness}]}` (`backend/src/schemas/wheel.py`) | `{status, tool, tier_ceiling, total_classified, unclassified, wheel:{F1..F10:{name, count, share}}}` (`creek-tools/creek_mcp/tools/wheel.py:95-110`) | PENDING creek-vault#1072 for the ratified `/v1` shape; the stage/aspect projection is Adepthood's to own — Creek must not invent our vocabulary, and the F1-F10-to-ten-stage numeric coincidence is NOT a semantic identity | adepthood #1937 |
| Major-only version gate, a no-op pre-1.0 (`_CONTRACT_MAJOR`, `creek_vault_client.py:79,242`) | `CONTRACT_VERSION = "0.2.0"` (`creek-tools/creek_mcp/contract.py:18`) | Exact-minor comparison per Decision 4; pin lives here, comparison code lands in #2045 | both repos |

## Deprecation and change control

While the contract is pre-1.0, adepthood pins to exactly one
`major.minor` at a time (Decision 4); there is no "supported minor
window" to manage yet, because a minor bump *is* a breaking change and
requires a coordinated pin update, not a grace period. Once Creek
publishes 1.0.0 and the major-match-with-forward-compatible-minors
rule takes over, a deprecated minor stays supported for at least one
Creek release cycle past the minor that superseded it, announced in
both repositories' release notes before the old minor stops being
advertised as compatible.

Every version bump — of the pin here, or of the rule itself — gets a
dated note appended to this ADR, following ADR 0001's pattern
(`docs/adr/0001-git-content-pipeline.md:85-104`). The drift test
(`backend/tests/test_contract_version_docs.py`) enforces that the pin
in this ADR, the version bullet in the contract doc, and the
`CONTRACT_VERSION` constant all move together — none of the three may
change without the other two.

## Consequences

- The HTTP/JSON `/v1` adapter is new work (tracked in #2044's epic
  #2043 and its sub-issues #2045-#2049); the existing `McpCreekVaultClient`
  is not deleted until that adapter is proven and Creek's `/v1` ships.
- `domain/creek_vault.py` needs no redesign; the protocol and value
  objects this ADR retains (Decision 2) are the contract every future
  adapter — MCP or HTTP — must satisfy.
- `CONTRACT_VERSION` becomes `"0.2.0"` immediately (this branch), ahead
  of the exact-minor comparison code (#2045) and the distinguishable
  `vault_incompatible_version` telemetry (#2049) landing — until those
  ship, the major-only gate remains a known no-op, tracked rather than
  silently accepted.
- `docs/creek-vault-mcp-contract.md` stops being a mirror and starts
  being a pointer; future wire-shape questions are answered by reading
  Creek's published contract, not this repository's copy of it.
- Every `/v1` shape claim in this ADR is provisional on
  creek-vault#1072; when that issue ships, the divergence table's
  "PENDING" resolutions get replaced with real ratified shapes in a
  follow-up ADR update, not silently overwritten.
- No confidential-compute work is unblocked, advanced, or implied by
  this ADR (Decision 6); #958 and creek-vault#757 remain exactly where
  they were.
