# ADR 0005: Operator-side ontologization of OPEN and PERSONAL content

- **Status:** Proposed
- **Date:** 2026-08-19
- **Issue:** [#2228](https://github.com/Geoffe-Ga/adepthood/issues/2228)
  (the epic whose posture this record ratifies); written under
  [#2287](https://github.com/Geoffe-Ga/adepthood/issues/2287)
- **Supersedes:** nothing. **Amends:** ADR 0002 Decision 1's harm
  analysis — see Decision 1(c). ADR 0002 itself is not edited.

## Context

This document is late, and the lateness is the first thing to record.
Epic #2228 cites `docs/adr/0005-operator-side-ontologization.md` as an
existing authority; #2229 and #2230 cite it in turn; PR #2245 (merged
2026-08-19, commit `c693804a`) shipped the classifier under it. Until
this commit, `docs/adr/` stopped at `0004`, and
`grep -rn "ADR 0005"` over the repository returned nothing. The
citation lived only in issue bodies. Nothing here is a new policy:
every decision below is traceable to text already ratified in #2228,
ADR 0002, or ADR 0004, and is cited inline. What was missing was the
place the codebase points at.

**What the vault would cost on Day 1.** ADR 0002 Decision 1 ratified a
persistent per-user VM; Decision 2 ratified a user-held key released
into an attested TEE enclave, GPU confidential compute explicitly in
scope. Epic #2228 reports that `creek-vault` ships no deployment
tooling at all today — no Dockerfile, compose, Terraform, or Helm —
and that creek-vault#757 shipped the crypto primitives but not the
provisioning layer. That report is upstream's state, not something
this repository can verify from here; what *is* verifiable here is
that the intimate-transit path those decisions depend on remains
entirely unshipped in adepthood too (ADR 0004 Decision 6:
"**Every one of them is entirely unshipped**").

**The opening the epic uses.** ADR 0002 Decision 3 permits cloud
routing "for OPEN and PERSONAL tiers only"
(`docs/adr/0002-intimate-content-local-routing.md:74-84`); only
INTIMATE is forbidden. ADR 0002 Decision 1's rejection of shared
hosting names exactly one harm, quoted verbatim from `:55-58`:

> **Rejected — multi-tenant or shared hosting:** an operator-run
> shared store means the operator can see intimate content in the
> ordinary course of running the service — exactly the trust boundary
> this whole decision exists to remove.

A corpus that by construction contains no INTIMATE content does not
trigger *that* harm. That is the whole argument, and it is worth
stating its limit in the same breath: it says the named harm is not
triggered, not that no cost is paid. The cost is Decision 1(b).

**A vocabulary note, because two tier names differ.** The epic and
this ADR's title say "OPEN and PERSONAL". `OPEN` is Creek's word;
adepthood's own `JournalClassification` spells the same tier `public`
(`backend/src/models/journal_entry.py:78-80`), and
`domain/creek_vault.py:72-83` says so outright — "Note the `OPEN`
name: it is Creek's word for what adepthood calls `PUBLIC`". Read
"OPEN and PERSONAL" throughout this document as adepthood's `public`
and `personal`.

**What is actually shipped, stated precisely.**
`backend/src/services/frequency_classification.py` exists and refuses
INTIMATE at `:204-205`, before the provider call is constructed at
`:207-212`; the per-fragment ceiling `MAX_FRAGMENT_CHARS` is at `:53`.
It has **no production caller**: a grep for `classify_frequencies`
across `backend/src` finds the definition and nothing else; every
other call site is in
`backend/tests/services/test_frequency_classification.py`. So as of
this date no user's OPEN or PERSONAL content has been sent anywhere by
this pipeline. The posture below is prospective for everything except
the code that can perform it — which is precisely why ratifying it now,
before #2230 lands a table of user journal text on its authority, is
worth doing rather than skipping as a formality.

## Decision 1 — Adepthood may run the ontologization pipeline server-side over OPEN and PERSONAL content

**(a) The permission.** Adepthood classifies OPEN and PERSONAL
fragments into the APTITUDE frequency ontology on operator-run
infrastructure, using adepthood's own provider layer, with no per-user
VM, no enclave, and no per-user GPU cost. This is the floor every user
gets on Day 1; a user who has configured their own Creek Vault keeps
using it (#2228, "A user with a configured vault keeps using it; the
operator-side path is the floor, not a replacement").

**(b) What "operator-readable" means, in plain words.** The fragments
live as rows in the operator's Postgres, and the operator can read
them. Per-`user_id` scoping is **isolation, not operator-blindness** —
it partitions the table between users; it says nothing about who
outside the table can read it. Encryption at rest does not change this
either: journal content is encrypted with Fernet keys the *operator*
configures via `JOURNAL_ENCRYPTION_KEYS`
(`backend/src/services/journal_encryption.py:1-16`), which defends
against a stolen disk, not against the party holding the key. Anyone
building on this posture — #2230 first — must describe the property
this way in the model's own docstring, so the two are never confused
by a later reader.

**(c) The amendment to ADR 0002 Decision 1.** That decision rejected
operator-run shared storage on the strength of one harm: the operator
can see intimate content. This ADR does not reverse that rejection —
it narrows what it reaches. A shared store holding **no INTIMATE
content** is outside the harm as ADR 0002 stated it, and is permitted
here. A shared store holding intimate content remains rejected,
exactly as ADR 0002 wrote it. ADR 0002 is deliberately not edited:
this record carries the amendment and cross-references it, following
ADR 0004's treatment of the same document ("**ADR 0002 stands
unchanged in substance**").

**Rejected — waiting for the confidential vault before any user gets
an ontologized corpus.** The vault's provisioning layer does not
exist upstream, so this is not a delay of weeks against a known date;
it is deferring the product's central promise (NORTH-STAR §2, a corpus
that "speaks back, calibrated to where you are right now") for an
unbounded period, for every user at launch. Reopen when per-user vault
provisioning ships and the per-user cost is known.

**Rejected — semantic retrieval alone, with no ontology.** Embeddings
return topically-near text; "calibrated to where you are right now" is
a frequency claim, not a similarity claim (#2228). Retrieval without
the ontology would let the Higher Self speak in generic-LLM shape
about approximately the right subject, which is the failure the
ontology exists to prevent.

**Rejected — running the pipeline client-side on the user's device.**
This is ADR 0002's option 2/3 (on-device model, local heuristic), and
those options were weighed and not chosen there; nothing in this
epic's scope revisits that analysis. Reopen it on ADR 0002's terms,
not here.

## Decision 2 — INTIMATE never enters the operator-side corpus and never reaches a cloud LLM

The exclusion is structural, not advisory, and there are two shipped
models of the shape it must take.

- `backend/src/services/creek_vault_write.py:274-278` short-circuits
  an intimate entry to `_SKIPPED_INTIMATE_OUTCOME` before any vault
  call — not before the request is sent, before the client is touched
  at all — and it does so twice over: once on the journal
  classification and once on the resolved `VaultTierCeiling`.
- `backend/src/services/frequency_classification.py:204-205` raises
  `IntimateContentRefusedError` before `generate_response` is called
  at `:207-212`. Its module docstring states the reason for the
  ordering: "A guard placed after a request was built would be correct
  today and one refactor away from leaking."

Today's behavior for intimate journal entries is unchanged and remains
#895's skip-only mode, as ADR 0002's Consequences already record.
Every surface #2230 and #2231 add must exclude INTIMATE the same way,
with a test that fails if a call is *attempted* rather than one that
merely checks a return value — the test PR #2245 already wrote for the
classifier is the pattern.

**Rejected — admitting INTIMATE under redaction, summarization, or a
local pre-pass.** Any of these produces a derived artifact of intimate
writing in an operator-readable store, which is the harm ADR 0002
Decision 1 names, reached one step later. The vault upgrade in
Decision 4 is the sanctioned route to ontologized intimate content;
there is no partial one.

**Rejected — enforcing the exclusion by convention at each call
site.** A rule that lives in reviewers' heads is not a rule the next
caller inherits. The refusal belongs where the content enters the
pipeline, raising rather than logging, which is what
`IntimateContentRefusedError` already is: "a defect at the call site
rather than a runtime condition."

## Decision 3 — User-facing privacy copy is reviewed as part of this epic, not after it

#2228 lists this as a constraint and attributes it to this ADR, so it
is written down here as a decision with the specific strings named,
rather than as an aspiration.

The promise ADR 0002 converged on is one sentence
(`0002-intimate-content-local-routing.md:27-30`): "your writing lives
in your own private space that only you can open, and your intimate
writing is never handed to an outside AI." The second clause stays
exactly true under this ADR — Decision 2 is what keeps it true. The
first clause is the one under pressure, and the shipped copy that
carries it is:

- `frontend/src/features/Journal/PrivacyTierControl.tsx:40` —
  Personal: "Private to you; resonance may read it."
- `frontend/src/features/Journal/PrivacyTierControl.tsx:41` and `:28`
  — Intimate: "Never sent to AI; resonance is paused." /
  "Intimate entries are never sent to AI."
- `frontend/src/features/Journal/CaptureClassificationControl.tsx:26`
  — "Intimate writing is never handed to an outside AI…"
- `NORTH-STAR.md:66` — the Privacy guardrail.

The intimate strings need no change. "Private to you" is the one a
reader could take as a claim about the operator, and it is the one the
review must settle before #2230 ships a table of that content. The
review inherits ADR 0002's own constraint on any fix: "No technical
tier names are exposed to the user; the promise is the whole surface."
So the remedy cannot be to teach the user the word `PERSONAL`.

**Rejected — shipping the pipeline and revising the copy afterwards.**
The copy is the user's only view of this decision. Shipping first
means the interval between the two is a period in which the product
says something the code has stopped making true, and there is no
version of "we'll fix the wording next sprint" that is honest about
that interval.

## Decision 4 — The confidential vault is not descoped; it becomes the upgrade

The vault remains exactly what ADR 0002 and ADR 0004 Decision 6
describe. Against this floor it buys two distinct things, and #2228
names both: it **extends ontologization to INTIMATE content**, and it
**removes operator-readability entirely**. Both are real; neither
blocks launch.

Nothing in this ADR advances, defers, or discharges any part of that
build-out. The intimate-transit sub-decisions (ADR 0004 Decision 6
(a)–(d)) remain entirely unshipped and owned by #958 and
creek-vault#757, and ADR 0004 Decision 7's single-user vault binding
(`CREEK_VAULT_OWNER_USER_ID`) is untouched — a deployment with a
configured vault still serves exactly one bound user from it.

**Rejected — reading this ADR as retiring the vault.** A reader who
takes "every user gets a corpus on Day 1" to mean the confidential
path was abandoned has misread it, in the same way ADR 0004's
2026-08-07 note warns against reading "retire the MCP transport" as
retiring MCP.

## Decision 5 — Consent for each imported source is an auditable event

#2228's constraint, verbatim: "Consent for each imported source is
logged as an auditable event." An import surface (#2232) pulls in
material a user wrote *somewhere else* — Claude, ChatGPT, Drive,
Substack, Discord, documents — and every such source is a separate act
of bringing outside writing into an operator-readable store. One
blanket agreement at signup is not a record of which source, when.

**This ADR records the requirement but not its shape.** The epic
attributes the shape to "ADR 0012", and **ADR 0012 does not exist**:
`docs/adr/` holds `0001` through `0005`, and outside issue bodies and
this document the string appears nowhere in the tree. It is named here
by number only, with no path, because there is no file to point at —
the same discipline ADR 0004 applied to its own unshipped companion
document. What the event must contain, how long it is kept,
and where it is stored are deferred to that ADR, and are listed under
Open question below until it is written. **A dangling ADR citation is
what produced this document; repeating it in this document would be
the same defect, so the pointer says plainly that the target is
unwritten.**

**AMENDED 2026-08-22:** the target is now written. The shape lives in
[ADR 0006](0006-consent-as-an-auditable-event.md), which records the
contract as it shipped rather than designing one: an append-only
`corpusconsentevent` row per decision, per source, content-free. The
paragraph above stands as written — it is the record of what was true
when this decision was made, and the missing number is the reason this
document exists at all. Two of the three questions it defers are
answered there; retention is not, and stays open below.

**Rejected — treating the tier a user picked as consent for import.**
The tier is a choice about a piece of writing the user is composing in
this app. It is not a decision about whether a body of writing that
lives elsewhere may be ingested, and one cannot be read off the other.

## Open question — what this ADR names but does not settle

Following ADR 0002's precedent for intimate transit, these are
recorded as open rather than answered, because nothing in #2228,
ADR 0002, or ADR 0004 decides them and an agent may not invent them:

- **Retention.** How long an operator-side corpus fragment is kept, and
  whether it has a lifetime independent of the journal entry it was
  derived from.
- **Deletion.** Whether deleting a journal entry deletes its derived
  fragments; and whether a user may delete the ontologized copy while
  keeping the entry — a right this posture makes meaningful and that
  no shipped surface offers.
- **Whose provider account sees the content.** ADR 0002 Decision 3
  permits BYOK for OPEN and PERSONAL, and
  `classify_frequencies` threads an `api_key` through
  (`frequency_classification.py:187-203`), so both paths are already
  permitted. Which is the *default* — the operator's key, or the
  user's — and whether the user is told which one classified their
  writing, is undecided.
- **What happens on upgrade.** When a user later configures a vault,
  does the operator-side corpus migrate, dual-home (ADR 0004 Decision
  6(d)'s answer for journal entries), or get deleted? Decision 4 says
  the vault removes operator-readability; it does not say what becomes
  of rows written before it.
- **Where the consent-event contract lives.** ADR 0012 is unwritten
  (Decision 5). Until it exists, #2232 has a requirement with no
  ratified shape. — **AMENDED 2026-08-22:** closed. It lives in
  [ADR 0006](0006-consent-as-an-auditable-event.md).
- **Whether ontologizing an entry the user wrote in this app is itself
  a consented act** needing its own record, distinct from the
  per-source consent Decision 5 requires for imports. #2230 defers
  backfill of existing entries as separate work, which is where this
  question would first bite. — Closed by ADR 0006 Decision 3: yes, and
  `journal` carries its own per-source consent like any other source.

## Consequences

- #2230 may land `CorpusFragment` on this posture, and must state
  Decision 1(b)'s property — isolation, not operator-blindness — in
  the model's own docstring, not only here.
- **Status is `Proposed`.** An agent cannot ratify a privacy posture.
  Until the repo owner flips this header to `Accepted`, every issue in
  epic #2228 that cites this ADR is building on an unratified record —
  which is a smaller problem than building on an absent one, and a
  real one to close before #2230 merges.
- The classifier shipped by PR #2245 remains unwired (Context). This
  ADR authorizes wiring it; it does not itself wire anything, and no
  user content changes hands as a result of this commit.
- ADR 0002 is not edited. Its Decision 1 harm analysis is amended by
  Decision 1(c) of this document and nowhere else.
- A drift guard lands with this ADR
  (`backend/tests/test_adr_references.py`): every `docs/adr/NNNN-….md`
  path written anywhere in the tree must resolve to a shipped file.
  Prose that names an unwritten ADR by number — as Decision 5 does for
  0012 — is deliberately still allowed, since naming a dependency is
  not the same as claiming a file exists.
- No new transport, protocol, or external seam is introduced. The
  pipeline is adepthood's own in-process code calling adepthood's own
  provider layer.

## What this ADR does not claim

- **No confidential-compute guarantee of any kind.** Not end-to-end
  encryption, not TEE trust, not key custody, not attestation. The
  same discipline ADR 0004 Decision 6 states for the transport
  decision applies here with equal force: a posture that permits
  server-side classification says nothing about protecting the
  material from the operator, and Decision 1(b) says the opposite
  outright.
- **Nothing about MCP.** HTTP/JSON `/v1` is and remains the sole
  adepthood↔Creek application seam (ADR 0004 Decision 1, and its
  2026-08-07 note retiring adepthood's MCP client). MCP stays Creek's
  adapter for genuine agents. Ontologization is in-process adepthood
  code; it neither needs nor reaches a transport, and nothing in this
  ADR should be read as reopening that boundary.
- **Nothing about the shape of the ontology.** The ten frequencies are
  fixed and cannot grow without a contract version bump
  (`backend/src/domain/frequencies.py:44-51`), and F1..F10, the
  APTITUDE Stages, the Adepthood Aspects of Wholeness and the
  Wavelength Modes are **one set of ten developmental positions under
  four names, joined on colour** — not four vocabularies of coincident
  size (`backend/src/domain/frequencies.py:1-57`;
  `graph/ontology-spine.md:46` writes the row as
  `Beige = Stage 1 = F1 = BEIGE = 01-beige = Survival`). The join is
  on colour rather than name because the labelings diverge at F5–F8.
  ADR 0004's divergence table still carries the superseded reading of
  this; correcting it is tracked separately as #2284 and is not
  bundled here. This ADR consumes that ontology and does not redefine
  it, and it makes no change to `WheelBalanceResponse` or the
  F1..F10 → stage projection (#2228's constraint).

## Note, 2026-08-21 — Decision 4's statement about the vault binding has been overtaken

Issue #2233. Decision 4 above says ADR 0004 Decision 7's single-user
vault binding "is untouched — a deployment with a configured vault
still serves exactly one bound user from it." That was true of *this*
ADR, which changed nothing about it, and it is no longer true of the
codebase: vault configuration has moved to the account. Each user
connects a vault of their own, with their own URL and their own
encrypted credential, and `CREEK_VAULT_OWNER_USER_ID` survives one
release only as a deployment-wide default for accounts that have
connected nothing. See ADR 0004's note of 2026-08-21 for the full
reasoning, including why per-user vault *instances* never needed the
creek-side contract change that partitioning one shared vault still
does.

Nothing else in Decision 4 changes. The confidential vault is still
the upgrade rather than the floor, INTIMATE still never enters the
operator-side corpus, and the operator-readability of that corpus is
unaffected by whose vault sits behind it.
