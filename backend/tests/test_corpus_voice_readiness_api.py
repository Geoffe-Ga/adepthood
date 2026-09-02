"""The voice-readiness route, through the HTTP surface a client actually holds.

Three properties belong here rather than in the service suite, because each is
a property of the *seam*.

*The answer is the caller's own.* The account comes from the token and from
nowhere else, so a well-stocked stranger changes nothing about what this
account is told — and the route refuses a request that carries no token at all.

*The answer never quotes the writing.* A readiness signal is a fact about a
corpus. A fragment holding a sentinel string is stored, and the whole response
body is searched for it: counts and a source may cross this boundary, and
nothing else may.

*``ready`` means one thing.* It is the projection of ``state`` and is asserted
as such in every state the route can return, so the boolean a client branches
on cannot drift away from the vocabulary the copy is chosen by.
"""

from __future__ import annotations

from http import HTTPStatus
from types import MappingProxyType

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from domain.frequencies import Frequency
from models.corpus_fragment import CorpusSource
from models.journal_entry import JournalClassification
from schemas.voice_readiness import VOICE_READINESS_MESSAGES, VoiceReadinessState
from services.corpus_store import FragmentDraft, record_fragment
from services.frequency_classification import ClassificationSource, FrequencyClassification
from services.higher_self_grounding import GroundingSource
from services.voice_readiness import VOICE_READY_FRAGMENT_THRESHOLD

_READINESS_PATH = "/corpus/voice-readiness"
_CONSENT_PATH = "/corpus/consent"
_JOURNAL_SOURCE = CorpusSource.JOURNAL.value

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

# A string that exists nowhere else in the response vocabulary, so finding it
# in the body can only mean a fragment's content was rendered.
_SENTINEL = "quartzlight-sentinel-phrase"

