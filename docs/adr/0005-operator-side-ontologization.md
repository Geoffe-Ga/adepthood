# ADR 0005: Operator-side ontologization of OPEN/PERSONAL content

- **Status:** Accepted
- **Date:** 2026-08-12
- **Issue:** epic [#2228](https://github.com/Geoffe-Ga/adepthood/issues/2228)
- **Amends:** ADR 0002 Decision 1 (scope of the shared-hosting rejection);
  ADR 0004 Decision 6 (extends the operator-held reasoning to a path
  that *does* call an LLM)

## Context

NORTH-STAR section 2 promises a corpus that "speaks back, calibrated to
where you are right now." At launch, no user has that. Grounding for
the Higher Self is `_recent_prior_bodies` — `ORDER BY id DESC LIMIT 5`,
each body truncated to 1000 characters. Recency, not relevance, and no
embeddings exist anywhere in the backend.

The ratified answer to that gap is the user's Creek Vault. It is worth
being precise about what the vault actually contributes, because an
earlier reading of it as "private storage plus retrieval" understated
it badly. Creek is an **ontologization pipeline**. It ingests a
person's heterogeneous corpus — `creek/ingest/` carries `claude.py`,
`chatgpt.py`, `gdrive.py`, `substack.py`, `discord.py`, `documents.py`,
`spreadsheets.py`, `presentations.py`, `code.py`, `html.py`,
`images.py` — and classifies every fragment into the APTITUDE frequency
ontology declared at `creek_mcp/api/models.py:848`:

| Code | Name | Code | Name |
| --- | --- | --- | --- |
| F1 | Agency | F6 | Pluralism |
| F2 | Receptivity | F7 | Integration |
| F3 | Self-Love / Power | F8 | True Self / Transcendence |
| F4 | Community Love / Conformity | F9 | Unity |
| F5 | Achievism | F10 | Emptiness |

Fragments compose holonically, weighted by conviction rather than
length (`creek/classify/holonic.py`: "A 3-word phrase ('Yes, I'm
rising.') confidently asserting F2/rising should outweigh a 500-word
ramble dimly hedging restoration"), across further passes for privacy
tier, audience, fidelity, evidence, praxis, and tags.

That ontologized corpus is what lets the Higher Self speak *in the
shape of APTITUDE* rather than in generic-LLM shape. Semantic retrieval
over raw journal text is not a substitute for it. It is a substitute
for the recency window, which is a much narrower claim.

But the vault as ratified is not a Day-1 capability. ADR 0002
Decision 1 and creek-vault ADR-0007 Decision 1 require a persistent
per-user VM; Decision 2 requires a user-held Argon2id key with no
operator escrow; Decision 3 puts an attested H100-class GPU enclave in
scope *by necessity*, because "CPU-small models follow instructions
inadequately." creek-vault#757 shipped the cryptographic primitives —
`creek/confidential/keyvault.py` (#758), the network transport (#759),
the attested enclave provider (#760) — but the repository contains no
deployment tooling of any kind: no Dockerfile, no compose file, no
Terraform, no Helm chart. There is nothing that turns the package into
a provisionable per-user instance, and knowing that the vault also runs
per-fragment LLM classification over a person's entire history makes
the per-user cost larger, not smaller.

So the question this ADR answers is: what does a user get on Day 1?

## Decision 1 — Adepthood classifies OPEN/PERSONAL content server-side

Adepthood runs the APTITUDE frequency classification over each user's
OPEN and PERSONAL content, in its own backend, storing the result in a
per-user corpus in its own database. Every user therefore has an
ontologized corpus and a Higher Self grounded in it, from first use,
with no per-user VM, no enclave, and no per-user GPU cost.

INTIMATE content does not enter this corpus and is not classified by
this path. Today's shipped behaviour — the skip-only short-circuit from
#895, `services/creek_vault_write.py:17-24`, which returns before even
a handshake — is carried forward unchanged.

## Decision 2 — The shared-hosting rejection is scoped to its own reasoning

ADR 0002 Decision 1 rejected multi-tenant or shared hosting in these
words:

> an operator-run shared store means the operator can see intimate
> content in the ordinary course of running the service — exactly the
> trust boundary this whole decision exists to remove.

The harm named is specific: the operator seeing **intimate** content.
A corpus that by construction contains no INTIMATE content does not
produce that harm, and the rejection therefore does not reach it. This
is consistent with ADR 0002 Decision 3, which permits cloud routing and
BYOK "for OPEN and PERSONAL tiers only" — the tier line, not the
hosting topology, is where that ADR actually draws its boundary.

This is a reading of Decision 1's scope, recorded deliberately rather
than assumed quietly. Decision 1 is not weakened for the vault: an
operator-run store holding INTIMATE content remains rejected, and
nothing here confers a confidential-compute guarantee on anything.

## Decision 3 — This is a new operator-readable surface, and it is disclosed

The per-user corpus lives in Adepthood's own database. Rows are scoped
to a user the way every other table's rows are, which gives isolation
*between users*. It does not give operator-blindness, and the two must
never be described as though they were the same property. The operator
can read this table.

That is a new trust surface, and ADR 0012 requires that consent be an
auditable event rather than an implicit state. Therefore:

- Each imported source records what was imported, when, and under what
  consent.
- The user-facing promise from #927 — "your writing lives in your own
  private space that only you can open, and your intimate writing is
  never handed to an outside AI" — must not be stated in a way this
  decision makes untrue. The second clause remains exactly true. The
  first describes the vault, and may only be claimed where a vault is
  actually configured.
- Copy review is part of shipping epic #2228, not a follow-up to it.

## Decision 4 — The distinction from ADR 0004 Decision 6 is the LLM call

ADR 0004 Decision 6's amendment of 2026-08-08 (owner ruling, #1924 /
PR #2149) already permits an INTIMATE document to reach an
operator-held vault in plaintext, on the reasoning that a Creek Vault
is "the user's **own** corpus on operator-held infrastructure, not a
third-party service." That ruling rests explicitly on a narrow fact:
"the upload path never does [reach a cloud LLM], because it calls no
LLM at all."

This ADR's path *does* call an LLM. The reasoning of Decision 6's
amendment therefore does not extend to it, and is not relied upon here.
What permits this path is Decision 1's tier scope (above) plus ADR 0002
Decision 3's OPEN/PERSONAL allowance — nothing else. The two paths
consequently differ by tier, and that difference is intentional:

| Path | OPEN / PERSONAL | INTIMATE |
| --- | --- | --- |
| Vault configured for the user | vault, unchanged | vault, unchanged (ADR 0004 D6 amendment) |
| No vault | classify + store locally | not classified, not stored in the corpus |

## Decision 5 — The ontology vocabulary is Creek's, and is vendored, not reinvented

The F1..F10 vocabulary is a shared contract. Creek declares it with
`extra="forbid"` and states that "an eleventh frequency is a change to
the shared ontology vocabulary — a contract change with a version
bump." Adepthood's server-side classifier vendors that vocabulary and
its classification prompt, following the existing contract-vendoring
pattern at `backend/tests/fixtures/creek_v1/`, rather than
reimplementing it from memory. A divergence between Adepthood's
frequencies and Creek's would silently corrupt every corpus that later
migrates to a vault.

The projection from Creek's frequencies onto Adepthood's ten stages is
unchanged and remains the consumer's own, per the vocabulary boundary
documented in `creek_mcp/httpapi/wheel.py` and shipped in #1937 /
PR #2080. Ten frequencies and ten stages are "a coincidence of
cardinality, not a shared meaning." This ADR does not touch that seam.

## Decision 6 — The confidential vault is not descoped

The vault remains the ratified end state and gains a clearer job. It is
the upgrade that (a) extends ontologization to INTIMATE content and
(b) removes operator-readability entirely. Both are real, both are
worth paying for, and neither blocks launch.

Per-user vault *configuration* — moving URL and credential from process
environment to a per-user record (#2233) — is unblocked, requires no
Creek contract change, and ships alongside this work so that a user who
runs their own Creek is served from Day 1 too.

## Consequences

- Every user gets an APTITUDE-shaped Higher Self at launch, not only
  the users who could self-host a vault.
- Adepthood takes on a per-fragment inference cost over user-imported
  history. This is a quota and rate-limit design problem; BYOK is the
  primary lever, reusing the existing `ApiKeySettings` pattern.
- Adepthood's database becomes a store of classified personal content,
  raising the stakes on at-rest encryption, backup handling, export,
  and deletion. Account deletion must delete the corpus.
- The classifier becomes a correctness surface: a systematically
  miscalibrated frequency assignment yields a Higher Self that speaks
  confidently in the wrong register. Calibration needs evaluation, not
  only unit tests.
- Two grounding paths now exist (vault, local corpus) plus the empty
  state. Each is a tested branch; an empty corpus degrades to today's
  behaviour rather than erroring, on the same principle Creek applies
  to a freshly-initialised vault.
- If the confidential vault later ships, corpora must migrate into it.
  The vendored-vocabulary rule in Decision 5 is what keeps that
  migration mechanical instead of lossy.
