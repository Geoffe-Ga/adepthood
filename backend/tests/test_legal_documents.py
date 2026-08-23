"""The published legal documents may say only what the code actually does.

A privacy policy is the one document in this repository that is *worse* than
absent when it is wrong: an absent policy blocks a store submission, an
overstated one is a false promise made to every person who writes something
private here. So the guarantees the policy makes are pinned from the code side,
the way ``test_account_deletion_policy`` pins ``docs/your-data.md``.

Five failure modes are guarded.

*A promise the code stops keeping.* The policy says production refuses to boot
without a journal-encryption key, that no journal body reaches the error
monitor, and that an entry marked Intimate never leaves for a vault. Each is
re-derived here by running the code, not by reading a comment about it.

*A promise whose breadth is only as true as the column set.* Thirteen columns
carry ciphertext today, and the policy now makes the broad claim -- what you
write is encrypted -- rather than the narrow one it shipped with. Dropping a
column quietly shrinks a published guarantee; adding one without widening the
policy leaves a reader believing they have less than they do. The set is pinned
and either direction fails here first.

That is not hypothetical, three times over. This guard was written naming two
columns; the ontologized corpus store landed ``corpusfragment.content`` as a
third while the policy was still in review, and the encryption sweep then took
it to eleven. The sweep looked for *copies* of journal text, which is why it
walked past the reflection and the insight a person writes after a practice --
original prose rather than a copy of anything -- and why those two arrived
separately, with the policy's plaintext carve-out narrowing as they did. Each
time the build caught the stale sentence rather than a reader.

*A promise that is only true because of a default.* The corpus is filled from
what somebody writes only if they turn it on, and the classification that
follows costs one provider call per entry. Both sentences are pinned to the
constants that make them true, so widening either is a rewrite of the document
before it is a change to the code.

*A promise that stopped covering what the app does.* The document is only
worth its banner while it is at least as wide as the code. Two claims narrowed
under it on one day: a person gained a Delete on a single page while the policy
still described account erasure as the only remedy, and ``POST /corpus/import``
gave the ``upload`` consent a writer while the corpus section still said the
only kind of material was writing composed here. Both are pinned from the code
side -- the delete by running it, the second kind of material by reading the
writers' own source constants -- so the policy narrows into a red build rather
than into a reader's wrong belief.

*A link that rots.* The in-app rows point at the documents by repository path.
A rename that leaves the rows behind gives a store reviewer, and a user, a 404
where a privacy policy should be.

Nothing here asserts prose quality; the claims, not the wording, are the
contract.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator, Mapping
from datetime import UTC, datetime
from pathlib import Path
from types import MappingProxyType, SimpleNamespace
from typing import Final

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from domain.account_deletion import POLICY, Disposition
from domain.frequencies import Frequency
from main import validate_journal_encryption_config
from models.corpus_fragment import CorpusSource
from models.journal_entry import JournalClassification, JournalEntry
from routers.journal import delete_journal_entry
from sentry import scrub_event
from services import frequency_classification, journal_encryption
from services.corpus_consent import CONSENT_GRANTED_BY_DEFAULT, set_consent
from services.corpus_import import IMPORT_SOURCE, reaches_a_vault
from services.corpus_ingest import (
    CLASSIFICATION_CALLS_PER_INGEST,
    INGEST_SOURCE,
    ingest_journal_entry,
)
from services.corpus_store import retrieve_fragments
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_write import VaultWriteStatus, store_and_classify
from services.higher_self_grounding import GROUNDING_LIMIT, GroundingSource
from services.journal_encryption import EncryptedString

_REPO_ROOT = Path(__file__).resolve().parents[2]
_LEGAL_DIR = _REPO_ROOT / "docs" / "legal"
_PRIVACY_POLICY = _LEGAL_DIR / "privacy-policy.md"
_TERMS_OF_SERVICE = _LEGAL_DIR / "terms-of-service.md"
_YOUR_DATA = _REPO_ROOT / "docs" / "your-data.md"
_LEGAL_LINKS = _REPO_ROOT / "frontend" / "src" / "features" / "Settings" / "legalLinks.ts"

# The in-app rows address the documents through the repository's public web
# view, which is reachable with the application backend down -- the hosting
# constraint the issue sets. The path half is what this module resolves.
_REPO_URL_PATH = re.compile(r"https://github\.com/Geoffe-Ga/adepthood/blob/main/([\w./-]+)")

# Every column in the live schema that stores ciphertext, as ``table.column``.
# The policy's sentence about what is encrypted was written against exactly
# this set; see :func:`test_exactly_the_pinned_columns_are_encrypted`.
#
# All but the last hold the account's own writing, or something derived from
# it. ``uservaultconfig.api_key`` is different in kind and the policy says so:
# it is a credential the account supplied for a service of its own, encrypted
# for the same reason but not a thing they wrote.
_ENCRYPTED_COLUMNS = frozenset(
    {
        "completionsuggestion.anchor_text",
        "completionsuggestion.label",
        "corpusfragment.content",
        "journalentry.message",
        "journalentry.title",
        "marginalia.anchor_text",
        "marginalia.essay",
        "marginalia.note",
        "practicesession.insight",
        "practicesession.reflection",
        "promotedquote.anchor_text",
        "promptresponse.response",
        "uservaultconfig.api_key",
    }
)

# Claims a reader would take as a confidentiality guarantee against the
# operator. None of them is true of this deployment: the journal keys are the
# operator's own, so the encryption defends a stolen disk and not the party
# holding the key (ADR 0005 Decision 1(b)).
_FORBIDDEN_CLAIMS = (
    "end-to-end",
    "end to end",
    "zero-knowledge",
    "zero knowledge",
    "we cannot read",
    "we can never read",
    "only you can read",
    "nobody else can read",
)

# A body that could only have come from a user's journal.
_SENTINEL_BODY = "the thing I have never told anyone"


@pytest.fixture
def _restored_encryption_cache() -> Iterator[None]:
    """Drop the cached key registry before and after a test that changes the env.

    The registry is process-cached on purpose (rotation is a deploy-time
    operation), so a test that sets or clears ``JOURNAL_ENCRYPTION_KEYS``
    without this leaves every later test reading the wrong answer.
    """
    journal_encryption.reset_cache()
    yield
    journal_encryption.reset_cache()


def _read(document: Path) -> str:
    """Return one document's text, lowercased for claim matching."""
    return document.read_text(encoding="utf-8").lower()


