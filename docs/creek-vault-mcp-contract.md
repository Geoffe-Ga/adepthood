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

This filename is retained deliberately for link stability — several
backend source docstrings and `docs/adr/0002` reference it by path —
even though its role has changed. It is no longer a draft contract
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

## Marginalia mapping (adepthood-owned, vocabulary gap)

Creek's `creek.reflect` emits margin notes with a `kind` drawn from
seven values: `{reframe, fear, longing, value, pattern, tension,
gift}` (`creek-tools/creek_mcp/tools/reflect.py:85`). Adepthood's
`MarginaliaKind` permits only three: `{theme, connection, symbol}`
(`backend/src/models/marginalia.py:23-27`), enforced by a database
`CHECK` constraint (`marginalia.py:42-45`) and mirrored in
`domain/resonance.py:21`'s `VALID_KINDS`. A raw passthrough of Creek's
`kind` would be rejected by that constraint outright — the two
vocabularies are not aligned and there is no trivial one-to-one
mapping. The concrete kind-by-kind mapping (which of Creek's seven
kinds maps to which of adepthood's three, and what happens to the ones
that don't fit cleanly) is owned by adepthood #1936 and is
deliberately **not** invented in this document.

## Per-capability fallback rules (as shipped)

Every capability degrades independently; a vault missing one
capability is still used for the others it supports:

- **JOURNAL** — if absent from the handshake, or the vault is
  otherwise unavailable, the write path reports `DEGRADED` or
  `UNAVAILABLE` (`backend/src/services/creek_vault_write.py:83-90`);
  the operator's own Postgres remains the sole system of record for
  that content either way.
- **REFLECT** — if absent, adepthood falls back to its existing cloud
  LLM reflection path (`backend/src/services/creek_vault_reflect.py:105-120`).
  Content already flagged by the care gate never calls the vault for a
  reflection at all, regardless of vault availability.
- **WHEEL** — if absent, or if the returned payload fails field-level
  validation, adepthood computes `WheelBalanceResponse` locally
  (`backend/src/services/creek_vault_wheel.py:95-110`).
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
