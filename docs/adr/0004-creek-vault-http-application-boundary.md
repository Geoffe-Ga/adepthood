# ADR 0004: Creek Vault application boundary moves to HTTP/JSON; MCP retained for agents

- **Status:** Accepted
- **Date:** 2026-07-31
- **Issue:** [#2044](https://github.com/Geoffe-Ga/adepthood/issues/2044)
  (epic [#2043](https://github.com/Geoffe-Ga/adepthood/issues/2043))
- **Pinned contract version:** 0.2.0 (tracks Creek's published
  constant; see the 2026-07-31 note at the end of this document — the
  `/v1` bundle creek-vault#1072 tracked has since shipped and is now
  vendored, and it publishes this same 0.2.0)

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
| `reflect` result read as scalar `payload.get("reflection")` (`creek_vault_client.py:406-407`) | `{status, tool, tier_ceiling, routed_tier, notes[{quote, kind, note}], essay_grounded, essay?}` (`creek-tools/creek_mcp/tools/reflect.py:479-490`) | PENDING creek-vault#1072 for the ratified `/v1` shape | adepthood #1936 |
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
point at was deleted by this issue. They are left exactly as written,
per this ADR's append-only convention, because the argument they
support is an argument about what was true when the decision was made,
and rewriting the evidence under a decision is how a decision record
stops being a record. Read them as archaeology, not as a map of the
current file.
