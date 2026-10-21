"""``GET /corpus/sweep``: how much writing is unsorted, and what sorting costs.

The sweep that ontologizes writing an account already had is bounded at
``BACKFILL_ENTRY_CEILING`` entries per pass, so an account with a backlog
reaches the rest of it by asking again. Asking again is only a decision
somebody can make if they can see what is left — and, once sorting carries a
price, what finishing it would cost. This is the read that answers both.

Four properties belong at this seam rather than in the service suite.

*The answer is the caller's own.* The account comes from the token and from
nowhere else, so a stranger's backlog changes nothing about what this account
is told.

*The answer never quotes the writing.* A backlog is a count. An entry holding
a sentinel string is stored and the whole response body is searched for it:
counts and a price may cross this boundary, and nothing else may.

*Reading a price costs nothing.* No provider is dialled, nothing is charged,
and nothing is written — so the same request twice reads the same, which is
what lets a client poll it while deciding.

*The price is disclosed from one constant.* ``price_units`` is whatever
:data:`services.corpus_backfill.CORPUS_SWEEP_PRICE_UNITS` says, and
``estimated_price_units`` is that times the backlog, so a surface cannot come
to disagree with the charge it is describing.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from models.corpus_fragment import CorpusSource
from models.journal_entry import JournalClassification, JournalEntry
from models.user import User
from services import corpus_backfill
from services import frequency_classification as fc
from services.usage import get_monthly_cap

_SWEEP_PATH = "/corpus/sweep"
_CONSENT_PATH = "/corpus/consent"
_JOURNAL_SOURCE = CorpusSource.JOURNAL.value

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

# A string that exists nowhere in the response vocabulary, so finding it in the
# body can only mean an entry's words were rendered.
_SENTINEL = "quartzlight-sentinel-phrase"

# A backlog small enough to write quickly and larger than one, so a per-entry
# price multiplies by something a wrong implementation could not stumble onto.
_BACKLOG = 3

# A price worth more than one unit, for the same reason.
_PRICED = 2

# Far enough back that the monthly reset date is unambiguously lapsed.
_A_MONTH_AGO_DAYS = 40


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a fresh account and return its auth header and id."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


def _entry(
    *, user_id: int, body: str, tier: JournalClassification, sender: str = "user"
) -> JournalEntry:
    """One un-ontologized journal row, owned by ``user_id``."""
    return JournalEntry(
        message=body,
        sender=sender,
        user_id=user_id,
        classification=tier.value,
        timestamp=datetime.now(UTC),
    )


async def _entries(
    session: AsyncSession,
    *,
    user_id: int,
    count: int,
    tier: JournalClassification = JournalClassification.PERSONAL,
    sender: str = "user",
) -> None:
    """Put ``count`` un-ontologized journal rows in ``user_id``'s history."""
    for index in range(count):
        session.add(_entry(user_id=user_id, body=f"a morning {index}", tier=tier, sender=sender))
    await session.commit()


@pytest.mark.asyncio
async def test_refuses_a_request_carrying_no_token(async_client: AsyncClient) -> None:
    """There is no anonymous answer to "how much of *your* writing is waiting"."""
    resp = await async_client.get(_SWEEP_PATH)

    assert resp.status_code == HTTPStatus.UNAUTHORIZED, resp.text