def _prose(document: Path) -> str:
    """Return one document's text as unwrapped prose, for phrase matching.

    These documents are hard-wrapped, so a sentence a reader sees as one line
    is several in the file and a phrase can straddle two of them. Collapsing
    whitespace is what keeps a guard about *what the policy says* from turning
    into a guard about where an editor happened to break a line.
    """
    return " ".join(_read(document).split())


def _encrypted_columns() -> frozenset[str]:
    """Return every ``table.column`` in the live schema that stores ciphertext."""
    return frozenset(
        f"{table.name}.{column.name}"
        for table in SQLModel.metadata.tables.values()
        for column in table.columns
        if isinstance(column.type, EncryptedString)
    )


def test_both_documents_exist() -> None:
    """The two documents the store submission needs are on disk."""
    assert _PRIVACY_POLICY.is_file(), f"missing {_PRIVACY_POLICY}"
    assert _TERMS_OF_SERVICE.is_file(), f"missing {_TERMS_OF_SERVICE}"


def test_the_app_links_to_both_documents() -> None:
    """The in-app rows address both documents, not just the privacy policy.

    App Store Review 5.1.1 asks for a reachable privacy policy; the terms are
    what the purchase and account language in the app rests on. Shipping one
    row and not the other is the failure this catches.
    """
    linked = set(_REPO_URL_PATH.findall(_LEGAL_LINKS.read_text(encoding="utf-8")))

    assert "docs/legal/privacy-policy.md" in linked
    assert "docs/legal/terms-of-service.md" in linked


