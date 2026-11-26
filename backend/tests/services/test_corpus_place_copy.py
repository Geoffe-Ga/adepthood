"""A Corpus is the writing, never the place it is kept (#3827).

After epic #3802 one word named two things: a person's body of sorted writing
("your document is in your Corpus") and the thing that is connected, set up,
reached and deleted ("No Corpus was connected"). An account with nothing
connected could read both. The rule, stated in the Naming section of
``frontend/src/design/DESIGN.md``: a sentence about the writing says "your
Corpus"; a sentence about the place says where the Corpus is kept or runs, or
calls it plain "storage".

``frontend/src/__tests__/wiring/userFacingNaming.test.ts`` holds the frontend
to this. These tests hold the sentences the server writes for a person: upload
and import receipts, the account-deletion receipt, the agent consent page and
the agent activity log.
"""

from __future__ import annotations

import re

import pytest

from schemas.corpus_import import CORPUS_IMPORT_MESSAGES
from schemas.journal_upload import UPLOAD_MESSAGES
from services import account_deletion, oauth_consent_copy, vault_agent_activity_copy

# A word straight before "Corpus" that counts it, points at it or connects it
# makes it a place. "a Corpus entry" is an entry in the writing, so it stays.
# The same pattern is written out in the frontend guard named above (its
# "Corpus as a place" rule). Change the two together.
_CORPUS_AS_A_PLACE = re.compile(
    r"\b(?:an?|another|this|that|the|no|new|fresh|previous|managed|connected|isolated|"
    r"(?:re|dis)?connect|create|replace) Corpus\b(?! entry)",
    re.IGNORECASE,
)


def _server_sentences() -> dict[str, str]:
    """Every sentence the guarded modules write for a person, by a name for it."""
    sentences: dict[str, str] = {}
    for status, message in CORPUS_IMPORT_MESSAGES.items():
        sentences[f"import:{status.value}"] = message
    for upload_status, message in UPLOAD_MESSAGES.items():
        sentences[f"upload:{upload_status.value}"] = message
    for module in (account_deletion, oauth_consent_copy, vault_agent_activity_copy):
        for name, value in vars(module).items():
            if not name.isupper():
                continue
            if isinstance(value, str):
                sentences[f"{module.__name__}.{name}"] = value
            elif hasattr(value, "items"):
                for key, text in value.items():
                    if isinstance(text, str):
                        sentences[f"{module.__name__}.{name}[{key}]"] = text
    return sentences


def test_the_guard_reads_the_sentences_it_is_meant_to() -> None:
    sentences = _server_sentences()

    assert "services.account_deletion.VAULT_GUIDANCE_NONE" in sentences
    assert "services.oauth_consent_copy.ERROR_BODIES[no_vault]" in sentences
    assert "services.vault_agent_activity_copy.TOOL_LABELS[creek.handshake]" in sentences
    assert "upload:vault_unavailable" in sentences
    assert "import:format_unreadable" in sentences


def test_no_server_sentence_makes_a_corpus_a_place() -> None:
    offenders = {
        name: text for name, text in _server_sentences().items() if _CORPUS_AS_A_PLACE.search(text)
    }

    assert offenders == {}


@pytest.mark.parametrize(
    "text",
    [
        "No Corpus was connected, so nothing of yours is held outside Adepthood.",
        "A connected Corpus reads richer formats for you.",
        "Your account has no Corpus connected yet.",
        "Deletion of your managed Corpus has been requested.",
        "This request named a Corpus that is not the one connected to your account.",
    ],
)
def test_the_guard_fails_on_the_sentences_it_replaced(text: str) -> None:
    assert _CORPUS_AS_A_PLACE.search(text)


@pytest.mark.parametrize(
    "text",
    [
        "Your document is in your Corpus. It will show up in reflections from here on.",
        "Tried to re-sort your Corpus",
        "a Corpus entry has to sit somewhere on the map to be found again.",
        "Nothing was connected to keep your Corpus.",
    ],
)
def test_the_guard_leaves_the_writing_alone(text: str) -> None:
    assert _CORPUS_AS_A_PLACE.search(text) is None


def test_the_place_is_said_as_where_the_corpus_is_kept() -> None:
    assert account_deletion.VAULT_GUIDANCE_NONE == (
        "Nothing was connected to keep your Corpus, so nothing of yours is held outside Adepthood."
    )
    assert oauth_consent_copy.ERROR_BODIES["no_vault"] == (
        "Nothing is connected to keep your Corpus yet, so there is nothing for an agent to "
        "work with. You can set that up in Settings, under Where your writing lives."
    )
    assert oauth_consent_copy.ERROR_BODIES["other_vault"] == (
        "This request named storage that is not what is connected to your account. "
        "Nothing was shared."
    )
    assert (
        "Storage connected to keep your Corpus reads richer formats for you."
        in (
            CORPUS_IMPORT_MESSAGES[
                next(s for s in CORPUS_IMPORT_MESSAGES if s.value == "format_unreadable")
            ]
        )
    )
    assert UPLOAD_MESSAGES[next(s for s in UPLOAD_MESSAGES if s.value == "vault_unavailable")] == (
        "Where your Corpus is kept didn't answer, so the document wasn't sent. Check "
        "that it is running and reachable, then upload it again."
    )
    assert account_deletion.VAULT_GUIDANCE_TEARDOWN_PENDING.startswith(
        "Deletion of your managed storage has been requested."
    )
    assert vault_agent_activity_copy.TOOL_LABELS["creek.handshake"] == (
        "Checked that it was connected"
    )
