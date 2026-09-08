"""The corpus-invitation routes, through the HTTP surface a client holds (#2407).

Four properties belong at the seam. *The answer is the caller's own*: the
account comes from the token, so there is no anonymous answer and no way to
name another account. *A read writes nothing*: a fresh account's ``GET`` is
``offer: false`` and provisions no row. *A decline is one required boolean*:
``PUT {}`` is a 422, because a decline whose meaning depends on a default is a
decline that can be sent by accident. *Nothing counted leaves*: no
``user_id`` and no pass count appear in any body, since a number on an
invitation would make it a meter.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.corpus_fragment import CorpusSource
from models.corpus_invitation_state import CorpusInvitationState
from services.corpus_invitation import record_completed_pass

_INVITATION_PATH = "/corpus/invitation"
_CONSENT_PATH = "/corpus/consent"
_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

#: Keys a body may never carry, whatever else it says.
_FORBIDDEN_KEYS = frozenset({"user_id", "completed_passes", "passes_at_dismissal"})


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a fresh account and return its auth header and id."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _complete_a_pass(session: AsyncSession, user_id: int) -> None:
    """Count one completed pass for ``user_id`` and commit it, as the settlement would."""
    await record_completed_pass(session, user_id=user_id)
    await session.commit()


async def _row_count(session: AsyncSession) -> int:
    """How many invitation-state rows exist at all."""
    count: int = (
        await session.execute(select(func.count()).select_from(CorpusInvitationState))
    ).scalar_one()
    return count


def _assert_body_is_content_free(body: dict[str, object]) -> None:
    """The response is three fields about being asked, and nothing counted."""
    assert set(body) == {"offer", "dismissed_at", "do_not_ask_again"}
    assert not (_FORBIDDEN_KEYS & set(body))


@pytest.mark.asyncio
async def test_the_read_refuses_a_request_carrying_no_token(async_client: AsyncClient) -> None:
    """There is no anonymous answer to "may we ask *you*?"."""
    resp = await async_client.get(_INVITATION_PATH)

    assert resp.status_code == HTTPStatus.UNAUTHORIZED, resp.text


@pytest.mark.asyncio
async def test_the_decline_refuses_a_request_carrying_no_token(async_client: AsyncClient) -> None:
    """Nor is there an anonymous decline."""
    resp = await async_client.put(_INVITATION_PATH, json={"do_not_ask_again": False})

    assert resp.status_code == HTTPStatus.UNAUTHORIZED, resp.text


@pytest.mark.asyncio
async def test_a_fresh_account_is_offered_nothing_and_gains_no_row(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Before any completed pass the answer is quiet, and asking provisions nothing."""
    headers, _ = await _signup(async_client, "invitation-fresh")

    resp = await async_client.get(_INVITATION_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body == {"offer": False, "dismissed_at": None, "do_not_ask_again": False}
    assert await _row_count(db_session) == 0


@pytest.mark.asyncio
async def test_the_first_completed_pass_on_an_undecided_account_is_offered(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The ruling's trigger, read back through the route."""
    headers, user_id = await _signup(async_client, "invitation-first")
    await _complete_a_pass(db_session, user_id)

    resp = await async_client.get(_INVITATION_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["offer"] is True
    _assert_body_is_content_free(body)


@pytest.mark.asyncio
async def test_a_decline_needs_its_one_boolean(async_client: AsyncClient) -> None:
    """``PUT {}`` is malformed, not a default decline."""
    headers, _ = await _signup(async_client, "invitation-422")

    resp = await async_client.put(_INVITATION_PATH, json={}, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, resp.text


@pytest.mark.asyncio
async def test_not_now_is_recorded_and_ends_the_offer_for_now(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A plain decline stamps the instant and silences the next read."""
    headers, user_id = await _signup(async_client, "invitation-not-now")
    await _complete_a_pass(db_session, user_id)

    resp = await async_client.put(
        _INVITATION_PATH, json={"do_not_ask_again": False}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["offer"] is False
    assert body["dismissed_at"] is not None
    assert body["do_not_ask_again"] is False
    _assert_body_is_content_free(body)
    again = (await async_client.get(_INVITATION_PATH, headers=headers)).json()
    assert again["offer"] is False
    assert again["dismissed_at"] == body["dismissed_at"]


@pytest.mark.asyncio
async def test_do_not_ask_again_sticks_through_a_later_not_now(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The firmer answer is never softened by the softer one that follows it."""
    headers, user_id = await _signup(async_client, "invitation-final")
    await _complete_a_pass(db_session, user_id)

    first = await async_client.put(
        _INVITATION_PATH, json={"do_not_ask_again": True}, headers=headers
    )
    second = await async_client.put(
        _INVITATION_PATH, json={"do_not_ask_again": False}, headers=headers
    )

    assert first.status_code == HTTPStatus.OK, first.text
    assert second.status_code == HTTPStatus.OK, second.text
    assert first.json()["do_not_ask_again"] is True
    assert second.json()["do_not_ask_again"] is True
    assert (await async_client.get(_INVITATION_PATH, headers=headers)).json()[
        "do_not_ask_again"
    ] is True


@pytest.mark.asyncio
async def test_granted_consent_ends_the_offer(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Once the account has decided about its journal there is nothing to invite."""
    headers, user_id = await _signup(async_client, "invitation-granted")
    await _complete_a_pass(db_session, user_id)
    grant = await async_client.put(
        f"{_CONSENT_PATH}/{CorpusSource.JOURNAL.value}", json={"granted": True}, headers=headers
    )
    assert grant.status_code == HTTPStatus.OK, grant.text

    resp = await async_client.get(_INVITATION_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["offer"] is False