def test_every_in_app_legal_url_resolves_to_a_file() -> None:
    """Each linked path names a file that exists, so no row opens a 404."""
    paths = _REPO_URL_PATH.findall(_LEGAL_LINKS.read_text(encoding="utf-8"))

    assert paths, "no repository-hosted legal URL found; the scan matched nothing"
    for path in paths:
        assert (_REPO_ROOT / path).is_file(), f"in-app legal link points at missing {path}"


@pytest.mark.usefixtures("_restored_encryption_cache")
def test_production_refuses_to_boot_unencrypted(monkeypatch: pytest.MonkeyPatch) -> None:
    """A production boot without a key raises, which is what the policy promises.

    The policy tells a reader that entries are encrypted in the database. That
    sentence is only true because an unkeyed production deployment cannot start;
    without this the same code would run happily and store plaintext.
    """
    monkeypatch.setenv("ENV", "production")
    monkeypatch.delenv(journal_encryption.KEYS_ENV_VAR, raising=False)
    journal_encryption.reset_cache()

    with pytest.raises(RuntimeError, match=journal_encryption.KEYS_ENV_VAR):
        validate_journal_encryption_config()


def test_exactly_the_pinned_columns_are_encrypted() -> None:
    """Ciphertext covers the journal, everything derived from it, and no more.

    The policy's promise is now the broad one -- what you write is encrypted --
    so this set is what makes that sentence true rather than aspirational.
    Dropping a column silently narrows a published guarantee, and adding one
    without widening the policy leaves a reader believing less protection than
    they have. Either direction is a rewrite before the schema change ships.
    """
    assert _encrypted_columns() == _ENCRYPTED_COLUMNS


# The one sentence in the policy that lists what is *not* encrypted, identified
# by the phrase it ends on. Everything it names must genuinely be plaintext, and
# nothing it names may be a column the schema encrypts -- the two halves of
# :func:`test_the_policy_names_the_prose_that_is_still_plaintext`.
_CARVE_OUT_TAIL = "stored as written"

# What the carve-out sentence has to keep naming: the user-authored strings the
# schema still holds in the clear. Each is a label or a target rather than
# composed prose, except a goal description, which can run long enough to be
# writing -- which is exactly why the policy has to name it rather than let the
# broad claim be read as covering it.
_PLAINTEXT_STRINGS_THE_POLICY_MUST_NAME = (
    "habit names",
    "goal titles and descriptions",
    "goal groups and practices",
)

# The table whose prose the carve-out used to confess. The negative half of the
# guard is scoped to it rather than to the whole encrypted set because the words
# for the rest -- "title", "note", "label" -- are ordinary English the sentence
# legitimately needs for the goal titles and habit labels it *does* name.
_SESSION_PROSE_PREFIX = "practicesession."


def _carve_out_sentence(prose: str) -> str:
    """Return the policy sentence that ends on :data:`_CARVE_OUT_TAIL`."""
    tail_at = prose.index(_CARVE_OUT_TAIL)
    end = tail_at + len(_CARVE_OUT_TAIL)
    start = prose.rfind(". ", 0, tail_at)
    return prose[start + 2 : end] if start != -1 else prose[:end]


def test_the_policy_names_the_prose_that_is_still_plaintext() -> None:
    """The carve-out names everything in the clear, and nothing that is not.

    This assertion is deliberately pointed at the *weakest* claim in the
    document. Two ancestors of it have already gone stale in the direction a
    phrase match cannot see. The first asserted the policy said margin notes
    were stored as written -- true when written, false the moment margin notes
    were encrypted, and it would have kept passing on the phrase alone while
    guarding the opposite of the truth. The second named practice-session prose
    as plaintext, which was honest until the columns became ciphertext and then
    understated the protection by two columns.

    So the sentence is checked from both sides. Every string it names has to
    still be plaintext, and no column the schema encrypts may be named in it --
    the second half read out of ``_ENCRYPTED_COLUMNS``, which
    :func:`test_exactly_the_pinned_columns_are_encrypted` holds against the live
    schema, so an encryption that lands without narrowing the sentence fails
    here rather than shipping an out-of-date confession.
    """
    carve_out = _carve_out_sentence(_prose(_PRIVACY_POLICY))

    for named in _PLAINTEXT_STRINGS_THE_POLICY_MUST_NAME:
        assert named in carve_out, f"the carve-out stopped naming {named}: {carve_out!r}"

    still_confessed = sorted(
        column
        for column in _ENCRYPTED_COLUMNS
        if column.startswith(_SESSION_PROSE_PREFIX) and column.split(".")[-1] in carve_out
    )
    assert not still_confessed, (
        f"the carve-out calls {still_confessed} plaintext; the schema encrypts them: {carve_out!r}"
    )


