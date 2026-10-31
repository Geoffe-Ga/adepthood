"""Intimate text is excluded from folded quotes (#3059, owner decision R5-2).

Three doors: a quote of restricted text cannot be created, cannot be folded,
and -- where a review already holds one -- its text is withheld from every
body that egresses. The sink side is driven end to end in
``tests/test_privacy_lineage.py``; this file pins the pure matcher, the
resolver, and the two refusals, each beside a control that shows the same
request succeeds when the source may egress.
"""

from __future__ import annotations

import logging
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.ownership import require_owned_journal_entry
from domain.folded_passages import (
    WITHHELD_MARK,
    carries_passage,
    passage_lines,
    span_overlaps_passage,
    withhold_passages,
)
from main import app
from models.journal_entry import EntryStatus, JournalClassification, JournalEntry, JournalTag
from models.promoted_quote import PromotedQuote
from services.folded_quote_privacy import (
    MAX_FOLD_LEVELS,
    QUOTE_REFUSED_EVENT,
    QUOTE_SOURCE_RESTRICTED,
    egress_bodies,
    restricted_folded_passages,
)
from tests.support.lineage_canaries import (
    LINEAGE_SENTINEL,
    REVIEW_PROSE,
    folded_blockquote,
    seed_folded_lineage,
)

_KEPT_CLOSE = "the thing I never say aloud"


# --- the pure matcher ----------------------------------------------------------


def test_withholding_replaces_a_spliced_multi_line_blockquote() -> None:
    passage = f"first {_KEPT_CLOSE}\nsecond line too"
    body = f"{REVIEW_PROSE}\n\n{folded_blockquote(passage)}\n\nAfter."

    withheld = withhold_passages(body, [passage])

    assert _KEPT_CLOSE not in withheld
    assert "second line too" not in withheld
    assert WITHHELD_MARK * len("second line too") in withheld
    assert withheld.startswith(REVIEW_PROSE)
    assert withheld.endswith("After.")


def test_withholding_keeps_every_offset_outside_the_passage() -> None:
    """Anchors a model quotes back are offsets into the sent body; they must fit the real one."""
    body = f"Before. {_KEPT_CLOSE}. After the passage."
    withheld = withhold_passages(body, [_KEPT_CLOSE])

    assert len(withheld) == len(body)
    after = body.index("After")
    assert withheld[after:] == body[after:]
    assert withheld[: body.index(_KEPT_CLOSE)] == body[: body.index(_KEPT_CLOSE)]


def test_withholding_nothing_returns_the_body_unchanged() -> None:
    assert withhold_passages(REVIEW_PROSE, []) == REVIEW_PROSE
    assert withhold_passages(REVIEW_PROSE, ["  \n "]) == REVIEW_PROSE


def test_every_occurrence_is_withheld_not_only_the_fold() -> None:
    body = f"{_KEPT_CLOSE}. And again: {_KEPT_CLOSE}."

    assert _KEPT_CLOSE not in withhold_passages(body, [_KEPT_CLOSE])


def test_a_longer_line_is_withheld_whole_before_a_shorter_one_inside_it() -> None:
    assert passage_lines(["ab", "xxabyy"]) == ("xxabyy", "ab")
    assert withhold_passages("xxabyy", ["ab", "xxabyy"]) == WITHHELD_MARK * len("xxabyy")


def test_carries_passage_sees_a_whole_line_and_a_quote_from_inside_one() -> None:
    assert carries_passage(f"before {_KEPT_CLOSE} after", [_KEPT_CLOSE])
    assert carries_passage("never say", [_KEPT_CLOSE])
    assert not carries_passage("something else entirely", [_KEPT_CLOSE])
    assert not carries_passage("anything", [])


