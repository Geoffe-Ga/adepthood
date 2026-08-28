# ADR 0006: Consent as an auditable event — the shape of the record

- **Status:** Proposed
- **Date:** 2026-08-22
- **Issue:** [#2342](https://github.com/Geoffe-Ga/adepthood/issues/2342)
  (written under it; the contract it records shipped under
  [#2332](https://github.com/Geoffe-Ga/adepthood/issues/2332))
- **Supersedes:** nothing. **Amends:**
  [ADR 0005](0005-operator-side-ontologization.md) Decision 5, which
  states the requirement and defers its shape — see *What this
  settles* below. ADR 0005's history is not edited; two dated notes
  point forward to this document.

## Context

This record is unusual in one respect and ordinary in the other:
every decision below is already in the code, under test, on `main`.
Nothing here is designed. That is deliberate, and it is the correction
this document exists to make.

**The number that was never written.** ADR 0005 Decision 5 ratifies
the requirement — "consent for each imported source is logged as an
auditable event" — and explicitly declines to fix its shape, deferring
that to a companion record. Five open issues cite that companion as
"ADR 0012", a number that has never existed: `docs/adr/` ran `0001`
through `0005` until this commit, and ADR 0005 says as much at its own
Decision 5. A number with no document behind it
still reads, to everyone downstream, like ratified authority. It cost
two agents an afternoon each on 2026-08-21, working independently,
and — the part that matters — they arrived at two different answers:

- One needed the consent contract in order to build the corpus writer
  at all. It settled the blocking question in the only direction an
  unratified question may be settled in, conservatively: nothing is
  ontologized until somebody says so, per source, and the record of
  saying so is an append-only event log.
- The other needed only to note that an export had happened. It judged
  an audit *table* out of scope for a read path that adds no
  migration, and followed the shipped `account_deleted` precedent — a
  structured log line carrying counts and an account id, never
  content.

Both are right. They are not the same contract, and until this
document nothing said which one a third feature should copy. That
question — not the two answers, which are already shipped and already
tested — is what is settled here.

**What is on disk.** `models/corpus_consent.py` holds the
`corpusconsentevent` table and the `ConsentDecision` vocabulary;
`services/corpus_consent.py` holds the read, the write, and
`CONSENT_GRANTED_BY_DEFAULT`; `migrations/versions/b5f1a2c3d4e6_corpus_provenance_and_consent.py`
creates the table. `services/account_deletion.py` holds the
`account_deleted` log line and the `accountdeletionaudit` receipt row
that predates all of it.

## Decision 1 — A consent decision is an append-only row, never a flag

A durable decision an account makes about what may be ingested is
recorded as one row appended to `corpusconsentevent`: account, source,
decision, instant, and — on a revocation — how many fragments the
purge removed. Rows are never updated in place. Current consent is the
newest row for a `(user_id, source)` pair, ordered by `id` rather than
by timestamp so that two decisions inside one clock tick still resolve
deterministically.

**Why the log rather than a boolean.** A boolean answers "may we?" and
destroys every other question an audit record exists for. "When did
they agree?" and "did they ever?" are both erased by the update that
revokes — which is precisely the moment somebody wants the earlier
answer. `accountdeletionaudit` already keeps its receipt on that
reasoning: evidence that a decision happened has to outlive the state
the decision produced.

**The row is content-free**, and this is a constraint on the shape,
not an incidental property of the current columns. Account, source,
decision, instant, count. Nothing from a fragment, and nothing that
would let a reader reconstruct one.

**Consent is per source**, in the `CorpusSource` vocabulary, and the
persisted set is CHECK-constrained from that enum so a permission for
a value no fragment could ever carry cannot be stored. ADR 0005
Decision 5 rejects reading consent off the privacy tier a user picked
for a piece of writing, and nothing here reopens that.

**Repeating an answer is not a decision.** A client that re-sends the
state already recorded appends nothing. The log holds decisions, not
requests, and a retry storm must not be able to make an account look
as though it agreed forty times.

*Pinned by* `backend/tests/services/test_corpus_consent.py::test_changing_your_mind_appends_rather_than_overwrites`
— both decisions survive, in the order they were made — and
`::test_repeating_a_decision_does_not_repeat_the_event`.

## Decision 2 — An action taken under an existing consent is a log line, not a row

Reading, exporting, or otherwise acting on material an account has
*already* consented to is recorded as a content-free structured log
line: the event name, the account's surrogate id, and counts. It does
not append a consent row, and it does not earn a table of its own.

**Why the two shapes differ.** A consent row answers "what is this
account's standing permission, and when did it change?" An action
under that permission changes no permission; a row per action would
dilute the log whose only read is *its newest entry per source*, and
would put a durable database write on a read path — for #2238's case,
one that deliberately ships no migration. The log line answers the
question actions actually raise, which is operational: did this
happen, to whose account, how much of it.

**The line has to be safe to ship to an aggregator** that the material
itself deliberately never reaches. Counts and the surrogate id only.
`account_deleted` is the shipped precedent and the one to copy.

**Where the boundary falls.** If the user's answer to a question
changes what the system may do from now on, it is Decision 1. If the
system does something it was already permitted to do, it is Decision
2. Granting or withdrawing permission to ontologize a source is the
first. Exporting an account's own data, or erasing it on request, is
the second — the erasure additionally leaves a durable receipt row
because the account it belonged to will not be there to ask.

*Pinned by*
`backend/tests/test_account_deletion_api.py::test_deletion_logs_counts_and_never_content`.

**AMENDED 2026-08-28:** "it does not earn a table of its own" does not
reach an action that *writes* corpus material and can be resumed.
`services.corpus_backfill` sweeps the writing an account already had
under a grant it already gave; it is bounded by a ceiling and two
clocks, so it leaves a remainder that a later request under that same
grant continues. Three things separate it from the reads and exports
this decision was written about. It changes durable state rather than
observing it. It is *incomplete*, so what one decision eventually
reached is a running total across several sweeps rather than a fact
about any one of them. And it already sits on a write path, so the
objection about putting a database write on a read path does not
apply. A log line cannot carry a running total: recovering one means
re-reading an aggregator, which is exactly the reconstruction
Decision 1 exists to make unnecessary. So a resumable sweep appends a
row to an append-only log of its own, `corpussweep`, naming the
`corpusconsentevent` row that authorised it.

The consent log is untouched by this. It is still one row per
decision, its only read is still its newest row per source, and a
repeated answer still appends nothing to it — which is the whole
reason the sweeps that do most of the reaching for a long journal had
nowhere to be recorded. The sweep log takes Decision 1's rule with it
rather than leaving it behind: a sweep appends a row when some number
moved, so one that offered nothing, or that reports exactly what the
last sweep under the same decision reported, appends nothing. A table
that mostly recorded that nothing happened would be the request log
Decision 1 refuses, one table over.

This amendment also brings `corpusconsentevent` into line with the
enumeration in Decision 1, which never listed a grant's added-count.
`fragments_added` is retired from that row. What a grant reached now
lives only in the sweep log, where the sweeps it authorised after the
first one can be recorded beside it — a count on the decision row
could only ever have described the first of them, and a first-of-many
sitting beside the log of all of them is the second source of truth
this record is written to avoid.

Reading and exporting stay exactly as this decision leaves them: a
content-free log line, no consent row, no table. Erasure was always
the other way round, and this record already said so — it "leaves a
durable receipt row because the account it belonged to will not be
there to ask", and that receipt is `accountdeletionaudit`, a table of
its own. So "it does not earn a table" was never the flat rule the
sentence made it sound; two exceptions with one shape are a pattern.
An action under a standing consent earns a table when what it did
outlives the request that did it — because the account will not be
there to ask, or because the work is not finished and the next request
continues it. Reads and exports are neither.

*Pinned by*
`backend/tests/services/test_corpus_backfill.py::test_a_resumed_sweep_is_logged_under_the_yes_that_was_already_standing`
— three sweeps under one standing decision leave three rows and still
only one consent row — and
`::test_a_sweep_that_found_nothing_pending_logs_nothing`.

## Decision 3 — Nothing is consented by default, and withdrawal takes the writing with it

`CONSENT_GRANTED_BY_DEFAULT` is `False`. An account with no row for a
source has agreed to nothing for it, and no fragment is written on its
behalf. The absence of a row is a question not yet asked, which is a
different state from a refusal on the record, and `ConsentState`
distinguishes them by carrying `decided_at = None` for the former.

The alternative — reading silence as agreement — would move every
journal entry every existing account has ever written into an
operator-readable store on the strength of a deploy. No part of the
ratified record authorises that, and the published privacy policy says
the opposite; `backend/tests/test_legal_documents.py` holds that
sentence against this constant, so flipping it fails there rather than
in review.

Revoking deletes that source's fragments in the same transaction that
appends the receipt, and the receipt records how many went. A
permission that can be withdrawn while the material stays is a
preference, not a permission — and a count written by the purge is
evidence the sweep ran, where a bare `revoked` row is only a claim
that it did.

## What this settles in ADR 0005, and what it leaves open

**Settled.** ADR 0005's open question "**Where the consent-event
contract lives**" is answered: here. Decision 1 fixes what the event
contains and where it is stored. ADR 0005's question "**Whether
ontologizing an entry the user wrote in this app is itself a consented
act**" needing its own record is answered *yes* — `journal` is a
member of `CorpusSource` and carries its own consent like any other
source.

**Still open, and not touched by this document.** ADR 0005 forbids an
agent settling its open questions unilaterally, and these are recorded
as open for the same reason they were there:

- **Retention.** How long a fragment kept under a *live* consent may
  live, and whether it has a lifetime independent of the entry it came
  from. Decision 3 is narrower than this and does not answer it:
  purge-on-revocation is what happens when consent ends, not a
  lifetime for consent that continues.
- **Whose provider account sees the content.** Operator key or user
  key as the default, and whether the user is told which one
  classified their writing.
- **Deletion**, **what happens on upgrade**, and the rest of ADR
  0005's list are likewise untouched.

Nothing in this document should be read as narrowing those. Where a
future decision on retention conflicts with anything above, the
retention decision wins and this record is amended by dated note.

## Consequences

- A third feature needing to record something about consent has a rule
  to apply rather than two precedents to choose between: durable
  decision → append a row; action under an existing decision → log a
  content-free line.
- The five issues that cited an unwritten number can cite a document.
  The citation itself is now guarded: `backend/tests/test_adr_references.py`
  fails on any tracked markdown or source file that names a record
  number with no file behind it, unless the citation is explicitly
  marked as unwritten. Naming an unwritten record *as* unwritten stays
  legitimate — that is how ADR 0005 handled this one — but borrowing
  its authority silently no longer does.
- The two shapes stay honest because the tests naming them are
  asserted to exist from this record's side as well.
- This record is Proposed, not Accepted. It describes shipped code, so
  its accuracy is checkable today; its ratification is a human's.
