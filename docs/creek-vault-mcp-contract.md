# Creek Vault contract pointer + adepthood-owned projections

- **Status:** Superseded pointer doc. This file no longer restates
  Creek's wire contract; see
  [ADR 0004](adr/0004-creek-vault-http-application-boundary.md) for
  the application-boundary decision and the version pin.
- **Contract version:** 0.8.0
- **Date:** 2026-07-31
- **Issue:** [#2044](https://github.com/Geoffe-Ga/adepthood/issues/2044)
  (epic [#2043](https://github.com/Geoffe-Ga/adepthood/issues/2043);
  originally drafted under [#950](https://github.com/Geoffe-Ga/adepthood/issues/950),
  epic [#949](https://github.com/Geoffe-Ga/adepthood/issues/949))

## Purpose

This filename is retained deliberately for link stability — two backend
source docstrings, `graph/ontology-spine.md`, and a drift-guard test
reference it by path — even though its role has changed. It is no longer a draft contract
awaiting cross-repo ratification. It is now a **pointer**: Creek
Vault's own published contract is the single source of truth for
every request/response shape, and this document holds only the pinned
version and the material Creek does not and should not own. For the
decision that retired this document's old role as a mirror, and for
the full HTTP/JSON application-boundary rationale, see
[ADR 0004](adr/0004-creek-vault-http-application-boundary.md).

## Where the wire contract actually lives

Do not restate Creek's request/response shapes here — that mirroring
is what let this document and Creek's real server drift apart, which
ADR 0004's Context section documents in detail. Instead:

- Creek's ratified, canonical `/v1` contract **has shipped**
  (creek-vault#1072, closed). It is published as a generated bundle at
  `docs/contracts/adepthood-v1/` in the `Geoffe-Ga/creek-vault`
  repository: 16 JSON Schemas, a `retry-policy.json` disposition
  table, a four-capability by seven-state example matrix, and a
  `manifest.json` recording a sha256 per generated file. Creek's ADR
  `docs/decisions/2026-07-31-adepthood-http-application-api.md` is the
  decision behind it. That bundle — not this file, and no longer
  Creek's server code read by hand — is the authoritative source for
  every `/v1` request and response shape.
- Adepthood **vendors** that bundle byte-for-byte at a pinned upstream
  commit, under `backend/tests/fixtures/creek_v1/`, alongside a
  `vendor.json` sidecar recording the source repository, commit, path,
  contract version, ontology version, and a sha256 per vendored file.
  Copy-and-pin is upstream's own prescribed integration, and it is
  what lets adepthood's tests assert against Creek's real bytes
  instead of against a second, independently-editable mirror — the
  mirroring that produced the divergences ADR 0004's Context section
  documents.
- Two checks keep the copy honest, and both fail loudly rather than
  quietly: an offline test asserts every vendored file still hashes to
  its recorded digest and that the vendored set is exactly the
  recorded set, and a scheduled workflow re-fetches the bundle from
  upstream and fails when it no longer matches, naming the capability
  that moved. Neither is allowed to report success for a run that
  compared nothing. The re-vendor procedure lives in the module
  docstring of `backend/tests/test_creek_contract_conformance.py`.
- The MCP surface is unaffected: Creek's `creek-tools/creek_mcp/`
  server remains the agent-facing adapter for CrawDad, Claude Code, and
  Hermes. Adepthood's own MCP client is retired (ADR 0004's 2026-08-07
  note) — nothing in this repository calls Creek over MCP any more, and
  nothing about Creek's MCP surface changed to make that so. The bundle
  describes `/v1` only.
- **This document's *filename* still says `mcp`; its title no longer
  does, and neither says anything about how adepthood reaches Creek.**
  The filename is retained for the link-stability reason ADR 0004's
  Decision 5 gives and its 2026-08-07 note re-examines — the inbound
  references have not moved, and one of them, the drift guard
  `backend/tests/test_contract_version_docs.py`, reads this file by
  path. The title was corrected on 2026-08-19 because it cost nothing
  to correct and, unlike the path, it is what a reader sees first.
  Every `creek.*` capability name below (`CreekCapability` in
  `domain/creek_vault.py`) is adepthood's own vocabulary and telemetry
  key, chosen because it was minted that way originally; it is not a
  claim about how the call reaches Creek.
- The version this document pins against is Creek's published
  `CONTRACT_VERSION`, which the vendored bundle's `manifest.json`
  restates and which
  `backend/tests/test_creek_contract_conformance.py` asserts equal to
  `domain/creek_vault.py`'s constant.
- **The pin above is behind upstream, deliberately and visibly.** As of
  2026-08-19 Creek publishes contract **0.8.0** (a 54-file bundle at
  `docs/contracts/adepthood-v1/`) while adepthood vendors and pins
  **0.2.0**. This is not an outage: `0.2` is still a member of
  upstream's `supported_contract_minors`, so every capability adepthood
  actually calls is still served exactly as before. It has one concrete
  consequence, and it is the reason the gap is written down here rather
  than left to the drift workflow. From contract 0.8.0 onward the
  advertised capability list is keyed on the caller's minor, so a
  `0.2`-pinned client is **never told about `upload`** and is refused
  `incompatible_version` if it calls `POST /v1/uploads` anyway. Raising
  the pin is therefore a prerequisite for the upload capability, not
  bookkeeping. Tracked on epic
  [#2043](https://github.com/Geoffe-Ga/adepthood/issues/2043).

## Shared ontology and tier mapping (adepthood-owned)

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

**How the ceiling reaches Creek over `/v1`.** Every request carries an
`X-Creek-Tier-Ceiling` header, derived from the material that call
touches — the entry's own tier for a write or a reflection, `personal`
for the whole-corpus wheel read, `open` for the content-free capability
handshake. It is not optional: Creek admits an absent header at `open`
(`creek_mcp/httpapi/middleware/ceiling.py`) and an `open` ceiling cannot
admit a `personal` write, so a client that omits it has every
default-classification entry refused `403 privacy_refused` and reads a
wheel computed over open-tier material alone. That was the state of this
client until issue #2246.

The header's vocabulary is **narrower than the table above**: Creek caps
every network consumer below intimate, so its wire enum publishes only
`open` and `personal` and `INTIMATE` has no spelling on `/v1` at all.
Adepthood encodes that as a separate `WireTierCeiling` type, with
`wire_ceiling_for` the one translation into it — it refuses rather than
narrowing, so an intimate ceiling cannot reach a request header even by
mistake.

## Wheel-of-Wholeness projection (adepthood-owned)

Creek's `creek.wheel` computes and owns the Frequency-wheel counts and
shares — ten buckets, `F1` through `F10`
(`creek-tools/creek_mcp/tools/wheel.py`, `creek-tools/creek_mcp/server.py`).
Adepthood's `WheelBalanceResponse` (`backend/src/schemas/wheel.py`) is a
*ten-stage aspect-fullness* projection, and the projection from one onto the
other is Adepthood's to own — Creek must not invent our stage/aspect
vocabulary on our behalf. The fact that both land on ten buckets is a
numeric coincidence, **not a semantic identity**: `F1..F10` are
Creek's frequency classification of corpus content, while adepthood's
ten stages are `CourseStage` rows tied to the APTITUDE program.

### The request

`/v1/wheel` is a bare `GET` with no query parameters and no body — the
ratified surface publishes neither for this capability, and sending an
undocumented one would be guessing at a contract (`_get_wheel`).

The ceiling therefore travels in a **header**, not in the request shape:
every `/v1` call declares `X-Creek-Tier-Ceiling`, and the wheel read
declares `personal` from `_WHEEL_WIRE_CEILING`. That is what
`_WHEEL_TIER_CEILING` has always named — the widest ceiling adepthood is
willing to accept — and it is now also what adepthood *asks* Creek to
count at. `_admissible_wheel` still refuses a response that echoes
anything wider, so the declaration and the check agree rather than the
check standing alone.

Declaring it matters, because the alternative is not neutral. Absent the
header Creek applies its published `open` default to what it *counts*,
and `open` ranks unclassified content below `personal`: a not-yet-classified
fragment is silently excluded, so a young corpus — most of whose entries
have no Frequency yet — reads back as an all-zero wheel even though it
plainly is not empty. Declaring `personal` is what stops that silent
undercount. How adepthood treats a genuinely all-zero answer as
legitimate rather than a failure is covered in "WHEEL over `/v1`" under
"Per-capability fallback rules" below.

`personal` is the honest maximum here, on either reading: only aggregate
per-Frequency counts and shares cross this seam — never fragment content
— no intimate *journal entry* reaches the vault from adepthood at all
(see "Intimate-tier content: pointer only" below for the per-surface
rule), and creek independently caps a network consumer below intimate
regardless of what adepthood would ask for.

Symbols above are named rather than cited by line number on purpose: the
previous exact-range citations drifted the moment lines were inserted
earlier in the file, which is a footgun this doc has already stepped on.

### The response projection

The adapter walks a whitelist of the ten `F1..F10` codes rather than
whatever keys the vault's `wheel` map happens to contain
(`_wheel_aspects`, `creek_vault_client.py:571-582`), and projects each
surviving entry as follows:

| Creek `wheel["F<n>"]` field | Adepthood field | Notes |
| --- | --- | --- |
| the `F<n>` key itself | `stage_number` = `n` | Canonical order comes from the whitelist, not the map's iteration order |
| `share` | `fullness` | Read as a float; a boolean is rejected before the numeric test (`_wheel_fullness`, `creek_vault_client.py:520-543`) |
| `count` | *(not used)* | Adepthood renders proportions, not raw counts |
| `name` | *(carried, never rendered)* | Validated at the seam but relabelled before it reaches the read path — see below |

The envelope's `total_classified`, `unclassified`, `tool`, and
`tier_ceiling` fields are read by nothing on adepthood's side. Unknown
keys — extra envelope fields, and any Frequency code outside
`F1..F10` — are ignored rather than erroring, the same
drop-don't-coerce discipline the marginalia mapping below already
describes for unrecognized kinds.

### The vocabulary decision

Creek's canonical Frequency names are `Agency`, `Receptivity`,
`Self-Love / Power`, `Community Love / Conformity`, `Achievism`,
`Pluralism`, `Integration`, `True Self / Transcendence`, `Unity`, and
`Emptiness`. Adepthood's seeded `CourseStage.aspect` labels for stages
1–10 (`backend/src/curriculum/archetypal_wavelength.json`) are `Agency`,
`Receptivity`, `Self-Love`, `Community Love`, `Intellectual
Understanding`, `Embodied Understanding`, `Systems Wisdom`, `True Self
Connection`, `Unity`, and `Emptiness`. Same APTITUDE ontology, different
wording for stages 5 through 8 — Creek's "Achievism" and "Pluralism"
where adepthood says "Intellectual Understanding" and "Embodied
Understanding", for instance.

Because of that mismatch, the vault's `name` is validated and carried
as the faithful wire value at the seam (bounded, non-blank, and
printable — `_wheel_aspect`, `creek_vault_client.py:546-568`), but it
is never what the user reads. The read path relabels every item from
adepthood's own `CourseStage` rows before rendering
(`_relabelled_items`, `backend/src/services/creek_vault_wheel.py:150-167`,
calling the now-public `aspect_labels_by_stage`,
`backend/src/domain/wheel.py:54-69`). A wheel that cannot be relabelled
in full — a missing or blank `CourseStage` row for any of the ten
stages — is discarded whole rather than rendered as a hybrid of vault
words and adepthood words
(`select_wheel_balance`, `creek_vault_wheel.py:170-183`). This is what
"Creek must not invent our stage/aspect vocabulary on our behalf" means
concretely: creek's `name` never reaches a screen.

### Bounds on untrusted input

A wheel payload is untrusted input like any other vault response, and
is bounded accordingly before anything is built from it
(`creek_vault_client.py:520-582`):

- `name` is length-bounded (`_MAX_WHEEL_ASPECT_NAME_LENGTH`, 128
  characters), must be non-blank, and must be printable. A Frequency
  name is short label text, so a control character in one is never
  legitimate, and CR/LF, an ANSI escape, or a bidirectional override is
  exactly the payload that forges a log line or misrenders a label —
  the same rule the seam already applies to a vault-issued fragment id.
- `share` must be a real number; a boolean is explicitly rejected
  rather than silently read as a fully-full Frequency, and an integer
  too large for a float to hold is treated as unreadable rather than
  raising an `OverflowError` past the seam's degrade set. JSON has no
  integer ceiling, so that literal really can arrive.
- A Frequency entry that fails either check drops the *entire* wheel
  (`_parse_wheel`, `creek_vault_client.py:585-604`) rather than yielding
  a ring with one bucket missing.
- Adepthood reads at most the ten whitelisted `F1..F10` codes no matter
  how large a map the vault sends.

## Marginalia mapping (adepthood-owned)

Creek's `creek.reflect` emits margin notes with a `kind` drawn from
seven values: `{reframe, fear, longing, value, pattern, tension,
gift}` (`creek-tools/creek_mcp/tools/reflect.py:85`). Adepthood's
`MarginaliaKind` permits only three: `{theme, connection, symbol}`
(`backend/src/models/marginalia.py:23-28`), enforced by a database
`CHECK` constraint (`marginalia.py:42-45`) and mirrored in
`domain/resonance.py:21`'s `VALID_KINDS`. A raw passthrough of Creek's
`kind` would be rejected by that constraint outright, so the
translation below happens in adepthood's client adapter, not in
Creek — Creek owns its own vocabulary and must not be asked to learn
adepthood's:

| Creek kind | Adepthood kind | Why |
| --- | --- | --- |
| `pattern` | `connection` | Creek grounds its notes in the surrounding corpus, so a recurrence note is exactly adepthood's cross-entry "connection" |
| `reframe` | `theme` | A reinterpretation of this one entry, not a cross-entry link |
| `fear` | `theme` | An affective reading of the entry's own content |
| `longing` | `theme` | Same: affect surfaced from the entry itself |
| `value` | `theme` | A value the entry expresses is a theme of the entry |
| `tension` | `theme` | An intra-entry tension is thematic, not relational across entries |
| `gift` | `theme` | A quality observed in the entry — thematic |

Unrecognized kinds are dropped, not coerced: a `kind` adepthood does
not know is never stored or rendered — the same drop-don't-coerce
discipline the client already applies to unknown capability and
error-code strings. Dropping one note does not discard its siblings.

`symbol` is deliberately unused. Nothing in Creek's vocabulary denotes
an image standing for something else, and forcing a non-symbol note
onto that kind would misrender it. `symbol` remains reachable only
from adepthood's own cloud reflection path.

## Per-capability fallback rules (as shipped)

Every capability degrades independently; a vault missing one
capability is still used for the others it supports:

- **JOURNAL** — the one capability with a ratified `/v1` shape.
  `CREEK_VAULT_PROTOCOL` now admits exactly one value, `http` (its own
  default), so there is a single wire path: the client gates on the
  handshake having advertised `creek.journal` — an unadvertised
  capability is refused locally, with no request sent
  (`_ingest`, `backend/src/services/creek_vault_client.py:1394-1417`)
  — before issuing a `PUT` to the entry's own
  `/v1/journal-entries/{entry_id}` URL
  (`_put_journal_entry`, `creek_vault_client.py:1355-1381`). If the
  vault is absent or otherwise unavailable at handshake time, the write
  path reports `UNAVAILABLE`
  (`backend/src/services/creek_vault_write.py:266-267`); if the
  handshake succeeds but the ingest call itself fails — or answers
  with a payload the client cannot verify as a durably stored write —
  it reports `DEGRADED` (`creek_vault_write.py:276-277`). A failed
  ingest is further classified into one of three kinds an operator can
  act on differently — a contract violation (bad payload, an unclaimed
  capability, or a version mismatch), a rejected credential (401/403),
  or a plain unavailable vault (timeout, 5xx, an unreadable success
  body) — each logged with its own `VaultDegradeReason` in
  content-free structured fields (`creek_vault_write.py:77-95`).
  **A failed replication is dropped, not queued: there is no retry
  and no backlog.** The write is logged once and forgotten, and the
  operator's own Postgres remains the sole system of record for that
  content either way. Adepthood once also spoke MCP for this
  capability, through a client of its own; that client is retired
  (ADR 0004's 2026-08-07 note) — Creek's own MCP server is untouched
  and remains what agents like CrawDad, Claude Code, and Hermes talk
  to, but nothing in this repository calls it any more.
- **UPLOAD** — a *required* capability for the document-upload surface,
  and gated entirely separately from JOURNAL: a vault that advertises
  `creek.journal` has said nothing about whether it accepts files, so
  the upload path checks `creek.upload` on its own
  (`store_upload`, `backend/src/services/creek_vault_upload.py`) and an
  unadvertised capability is refused locally with no request sent
  (`_upload`, `backend/src/services/creek_vault_client.py`). Adepthood
  `PUT`s the document to its own `/v1/uploads/{external_id}` URL,
  carrying `filename`, `content_base64`, `timestamp`, and `tier`, and
  **names no source or content type**: the vault reads the extension
  off the filename and selects its own ingestor, so adepthood never
  parses, sniffs, or classifies the document. `external_id` is a
  deterministic digest of (owner user id, filename), which is what makes
  a re-send idempotent — the vault edits the same fragment in place
  rather than accumulating one per attempt — and it is a *digest*
  specifically so a filename, which is the user's own words about their
  life, never travels in a request line or an access log.

  Tier semantics match JOURNAL: the document's tier and the declared
  write ceiling are both the uploader's chosen tier, so the vault stores
  at exactly that depth and refuses any widening.

  Graceful degradation is finer-grained here than for JOURNAL, because
  an upload has **no local system of record** — if the vault will not
  take the document, it went nowhere, and the user has to be told which
  problem they have. An unreachable vault reports `VAULT_UNAVAILABLE`,
  a reachable vault that never advertised the capability reports
  `CAPABILITY_UNSUPPORTED`, and a call that failed mid-flight (or
  answered without durably storing) reports `DEGRADED`. All three are
  answered as a `202` carrying the status and a self-serve message —
  never a 5xx, since an optional integration being absent is not a
  server fault. As with JOURNAL, **a failed upload is dropped, not
  queued**: there is no spool, because durably holding user document
  bytes outside the vault is a privacy decision nobody has made.

  Per-fragment classification tags are read from the response when the
  vault supplies them and are otherwise empty, which is the expected
  answer today rather than a failure — adepthood deliberately builds no
  second, local classifier.

  **Intimate documents are forwarded, unlike intimate journal entries.**
  An `intimate` upload is sent at the `INTIMATE` tier ceiling rather than
  withheld, per the 2026-08-08 amendment to ADR 0004's Decision 6: the
  vault is the user's own corpus on operator-held infrastructure, and
  this path calls no cloud LLM. The vault's router still enforces the
  ceiling it is handed, so a vault declining to store at `INTIMATE`
  refuses the write and adepthood degrades honestly rather than
  downgrading the tier to force a success. Note the asymmetry with
  JOURNAL, which remains skip-only — see the amendment for why that is
  deliberate and tracked in issue #2152.

  **This path does not exist on `/v1` today**, and cannot as written:
  the HTTP client refuses UPLOAD as unratified before any request, and
  `/v1`'s ceiling vocabulary has no `intimate` member to declare even if
  it did. Whenever the upload surface is ratified, "forwarded at the
  `INTIMATE` ceiling" is a decision that has to be re-made against a
  transport that cannot express it — not one this client can carry over.
- **REFLECT** — if absent, adepthood falls back to its existing cloud
  LLM reflection path
  (`select_reflection_llm`, `backend/src/services/creek_vault_reflect.py:158-190`).
  The same fallback fires for Creek's `empty` status, which yields no
  vault reflection exactly as an absent capability does — but not for
  its `escalate` care handoff, which is not a fallback at all (see the
  next bullet). An `ok` response none of whose
  notes survive the marginalia-kind translation above also falls
  back, rather than rendering an empty note set. A vault response is
  untrusted input: the number of notes adepthood will accept from one
  response is bounded, and each note's quote and note text are
  length-bounded, before anything is built from them. Additive fields
  Creek may add later — its optional `essay`, and any future
  related-praxis or related-eddies fields — are ignored rather than
  erroring. Content already flagged by the care gate never calls the
  vault for a reflection at all, regardless of vault availability.
- **REFLECT over `/v1`** — the ratified request *body* carries no tier
  ceiling (`ReflectionRequest` is `additionalProperties: false` and
  publishes none), so the entry's own ceiling is declared in the
  `X-Creek-Tier-Ceiling` header instead, and adepthood still verifies
  the `tier_ceiling` and `routed_tier` the vault echoes back: what was
  asked for and what was applied are two separate claims. A care
  escalation is a **200, not an error**: it leaves the seam as
  `CreekVaultCareEscalationError` — deliberately outside the
  `CreekVaultError` hierarchy the read path degrades on — and the
  resonance handler answers it with adepthood's own reviewed care
  resources and no reflection, never with a cloud fallback and never
  with Creek's own copy.
- **WHEEL** — if absent, or if the vault does not advertise it,
  `fetch_vault_wheel` returns `None` before any call is made
  (`backend/src/services/creek_vault_wheel.py:128-147`). A malformed or
  refused payload degrades exactly like every other capability: a
  non-2xx response is classified into the `CreekVaultError` hierarchy by
  `_read_failure`
  (`backend/src/services/creek_vault_client.py:1065-1090`), and a 2xx
  that will not decode, is missing a required field, or echoes a ceiling
  wider than adepthood accepts becomes `CreekVaultPayloadError`
  (`_wheel`, `creek_vault_client.py:1552-1588`) — rather than surfacing
  a raw `pydantic.ValidationError` as an earlier version of this client
  once did, the one deliberately un-normalized error path it used to
  have. The read path catches only that error hierarchy
  (`_read_balance`, `creek_vault_wheel.py:106-125`). A well-formed
  balance then still has to clear domain-range validation (stage numbers
  in range, fullness in `0.0..1.0`, all ten stages present with no
  duplicates) or `fetch_vault_wheel` returns `None` all the same. So does
  a *valid* all-zero wheel — creek's documented answer for an empty or
  wholly-unclassified corpus — because it carries no information and
  would blank a Map the local computation can fill
  (`_carries_signal`, `creek_vault_wheel.py:85-95`). Any of these causes
  `select_wheel_balance` to fall back to computing the balance locally
  (`creek_vault_wheel.py:170-183`).
- **WHEEL over `/v1`** — the ratified surface publishes no request field
  and no query parameter for a ceiling, so the read declares `personal`
  in the `X-Creek-Tier-Ceiling` header, and verifies the ceiling the
  vault echoes back besides — refusing a payload claiming a wider one.
  `personal` is the honest maximum: intimate content never reaches the
  vault from adepthood, and Creek independently caps a network consumer
  below intimate. It matters that it is declared rather than defaulted,
  because Creek ranks unclassified fragments with `personal`, so a read
  left at the server's `open` default counts only classified open-tier
  material and reads back as an all-zero wheel on a young corpus. That
  all-zero answer is still a valid one rather than a failure when the
  corpus really is empty, and falls back to the locally-computed
  balance by the same `_carries_signal` rule above.
- **CLASSIFY** — has **no call site anywhere in `backend/src`**.
  Adepthood does not call Creek's classify capability today; every
  Frequency/Wavelength tag in the app is produced locally.

## Intimate-tier content: pointer only

The rule governing whether, and how, intimate content may ever cross
the adepthood-to-vault seam is recorded in
[ADR 0004](adr/0004-creek-vault-http-application-boundary.md),
Decision 6, not in this document. **It differs by surface**, and the
split is deliberate:

- **Journal entries — skip-only, unchanged.** The ciphertext/attested
  transit topology in Decision 6 (a)–(d) is **entirely unshipped**, so
  today's behavior remains the skip-only mode from
  [ADR 0002](adr/0002-intimate-content-local-routing.md): an `intimate`
  classification short-circuits before any vault call at all, not even
  a handshake. No intimate journal *entry* is transmitted to any vault
  today, in any form.
- **Document uploads — vault-only.** Per the 2026-08-08 amendment to
  Decision 6, an `intimate` document sent to `POST /journal/upload`
  **is** forwarded to the vault, at the `INTIMATE` tier ceiling. The
  amendment's reasoning is that the vault is the user's own corpus on
  operator-held infrastructure rather than a third-party service, and
  that this path calls no cloud LLM.

The asymmetry between the two is known and tracked in issue #2152;
read Decision 6's amendment before treating either half as the general
rule.

## Vault tenancy: pointer only

Tenancy is not part of Creek's `/v1` wire contract at all — none of
`ReflectionRequest`, `JournalUpsertRequest`, `/v1/wheel`, or
`CapabilitiesResponse` carries a tenant field to document here. The
rule governing how adepthood copes with that absence — binding a
configured vault to exactly one adepthood user — is recorded in
[ADR 0004](adr/0004-creek-vault-http-application-boundary.md),
Decision 7, not in this document.