@pytest.mark.asyncio
async def test_a_brand_new_account_is_told_zero_rather_than_a_404(
    async_client: AsyncClient,
) -> None:
    """An account that has written nothing has an answer, not a missing resource.

    This is the most common state, not an error one — the same contract
    ``GET /corpus/voice-readiness`` keeps.
    """
    headers, _ = await _signup(async_client, "sweep-fresh")

    resp = await async_client.get(_SWEEP_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["entries_pending"] == 0
    assert body["estimated_price_units"] == 0
    assert body["wallet_covers"] is True


@pytest.mark.asyncio
async def test_counts_the_writing_that_has_no_fragment_yet(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The backlog is the rows the sweep would actually take."""
    headers, user_id = await _signup(async_client, "sweep-backlog")
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    resp = await async_client.get(_SWEEP_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["entries_pending"] == _BACKLOG


@pytest.mark.asyncio
async def test_an_intimate_entry_is_never_counted(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An intimate entry is not sorted at all, so it is not a backlog item.

    Offering to sort it — or pricing it — would describe reach the deployment
    does not have.
    """
    headers, user_id = await _signup(async_client, "sweep-intimate")
    await _entries(db_session, user_id=user_id, count=_BACKLOG, tier=JournalClassification.INTIMATE)

    resp = await async_client.get(_SWEEP_PATH, headers=headers)

    assert resp.json()["entries_pending"] == 0


@pytest.mark.asyncio
async def test_a_resonance_reply_is_never_counted(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Only the person's own writing is a candidate; ``sender='bot'`` is ours."""
    headers, user_id = await _signup(async_client, "sweep-bot")
    await _entries(db_session, user_id=user_id, count=_BACKLOG, sender="bot")

    resp = await async_client.get(_SWEEP_PATH, headers=headers)

    assert resp.json()["entries_pending"] == 0


@pytest.mark.asyncio
async def test_a_strangers_backlog_is_not_this_accounts_answer(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The account comes from the token, so no request can read another's backlog."""
    _, stranger_id = await _signup(async_client, "sweep-stranger")
    await _entries(db_session, user_id=stranger_id, count=_BACKLOG)
    headers, _ = await _signup(async_client, "sweep-asker")

    resp = await async_client.get(_SWEEP_PATH, headers=headers)

    assert resp.json()["entries_pending"] == 0


@pytest.mark.asyncio
async def test_the_response_never_quotes_the_writing(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A backlog is a count. The words stay in the journal."""
    headers, user_id = await _signup(async_client, "sweep-privacy")
    for index in range(_BACKLOG):
        db_session.add(
            _entry(
                user_id=user_id,
                body=f"{_SENTINEL} {index}",
                tier=JournalClassification.PERSONAL,
            )
        )
    await db_session.commit()

    resp = await async_client.get(_SWEEP_PATH, headers=headers)

    assert resp.json()["entries_pending"] == _BACKLOG
    assert _SENTINEL not in resp.text


@pytest.mark.asyncio
async def test_reading_the_estimate_twice_reads_the_same(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The read is a read: no write, so polling it while deciding is free."""
    headers, user_id = await _signup(async_client, "sweep-idempotent")
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    first = await async_client.get(_SWEEP_PATH, headers=headers)
    second = await async_client.get(_SWEEP_PATH, headers=headers)

    assert first.json() == second.json()


@pytest.mark.asyncio
async def test_the_free_default_prices_nothing_and_the_wallet_always_covers(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """At the shipped default the sweep is free, so there is no price to show."""
    headers, user_id = await _signup(async_client, "sweep-free")
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    resp = await async_client.get(_SWEEP_PATH, headers=headers)

    body = resp.json()
    assert corpus_backfill.CORPUS_SWEEP_PRICE_UNITS == 0
    assert body["price_units"] == 0
    assert body["estimated_price_units"] == 0
    assert body["wallet_covers"] is True


@pytest.mark.asyncio
async def test_a_non_zero_price_multiplies_by_the_backlog(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``estimated_price_units`` is the price times what is waiting.

    Pinned with a price above one so an implementation that returned the
    backlog, or the price, could not pass by coincidence.
    """
    monkeypatch.setattr(corpus_backfill, "CORPUS_SWEEP_PRICE_UNITS", _PRICED)
    headers, user_id = await _signup(async_client, "sweep-priced")
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    resp = await async_client.get(_SWEEP_PATH, headers=headers)

    body = resp.json()
    assert body["price_units"] == _PRICED
    assert body["estimated_price_units"] == _BACKLOG * _PRICED


@pytest.mark.asyncio
async def test_the_wallet_does_not_cover_a_backlog_beyond_the_allowance(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``wallet_covers`` is false when the estimate exceeds what is available.

    A surface that offered the sweep without this would be offering work the
    wallet is going to stop partway through.
    """
    monkeypatch.setenv("BOTMASON_MONTHLY_CAP", "1")
    monkeypatch.setattr(corpus_backfill, "CORPUS_SWEEP_PRICE_UNITS", _PRICED)
    headers, user_id = await _signup(async_client, "sweep-short")
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    resp = await async_client.get(_SWEEP_PATH, headers=headers)

    body = resp.json()
    assert body["estimated_price_units"] > body["monthly_remaining"] + body["offering_balance"]
    assert body["wallet_covers"] is False


@pytest.mark.asyncio
async def test_the_estimate_dials_no_provider(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pricing the work is not doing it: the classifier is never asked."""

    def forbidden(**_kwargs: object) -> object:
        msg = "the estimate must not dial a provider"
        raise AssertionError(msg)

    monkeypatch.setattr(fc, "generate_response", forbidden)
    headers, user_id = await _signup(async_client, "sweep-no-dial")
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    resp = await async_client.get(_SWEEP_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["entries_pending"] == _BACKLOG


@pytest.mark.asyncio
async def test_consent_is_not_required_to_be_told_what_is_waiting(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Seeing the cost is how somebody decides whether to agree at all.

    Granting consent runs a sweep, so the number this endpoint reports is
    exactly what a prospective yes would reach — withholding it until after the
    yes would put the disclosure after the decision.
    """
    headers, user_id = await _signup(async_client, "sweep-unconsented")
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    resp = await async_client.get(_SWEEP_PATH, headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["entries_pending"] == _BACKLOG


@pytest.mark.asyncio
async def test_a_lapsed_month_is_rolled_over_before_the_allowance_is_quoted(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Last month's spending must not be charged against this month's allowance.

    Without the rollover the raw ``monthly_messages_used`` column still holds a
    spent month, so the remainder is quoted too low and an account is told it
    cannot afford a sweep it can in fact afford. The failure mode is a
    disclosure that talks somebody out of work they have already paid for,
    which is why it is pinned here rather than left to the wallet suite.
    """
    monkeypatch.setattr(corpus_backfill, "CORPUS_SWEEP_PRICE_UNITS", 1)
    headers, user_id = await _signup(async_client, "sweep-lapsed")
    await _entries(db_session, user_id=user_id, count=_BACKLOG)

    cap = get_monthly_cap()
    await db_session.execute(
        update(User)
        .where(col(User.id) == user_id)
        .values(
            monthly_messages_used=cap,
            monthly_reset_date=datetime.now(UTC) - timedelta(days=_A_MONTH_AGO_DAYS),
        )
    )
    await db_session.commit()

    resp = await async_client.get(_SWEEP_PATH, headers=headers)

    body = resp.json()
    assert body["monthly_remaining"] == cap
    assert body["wallet_covers"] is True
