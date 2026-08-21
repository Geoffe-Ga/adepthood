# ADR 0004: Creek Vault application boundary moves to HTTP/JSON; MCP retained for agents

- **Status:** Accepted
- **Date:** 2026-07-31
- **Issue:** [#2044](https://github.com/Geoffe-Ga/adepthood/issues/2044)
  (epic [#2043](https://github.com/Geoffe-Ga/adepthood/issues/2043))
- **Pinned contract version:** 0.8.0 (tracks Creek's published
  constant; the pin opened at 0.2.0 with the 2026-07-31 note at the end
  of this document and moved to 0.8.0 with the 2026-08-19 note, which
  records why that move became a prerequisite rather than housekeeping)

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
   adepthood's client reads a bare scalar
   `payload.get("reflection")` (`creek_vault_client.py:406-407`) and
   never touches `notes`, `essay`, or `essay_grounded`.
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
deliberately, for two reasons: link stability — four inbound
references would otherwise need updating and re-reviewing
(`backend/src/domain/creek_vault.py` and
`backend/src/services/creek_vault_client.py`, which cross-reference it
by path from their module docstrings; `graph/ontology-spine.md`; and
the drift guard `backend/tests/test_contract_version_docs.py`, which
reads the file by path) — and because the shipped transport genuinely
is still MCP until the HTTP cutover in Decision 1 lands; renaming a
doc titled "MCP contract" while MCP is still the live transport would
be premature.

Two former inbound references are repointed rather than retained,
because they cited the doc for material it no longer owns:
`docs/adr/0002` and `backend/src/services/creek_vault_write.py` both
now cite Decision 6 below, which is where the intimate-transit rule
actually lives.

**Rejected — deleting or renaming the file:** breaks four live inbound
references for no reader benefit; nothing about the filename is wrong
while MCP remains the shipped transport.

**Rejected — keeping the full mirror of Creek's shapes in our doc:** a
second, independently-editable copy of the wire contract is exactly
what produced the five divergences in the Context section above. One
authoritative source, one pointer, is the fix.

## Decision 6 — The intimate-transit rule is carried forward, and is entirely unshipped

> **SUPERSEDED 2026-08-21 — see the note at the end of this ADR.** The
> amendment below is kept verbatim as the record of what was ruled and
> why. It no longer describes shipped behaviour: contract 0.7.0/0.8.0
> made `intimate` unexpressible on the upload wire, so the upload path
> withholds an intimate document exactly as the journal-entry path
> does, and the "known asymmetry" recorded here is closed rather than
> outstanding. Nothing about the *destination* reasoning was overturned
> — the premise it rested on was removed upstream.
>
> **Amended 2026-08-08 (owner ruling, issue #1924 / PR #2149) — the
> document-upload surface is vault-only, not skip-only.** Sub-decisions
> (a)–(d) below are unchanged and still describe the *journal-entry*
> write path. They do **not** govern `POST /journal/upload`, which
> forwards an `intimate` document to the vault at the `INTIMATE` tier
> ceiling, in plaintext, over the configured `CREEK_VAULT_URL`.
>
> The ruling rests on who the far end is. A Creek Vault is the user's
> **own** corpus on operator-held infrastructure, not a third-party
> service, so reaching it is not the cloud disclosure the privacy floor
> was built to prevent. What that floor forbids — intimate content
> reaching a cloud LLM — the upload path never does, because it calls no
> LLM at all. This is a narrower claim than (a)'s ciphertext topology,
> and it does not weaken (a): a deployment whose vault is *not*
> operator-held is outside the assumption this amendment rests on, and
> nothing here confers a confidential-compute guarantee.
>
> **Known asymmetry, deliberately left standing.** The journal-entry
> write path still withholds intimate entries (skip-only, as below)
> while the upload path forwards them. That is not an oversight and not
> a contradiction to resolve silently: widening a shipped write path is
> its own change, with its own tests and its own review, and it is
> tracked in issue #2152. Until that lands, read (a)–(d) as governing
> journal entries only.

The four intimate-transit sub-decisions ratified via #927/#950 move
into this ADR in condensed form. **Every one of them is entirely
unshipped**; the owning issues are #958 (frontend vault key setup) and
creek-vault#757 (Creek's confidential-compute epic). Today's shipped
behavior for journal entries remains ADR 0002 / #895's skip-only mode:
an `intimate` classification short-circuits before any vault call at
all, not even a handshake (`services/creek_vault_write.py:17-24`).

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

## Decision 7 — Creek Vault is bound to exactly one adepthood user per deployment

**(a) Identity scope.** Adepthood reaches a configured vault with a
single deployment-wide bearer credential, `CREEK_VAULT_API_KEY`, and
nothing else on the wire says who is asking. Verified directly
against the vendored `/v1` schemas: `ReflectionRequest.schema.json`
is `additionalProperties: false` and admits only `content`,
`entry_ref`, `max_notes`; `JournalUpsertRequest.schema.json` is
`additionalProperties: false` and admits only `content`, `tier`,
`timestamp`; `/v1/wheel` is a parameterless `GET`; and
`CapabilitiesResponse.schema.json` advertises `status`,
`contract_version`, `contract_minor`,
`supported_contract_minors`, `ontology_version`, `vault.available`,
`tier_model`, and `capabilities` — nothing about tenancy or
partitioning anywhere in that list. No request shape has anywhere to
carry a tenant, and no response shape says the corpus is split by
one. Per-user scoping is therefore not a feature adepthood chose to
skip; it is not buildable from adepthood's side of this contract at
all. Nor is any creek-side partitioning guarantee assumed in its
place — none is published, and Decision 6's discipline about not
inferring a guarantee the wire does not state applies here with equal
force.

**(b) Owner binding.** `CREEK_VAULT_OWNER_USER_ID` names the one
adepthood user a configured vault belongs to. It is enforced once, at
the client-provider seam (`backend/src/dependencies/creek_vault.py`),
which every router reaches through — journal writes, reflections, and
the wheel read all resolve their `CreekVaultClient` through this one
dependency, so the binding covers ingest, reflect, and wheel
together rather than needing three separate gates that could drift
apart. Gating only the read path was considered and rejected: if
every user's entries still reached the corpus, the bound owner's own
reflections and wheel would be grounded in everyone else's journals —
the identical leak this ADR exists to close, just pointed at a single
victim instead of the whole user base. The write side has to be
gated for the read side's guarantee to mean anything.

**(c) Fail-closed default.** An unset or unreadable
`CREEK_VAULT_OWNER_USER_ID` — missing, blank, non-integer, `0`, or
negative — resolves to no owner at all
(`domain.creek_vault.resolve_vault_owner`), and no user id ever
equals `None`, so every user, including whoever might have been
intended as the owner, gets `LocalFallbackCreekVaultClient`. A
deployment in that state is not broken; it behaves exactly like a
deployment with no vault configured at all, which is the floor the
whole seam is already built on. The one difference an operator is
owed is a signal: a vault that is configured (URL and credential
both present) but carries no readable owner logs one WARNING per
request naming the variable to set, and never echoes the raw value —
the same discipline `build_creek_vault_client` already applies to a
stale protocol selector. The gate degrades instead of raising for the
same reason that selector does: it runs inside a per-request FastAPI
dependency, so a raise there means the handler body never executes —
every journal save would 500 and the writer's entry would exist
nowhere. That is exactly the loss this seam promises can never happen
for a vault's sake, so an unreadable binding costs a user an optional
capability, never their journal entry.

**(d) Per-user end-state.** This binding is an interim floor, not
the destination — a deployment with real multi-user vault-backed
reflections is still future work. Lifting it needs a change on
Creek's side of the contract, not adepthood's: either a tenant or
consumer field admitted by `ReflectionRequest` and
`JournalUpsertRequest`, paired with a `/v1/wheel` scoped to that same
tenant, or per-consumer credentials backed by a partitioning
guarantee that is itself *advertised in `CapabilitiesResponse`* so
adepthood can verify it at handshake time rather than assume it
holds. A guarantee this ADR cannot observe at handshake is not one it
may act on — that is the same reasoning (a) applies to the absence of
any tenancy claim today, run forward to what would have to change for
the claim to exist. Tracked as adepthood #2134, blocked on
`Geoffe-Ga/creek-vault` shipping either shape.

What this costs, recorded honestly rather than rounded up: on a
genuinely multi-user deployment that configures a vault, only the
one bound user gets vault-backed reflections and a vault-backed
wheel. Every other user runs the local pipeline — local reflection,
locally computed wheel — which is not a degraded experience relative
to some richer default; it is the same floor every vault-less
deployment already runs on today, for every one of its users.

**Rejected — shipping the leak and calling it a known limitation:**
the alternative to (b) and (c) above was not "no vault feature" but
"a vault feature that silently mixes users' journals in the corpus it
grounds reflections in" — a privacy defect, not a limitation, and one
this ADR will not document as though it were a tradeoff.

**Rejected — inferring a per-consumer partitioning guarantee from
Creek's behavior:** even if today's Creek deployment happened to
partition by credential in practice, nothing in the ratified contract
promises it, and `CapabilitiesResponse` has a `tier_model` field for
exactly this kind of standing promise yet says nothing about tenancy
there. Building on unpublished behavior is the same mistake Decision
6 already refuses to make for confidential compute, and (d) names the
one place such a promise would have to appear before adepthood could
rely on it.

## Divergence table

| What adepthood ships | What Creek publishes | Resolution | Owning repo / issue |
| --- | --- | --- | --- |
| `reflect` params `{consumer, body, tier_ceiling}` (`backend/src/services/creek_vault_client.py:277-279`) | `reflect(content, entry_ref, privacy_tier_ceiling)` (`creek-tools/creek_mcp/server.py:332-346`) | RESOLVED by the `/v1` cutover (#2047); the client this row describes is retired — archaeology only, per the 2026-08-07 note | adepthood #2047 |
| `wheel` params `{"consumer": CONSUMER_ID}` (`creek_vault_client.py:426`) | `wheel(privacy_tier_ceiling)` only (`server.py:349-358`) | RESOLVED by the `/v1` cutover (#2047); `CONSUMER_ID` no longer exists in the codebase — archaeology only, per the 2026-08-07 note | adepthood #2047 |
| `reflect` result read as scalar `payload.get("reflection")` (`creek_vault_client.py:406-407`) | `{status, tool, tier_ceiling, routed_tier, notes[{quote, kind, note}], essay_grounded, essay?}` (`creek-tools/creek_mcp/tools/reflect.py:479-490`) | PENDING creek-vault#1072 for the ratified `/v1` shape | adepthood #1936 |
| `wheel` result validated as `WheelBalanceResponse{aspects:[{stage_number, aspect, fullness}]}` (`backend/src/schemas/wheel.py`) | `{status, tool, tier_ceiling, total_classified, unclassified, wheel:{F1..F10:{name, count, share}}}` (`creek-tools/creek_mcp/tools/wheel.py:95-110`) | PENDING creek-vault#1072 for the ratified `/v1` shape; the stage/aspect projection is Adepthood's to own — Creek must not invent our vocabulary, and the F1-F10-to-ten-stage numeric coincidence is NOT a semantic identity | adepthood #1937 |
| Major-only version gate, a no-op pre-1.0 (`_CONTRACT_MAJOR`, `creek_vault_client.py:79,242`) | `CONTRACT_VERSION = "0.2.0"` (`creek-tools/creek_mcp/contract.py:18`) | Exact-minor comparison per Decision 4; pin lives here, comparison code lands in #2045 | both repos |
| Single deployment-wide bearer credential; no tenant field on any `/v1` request or response (`backend/src/dependencies/creek_vault.py`) | No tenancy or partitioning of any kind published in `/v1` — verified against every schema in `backend/tests/fixtures/creek_v1/schemas/` | PENDING a creek-side contract change (tenant field, or advertised per-consumer partitioning); interim single-tenant binding shipped per Decision 7 | `creek-vault` / adepthood #2134 |

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

## Note, 2026-07-31 — creek-vault#1072 shipped; the bundle is vendored

This ADR was written while creek-vault#1072 was open and had published
nothing, which is why every `/v1` shape above is marked **PENDING
creek-vault#1072**. That issue has since closed. Creek now publishes a
generated, byte-deterministic contract bundle at
`docs/contracts/adepthood-v1/` — 16 JSON Schemas, a
`retry-policy.json` disposition table over nine error codes, a
four-capability by seven-state example matrix, and a `manifest.json`
recording a sha256 per generated file — behind its own ADR,
`docs/decisions/2026-07-31-adepthood-http-application-api.md`.

Three facts this ADR asserted are therefore now out of date, and are
recorded here rather than edited in place so the reasoning above stays
readable as what was known at the time:

1. "creek-vault#1072 is open and has shipped nothing" (Context) is no
   longer true, and neither is Decision 5's forward-looking phrasing
   about the ratified document arriving later. It has arrived.
2. The published bundle advertises `contract_version` **0.2.0** — the
   same value Decision 3 pins, and the same value
   `domain/creek_vault.py` carries. The pin needs no change. Decision
   3's refusal to guess a number is vindicated rather than overtaken.
3. Every "PENDING creek-vault#1072" resolution in the divergence table
   now has a real ratified shape to resolve against. Replacing those
   cells is deliberately **not** done in this note: the owning issues
   named in that table's last column own both the shape and the client
   change, and a resolution written here ahead of the code would be
   the same mirroring this ADR exists to end.

The bundle is vendored byte-for-byte at a pinned upstream commit under
`backend/tests/fixtures/creek_v1/`, with a `vendor.json` sidecar
recording the source repository, commit, path, versions and a sha256
per file. An offline test asserts the vendored bytes still hash to
their recorded digests and that the vendored set is exactly the
recorded set; a scheduled workflow re-fetches the bundle and fails when
upstream no longer matches, naming the capability that moved. Neither
check may report success for a run that compared nothing.

Vendoring the bundle does **not** by itself close any divergence. The
conformance suite that reads it records, as executable assertions, that
today's HTTP client cannot complete a handshake against Creek's own
ratified capability document at all: it reads a top-level `available`
where Creek nests `vault.available`, and it maps advertised capability
names through an enum whose `creek.*` values share no member with
Creek's published `capabilities`/`journal-upsert`/`reflections`/`wheel`.
A third divergence sits in the error vocabulary — Creek's
`privacy_refused` is not a `VaultErrorCode` member, so a privacy
refusal served at 403 is classified on status alone and surfaces as a
rejected credential. Fixing all three belongs to the issues named in
the divergence table.

Nothing in Decision 6 changes. This note is a factual correction and a
pointer to the vendored bundle; it revises no decision.

## Note, 2026-08-07 — the HTTP cutover shipped; adepthood's MCP client is retired

Issue #2049, the capstone of epic #2043, landed. `CREEK_VAULT_PROTOCOL`
now defaults to `http`, and `http` is the only transport it selects.
`McpCreekVaultClient`, the `VaultTransport` protocol, and every
MCP-only helper underneath them are deleted from
`services/creek_vault_client.py`, along with the `mcp` and `httpx2`
imports. `build_creek_vault_client` lost its `transport` parameter —
there is exactly one transport to choose now, not a choice between two.

**Operator migration, and the one place this decision had teeth.** A
stale `CREEK_VAULT_PROTOCOL=mcp` — the value this repository's own
`backend/.env.example` prescribed until this commit — is never
reinterpreted as `http`; reading it that way would send vault traffic
over a transport the operator did not choose, which is the guess this
whole epic exists to end. But it does not raise, either. The factory
runs inside a per-request FastAPI dependency, so a raise there means
the handler body never runs: every journal save would 500 and the
writer's entry would exist nowhere. That is exactly the loss the seam
promises can never happen for a vault's sake, and it would have been
inflicted on precisely the deployments that followed our own
documentation. So a retired selector degrades to
`LocalFallbackCreekVaultClient` and logs one WARNING naming the remedy:
the entry still lands in Postgres, and only the optional replication is
skipped. Any *other* unrecognized value — a typo, or a transport nobody
implemented — degrades the same way, with its own WARNING saying it was
not recognized rather than that it was retired. Adepthood knows less
about what such a value meant, but knowing less argues for more caution,
not for a harsher failure: whatever the operator intended, they did not
intend to lose every journal entry until someone read a traceback. What
neither case ever does is guess `http`. **Operators should unset
`CREEK_VAULT_PROTOCOL` or set it to `http`**; until they do, a configured
vault is silently unused and the warning is how they find out.

Decision 2's "adapter swap, not a rewrite" held through the cutover, not
just through the client's introduction. Everything the domain seam
promised stays exactly as it was: the `CreekVaultClient` protocol,
every value object (`VaultIngestRequest`, `VaultClassification`,
`VaultWheelBalance`, `HandshakeResult`, …), the fail-closed
`tier_ceiling_for`, the whole `CreekVaultError` hierarchy, and
`LocalFallbackCreekVaultClient` are untouched. Every graceful-degradation
guarantee this ADR and its callers depend on — an unconfigured
deployment gets the local fallback before the protocol is even read, a
version mismatch degrades rather than crashes, a failed write is
dropped rather than queued — still holds, because none of it lived in
the transport that was retired.

**Creek's MCP surface is unaffected.** Nothing in the `creek-vault`
repository changed for this issue, and nothing in Creek's
`creek-tools/creek_mcp/` server was touched. CrawDad, Claude Code, and
Hermes keep talking to Creek over MCP exactly as they did before this
note. What retired is *adepthood's own client* of that surface — the
half of Decision 1 this ADR always scoped to "adepthood's backend is a
deterministic consumer with no agent needs of its own." A reader who
takes the issue title ("retire the MCP transport") to mean MCP itself
was retired has misread it.

Rollout criteria, recorded honestly rather than rounded up. Met, and
machine-verified: the HTTP verticals this ADR's divergence table
tracked have landed (the HTTP adapter #2045, journal replication
#2046, `/v1` reflections and `/v1/wheel` #2047); the vendored `/v1`
conformance and drift
suites (`backend/tests/test_creek_contract_conformance.py`,
`backend/tests/scripts/test_creek_contract_drift.py`) are green with
the strict-xfail tripwire `test_ratified_capability_documents_are_understood`
still XFAILing; and the full backend suite is green. **Not met, and not
claimed as met:** nobody has run this client end-to-end against a real
local Creek `/v1` server. That manual run — start a local Creek,
configure `CREEK_VAULT_URL` against it, exercise all four capabilities,
and confirm success counters for each and zero schema failures in the
telemetry this issue also shipped — is outstanding. It is recorded here
as a criterion the operator must run before, or immediately upon, the
first real deployment with a vault configured. The vendored conformance
suite proves adepthood's client agrees with Creek's *published* shapes;
it does not prove a live vault answers them the same way over an actual
network.

Decision 4's requirement — a version mismatch must be countable apart
from an unreachable vault, not folded into it — is now satisfied. The
new telemetry module, `services/creek_vault_telemetry.py`, gives
`vault_incompatible_version` its own counter key, distinct from
`vault_unavailable` and the new `vault_timeout` (a slow vault is now
countable apart from an absent one too, via `HandshakeDegradeReason.TIMED_OUT`).
The gap the Consequences section above flagged as "tracked rather than
silently accepted" is closed.

**One outcome is tiered for privacy rather than for noise, and that is a
product decision, not a logging preference.** The telemetry module's
fields are content-free by construction — every value is a member of one
of adepthood's own closed enums, so no journal text, note, fragment id,
or credential can reach a record. For a care escalation that is not
sufficient, because the sensitive fact is not what the record *says* but
that there is a record at all: `vault_escalated` means a particular
person's writing tripped Creek's care guard, which is a
special-category inference about their mental health. It would not have
stayed abstract either — `TraceIdLogFilter` stamps every record with the
request's trace id, and the journal router's own records carry a
`user_id`, so an escalation logged at INFO would be trivially joinable
to a named user in ordinary production logs. Accumulating a
log-joinable record of who reached that state is the wrong trade for a
product whose whole promise is a private place to write the worst of it
down. So `vault_escalated` logs at DEBUG (absent from ordinary logs
entirely) and additionally carries `SUPPRESS_TRACE_CORRELATION`, a new
opt-in marker `TraceIdLogFilter` honours by stamping `NO_TRACE` instead
of the live trace id — a second layer for the case where an operator has
DEBUG on for something else. Nothing operational is lost: the counters
still tally every escalation, per capability, with nobody's identity in
them, and a rate is what an on-call actually reads. Tests pin both
halves so a future edit to the severity table cannot silently re-promote
the event.

Stated precisely, because a privacy claim that overstates itself is
worse than none: this removes the *trivial* join, not every join. With
DEBUG enabled, the request-logging middleware still writes its own
`request_completed` record for the same request at the same instant, so
timestamp adjacency plus a database lookup could still re-identify an
escalation. Closing that would mean reasoning about the whole logging
surface rather than this one record, which is a larger piece of work
than this issue; what is claimed here is that the event no longer falls
out of a generic severity table into ordinary logs already stamped with
the user's id.

One wart, left in on purpose rather than missed: `backend/requirements.txt`
still pins `mcp==2.0.0` and `httpx2==2.9.1`. Nothing imports either
package any more. They stay for this change because removing a
dependency is a separate, independently-reviewable diff from retiring
the code that used it — not because anyone forgot they are now dead
weight. A follow-up dependency change owns dropping them.

Decision 5's two reasons for keeping the filename
`docs/creek-vault-mcp-contract.md` are now down to one. Link stability
still holds — the inbound references it named have not moved. But "the
shipped transport genuinely is still MCP until the HTTP cutover in
Decision 1 lands" has expired: the cutover landed with this issue. The
filename survives on link stability alone now, which is a thinner
justification than the two together, though not yet a thin enough one
to force a rename that would break those same references.

Finally, a reading note about this document rather than about the
code. Every `backend/src/services/creek_vault_client.py` citation in
the Context section and the divergence table above — `_content_params`
at `:277-279`, `_CONTRACT_MAJOR` at `:79,242`, the scalar
`payload.get("reflection")` read at `:406-407`, the `wheel` params at
`:426` — describes the **pre-cutover MCP client**, and none of those
symbols or line numbers resolves to anything today: the code they
point at was deleted by this issue. The `CONSUMER_ID` constant those
citations name is gone too — it carried no tenancy meaning even while
it existed (Decision 7(a)), and Decision 7's binding replaces it with
a real one. They are left exactly as written,
per this ADR's append-only convention, because the argument they
support is an argument about what was true when the decision was made,
and rewriting the evidence under a decision is how a decision record
stops being a record. Read them as archaeology, not as a map of the
current file.

## Note, 2026-08-07 — the vault-tenancy binding ships

Issue #2072, whose bug report is the one that surfaced Decision 7 in
the first place: a deployment-wide vault identity meant every user's
replicated journal material landed in one corpus, so a reflection
returned to one user could ground itself in another user's writing,
and `/v1/wheel`'s whole-corpus aggregate was being served to every
user as though it were theirs. `CREEK_VAULT_OWNER_USER_ID` and its
enforcement at `backend/src/dependencies/creek_vault.py`, described
in full in Decision 7 above, are the fix that shipped for it.

What is proven, and how: `backend/tests/test_creek_vault_tenancy.py`
drives the real app end to end with two registered users and one
shared fake vault standing in for the single corpus, and asserts the
leak cannot travel in either direction — the non-owner's journal entry
never reaches the corpus at all, and nothing the non-owner is answered
with (reflection or wheel) is drawn from it. A second family in the
same suite drives the dependency directly against a bare environment,
pinning the fail-closed parse (missing, blank, non-integer, `0`, and
negative all resolve to no owner) and the WARNING behavior — logged
once per request, naming the variable, never echoing the raw value.

**What this does not reach: a corpus that is already mixed.** The
binding governs what enters the corpus from the moment it ships. It
cannot touch what a previous configuration already replicated. Any
deployment that ran with a vault configured and more than one active
user before this shipped has a corpus that *already* holds several
people's writing, and binding an owner does not retroactively
partition it — every reflection the bound owner is served can still
ground itself in material that was never theirs. The gate closes the
inflow; it does not undo the past, and nobody should read a green
tenancy suite as saying otherwise.

Remediation for that case is operational and sits on Creek's side,
not adepthood's: the corpus has to be re-scaffolded, or purged of
everyone but the bound owner, by whoever administers the vault.
Adepthood cannot do it from here even in principle — the ratified
`/v1` capability list is exactly `capabilities`, `journal-upsert`,
`reflections`, `wheel` (`CapabilitiesResponse.schema.json`), and none
of those removes a fragment; journal writes are upsert-only. An
operator turning this binding on for a vault that predates it should
treat the existing corpus as compromised for tenancy purposes and
decide deliberately whether to keep it.

What is deliberately **not** claimed. Nothing here says anything about
how Creek partitions, or fails to partition, a corpus on its own side
— no such guarantee is published, per Decision 7(a), and this ADR has
not gone looking for one. The single-tenant property this deployment
actually gets holds for exactly one reason: adepthood refuses to put
a second user's material into a corpus it already knows is shared and
unpartitioned. That is an adepthood-side refusal, not a Creek-side
promise, and reads exactly that way at every place this ADR touches
it — Decision 7(a)'s citation of the schemas that carry no tenant
field, and (d)'s naming of the specific creek-side change (a tenant
field, or an advertised partitioning guarantee) that would be needed
before adepthood could ever claim otherwise.

## Note, 2026-08-08 — a malformed or insecure CREEK_VAULT_URL degrades

Issue #2119, filed while reviewing #2117's protocol-selector fix,
named the asymmetry that fix left standing: `_require_secure_vault_url`
still raised straight out of `build_creek_vault_client`, which runs
inside the per-request FastAPI dependency every router resolves its
vault client through, whenever a configured `CREEK_VAULT_URL` was
insecure or malformed. Every journal write on such a deployment 500'd,
and the entry the writer had just typed existed nowhere — the same
loss #2117 had just finished closing for a stale protocol selector,
left standing one variable over.

**Insecure and malformed now degrade the same way at the factory, and
that was a decision, not a convenience.** The two had different
histories: forbidden components (userinfo, a query, a fragment) and
insecure transport were already refused inline, while a URL with no
host at all — `https://` — parsed cleanly under the old scheme-only
check and was silently accepted, and an unparseable URL escaped every
check by raising straight out of `urlsplit`. All four now route
through one classifier, `classify_vault_url`, into a closed
four-member taxonomy, `VaultUrlDefect`, carried on the WARNING as a
structured `url_defect` field rather than as four differently-shaped
outcomes. The argument for failing closed on the insecure case does
not survive contact with what failing closed actually buys here: in
both designs — raise, or degrade — no request reaches the suspect URL
and the bearer credential never leaves the process. Nothing about that
guarantee changed; `HttpCreekVaultClient.__init__` still fails closed
on every one of these defects, via the same classifier, because
reaching its constructor with an unclassified URL is a programming
error and it does not sit on a request path. What failing closed at
the *factory* actually cost was never the credential's exposure — it
was whether the writer's entry survived someone else's typo. Labelling
the four defects apart, rather than collapsing them into one generic
"unusable," is what keeps a plaintext URL countable apart from a
missing host even though both now answer the same way.

**Startup validation and the per-request degrade both shipped — this
was not a choice between them.** `main.validate_creek_vault_url_config`,
called from `lifespan` immediately after
`validate_ipv6_throttle_prefix_config`, states the same finding once,
before any traffic — an operator's first and best chance to notice a
vault that is configured and inert, since the request path only ever
says so at request rate, to whoever happens to be reading logs under
load at the time. It follows `validate_ipv6_throttle_prefix_config`'s
own two choices for the same kind of setting: it never raises, on any
defect, and it is not gated on `ENV`, because refusing to boot over an
optional capability would be a worse outage than the typo, and a value
typed wrong in staging is wrong there too — staging is exactly where
it gets typed. Neither check makes the other redundant. Boot is what
an operator reads once, at deploy time; the per-request degrade is
what actually keeps every subsequent entry landing in Postgres.

**The URL is still never normalized.** No trailing `?` is stripped, no
URL is rebuilt from its parsed components — `classify_vault_url`
judges the string exactly as configured and refuses it exactly as
configured, the same discipline #2117 already established for the
protocol selector. Reconstructing a URL from its parts would close the
same holes, but by editing configuration nobody wrote; refusing it and
saying so remains the honest half of that trade.

**A credential leak closed on the way, worth stating plainly rather
than folding into the rest.** `urlsplit` does not merely fail on a
netloc it cannot NFKC-normalize — it quotes the whole offending
netloc, userinfo included, back into its own message. Checked directly
against this repository's interpreter, a URL whose netloc is
`user:PASSWORD@` followed by a host carrying a codepoint NFKC
normalization rewrites raises `ValueError("netloc
'user:PASSWORD@<host>' contains invalid characters under NFKC
normalization")` — the password, quoted back verbatim by the standard
library. Before this issue, `_require_secure_vault_url`
called `urlsplit` unguarded, so that `ValueError` — the vault password
included — propagated straight out of the per-request dependency and
into whatever traceback the unhandled 500 wrote to the logs.
`classify_vault_url` now catches `ValueError` and discards it,
reporting only the static, value-free `VaultUrlDefect.UNPARSEABLE`
finding, and `_require_secure_vault_url` re-raises with `from None` so
neither `__cause__` nor `__context__` can carry the parser's own
exception forward. Two live acceptance holes closed alongside it,
neither previously covered by any check: `https://[::1`, unparseable,
which used to escape every validator that assumed `urlsplit` had
already succeeded; and `https://`, which parses cleanly with the right
scheme and no host at all, and which the old scheme-only check — `if
parsed.scheme == "https": return` — accepted outright.

**What is not claimed: the degrade is still counted as
`vault_fallback_unconfigured`.** `LocalFallbackCreekVaultClient`'s
default outcome is unchanged by this issue, so a deployment whose
`CREEK_VAULT_URL` is a typo records identically, in
`VaultTelemetryOutcome`, to one that configured no vault at all — the
same conflation Decision 7(c) already accepts for an unreadable owner
binding, and the one #2117 already accepts for a stale or unrecognized
protocol selector. The two WARNINGs (one at boot, one per request) are
the only signal that distinguishes "chose no vault" from "meant to
have one and mistyped it." No new `VaultTelemetryOutcome` member was
added here: that enum's membership and order are pinned by test as
contract, and adding one is a separate, independently-reviewable
change from this issue's scope. This is recorded as a known
limitation, not a virtue — an operator watching only the fallback-rate
counter cannot tell a misconfigured vault from an intentionally absent
one today; the WARNING is what carries that distinction until a future
issue gives the URL defect its own telemetry.

## Note, 2026-08-09 — Decision 4 refines to membership in the server's supported set

Decision 4 states the rule as "client and server must match on **exact
`major.minor`**". That phrasing predates the `supported_contract_minors`
field, and taken literally it compares adepthood's pin against the
single version the server advertises *as its own*. That is strictly
more brittle than the contract requires, and it had already begun to
bite.

`CapabilitiesResponse.schema.json` publishes three version fields, and
adepthood read only the first: `contract_version` ("Full semantic
contract version"), `contract_minor` ("The `major.minor` spoken
here"), and `supported_contract_minors` ("Every contract minor this
server still serves"). The third exists precisely so that a client can
negotiate, and it is a `required` property — a server that omits it
has published a malformed document.

Upstream `creek-vault` moved to contract 0.3.0 on 2026-08-08 and
deliberately *widened* rather than shifted its window. From upstream's
own ADR: "`SUPPORTED_CONTRACT_MINORS` was widened to `("0.3", "0.2")`
in the same change rather than shifted, so an existing client still
sending `X-Creek-Contract-Version: 0.2` is served exactly as before."
Against that server, adepthood read `contract_version` as `"0.3.0"`,
found `0.3 != 0.2`, and degraded to the local fallback — **refusing a
vault that was actively advertising that it would answer it**.

**The refined rule: `client_minor ∈ server.supported_contract_minors`.**
This is still exact-minor matching pre-1.0, and it still relaxes to a
major match at 1.0 — the per-entry comparison is unchanged. What
changes is *what* the pin is compared against: the set the server
serves, not the one minor it happens to speak natively. The two worked
examples in Decision 4 both still hold, because a server advertising
`0.3.0` and serving only `0.3` publishes `["0.3"]`, which a `0.2.x`
client is correctly not a member of.

This is a refinement, not a widening of the kind Decision 4 forbids.
The prohibition there is against relaxing *how* versions are compared —
back toward major-only, or dropping the check. Nothing here does that:
a server whose window has genuinely moved past adepthood's pin is
still rejected, still as `INCOMPATIBLE_VERSION`, and an absent or
wrong-typed `supported_contract_minors` degrades as a malformed
payload rather than being silently trusted. Fail-closed in both
directions.

**Alongside it, the required request header, which was never sent.**
Upstream's ratified ADR: "Every `/v1` **capability** endpoint requires
an `X-Creek-Contract-Version: <major.minor>` request header; a missing
or mismatched value is refused `409 incompatible_version` before any
vault read. `GET /v1/capabilities` requires nothing on this axis,
deliberately — the negotiation endpoint must never itself be able to
fail to negotiate." Adepthood sent only `Authorization`, on every
request, since the HTTP cutover shipped. A real Creek server would
have accepted the handshake and then refused **every** journal upsert,
reflection and wheel call — presenting as a configured, reachable,
correctly-credentialed vault that accepts negotiation and then does no
work.

**Why no gate caught either.** The conformance suite validates payload
*shapes* against the vendored bundle, and the bundle contains schemas
and examples only: it says nothing about request headers, so no
fixture could have caught a missing one. This is the same failure mode
as the upload client retired in the 2026-08-07 note above — a fake
answers any request it is given. The test added with this change
therefore drives a fake that **refuses** capability requests lacking
the header, which is the only shape of test that can hold the property.

The `409 incompatible_version` a real server sends on the capability
path is counted as `vault_incompatible_version`, not as a generic
contract failure, which is what Decision 4's own "distinguishable
signal" requirement asks for on this newer axis.

**What is not claimed.** `CONTRACT_VERSION` stays pinned at `0.2.0`;
0.2 remains served upstream, and moving the pin is separate work.
The vendored bundle in `backend/tests/fixtures/creek_v1/` is still at
upstream `879d961` (contract 0.2.0) while upstream `main` is at 0.3.0,
so the scheduled `Creek contract drift` workflow is expected to go red
on its next run — that is the gate working as designed, and
re-vendoring is deliberately not bundled here.

## Note, 2026-08-19 — the pin moves to 0.8.0, because the capability list stopped being minor-independent

The 2026-08-09 note closed by saying `CONTRACT_VERSION` stays at
`0.2.0` and that moving it was separate work. That was right at the
time and is no longer: the pin has become a prerequisite rather than
housekeeping, and this note records why, along with the re-vendoring
that came with it.

**What was true through contract 0.7.** Upstream widened
`SUPPORTED_CONTRACT_MINORS` six times and never shifted it — the set
is now `("0.8", "0.7", "0.6", "0.5", "0.4", "0.3", "0.2")` — and every
one of those minors was answered the *same four* capability names.
`GET /v1/capabilities` was a fact about the vault alone. So a 0.2 pin
cost adepthood nothing it could observe: handshake, journal upsert,
reflection and wheel were all still served, and the refined Decision 4
rule accepted such a server correctly. This was a capability gap, not
an outage, and nothing in production was broken by the pin alone.

**What contract 0.8.0 changed.** creek-vault#1524 published `upload`
as a fifth capability and `POST /v1/uploads` as its route, and — this
is the load-bearing part — keyed both on the caller. What
`GET /v1/capabilities` advertises now depends on the declared minor
via `CAPABILITY_SINCE_MINOR`, and the route refuses a caller below the
threshold with `incompatible_version`. Upstream's own `Capability`
docstring, vendored with this change, says it outright: the list is
"**no longer minor-independent**".

The consequence for adepthood is concrete. A 0.2-pinned client is
never *told* about `upload`, so no amount of client work could reach
that route while the pin stood. Implementing the upload call therefore
depends on this move; it is not parallel to it.

**What moved, and what deliberately did not.** The vendored bundle in
`backend/tests/fixtures/creek_v1/` is re-cut byte-for-byte from
upstream `349a56d` (54 manifest entries, 56 vendored files) with
`vendor.json` regenerated by the drift script's `snapshot` subcommand;
`CONTRACT_VERSION`, this bullet, and the contract doc's version bullet
move together as `test_contract_version_docs.py` requires; and the
client's wire-name table now recognises `upload`, so a vault
advertising it is believed. The upload *call* is not implemented here
and still refuses — recognising a route and speaking it are separate
changes, and a test pins the seam between them.

**No wire shape adepthood already calls moved.** Across 0.2 → 0.8 the
four capabilities in use changed in exactly one additive way:
`JournalUpsertResponse` gained an optional `warnings` array at 0.5.0.
The two purge counters added at 0.6.0 sit on a capability adepthood
does not call. Everything else that re-hashed did so through
docstrings inside the generated schemas.

**Two privacy hardenings ride along and are asserted, not rebuilt.**
0.7.0 removed the `open` default from the write tools' `tier`, so a
caller that omits it is refused rather than having its content filed in
the clear; 0.8.0 types `UploadRequest.tier` to the two-member wire
ceiling, so `intimate` is not expressible and omission is not
defaultable. Adepthood already satisfied both — it sends `tier`
unconditionally, and `wire_ceiling_for` refuses an intimate ceiling
rather than narrowing it. The conformance suite now pins both
properties against the published schemas so a regression fails here
rather than in Creek's logs.

**Decision 4 is untouched.** Nothing here widens `_contract_minor_supported`
or reintroduces a major-only comparison. The pin still names one minor,
membership in the server's advertised set is still how compatibility is
decided, and a server whose window moves past 0.8 will still be
refused.

## Note, 2026-08-21 — the upload call is implemented, and Decision 6's upload amendment is superseded by the wire

The 2026-08-19 note closed by saying the upload *call* was not
implemented and still refused, because recognising a route and speaking
it are separate changes. This note records the second change, and one
consequence of it that nobody chose and everybody has to live with.

**The route.** `HttpCreekVaultClient.upload` now performs Creek's
published exchange: a single `POST /v1/uploads` carrying
`UploadRequest{filename, content_base64, external_id, timestamp, tier}`
as JSON, with the document base64-encoded in the body. The shape is read
off the vendored bundle at `backend/tests/fixtures/creek_v1/`, and the
conformance suite drives every published example cell — success, empty,
refusal, malformed-input, incompatible-version, unavailable-service —
through the real adapter. There is no per-document URL: `external_id` is
a field of the published request, so idempotence is keyed off the body
the vault reads rather than off a path adepthood assembled. The invented
`PUT /v1/uploads/{external_id}` that the long-standing refusal replaced
is gone for good, and nothing on this path builds a path segment at all.

**No MCP.** Decision 1 stands untouched. This is HTTP/JSON over `/v1`
and nothing else; the retired MCP client is not resurrected, and
`creek.upload`-the-MCP-tool remains Creek's adapter for agents.

**Decision 6's 2026-08-08 upload amendment is superseded, and not on
privacy grounds.** That owner ruling held that `POST /journal/upload`
could forward an `intimate` document to the vault at the `INTIMATE`
ceiling, because a Creek Vault is the user's own corpus on
operator-held infrastructure rather than a third-party service. The
reasoning about the *destination* is untouched and is not what changed.
What changed is that upstream removed the premise from underneath it:
contract 0.7.0 made `tier` required on the write shapes, and 0.8.0 typed
`UploadRequest.tier` to the two-member `WireTierCeiling`. There is no
way to say `intimate` on `/v1`, in either direction, and adepthood's own
`wire_ceiling_for` refuses rather than narrowing — narrowing would file a
document at a depth its owner never chose, which is the exact defect the
wire vocabulary exists to prevent.

So the amendment was already unreachable when it was written down; it
survived only because `upload()` refused unconditionally and no request
was ever built to test it against. Implementing the call is what made it
visible. `services/creek_vault_upload.store_upload` now withholds an
intimate document before the vault is probed at all, asking
`wire_ceiling_for` the same question `services/creek_vault_write` asks
before touching its client.

**The known asymmetry is therefore closed rather than tracked.** Both
write paths now withhold intimate material, for one reason, at one door.
This is the *opposite* of the widening that issue was opened to
consider, and it needs no privacy review to adopt: nothing that used to
stay local now travels, and nothing that used to travel was ever
actually able to.

**What an uploader is told.** An intimate document answers
`capability_unsupported` rather than `degraded`. Both are honest about
the outcome; only one is honest about the remedy. `degraded` means "it
broke, try again", and a retry re-runs an identical request against an
identical contract — an instruction that cannot work. The
`capability_unsupported` copy now names the tier first, because choosing
a different one is the only remedy on this list that the person holding
the document controls.

**The degraded/unsupported split becomes meaningful for the first
time.** While every upload refused before sending, every failure a real
deployment reached was that refusal, so mapping it to `degraded` told
users to retry something no retry could reach — which is why the 0.8.0
re-vendoring changed it to `capability_unsupported`. Now that a document
genuinely crosses the wire, the two halves are distinguishable again and
both are live:

- **Mishaps during a working upload keep `degraded`**, and the advice is
  now true: a dropped connection, a 5xx, a rejected credential, a 2xx
  body adepthood could not read, a vault that answered without storing.
  Trying again is exactly right for all of them.
- **Failures that say the route is closed to this caller answer
  `capability_unsupported`**: a capability withdrawn between the
  handshake and the call, and a vault refusing at the route with
  `unsupported_capability` or `incompatible_version`. The second of
  those is routine rather than theoretical from 0.8.0, because the
  capability list is keyed on the caller's declared minor — a vault can
  be reachable, serve the route to others, and still refuse this caller.
- **`invalid_request` and `privacy_refused` stay on the degraded side**
  deliberately. Both are defects in the request adepthood built or the
  material it asked for, fixable on this side; neither says the route is
  closed. Reading them as "no retry helps" would file adepthood's own
  bug as a version gap.

**Not covered end to end.** The `seed.upload-document` journey in
`frontend/e2e/journeys.json` stays `uncovered`, and the reason is
structural rather than an omission: the e2e lane's server process reads
`CREEK_VAULT_OWNER_USER_ID` from its own environment at request time,
and that environment is fixed before any account exists, so no account a
spec can create is ever the vault's owner. Every e2e upload therefore
takes the local-fallback path whatever else the lane does. A spec
asserting only `vault_unavailable` would register as coverage while
proving the journey's own outcome never happens, which is precisely the
quiet coverage loss that ledger exists to prevent.