def test_span_overlap_is_half_open_on_both_edges() -> None:
    body = f"abc {_KEPT_CLOSE} xyz"
    start = body.index(_KEPT_CLOSE)
    end = start + len(_KEPT_CLOSE)

    assert span_overlaps_passage(body, start - 2, start + 1, [_KEPT_CLOSE])
    assert span_overlaps_passage(body, end - 1, end + 2, [_KEPT_CLOSE])
    assert not span_overlaps_passage(body, 0, start, [_KEPT_CLOSE])
    assert not span_overlaps_passage(body, end, len(body), [_KEPT_CLOSE])


# --- the resolver --------------------------------------------------------------


async def _entry(
    session: AsyncSession,
    user_id: int,
    message: str,
    classification: JournalClassification = JournalClassification.PERSONAL,
    **overrides: object,
) -> JournalEntry:
    entry = JournalEntry(
        user_id=user_id,
        message=message,
        sender="user",
        status=EntryStatus.FINISHED,
        classification=classification,
        **overrides,
    )
    session.add(entry)
    await session.commit()
    await session.refresh(entry)
    return entry


async def _fold(
    session: AsyncSession, user_id: int, source: JournalEntry, text: str, target_id: int | None
) -> PromotedQuote:
    start = source.message.index(text)
    quote = PromotedQuote(
        user_id=user_id,
        source_entry_id=int(source.id or 0),
        anchor_start=start,
        anchor_end=start + len(text),
        anchor_text=text,
        included_in_entry_id=target_id,
    )
    session.add(quote)
    await session.commit()
    await session.refresh(quote)
    return quote


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    return {"Authorization": f"Bearer {payload['token']}"}, int(payload["user_id"])


