# Creek Vault MCP contract (pointer + adepthood-owned projections)

- **Status:** Superseded pointer doc. This file no longer restates
  Creek's wire contract; see
  [ADR 0004](adr/0004-creek-vault-http-application-boundary.md) for
  the application-boundary decision and the version pin.
- **Contract version:** 0.2.0
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

- Creek's ratified, canonical `/v1` contract is tracked in
  creek-vault#1072. As of this writing that issue is **open and has
  shipped nothing** — treat any `/v1` shape as **PENDING
  creek-vault#1072** until it ships.
- Until `/v1` ships, Creek's own published reference is
  `docs/decisions/2026-06-30-adepthood-creek-mcp-contract.md` in the
  `Geoffe-Ga/creek-vault` repository. Read that document, and Creek's
  actual server code (`creek-tools/creek_mcp/contract.py`,
  `server.py`, `tools/reflect.py`, `tools/wheel.py`), for the
  authoritative shapes — not this file.
- The version this document pins against is Creek's currently
  published `CONTRACT_VERSION` constant (`creek-tools/creek_mcp/contract.py:18`),
  not a guess at what `/v1` will eventually say.

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

## Wheel-of-Wholeness projection (adepthood-owned)

Creek's `creek.wheel` computes and owns the Frequency-wheel counts and
shares — ten buckets, `F1` through `F10`
(`creek-tools/creek_mcp/tools/wheel.py:95-110`). Adepthood's
`WheelBalanceResponse` (`backend/src/schemas/wheel.py`) is a *ten-stage
aspect-fullness* projection, and the projection from one onto the
other is Adepthood's to own — Creek must not invent our stage/aspect
vocabulary on our behalf. The fact that both land on ten buckets is a
numeric coincidence, **not a semantic identity**: `F1..F10` are
Creek's frequency classification of corpus content, while adepthood's
ten stages are `CourseStage` rows tied to the APTITUDE program. The
concrete field-by-field projection is owned by adepthood #1937.

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

- **JOURNAL** — the one capability with a ratified `/v1` shape, so it
  is wired up on both transports adepthood can select via
  `CREEK_VAULT_PROTOCOL` (default `mcp`, unchanged): the MCP client
  calls the vault's ingest tool directly, and the HTTP client
  (`CREEK_VAULT_PROTOCOL=http`) gates on the handshake having
  advertised `creek.journal` — an unadvertised capability is refused
  locally, with no request sent — before issuing a `PUT` to the
  entry's own `/v1/journal-entries/{entry_id}` URL
  (`backend/src/services/creek_vault_client.py:1241-1288`). Either
  way, if the vault is absent or otherwise unavailable at handshake
  time, the write path reports `UNAVAILABLE`
  (`backend/src/services/creek_vault_write.py:266-267`); if the
  handshake succeeds but the ingest call itself fails — or answers
  with a payload the client cannot verify as a durably stored write —
  it reports `DEGRADED` (`creek_vault_write.py:276-277`). Under HTTP,
  a failed ingest is further classified into one of three kinds an
  operator can act on differently — a contract violation (bad
  payload, an unclaimed capability, or a version mismatch), a
  rejected credential (401/403), or a plain unavailable vault
  (timeout, 5xx, an unreadable success body) — each logged with its
  own `VaultDegradeReason` in content-free structured fields
  (`creek_vault_write.py:77-95`). **A failed replication is dropped,
  not queued: there is no retry and no backlog.** The write is logged
  once and forgotten, and the operator's own Postgres remains the
  sole system of record for that content either way.
- **REFLECT** — if absent, adepthood falls back to its existing cloud
  LLM reflection path (`backend/src/services/creek_vault_reflect.py:108-123`).
  The same fallback fires for a response whose `status` is anything
  other than `ok` — Creek's `empty`, its `escalate` care-signal
  envelope, and its `refused` envelope all yield no vault reflection,
  exactly as an absent capability does. An `ok` response none of whose
  notes survive the marginalia-kind translation above also falls
  back, rather than rendering an empty note set. A vault response is
  untrusted input: the number of notes adepthood will accept from one
  response is bounded, and each note's quote and note text are
  length-bounded, before anything is built from them. Additive fields
  Creek may add later — its optional `essay`, and any future
  related-praxis or related-eddies fields — are ignored rather than
  erroring. Content already flagged by the care gate never calls the
  vault for a reflection at all, regardless of vault availability.
- **WHEEL** — if absent, or if the returned payload fails
  field-level validation, `fetch_vault_wheel` returns `None`
  (`backend/src/services/creek_vault_wheel.py:97-113`), and
  `select_wheel_balance` then falls back to computing the balance
  locally (`creek_vault_wheel.py:115-120`).
- **CLASSIFY** — has **no call site anywhere in `backend/src`**.
  Adepthood does not call Creek's classify capability today; every
  Frequency/Wavelength tag in the app is produced locally.

## Intimate-tier content: pointer only

The rule governing whether, and how, intimate content may ever cross
the adepthood-to-vault seam is recorded in
[ADR 0004](adr/0004-creek-vault-http-application-boundary.md),
Decision 6, not in this document. That rule is **entirely unshipped**.
Today's actual behavior is the skip-only mode from
[ADR 0002](adr/0002-intimate-content-local-routing.md): an `intimate`
classification short-circuits before any vault call at all, not even a
handshake. No intimate journal content is transmitted to any vault
today, in any form.
