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
(`creek-tools/creek_mcp/tools/wheel.py`, `creek-tools/creek_mcp/server.py`).
Adepthood's `WheelBalanceResponse` (`backend/src/schemas/wheel.py`) is a
*ten-stage aspect-fullness* projection, and the projection from one onto the
other is Adepthood's to own — Creek must not invent our stage/aspect
vocabulary on our behalf. The fact that both land on ten buckets is a
numeric coincidence, **not a semantic identity**: `F1..F10` are
Creek's frequency classification of corpus content, while adepthood's
ten stages are `CourseStage` rows tied to the APTITUDE program.

### The request

`creek.wheel` takes exactly one caller-supplied parameter,
`privacy_tier_ceiling`; unlike `creek.classify` there is no `consumer`
parameter — the vault fills that in from its own MCP session
(`_wheel_params`, `backend/src/services/creek_vault_client.py:658-666`).
Adepthood always sends `personal`
(`_WHEEL_TIER_CEILING`, `creek_vault_client.py:237-246`), because only
aggregate per-Frequency counts and shares cross this seam — never
fragment content — so the ceiling governs what the vault *counts*, not
what it hands back. `personal` is the honest maximum here: intimate
content never reaches the vault from adepthood at all (see
"Intimate-tier content: pointer only" below), and creek independently
caps a network consumer below intimate regardless of what adepthood
asks for. Sending `open` would be worse than useless rather than safer,
because creek ranks unclassified content with `personal`: an `open`
ceiling silently excludes every not-yet-classified fragment from the
count, so a young corpus — most of whose entries have no Frequency yet
— reads back as an all-zero wheel even though it plainly isn't empty.

### The response projection

The adapter walks a whitelist of the ten `F1..F10` codes rather than
whatever keys the vault's `wheel` map happens to contain
(`_wheel_aspects`, `creek_vault_client.py:720-731`), and projects each
surviving entry as follows:

| Creek `wheel["F<n>"]` field | Adepthood field | Notes |
| --- | --- | --- |
| the `F<n>` key itself | `stage_number` = `n` | Canonical order comes from the whitelist, not the map's iteration order |
| `share` | `fullness` | Read as a float; a boolean is rejected before the numeric test (`_wheel_fullness`, `creek_vault_client.py:669-692`) |
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
printable — `_wheel_aspect`, `creek_vault_client.py:695-717`), but it
is never what the user reads. The read path relabels every item from
adepthood's own `CourseStage` rows before rendering
(`_relabelled_items`, `backend/src/services/creek_vault_wheel.py:141-158`,
calling the now-public `aspect_labels_by_stage`,
`backend/src/domain/wheel.py:54-69`). A wheel that cannot be relabelled
in full — a missing or blank `CourseStage` row for any of the ten
stages — is discarded whole rather than rendered as a hybrid of vault
words and adepthood words
(`select_wheel_balance`, `creek_vault_wheel.py:161-174`). This is what
"Creek must not invent our stage/aspect vocabulary on our behalf" means
concretely: creek's `name` never reaches a screen.

### Bounds on untrusted input

A wheel payload is untrusted input like any other vault response, and
is bounded accordingly before anything is built from it
(`creek_vault_client.py:669-731`):

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
  (`_parse_wheel`, `creek_vault_client.py:734-753`) rather than yielding
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
- **WHEEL** — if absent, or if the vault does not advertise it,
  `fetch_vault_wheel` returns `None` before any call is made
  (`backend/src/services/creek_vault_wheel.py:119-138`). A malformed or
  refused payload degrades exactly like every other capability: the seam
  adapter now normalizes it to `CreekVaultUnavailableError`
  (`backend/src/services/creek_vault_client.py:893-913`) rather than
  surfacing a raw `pydantic.ValidationError` as it once did — the one
  deliberately un-normalized error path this client used to have — and
  the read path catches only that error hierarchy
  (`_read_balance`, `creek_vault_wheel.py:105-116`). A well-formed
  balance then still has to clear domain-range validation (stage numbers
  in range, fullness in `0.0..1.0`, all ten stages present with no
  duplicates) or `fetch_vault_wheel` returns `None` all the same. So does
  a *valid* all-zero wheel — creek's documented answer for an empty or
  wholly-unclassified corpus — because it carries no information and
  would blank a Map the local computation can fill
  (`_carries_signal`, `creek_vault_wheel.py:84-94`). Any of these causes
  `select_wheel_balance` to fall back to computing the balance locally
  (`creek_vault_wheel.py:161-174`).
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
