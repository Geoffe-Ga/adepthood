"""The published legal documents may say only what the code actually does.

A privacy policy is the one document in this repository that is *worse* than
absent when it is wrong: an absent policy blocks a store submission, an
overstated one is a false promise made to every person who writes something
private here. So the guarantees the policy makes are pinned from the code side,
the way ``test_account_deletion_policy`` pins ``docs/your-data.md``.

Three failure modes are guarded.

*A promise the code stops keeping.* The policy says production refuses to boot
without a journal-encryption key, that no journal body reaches the error
monitor, and that an entry marked Intimate never leaves for a vault. Each is
re-derived here by running the code, not by reading a comment about it.

*A promise whose breadth is only as true as the column set.* Ten columns carry
ciphertext today, and the policy now makes the broad claim -- what you write is
encrypted -- rather than the narrow one it shipped with. Dropping a column
quietly shrinks a published guarantee; adding one without widening the policy
leaves a reader believing they have less than they do. The set is pinned and
either direction fails here first.

That is not hypothetical, twice over. This guard was written naming two columns;
the ontologized corpus store landed ``corpusfragment.content`` as a third while
the policy was still in review, and the encryption sweep then took it to ten.
Each time the build caught the stale sentence rather than a reader.

*A link that rots.* The in-app rows point at the documents by repository path.
A rename that leaves the rows behind gives a store reviewer, and a user, a 404
where a privacy policy should be.

Nothing here asserts prose quality; the claims, not the wording, are the
contract.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlmodel import SQLModel

from domain.account_deletion import POLICY, Disposition
from main import validate_journal_encryption_config
from routers.journal import _RESONANCE_PRIOR_LIMIT
from sentry import scrub_event
from services import journal_encryption
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.creek_vault_write import VaultWriteStatus, store_and_classify
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
# this set; see :func:`test_exactly_two_columns_are_encrypted`.
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
        "promotedquote.anchor_text",
        "promptresponse.response",
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
    """Ciphertext covers the journal and everything derived from it, and no more.

    The policy's promise is now the broad one -- what you write is encrypted --
    so this set is what makes that sentence true rather than aspirational.
    Dropping a column silently narrows a published guarantee, and adding one
    without widening the policy leaves a reader believing less protection than
    they have. Either direction is a rewrite before the schema change ships.
    """
    assert _encrypted_columns() == _ENCRYPTED_COLUMNS


def test_the_policy_names_the_prose_that_is_still_plaintext() -> None:
    """The carve-out names practice-session prose, which is genuinely in the clear.

    This assertion is deliberately pointed at the *weakest* claim in the
    document. Its predecessor asserted the policy said margin notes were stored
    as written -- true when written, false the moment margin notes were
    encrypted, and it would have kept passing on the phrase alone while
    guarding the opposite of the truth.

    A reflection and an insight written after a practice are prose a person
    composed, held unencrypted (see the issue the policy cites). Until that
    closes, the policy has to say so, and this fails if the admission is
    dropped while the columns are still plaintext.
    """
    policy = _read(_PRIVACY_POLICY)
    assert "reflection and the insight" in policy
    assert "stored as written" in policy


# Spelled-out numbers, because the policy is written for a reader rather than a
# machine and says "up to three", never "up to 3".
_NUMBER_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}


def test_the_policy_states_the_context_window_the_code_actually_sends() -> None:
    """The count of prior entries sent to the LLM provider is the code's own.

    This is the one number in the document describing what leaves the deployment
    for a third party, so a reader deciding whether to write something down is
    deciding on it. It shipped as "five" against a limit that has been three
    since the constant was introduced -- overstating rather than understating,
    which is the harmless direction, and still wrong in a document whose whole
    value is that a reader who believes it is not misled.

    Pinned to ``_RESONANCE_PRIOR_LIMIT`` rather than to the literal ``three`` so
    that raising the limit fails here, where the policy is, instead of quietly
    widening what is shared.
    """
    policy = _read(_PRIVACY_POLICY)
    expected = _NUMBER_WORDS[_RESONANCE_PRIOR_LIMIT]

    assert f"up to {expected}" in policy, (
        f"the policy must say 'up to {expected}' to match "
        f"_RESONANCE_PRIOR_LIMIT = {_RESONANCE_PRIOR_LIMIT}"
    )
    wrong = {word for count, word in _NUMBER_WORDS.items() if count != _RESONANCE_PRIOR_LIMIT}
    stale = sorted(word for word in wrong if f"up to {word}" in policy)
    assert not stale, f"the policy also claims 'up to {stale}', contradicting itself"


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