# Spelled-out numbers, because the policy is written for a reader rather than a
# machine and says "up to three", never "up to 3".
_NUMBER_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}


def test_the_policy_states_the_context_window_the_code_actually_sends() -> None:
    """The count of writing sent to the LLM provider as context is the code's own.

    This is the one number in the document describing what leaves the deployment
    for a third party, so a reader deciding whether to write something down is
    deciding on it. It shipped as "five" against a limit that has been three
    since the constant was introduced -- overstating rather than understating,
    which is the harmless direction, and still wrong in a document whose whole
    value is that a reader who believes it is not misled.

    Pinned to ``GROUNDING_LIMIT`` rather than to the literal ``three`` so that
    raising the limit fails here, where the policy is, instead of quietly
    widening what is shared. That constant moved out of the journal router when
    grounding gained a second source; it is still the single bound, and
    ``tests/services/test_higher_self_grounding.py`` is where both sources are
    held to it.
    """
    policy = _prose(_PRIVACY_POLICY)
    expected = _NUMBER_WORDS[GROUNDING_LIMIT]

    assert f"up to {expected}" in policy, (
        f"the policy must say 'up to {expected}' to match GROUNDING_LIMIT = {GROUNDING_LIMIT}"
    )
    wrong = {word for count, word in _NUMBER_WORDS.items() if count != GROUNDING_LIMIT}
    stale = sorted(word for word in wrong if f"up to {word}" in policy)
    assert not stale, f"the policy also claims 'up to {stale}', contradicting itself"


def test_the_policy_says_the_corpus_is_off_until_the_reader_turns_it_on() -> None:
    """The corpus is opt-in in the document because it is opt-in in the code.

    ADR 0005 leaves open whether ontologizing an entry written in this app is
    itself a consented act. It is answered conservatively — the corpus stays
    empty until somebody says otherwise — and this is where that answer is
    published. Flipping ``CONSENT_GRANTED_BY_DEFAULT`` would put every entry
    every existing account has written into an operator-readable store on the
    strength of a deploy, while the sentence below went on telling readers it
    had not, so the constant is asserted here rather than in a service test.
    """
    policy = _prose(_PRIVACY_POLICY)

    assert CONSENT_GRANTED_BY_DEFAULT is False, (
        "the policy promises the corpus is off until the reader turns it on; "
        "rewrite that promise before changing the default"
    )
    assert "unless you turn it on" in policy
    assert "off for every account until you say otherwise" in policy


def test_the_policy_states_the_classification_calls_a_save_costs() -> None:
    """A reader is told that saving an entry can itself reach the provider.

    This is the one thing the corpus writer changed about what leaves the
    deployment, and it is easy to miss: everything else the provider receives
    is something the reader asked for. Classification happens on the save, so
    the count is pinned to the code's own ceiling — raising it widens what is
    sent, and fails here, in the file where the promise is written.
    """
    policy = _prose(_PRIVACY_POLICY)
    expected = _NUMBER_WORDS[CLASSIFICATION_CALLS_PER_INGEST]

    assert f"{expected} call per entry" in policy, (
        f"the policy must state '{expected} call per entry' to match "
        f"CLASSIFICATION_CALLS_PER_INGEST = {CLASSIFICATION_CALLS_PER_INGEST}"
    )