# How many sentinel-bearing fragments the privacy test stores. Small, and named
# so the count assertion that proves they are really there is not a bare literal.
_SENTINEL_FRAGMENTS = 3


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a fresh account and return its auth header and id."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _grant(client: AsyncClient, headers: dict[str, str]) -> None:
    """Agree to ontologizing what this account writes."""
    resp = await client.put(
        f"{_CONSENT_PATH}/{_JOURNAL_SOURCE}", json={"granted": True}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK, resp.text


async def _store_fragments(
    session: AsyncSession, *, user_id: int, count: int, content: str = "a morning"
) -> None:
    """Record ``count`` personal-tier journal fragments against ``user_id``."""
    classification = FrequencyClassification(
        weights=MappingProxyType({Frequency.F5: 1.0}),
        overall_confidence=1.0,
        source=ClassificationSource.OPERATOR,
    )
    for index in range(count):
        await record_fragment(
            session,
            user_id=user_id,
            draft=FragmentDraft(
                content=f"{content} {index}",
                tier=JournalClassification.PERSONAL,
                source=CorpusSource.JOURNAL,
                classification=classification,
            ),
        )
    await session.commit()


@pytest.mark.asyncio
async def test_readiness_refuses_a_request_carrying_no_token(
    async_client: AsyncClient,
) -> None:
    """There is no anonymous answer to "how is *your* corpus doing"."""
    resp = await async_client.get(_READINESS_PATH)

    assert resp.status_code == HTTPStatus.UNAUTHORIZED, resp.text


@pytest.mark.asyncio
async def test_a_brand_new_account_is_told_about_the_decision(
    async_client: AsyncClient,
) -> None:
    """The default answer names the consent decision, not an entry quota.

    This is the state the great majority of accounts are in, and the reason
    readiness is three-state: nothing this account writes reaches a classifier
    until it makes this decision, so copy offering it an entry count would be
    describing a road that does not exist.
    """
    headers, _ = await _signup(async_client, "readiness-fresh")

    resp = await async_client.get(_READINESS_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["state"] == VoiceReadinessState.NOT_CONSENTED.value
    assert body["ready"] is False
    assert body["classified_fragment_count"] == 0
    assert body["grounding_source"] == GroundingSource.RECENT_ENTRIES.value
    assert body["message"] == VOICE_READINESS_MESSAGES[VoiceReadinessState.NOT_CONSENTED]


@pytest.mark.asyncio
async def test_a_consented_account_below_the_threshold_is_gathering(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Having agreed and having a corpus are different things."""
    headers, user_id = await _signup(async_client, "readiness-gathering")
    await _grant(async_client, headers)
    await _store_fragments(db_session, user_id=user_id, count=VOICE_READY_FRAGMENT_THRESHOLD - 1)

    resp = await async_client.get(_READINESS_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["state"] == VoiceReadinessState.GATHERING.value
    assert body["ready"] is False
    assert body["classified_fragment_count"] == VOICE_READY_FRAGMENT_THRESHOLD - 1
    assert body["message"] == VOICE_READINESS_MESSAGES[VoiceReadinessState.GATHERING]


@pytest.mark.asyncio
async def test_an_account_at_the_threshold_is_ready_and_is_told_nothing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Arriving is silence — no message, and nothing to dismiss."""
    headers, user_id = await _signup(async_client, "readiness-ready")
    await _grant(async_client, headers)
    await _store_fragments(db_session, user_id=user_id, count=VOICE_READY_FRAGMENT_THRESHOLD)

    resp = await async_client.get(_READINESS_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["state"] == VoiceReadinessState.READY.value
    assert body["ready"] is True
    assert body["message"] is None
    assert body["grounding_source"] == GroundingSource.CORPUS.value


@pytest.mark.asyncio
async def test_ready_agrees_with_state_in_every_state_the_route_returns(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One rule, read back through the wire in all three of its outcomes."""
    seen: list[str] = []
    headers, user_id = await _signup(async_client, "readiness-invariant")

    async def _nothing() -> None:
        """The account as it already is, before either change is made."""
        return

    async def _agree() -> None:
        """Agree to have the journal sorted."""
        await _grant(async_client, headers)

    async def _fill() -> None:
        """Put a representative corpus on the record."""
        await _store_fragments(db_session, user_id=user_id, count=VOICE_READY_FRAGMENT_THRESHOLD)

    for advance in (_nothing, _agree, _fill):
        await advance()
        body = (await async_client.get(_READINESS_PATH, headers=headers)).json()
        seen.append(body["state"])
        assert body["ready"] == (body["state"] == VoiceReadinessState.READY.value)

    # Non-emptiness before the substantive claim: a walk that observed one
    # state three times would satisfy the invariant without testing it.
    assert seen == [
        VoiceReadinessState.NOT_CONSENTED.value,
        VoiceReadinessState.GATHERING.value,
        VoiceReadinessState.READY.value,
    ]


@pytest.mark.asyncio
async def test_readiness_never_renders_a_fragments_own_words(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Counts and a source cross this boundary; the writing does not."""
    headers, user_id = await _signup(async_client, "readiness-sentinel")
    await _grant(async_client, headers)
    await _store_fragments(
        db_session, user_id=user_id, count=_SENTINEL_FRAGMENTS, content=_SENTINEL
    )

    resp = await async_client.get(_READINESS_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    # The count proves the fragments are really there — without it this would
    # pass just as well against an account holding nothing at all.
    assert resp.json()["classified_fragment_count"] == _SENTINEL_FRAGMENTS
    assert _SENTINEL not in resp.text


@pytest.mark.asyncio
async def test_one_accounts_readiness_never_reflects_anothers_corpus(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A stranger's full corpus leaves this account exactly where it was."""
    mine, _ = await _signup(async_client, "readiness-mine")
    theirs, stranger_id = await _signup(async_client, "readiness-theirs")
    await _grant(async_client, mine)
    await _grant(async_client, theirs)
    await _store_fragments(
        db_session,
        user_id=stranger_id,
        count=VOICE_READY_FRAGMENT_THRESHOLD + 5,
        content="not mine",
    )

    ours = (await async_client.get(_READINESS_PATH, headers=mine)).json()
    stranger = (await async_client.get(_READINESS_PATH, headers=theirs)).json()

    # The stranger's side is asserted too: without it, a route that answered
    # zero for everybody would pass this.
    assert stranger["ready"] is True
    assert ours["classified_fragment_count"] == 0
    assert ours["state"] == VoiceReadinessState.GATHERING.value
    assert ours["ready"] is False