@pytest.mark.asyncio
async def test_resolver_names_only_folds_from_a_restricted_source(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    _, user_id = await _signup(async_client, "fold_resolver")
    restricted = await seed_folded_lineage(db_session, user_id=user_id)
    allowed = await seed_folded_lineage(
        db_session, user_id=user_id, source_classification=JournalClassification.PERSONAL
    )

    found = await restricted_folded_passages(
        db_session, user_id=user_id, entry_ids=[restricted.review_id, allowed.review_id]
    )

    assert found == {restricted.review_id: (LINEAGE_SENTINEL,)}


@pytest.mark.asyncio
async def test_resolver_is_scoped_to_the_writers_own_quotes(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    _, owner_id = await _signup(async_client, "fold_owner")
    _, other_id = await _signup(async_client, "fold_other")
    chain = await seed_folded_lineage(db_session, user_id=owner_id)

    assert (
        await restricted_folded_passages(db_session, user_id=other_id, entry_ids=[chain.review_id])
        == {}
    )
    assert await restricted_folded_passages(db_session, user_id=owner_id, entry_ids=[]) == {}


@pytest.mark.asyncio
async def test_a_quote_of_a_quote_inherits_the_restriction(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A week review's Intimate fold, re-quoted into a stage review, is withheld there too."""
    _, user_id = await _signup(async_client, "fold_transitive")
    week = await seed_folded_lineage(db_session, user_id=user_id)
    week_review = await db_session.get(JournalEntry, week.review_id)
    assert week_review is not None
    stage_body = f"Stage thoughts.\n\n{folded_blockquote(LINEAGE_SENTINEL)}"
    stage = await _entry(db_session, user_id, stage_body)
    await _fold(db_session, user_id, week_review, LINEAGE_SENTINEL, int(stage.id or 0))

    bodies = await egress_bodies(
        db_session, user_id=user_id, bodies={int(stage.id or 0): stage.message}
    )

    assert LINEAGE_SENTINEL not in bodies[int(stage.id or 0)]

    source = await db_session.get(JournalEntry, week.source_id)
    assert source is not None
    source.classification = JournalClassification.PERSONAL
    db_session.add(source)
    await db_session.commit()
    again = await egress_bodies(
        db_session, user_id=user_id, bodies={int(stage.id or 0): stage.message}
    )
    assert LINEAGE_SENTINEL in again[int(stage.id or 0)]


@pytest.mark.asyncio
async def test_a_self_quoting_review_is_not_a_restriction(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A cycle in the fold graph terminates, and a Personal self-quote stays sendable."""
    _, user_id = await _signup(async_client, "fold_cycle")
    review = await _entry(db_session, user_id, f"{REVIEW_PROSE} Mine to keep.")
    await _fold(db_session, user_id, review, "Mine to keep.", int(review.id or 0))

    found = await restricted_folded_passages(
        db_session, user_id=user_id, entry_ids=[int(review.id or 0)]
    )

    assert found == {}


@pytest.mark.asyncio
async def test_a_fold_chain_past_the_level_cap_fails_closed(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Every fold of a chain longer than the walk may follow is treated as restricted."""
    _, user_id = await _signup(async_client, "fold_deep")
    text = "a Personal passage, passed along"
    upstream = await _entry(db_session, user_id, text)
    for _ in range(MAX_FOLD_LEVELS + 1):
        downstream = await _entry(db_session, user_id, text)
        await _fold(db_session, user_id, upstream, text, int(downstream.id or 0))
        upstream = downstream

    found = await restricted_folded_passages(
        db_session, user_id=user_id, entry_ids=[int(upstream.id or 0)]
    )

    assert found == {int(upstream.id or 0): (text,)}


# --- creation: promote ---------------------------------------------------------


async def _quote_count(session: AsyncSession, entry_id: int) -> int:
    rows = await session.execute(
        select(PromotedQuote).where(col(PromotedQuote.source_entry_id) == entry_id)
    )
    return len(rows.scalars().all())


@pytest.mark.asyncio
async def test_promoting_from_an_intimate_entry_is_refused_and_stores_nothing(
    async_client: AsyncClient, db_session: AsyncSession, caplog: pytest.LogCaptureFixture
) -> None:
    headers, user_id = await _signup(async_client, "promote_intimate")
    entry = await _entry(db_session, user_id, _KEPT_CLOSE, JournalClassification.INTIMATE)

    with caplog.at_level(logging.INFO):
        resp = await async_client.post(
            f"/journal/{entry.id}/promote",
            json={"anchor_start": 0, "anchor_end": 5},
            headers=headers,
        )

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == QUOTE_SOURCE_RESTRICTED
    assert await _quote_count(db_session, int(entry.id or 0)) == 0
    refusals = [r for r in caplog.records if r.getMessage() == QUOTE_REFUSED_EVENT]
    assert len(refusals) == 1
    for record in caplog.records:
        assert _KEPT_CLOSE[:5] not in str(record.__dict__)


@pytest.mark.asyncio
async def test_promoting_from_a_personal_entry_still_works(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The control: the identical request on a Personal entry is a 201."""
    headers, user_id = await _signup(async_client, "promote_personal")
    entry = await _entry(db_session, user_id, _KEPT_CLOSE)

    resp = await async_client.post(
        f"/journal/{entry.id}/promote",
        json={"anchor_start": 0, "anchor_end": 5},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.CREATED, resp.text


@pytest.mark.asyncio
@pytest.mark.parametrize("tier", ["", "INTIMATE", "secret"])
async def test_an_unknown_tier_fails_closed(
    async_client: AsyncClient, db_session: AsyncSession, tier: str
) -> None:
    """A tier the allowlist does not name is refused like Intimate (read off the row)."""
    headers, user_id = await _signup(async_client, f"promote_unknown_{len(tier)}")
    entry = await _entry(db_session, user_id, _KEPT_CLOSE)

    async def _odd_tier() -> JournalEntry:
        # A transient copy: the CHECK constraint keeps an unknown tier out of
        # the table, so it can only reach the route as a row read some other way.
        return JournalEntry(
            id=entry.id,
            user_id=user_id,
            message=entry.message,
            sender="user",
            status=EntryStatus.FINISHED,
            classification=tier,
        )

    app.dependency_overrides[require_owned_journal_entry] = _odd_tier
    try:
        resp = await async_client.post(
            f"/journal/{entry.id}/promote",
            json={"anchor_start": 0, "anchor_end": 5},
            headers=headers,
        )
    finally:
        app.dependency_overrides.pop(require_owned_journal_entry, None)

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == QUOTE_SOURCE_RESTRICTED


@pytest.mark.asyncio
async def test_promoting_a_span_over_a_restricted_fold_is_refused(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A Personal review's own words promote; its folded Intimate passage does not."""
    headers, user_id = await _signup(async_client, "promote_over_fold")
    chain = await seed_folded_lineage(db_session, user_id=user_id)
    review = await db_session.get(JournalEntry, chain.review_id)
    assert review is not None
    start = review.message.index(LINEAGE_SENTINEL)

    over = await async_client.post(
        f"/journal/{chain.review_id}/promote",
        json={"anchor_start": start - 2, "anchor_end": start + 3},
        headers=headers,
    )
    own = await async_client.post(
        f"/journal/{chain.review_id}/promote",
        json={"anchor_start": 0, "anchor_end": len("Some personal")},
        headers=headers,
    )

    assert over.status_code == HTTPStatus.CONFLICT
    assert over.json()["detail"] == QUOTE_SOURCE_RESTRICTED
    assert own.status_code == HTTPStatus.CREATED, own.text


# --- creation: fold ------------------------------------------------------------


async def _reflection(session: AsyncSession, user_id: int) -> JournalEntry:
    return await _entry(
        session,
        user_id,
        "A review in progress.",
        tag=JournalTag.HIERARCHICAL_REFLECTION,
        reflection_level="week",
        reflection_scope_key="c1:w1",
    )


@pytest.mark.asyncio
async def test_folding_a_quote_whose_source_became_intimate_is_refused(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client, "fold_after_reclassify")
    source = await _entry(db_session, user_id, _KEPT_CLOSE)
    quote = await _fold(db_session, user_id, source, _KEPT_CLOSE, None)
    target = await _reflection(db_session, user_id)
    patched = await async_client.patch(
        f"/journal/{source.id}", json={"classification": "intimate"}, headers=headers
    )
    assert patched.status_code == HTTPStatus.OK, patched.text

    resp = await async_client.patch(
        f"/promotions/{quote.id}", json={"included_in_entry_id": target.id}, headers=headers
    )

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == QUOTE_SOURCE_RESTRICTED
    await db_session.refresh(quote)
    assert quote.included_in_entry_id is None


@pytest.mark.asyncio
async def test_a_refused_fold_can_still_be_returned_to_pending(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Unfolding sends nothing anywhere, so it is never refused."""
    headers, user_id = await _signup(async_client, "unfold_restricted")
    chain = await seed_folded_lineage(db_session, user_id=user_id)

    resp = await async_client.patch(
        f"/promotions/{chain.quote_id}", json={"included_in_entry_id": None}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["pending"] is True


@pytest.mark.asyncio
async def test_folding_a_personal_quote_still_works(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The control for the refusal: same flow, source left Personal."""
    headers, user_id = await _signup(async_client, "fold_personal")
    source = await _entry(db_session, user_id, _KEPT_CLOSE)
    quote = await _fold(db_session, user_id, source, _KEPT_CLOSE, None)
    target = await _reflection(db_session, user_id)

    resp = await async_client.patch(
        f"/promotions/{quote.id}", json={"included_in_entry_id": target.id}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["pending"] is False


@pytest.mark.asyncio
async def test_folding_a_requote_of_a_restricted_passage_is_refused(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A quote of a Personal review is refused when its words are that review's Intimate fold."""
    headers, user_id = await _signup(async_client, "fold_requote")
    chain = await seed_folded_lineage(db_session, user_id=user_id)
    review = await db_session.get(JournalEntry, chain.review_id)
    assert review is not None
    requote = await _fold(db_session, user_id, review, LINEAGE_SENTINEL, None)
    target = await _reflection(db_session, user_id)

    resp = await async_client.patch(
        f"/promotions/{requote.id}", json={"included_in_entry_id": target.id}, headers=headers
    )

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == QUOTE_SOURCE_RESTRICTED