# The sentence in the policy that discloses each source the grounding can draw
# from. Keyed by the enum rather than listed loose, so a third source added to
# the code raises a KeyError here until somebody writes down what it exposes.
_GROUNDING_DISCLOSURES = {
    GroundingSource.RECENT_ENTRIES: "your recent entries",
    GroundingSource.CORPUS: "passages chosen out of the corpus of your own writing",
}


def test_the_policy_describes_every_source_the_context_can_come_from() -> None:
    """A reader is told what the context is, not only how much of it there is.

    The count did not change when grounding gained its second source, but what
    the count counts did: a passage the retrieval chose out of the account's
    ontologized corpus is not "one of your recent entries". A policy describing
    only the window would keep a true number over a false description, which is
    the direction that misleads -- the reader would picture something narrower
    than what is actually sent.
    """
    policy = _prose(_PRIVACY_POLICY)

    missing = sorted(
        source.value for source in GroundingSource if _GROUNDING_DISCLOSURES[source] not in policy
    )

    assert not missing, f"the policy does not disclose these grounding sources: {missing}"


def test_the_error_monitor_never_receives_a_journal_body() -> None:
    """Scrubbing removes the channels a journal body could ride out on.

    Driven through the real ``before_send`` hook with a body planted in all four
    of them, so a channel that stopped being scrubbed fails here rather than in
    a vendor's dashboard.
    """
    event: dict[str, object] = {
        "request": {"data": {"message": _SENTINEL_BODY}},
        "extra": {"body": _SENTINEL_BODY},
        "breadcrumbs": [{"message": _SENTINEL_BODY}],
        "exception": {"values": [{"stacktrace": {"frames": [{"vars": {"body": _SENTINEL_BODY}}]}}]},
    }

    scrubbed = json.dumps(scrub_event(event, {}))

    assert _SENTINEL_BODY not in scrubbed


def test_the_policy_says_monitoring_is_deployment_configured() -> None:
    """The policy names monitoring as optional, which the DSN gate makes true."""
    assert "sentry" in _read(_PRIVACY_POLICY)


@pytest.mark.asyncio
async def test_an_intimate_entry_never_reaches_a_vault() -> None:
    """An intimate entry short-circuits before any vault call is made.

    The policy states this without qualification, so it is re-derived here
    rather than inherited from the write path's own suite.
    """
    outcome = await store_and_classify(
        LocalFallbackCreekVaultClient(),
        entry_id=1,
        body=_SENTINEL_BODY,
        classification="intimate",
        created_at=datetime(2026, 8, 21, tzinfo=UTC),
    )

    assert outcome.status is VaultWriteStatus.SKIPPED_INTIMATE
    assert outcome.vault_ref is None


def test_the_purchase_receipt_outlives_deletion_in_both_documents() -> None:
    """The policy and ``your-data.md`` agree with the code on what survives.

    ``gumroadsale`` is the one table whose rows keep an email address after an
    account is erased. Two user-facing documents now describe that, and the
    disposition in the code is what makes both of them true.
    """
    assert POLICY["gumroadsale"].disposition is Disposition.ANONYMISE
    assert "receipt" in _read(_PRIVACY_POLICY)
    assert "receipt" in _read(_YOUR_DATA)


def test_the_policy_claims_no_confidentiality_the_code_lacks() -> None:
    """No phrase in the policy reads as a guarantee against the operator.

    ADR 0005 Decision 1(b) is explicit that per-user scoping is isolation and
    that operator-held keys defend a stolen disk, not the key holder. Any of
    these phrases would tell a reader otherwise.
    """
    text = _read(_PRIVACY_POLICY)

    for claim in _FORBIDDEN_CLAIMS:
        assert claim not in text, f"privacy policy overclaims: {claim!r}"


def test_the_terms_do_not_promise_a_service_level() -> None:
    """The terms disclaim availability rather than committing to a number.

    Nothing in this deployment measures or defends an availability target, so
    a percentage or an agreement named here would be a commitment with no
    mechanism behind it. Saying "as is" is the claim the code can carry.
    """
    text = _read(_TERMS_OF_SERVICE)

    assert '"as is"' in text
    assert "service level agreement" not in text
    assert "99." not in text


