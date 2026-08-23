"""The corpus, end to end: consent, then writing, then reading it back.

The unit suites hold each piece to its own contract. This module is about the
seam, because the defect the corpus writer closes was a seam defect: every
piece worked and nothing connected them, so
:func:`services.higher_self_grounding.gather_grounding` fell through to its
recency window for every account in every deployment, permanently.

Three properties, each asserted through the real HTTP surface rather than
through a service call.

*Consent is a decision the account makes here.* A fresh account has agreed to
nothing, saying so is a request it makes, and until it makes it no journal
entry is classified and no provider is contacted.

*Saving is not classifying.* The entry lands whatever the classifier does, and
that is asserted against a provider that fails rather than against one that is
merely absent.

*What the corpus holds is what the journal holds.* Editing an entry through
the API replaces its fragment; deleting one removes it. Both are read back
through the grounding path, which is the thing an account would actually
notice.
"""

from __future__ import annotations

import json
from http import HTTPStatus
from types import SimpleNamespace

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from domain.frequencies import Frequency
from models.corpus_fragment import CorpusSource
from services import frequency_classification as fc
from services.botmason import LLMProviderError
from services.higher_self_grounding import GroundingSource, gather_grounding

_CONSENT_PATH = "/corpus/consent"
_JOURNAL_PATH = "/journal/"
_JOURNAL_SOURCE = CorpusSource.JOURNAL.value

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

_FIRST_BODY = "I sat with the thing I have been avoiding."
_SECOND_BODY = "This morning it was easier than yesterday."
_EDITED_BODY = "On reflection it was not easier at all."