# Every consent source something in this backend actually writes a fragment
# under, read off the writers' own constants rather than off the enum. A member
# nothing collects under is a name, not a kind of material somebody is being
# asked about -- and the policy owes a reader a description of each kind that
# can hold their writing, not of each token the schema can store.
_SOURCES_WITH_A_WRITER: Final[frozenset[CorpusSource]] = frozenset({INGEST_SOURCE, IMPORT_SOURCE})

# What the policy must call each of those kinds, in the words the consent
# screen offers the switch under. Keyed by the enum member, so a writer that
# moves to a source nobody has written down (``POST /corpus/import`` deciding
# to collect under ``import`` rather than ``upload``, say) leaves a switch the
# policy does not explain and fails here.
_CORPUS_SOURCE_DISCLOSURES: Final[Mapping[CorpusSource, str]] = MappingProxyType(
    {
        CorpusSource.JOURNAL: "what you write in adepthood itself",
        CorpusSource.UPLOAD: "documents you bring in",
    }
)

# Stands in for a source with no disclosure written for it. A control character
# cannot occur in the prose, so an undisclosed source is reported by name
# instead of raising a ``KeyError`` from inside a comprehension.
_NO_DISCLOSURE_WRITTEN: Final[str] = "\x00"

# The claim the corpus section shipped with, true while ``journal`` was the
# only source with a writer and false the moment a second one landed.
_SINGLE_SOURCE_CLAIM: Final[str] = "the only kind"


def test_the_policy_names_every_kind_of_material_the_corpus_can_hold() -> None:
    """Each source something writes fragments under is described, by name.

    The consent switch is per source, so a source with a writer is a permission
    a reader can be asked for -- and one the policy has to have explained
    before they are. ``POST /corpus/import`` collects under the ``upload``
    source rather than adding one of its own, which is precisely the change a
    phrase match on the corpus section would not have seen: no wording went
    stale, the meaning of an existing switch widened.

    Both halves are derived. The population is the writers' constants, so a
    third writer fails here until somebody writes down what it collects, and
    the count is what retires the "only kind" sentence rather than a reviewer
    remembering it exists.
    """
    policy = _prose(_PRIVACY_POLICY)

    undisclosed = sorted(
        source.value
        for source in _SOURCES_WITH_A_WRITER
        if _CORPUS_SOURCE_DISCLOSURES.get(source, _NO_DISCLOSURE_WRITTEN) not in policy
    )

    assert not undisclosed, (
        f"something writes corpus fragments under {undisclosed}, and the policy "
        f"describes no such kind of material"
    )
    assert len(_SOURCES_WITH_A_WRITER) == 1 or _SINGLE_SOURCE_CLAIM not in policy, (
        f"{len(_SOURCES_WITH_A_WRITER)} sources have writers; the policy still "
        f"tells a reader there is only one kind of material"
    )


def test_an_imported_document_reaches_the_corpus_only_without_a_vault() -> None:
    """The routing rule the policy states is the resolver's own answer.

    The policy tells a reader that a document they bring in goes to their vault
    if they have connected one and is sorted into their own corpus only if they
    have not. That sentence is a promise about where their writing ends up, so
    it is re-derived from :func:`services.corpus_import.reaches_a_vault` -- the
    predicate the import path actually branches on -- rather than paraphrased
    from the module that documents it.
    """
    policy = _prose(_PRIVACY_POLICY)

    assert reaches_a_vault(LocalFallbackCreekVaultClient()) is False, (
        "an account with no vault no longer takes the local-corpus branch; "
        "the policy describes the routing rule and must be rewritten with it"
    )
    assert _CORPUS_SOURCE_DISCLOSURES.get(IMPORT_SOURCE, _NO_DISCLOSURE_WRITTEN) in policy, (
        f"an imported document is now collected under {IMPORT_SOURCE.value!r}, which the "
        f"policy does not describe as a kind of material"
    )


# The policy section describing the deletion of a single entry, addressed by
# its heading. Scoped rather than matched across the whole document, because
# account deletion is immediate and irreversible and the words for that are
# exactly the ones this section may not borrow.
_SINGLE_PAGE_HEADING: Final[str] = "## deleting one page"

# Promises stronger than the schema keeps. The row is stamped, not removed, so
# any of these in that section would tell a reader their page is gone from the
# database when it is gone from the app.
_OVERSTATED_ERASURE: Final[tuple[str, ...]] = (
    "permanently",
    "shredded",
    "wiped",
    "expunged",
    "beyond recovery",
)

# A reply the classifier's parser accepts, naming one position on the ontology.
_CLASSIFIED_REPLY: Final[str] = json.dumps(
    {"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9}
)

# The account the deletion guard runs as. Any id; the promise is about
# behaviour, not about whose row it is.
_DELETING_ACCOUNT: Final[int] = 1


def _section(document: Path, heading: str) -> str:
    """Return one ``##`` section of a document, as collapsed prose."""
    text = _read(document)
    start = text.index(heading)
    following = text.find("\n## ", start + len(heading))
    return " ".join(text[start : len(text) if following == -1 else following].split())


def test_the_policy_describes_deleting_one_page_without_overstating_it() -> None:
    """The single-page section exists and promises only what the row does.

    A soft delete described as an erasure is the failure mode this section is
    most exposed to: the honest sentence and the reassuring one differ by a
    word, and the reassuring one is wrong. The in-app confirmation is already
    careful -- "there is no way back to it from inside the app" -- and a
    published policy may not be looser than the dialog it follows.
    """
    assert _SINGLE_PAGE_HEADING in _read(_PRIVACY_POLICY), (
        "the policy describes no single-page deletion; the journal shelf ships one"
    )
    section = _section(_PRIVACY_POLICY, _SINGLE_PAGE_HEADING)

    overstated = sorted(claim for claim in _OVERSTATED_ERASURE if claim in section)
    assert not overstated, f"the single-page section promises {overstated}: {section!r}"
    assert "corpus" in section, "the section does not say the corpus copy goes with the page"


@pytest.mark.asyncio
async def test_deleting_one_page_keeps_the_row_and_takes_the_corpus_copy(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both halves of that section, re-derived by running the delete.

    The policy makes two claims about one action, and they pull in opposite
    directions: the row survives, and the copy of it the reflections read does
    not. Reading either off a docstring would leave the document describing an
    intention. So an entry is written, ontologized, and then deleted through
    the endpoint the shelf's Delete calls.
    """

    async def classified(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(text=_CLASSIFIED_REPLY)

    monkeypatch.setattr(frequency_classification, "generate_response", classified)
    await set_consent(db_session, user_id=_DELETING_ACCOUNT, source=INGEST_SOURCE, granted=True)
    entry = JournalEntry(
        user_id=_DELETING_ACCOUNT,
        sender="user",
        message=_SENTINEL_BODY,
        classification=JournalClassification.PERSONAL.value,
        timestamp=datetime.now(UTC),
    )
    db_session.add(entry)
    await db_session.commit()
    await db_session.refresh(entry)
    await ingest_journal_entry(db_session, entry)
    await db_session.commit()
    assert await retrieve_fragments(db_session, user_id=_DELETING_ACCOUNT), (
        "the entry never reached the corpus, so the withdrawal below proves nothing"
    )

    await delete_journal_entry(current_user=_DELETING_ACCOUNT, session=db_session, entry=entry)

    assert entry.deleted_at is not None, "the delete did not mark the row"
    assert await db_session.get(JournalEntry, entry.id) is not None, (
        "the row was removed; the policy says it is kept until the account goes"
    )
    assert await retrieve_fragments(db_session, user_id=_DELETING_ACCOUNT) == [], (
        "the corpus copy outlived the delete and can still be read back as context"
    )