# A reply the classifier's parser accepts, naming one position on the ontology.
_CLASSIFIED_REPLY = json.dumps({"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9})

# An entry id no account in these tests owns, used where the grounding call
# needs an exclusion that excludes nothing.
_NO_SUCH_ENTRY = 9_999


@pytest.fixture
def _classifier(monkeypatch: pytest.MonkeyPatch) -> None:
    """Route the classifier's provider call to a fake that always succeeds.

    The one test that cares *how many* calls were made counts them itself, so
    this hands nothing back: a fixture returning a value nobody reads invites
    the next reader to believe an assertion is being made where none is.
    """

    async def fake(**_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(text=_CLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", fake)


@pytest.fixture
def _classifier_down(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every classification attempt fail the way an outage does."""

    async def down(**_kwargs: object) -> SimpleNamespace:
        raise LLMProviderError

    monkeypatch.setattr(fc, "generate_response", down)


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a fresh account and return its auth header and id."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _grant(client: AsyncClient, headers: dict[str, str]) -> dict[str, object]:
    """Agree to ontologizing what this account writes here."""
    resp = await client.put(
        f"{_CONSENT_PATH}/{_JOURNAL_SOURCE}", json={"granted": True}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    return dict(resp.json())


async def _write(client: AsyncClient, headers: dict[str, str], body: str) -> int:
    """Post one journal entry and return its id."""
    resp = await client.post(_JOURNAL_PATH, json={"message": body}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    return int(resp.json()["id"])


@pytest.mark.asyncio
async def test_a_fresh_account_is_offered_every_source_and_has_agreed_to_none(
    async_client: AsyncClient,
) -> None:
    """The consent surface can be rendered before any decision exists."""
    headers, _ = await _signup(async_client, "unasked")

    resp = await async_client.get(_CONSENT_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    listed = resp.json()["sources"]
    assert [entry["source"] for entry in listed] == [source.value for source in CorpusSource]
    assert not any(entry["granted"] for entry in listed)


@pytest.mark.asyncio
async def test_without_consent_a_saved_entry_reaches_no_classifier(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The floor for an account that has decided nothing is: nothing happens.

    The fake raises, so this fails if a provider call is *attempted* — not
    merely if a fragment is stored. An entry sent to a cloud classifier and
    then not kept has already left the deployment.
    """

    async def explode(**kwargs: object) -> SimpleNamespace:
        msg = f"a provider call was made without consent: {sorted(kwargs)}"
        raise AssertionError(msg)

    monkeypatch.setattr(fc, "generate_response", explode)
    headers, _ = await _signup(async_client, "undecided")

    entry_id = await _write(async_client, headers, _FIRST_BODY)

    assert entry_id > 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("_classifier")
async def test_consenting_makes_what_you_write_the_thing_you_are_grounded_in(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The corpus stops being unreachable: this is the whole point of the change.

    Before a writer existed, every grounding in every deployment resolved to
    the recency window. One consenting account and one entry is enough to move
    it to the corpus.
    """
    headers, user_id = await _signup(async_client, "consenting")
    await _grant(async_client, headers)

    await _write(async_client, headers, _FIRST_BODY)
    grounding = await gather_grounding(db_session, user_id=user_id, exclude_entry_id=_NO_SUCH_ENTRY)

    assert grounding.source is GroundingSource.CORPUS
    assert grounding.bodies == (_FIRST_BODY,)


@pytest.mark.asyncio
@pytest.mark.usefixtures("_classifier")
async def test_an_entry_is_never_grounded_in_itself(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Reflecting on an entry does not hand that entry back as earlier writing.

    Reachable only once the writer exists, which is why it is fixed on the
    same change: otherwise the model is asked to draw a connection between a
    passage and itself.
    """
    headers, user_id = await _signup(async_client, "reflecting")
    await _grant(async_client, headers)
    await _write(async_client, headers, _FIRST_BODY)
    second_id = await _write(async_client, headers, _SECOND_BODY)

    grounding = await gather_grounding(db_session, user_id=user_id, exclude_entry_id=second_id)

    assert _SECOND_BODY not in grounding.bodies
    assert grounding.bodies == (_FIRST_BODY,)


@pytest.mark.asyncio
@pytest.mark.usefixtures("_classifier_down")
async def test_a_classifier_outage_does_not_cost_anybody_their_writing(
    async_client: AsyncClient,
) -> None:
    """The entry is saved and readable back even though classification failed."""
    headers, _ = await _signup(async_client, "unlucky")
    await _grant(async_client, headers)

    entry_id = await _write(async_client, headers, _FIRST_BODY)
    stored = await async_client.get(f"/journal/{entry_id}", headers=headers)

    assert stored.status_code == HTTPStatus.OK, stored.text
    assert stored.json()["message"] == _FIRST_BODY


@pytest.mark.asyncio
@pytest.mark.usefixtures("_classifier")
async def test_saying_yes_grounds_you_in_what_you_had_already_written(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The population the corpus was built for: an account with a history.

    Every other test here consents first and writes afterwards, which is the
    one case a write-time gate already handled. This is the case it did not:
    the writing exists, the permission arrives later, and the grounding has to
    be the corpus over that writing rather than a recency window over it.
    """
    headers, user_id = await _signup(async_client, "already-writing")
    await _write(async_client, headers, _FIRST_BODY)
    await _write(async_client, headers, _SECOND_BODY)
    before = await gather_grounding(db_session, user_id=user_id, exclude_entry_id=_NO_SUCH_ENTRY)

    await _grant(async_client, headers)
    after = await gather_grounding(db_session, user_id=user_id, exclude_entry_id=_NO_SUCH_ENTRY)

    assert before.source is GroundingSource.RECENT_ENTRIES
    assert after.source is GroundingSource.CORPUS
    assert sorted(after.bodies) == sorted([_FIRST_BODY, _SECOND_BODY])


@pytest.mark.asyncio
@pytest.mark.usefixtures("_classifier")
async def test_editing_an_entry_changes_what_the_corpus_says(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The corpus holds the entry as it reads now, and holds it once."""
    headers, user_id = await _signup(async_client, "editing")
    await _grant(async_client, headers)
    entry_id = await _write(async_client, headers, _FIRST_BODY)

    edited = await async_client.patch(
        f"/journal/{entry_id}", json={"message": _EDITED_BODY}, headers=headers
    )
    grounding = await gather_grounding(db_session, user_id=user_id, exclude_entry_id=_NO_SUCH_ENTRY)

    assert edited.status_code == HTTPStatus.OK, edited.text
    assert grounding.bodies == (_EDITED_BODY,)


@pytest.mark.asyncio
@pytest.mark.usefixtures("_classifier")
async def test_deleting_an_entry_takes_it_out_of_the_corpus_too(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Writing an account has deleted stops being sent to a language model."""
    headers, user_id = await _signup(async_client, "deleting")
    await _grant(async_client, headers)
    entry_id = await _write(async_client, headers, _FIRST_BODY)

    removed = await async_client.delete(f"/journal/{entry_id}", headers=headers)
    grounding = await gather_grounding(db_session, user_id=user_id, exclude_entry_id=_NO_SUCH_ENTRY)

    assert removed.status_code == HTTPStatus.NO_CONTENT, removed.text
    assert grounding.bodies == ()


@pytest.mark.asyncio
@pytest.mark.usefixtures("_classifier")
async def test_revoking_consent_empties_the_corpus_it_filled(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Withdrawal reaches the writing, not merely the permission.

    Observed as the grounding falling back to the recency window: the corpus
    answers whenever it holds anything at all, so a source of
    ``recent_entries`` for an account that was corpus-grounded a moment ago is
    exactly the statement that its fragments are gone. Asserting on the bodies
    instead would prove nothing here — the entry itself is still in the
    journal, and the window would hand it back either way.
    """
    headers, user_id = await _signup(async_client, "revoking")
    await _grant(async_client, headers)
    await _write(async_client, headers, _FIRST_BODY)
    before = await gather_grounding(db_session, user_id=user_id, exclude_entry_id=_NO_SUCH_ENTRY)

    revoked = await async_client.put(
        f"{_CONSENT_PATH}/{_JOURNAL_SOURCE}", json={"granted": False}, headers=headers
    )
    after = await gather_grounding(db_session, user_id=user_id, exclude_entry_id=_NO_SUCH_ENTRY)

    assert revoked.status_code == HTTPStatus.OK, revoked.text
    assert revoked.json()["granted"] is False
    assert before.source is GroundingSource.CORPUS
    assert after.source is GroundingSource.RECENT_ENTRIES


@pytest.mark.asyncio
async def test_one_accounts_consent_does_not_write_another_accounts_journal(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Consent is per account, asserted where it would hurt: at the provider call.

    Two accounts, one consenting. Exactly one entry is classified, so a
    deployment-wide reading of one account's decision shows up as a second
    call rather than as a subtle difference in a corpus.
    """
    calls: list[dict[str, object]] = []

    async def fake(**kwargs: object) -> SimpleNamespace:
        calls.append(kwargs)
        return SimpleNamespace(text=_CLASSIFIED_REPLY)

    monkeypatch.setattr(fc, "generate_response", fake)
    consenting, _ = await _signup(async_client, "yes-please")
    refusing, _ = await _signup(async_client, "no-thanks")
    await _grant(async_client, consenting)

    await _write(async_client, consenting, _FIRST_BODY)
    await _write(async_client, refusing, _SECOND_BODY)

    assert len(calls) == 1


@pytest.mark.asyncio
async def test_consent_cannot_be_read_or_set_without_a_token(
    async_client: AsyncClient,
) -> None:
    """Both verbs are the caller's own; neither accepts an account from the wire."""
    listed = await async_client.get(_CONSENT_PATH)
    written = await async_client.put(f"{_CONSENT_PATH}/{_JOURNAL_SOURCE}", json={"granted": True})

    assert listed.status_code == HTTPStatus.UNAUTHORIZED
    assert written.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_a_source_outside_the_vocabulary_is_refused(
    async_client: AsyncClient,
) -> None:
    """The path names a source from the enum or it names nothing.

    A free-text source would be a permission for a value no fragment could
    ever carry, stored forever and readable as consent by whatever came next.
    """
    headers, _ = await _signup(async_client, "inventive")

    resp = await async_client.put(
        f"{_CONSENT_PATH}/telepathy", json={"granted": True}, headers=headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
