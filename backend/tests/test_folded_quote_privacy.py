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
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from http import HTTPStatus

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.ownership import require_owned_journal_entry
from domain.folded_passages import (
    WITHHELD_MARK,
    carries_passage,
    fold_carries_passage,
    passage_lines,
    span_overlaps_passage,
    withhold_passages,
)
from main import app
from models.journal_entry import EntryStatus, JournalClassification, JournalEntry, JournalTag
from models.marginalia import Marginalia
from models.promoted_quote import PromotedQuote, PromotedQuoteSourceKind
from services.folded_quote_privacy import (
    MAX_FOLD_LEVELS,
    QUOTE_REFUSED_EVENT,
    QUOTE_SOURCE_RESTRICTED,
    egress_bodies,
    egress_body,
    fold_source_admits_egress,
    refuse_unfoldable_quote,
    restricted_folded_passages,
)
from tests.support.lineage_canaries import (
    LETTER_LINE,
    LINEAGE_SENTINEL,
    REVIEW_PROSE,
    folded_blockquote,
    seed_course_quote,
    seed_folded_lineage,
    seed_letter_note,
    seed_letter_quote,
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


def test_a_fold_carries_a_phrase_from_inside_a_line_but_not_a_lone_word() -> None:
    """A word that also appears inside a restricted line is vocabulary, not the passage (#3639)."""
    assert fold_carries_passage(f"before {_KEPT_CLOSE} after", [_KEPT_CLOSE])
    assert fold_carries_passage("never say", [_KEPT_CLOSE])
    assert fold_carries_passage("first\nnever say", [_KEPT_CLOSE])
    assert not fold_carries_passage("never", [_KEPT_CLOSE])
    assert not fold_carries_passage("  aloud \n", [_KEPT_CLOSE])
    assert not fold_carries_passage("thing", ["the thing, I never say"])
    assert not fold_carries_passage("thing.", ["the thing, I never say"])


def test_a_fold_never_releases_less_than_a_whole_word_or_an_unspaced_phrase() -> None:
    """Only a whole word is released: the narrowest rule that still lets a common word through."""
    # A one-word restricted line is still matched whole, so a one-word passage never leaks.
    assert fold_carries_passage("aloud", ["aloud"])
    assert fold_carries_passage("> aloud", ["aloud"])
    # A piece of a word is not a word of the line.
    assert fold_carries_passage("ever", [_KEPT_CLOSE])
    # A script written without spaces has no words to release: any run inside fails closed.
    assert fold_carries_passage("\u4e0d\u8bf4", ["\u6211\u4ece\u6765\u4e0d\u8bf4\u51fa\u53e3"])


def test_the_refusal_gates_still_count_any_fragment() -> None:
    """Refusing an offer costs one quote, not a masked body: the gates keep the strict match."""
    assert carries_passage("never", [_KEPT_CLOSE])
    assert carries_passage("ever s", [_KEPT_CLOSE])


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


async def _set_tier(
    session: AsyncSession, entry: JournalEntry, classification: JournalClassification
) -> None:
    entry.classification = classification
    session.add(entry)
    await session.commit()


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


_PASSED_ALONG = "a Personal passage, passed along"


async def _deep_chain(session: AsyncSession, user_id: int) -> list[int]:
    """A Personal chain one fold longer than the walk may follow, ids from origin to top."""
    upstream = await _entry(session, user_id, _PASSED_ALONG)
    ids = [int(upstream.id or 0)]
    for _ in range(MAX_FOLD_LEVELS + 1):
        downstream = await _entry(session, user_id, _PASSED_ALONG)
        await _fold(session, user_id, upstream, _PASSED_ALONG, int(downstream.id or 0))
        upstream = downstream
        ids.append(int(upstream.id or 0))
    return ids


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
    top = await _deep_chain(db_session, user_id)

    found = await restricted_folded_passages(db_session, user_id=user_id, entry_ids=[top[-1]])

    assert found == {top[-1]: (_PASSED_ALONG,)}


@pytest.mark.asyncio
async def test_a_deep_chain_withholds_only_its_own_folds_in_a_batch(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One over-deep chain no longer masks an unrelated Personal fold beside it (#3639)."""
    _, user_id = await _signup(async_client, "fold_deep_batch")
    deep = (await _deep_chain(db_session, user_id))[-1]
    shallow = await seed_folded_lineage(
        db_session, user_id=user_id, source_classification=JournalClassification.PERSONAL
    )
    shallow_review = await db_session.get(JournalEntry, shallow.review_id)
    assert shallow_review is not None

    found = await restricted_folded_passages(
        db_session, user_id=user_id, entry_ids=[deep, shallow.review_id]
    )
    bodies = await egress_bodies(
        db_session,
        user_id=user_id,
        bodies={deep: _PASSED_ALONG, shallow.review_id: shallow_review.message},
    )

    assert found == {deep: (_PASSED_ALONG,)}
    assert bodies[shallow.review_id] == shallow_review.message
    assert LINEAGE_SENTINEL in bodies[shallow.review_id]
    assert bodies[deep] == WITHHELD_MARK * len(_PASSED_ALONG)


@pytest.mark.asyncio
async def test_an_entry_quoting_into_a_deep_chain_is_withheld_with_it(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Whatever reaches an unresolved fold is ambiguous, so it fails closed beside the chain."""
    _, user_id = await _signup(async_client, "fold_deep_branch")
    chain = await _deep_chain(db_session, user_id)
    below_top = await db_session.get(JournalEntry, chain[-2])
    assert below_top is not None
    branch = await _entry(db_session, user_id, _PASSED_ALONG)
    await _fold(db_session, user_id, below_top, _PASSED_ALONG, int(branch.id or 0))

    found = await restricted_folded_passages(
        db_session, user_id=user_id, entry_ids=[chain[-1], int(branch.id or 0)]
    )

    assert found == {chain[-1]: (_PASSED_ALONG,), int(branch.id or 0): (_PASSED_ALONG,)}


@pytest.mark.asyncio
async def test_a_lone_word_requoted_from_a_review_still_egresses(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A one-word re-quote that also appears inside the review's Intimate line egresses (#3639).

    The control in the same batch: a two-word phrase lifted from inside that
    line is still withheld, as is the Intimate passage in the review itself.
    """
    _, user_id = await _signup(async_client, "fold_lone_word")
    secret = await _entry(db_session, user_id, _KEPT_CLOSE, JournalClassification.INTIMATE)
    review = await _entry(
        db_session, user_id, f"The thing about this week.\n\n{folded_blockquote(_KEPT_CLOSE)}"
    )
    await _fold(db_session, user_id, secret, _KEPT_CLOSE, int(review.id or 0))
    word_body = f"Stage notes.\n\n{folded_blockquote('thing')}\n\nOne more thing."
    word = await _entry(db_session, user_id, word_body)
    await _fold(db_session, user_id, review, "thing", int(word.id or 0))
    phrase_body = f"Stage notes.\n\n{folded_blockquote('never say')}"
    phrase = await _entry(db_session, user_id, phrase_body)
    await _fold(db_session, user_id, review, "never say", int(phrase.id or 0))
    ids = (int(review.id or 0), int(word.id or 0), int(phrase.id or 0))

    bodies = await egress_bodies(
        db_session,
        user_id=user_id,
        bodies={ids[0]: review.message, ids[1]: word_body, ids[2]: phrase_body},
    )

    assert _KEPT_CLOSE not in bodies[ids[0]]
    assert bodies[ids[1]] == word_body
    assert "never say" not in bodies[ids[2]]


# --- egress: a letter quote inherits its entry's tier (#3657) ------------------


@pytest.mark.asyncio
async def test_a_folded_letter_quote_is_withheld_once_its_entry_becomes_intimate(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The fail-open trap: a letter has no tier of its own, so it follows the entry it answered.

    While the entry is Personal the folded letter line goes where the review
    goes; once the entry is made Intimate, the same review sends it withheld.
    Against an egress reader that INNER JOINs a fold onto its source entry, the
    letter quote's row is dropped and its line leaves unmasked.
    """
    _, user_id = await _signup(async_client, "letter_fail_open")
    answered = await _entry(db_session, user_id, "A page the letter answered.")
    note = await seed_letter_note(db_session, user_id=user_id, entry=answered)
    review = await _entry(
        db_session, user_id, f"{REVIEW_PROSE}\n\n{folded_blockquote(LETTER_LINE)}"
    )
    await seed_letter_quote(
        db_session, user_id=user_id, note=note, included_in_entry_id=int(review.id or 0)
    )

    assert await egress_body(db_session, review, review.message) == review.message

    await _set_tier(db_session, answered, JournalClassification.INTIMATE)
    sent = await egress_body(db_session, review, review.message)

    assert LETTER_LINE not in sent
    assert WITHHELD_MARK * len(LETTER_LINE) in sent
    assert sent.startswith(REVIEW_PROSE)


_ENTRY = PromotedQuoteSourceKind.ENTRY.value
_COURSE = PromotedQuoteSourceKind.COURSE.value
_LETTER = PromotedQuoteSourceKind.LETTER.value


@pytest.mark.parametrize(
    ("kind", "entry_tier", "letter_tier", "expected"),
    [
        (_ENTRY, "personal", None, True),
        (_ENTRY, "intimate", None, False),
        (_ENTRY, None, None, False),
        # A letter reads the tier of the entry it answered, never a source entry's.
        (_LETTER, None, "personal", True),
        (_LETTER, None, "intimate", False),
        (_LETTER, "personal", "intimate", False),
        (_LETTER, "personal", None, False),
        # A missing note or answered entry joins as NULL: nothing vouches for it.
        (_LETTER, None, None, False),
        # Published Course text, whatever either join found.
        (_COURSE, None, None, True),
        (_COURSE, "intimate", "intimate", True),
        # Any other kind, or none, fails closed.
        (None, "personal", "personal", False),
        ("ENTRY", "personal", "personal", False),
        ("chapter", "personal", "personal", False),
    ],
)
def test_each_kind_of_fold_reads_the_tier_it_inherits(
    kind: object, entry_tier: object, letter_tier: object, *, expected: bool
) -> None:
    assert fold_source_admits_egress(kind, entry_tier, letter_tier) is expected


@pytest.mark.asyncio
async def test_a_folded_course_quote_always_egresses(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Course text is the program's published text, identical for every reader."""
    _, user_id = await _signup(async_client, "course_egress")
    review = await _entry(
        db_session, user_id, f"{REVIEW_PROSE}\n\n{folded_blockquote(LETTER_LINE)}"
    )
    await seed_course_quote(db_session, user_id=user_id, included_in_entry_id=int(review.id or 0))

    found = await restricted_folded_passages(
        db_session, user_id=user_id, entry_ids=[int(review.id or 0)]
    )

    assert found == {}
    assert await egress_body(db_session, review, review.message) == review.message


@pytest.mark.asyncio
async def test_a_letter_quote_of_a_deleted_intimate_entry_stays_withheld(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The answered entry's tier is read live or soft-deleted; deleting it releases nothing."""
    _, user_id = await _signup(async_client, "letter_deleted_parent")
    answered = await _entry(
        db_session, user_id, "A page made private, then deleted.", JournalClassification.INTIMATE
    )
    note = await seed_letter_note(db_session, user_id=user_id, entry=answered)
    review = await _entry(
        db_session, user_id, f"{REVIEW_PROSE}\n\n{folded_blockquote(LETTER_LINE)}"
    )
    await seed_letter_quote(
        db_session, user_id=user_id, note=note, included_in_entry_id=int(review.id or 0)
    )
    answered.deleted_at = datetime.now(UTC)
    db_session.add(answered)
    await db_session.commit()

    assert LETTER_LINE not in await egress_body(db_session, review, review.message)


@pytest.mark.asyncio
async def test_a_letter_quote_on_another_writers_note_is_withheld(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Only the writer's own note vouches for a letter: a foreign one reads as unknown."""
    _, user_id = await _signup(async_client, "letter_foreign_note")
    _, other_id = await _signup(async_client, "letter_note_owner")
    answered = await _entry(db_session, other_id, "Someone else's Personal page.")
    note = await seed_letter_note(db_session, user_id=user_id, entry=answered, owner_id=other_id)
    review = await _entry(
        db_session, user_id, f"{REVIEW_PROSE}\n\n{folded_blockquote(LETTER_LINE)}"
    )
    await seed_letter_quote(
        db_session, user_id=user_id, note=note, included_in_entry_id=int(review.id or 0)
    )

    assert LETTER_LINE not in await egress_body(db_session, review, review.message)


@contextmanager
def _quote_reads(session: AsyncSession) -> Iterator[list[str]]:
    """Collect every statement ``session``'s engine runs against ``promotedquote``."""
    seen: list[str] = []
    engine = session.get_bind()

    def _record(*args: object) -> None:
        statement = str(args[2])
        if "promotedquote" in statement:
            seen.append(statement)

    event.listen(engine, "before_cursor_execute", _record)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", _record)


@pytest.mark.asyncio
async def test_the_walk_never_follows_a_course_or_letter_source_upstream(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Only an entry source can itself hold folds, so only one is walked to the next level.

    A review holding a Course fold and a letter fold is resolved in one read;
    the control, the same review with an entry fold beside them, takes a
    second read for that entry's own folds.
    """
    _, user_id = await _signup(async_client, "walk_entry_only")
    answered = await _entry(db_session, user_id, "A page the letter answered.")
    note = await seed_letter_note(db_session, user_id=user_id, entry=answered)
    review = await _entry(db_session, user_id, REVIEW_PROSE)
    review_id = int(review.id or 0)
    await seed_letter_quote(db_session, user_id=user_id, note=note, included_in_entry_id=review_id)
    await seed_course_quote(db_session, user_id=user_id, included_in_entry_id=review_id)

    with _quote_reads(db_session) as reading_only:
        await restricted_folded_passages(db_session, user_id=user_id, entry_ids=[review_id])
    upstream = await _entry(db_session, user_id, _PASSED_ALONG)
    await _fold(db_session, user_id, upstream, _PASSED_ALONG, review_id)
    with _quote_reads(db_session) as with_an_entry:
        await restricted_folded_passages(db_session, user_id=user_id, entry_ids=[review_id])

    assert len(reading_only) == 1
    assert len(with_an_entry) == 2


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


# --- fold: each kind answers to the tier it inherits (#3657) ------------------
#
# These replace #3656's pin, which refused every non-entry fold while the egress
# readers still dropped one. The rows are seeded straight into the database: no
# route creates a Course or letter quote yet (#3658).


async def _fold_patch(
    client: AsyncClient, headers: dict[str, str], quote: PromotedQuote, target: JournalEntry
) -> int:
    resp = await client.patch(
        f"/promotions/{quote.id}", json={"included_in_entry_id": target.id}, headers=headers
    )
    if resp.status_code == HTTPStatus.CONFLICT:
        assert resp.json()["detail"] == QUOTE_SOURCE_RESTRICTED
    return resp.status_code


@pytest.mark.asyncio
async def test_folding_a_course_quote_is_allowed(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Published text may always be folded: its tier is ``public``."""
    headers, user_id = await _signup(async_client, "fold_course_quote")
    quote = await seed_course_quote(db_session, user_id=user_id)
    target = await _reflection(db_session, user_id)

    assert await _fold_patch(async_client, headers, quote, target) == HTTPStatus.OK
    await db_session.refresh(quote)
    assert quote.included_in_entry_id == target.id


async def _make_intimate(session: AsyncSession, entry: JournalEntry, _: int) -> None:
    await _set_tier(session, entry, JournalClassification.INTIMATE)


async def _soft_delete(session: AsyncSession, entry: JournalEntry, _: int) -> None:
    entry.deleted_at = datetime.now(UTC)
    session.add(entry)
    await session.commit()


async def _hand_the_note_away(session: AsyncSession, entry: JournalEntry, other_id: int) -> None:
    """The note under the quote is stamped with another account."""
    note = (
        await session.execute(
            select(Marginalia).where(col(Marginalia.journal_entry_id) == entry.id)
        )
    ).scalar_one()
    note.user_id = other_id
    session.add(note)
    await session.commit()


async def _hand_the_entry_away(session: AsyncSession, entry: JournalEntry, other_id: int) -> None:
    """The answered entry belongs to another account while the note stays the writer's."""
    entry.user_id = other_id
    session.add(entry)
    await session.commit()


async def _leave_it_be(session: AsyncSession, entry: JournalEntry, _: int) -> None:
    del session, entry


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("change", "expected"),
    [
        (_leave_it_be, HTTPStatus.OK),
        (_make_intimate, HTTPStatus.CONFLICT),
        (_soft_delete, HTTPStatus.CONFLICT),
        (_hand_the_note_away, HTTPStatus.CONFLICT),
        (_hand_the_entry_away, HTTPStatus.CONFLICT),
    ],
    ids=["personal", "intimate", "deleted", "foreign_note", "foreign_entry"],
)
async def test_folding_a_letter_quote_follows_the_entry_it_answered(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    change: Callable[[AsyncSession, JournalEntry, int], Awaitable[None]],
    expected: HTTPStatus,
) -> None:
    """A letter folds only while its entry is live, the writer's own, and egress-eligible."""
    headers, user_id = await _signup(async_client, f"fold_letter{change.__name__}")
    _, other_id = await _signup(async_client, f"letter_other{change.__name__}")
    answered = await _entry(db_session, user_id, "A Personal page the letter answered.")
    note = await seed_letter_note(db_session, user_id=user_id, entry=answered)
    quote = await seed_letter_quote(db_session, user_id=user_id, note=note)
    target = await _reflection(db_session, user_id)
    await change(db_session, answered, other_id)

    with caplog.at_level(logging.INFO, logger="services.folded_quote_privacy"):
        status = await _fold_patch(async_client, headers, quote, target)

    assert status == expected
    await db_session.refresh(quote)
    refused = expected == HTTPStatus.CONFLICT
    assert (quote.included_in_entry_id is None) is refused
    assert any(r.getMessage() == QUOTE_REFUSED_EVENT for r in caplog.records) is refused


@pytest.mark.asyncio
async def test_folding_a_letter_quote_that_carries_a_restricted_passage_is_refused(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Defence in depth: a letter written before its entry's fold became restricted.

    The letter answered a Personal review that holds an Intimate fold, and it
    quotes that fold's words; a quote of the letter's own other words still folds.
    """
    headers, user_id = await _signup(async_client, "fold_letter_restricted_line")
    chain = await seed_folded_lineage(db_session, user_id=user_id)
    review = await db_session.get(JournalEntry, chain.review_id)
    assert review is not None
    note = await seed_letter_note(db_session, user_id=user_id, entry=review)
    carrying = await seed_letter_quote(
        db_session, user_id=user_id, note=note, text=f"you wrote {LINEAGE_SENTINEL}"
    )
    clean = await seed_letter_quote(db_session, user_id=user_id, note=note)
    target = await _reflection(db_session, user_id)

    assert await _fold_patch(async_client, headers, carrying, target) == HTTPStatus.CONFLICT
    assert await _fold_patch(async_client, headers, clean, target) == HTTPStatus.OK


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["", "ENTRY", "chapter"])
async def test_a_quote_of_no_known_kind_is_never_folded(
    async_client: AsyncClient, db_session: AsyncSession, kind: str
) -> None:
    """A kind nobody placed is refused, even with a Personal entry link beside it.

    A transient row: the kind CHECK keeps such a value out of the table, so it
    can reach the fold door only as a row read some other way.
    """
    _, user_id = await _signup(async_client, f"fold_unknown_kind_{len(kind)}_{kind.lower()}")
    source = await _entry(db_session, user_id, _KEPT_CLOSE)
    quote = PromotedQuote(
        user_id=user_id,
        source_kind=kind,
        source_entry_id=source.id,
        anchor_start=0,
        anchor_end=4,
        anchor_text=_KEPT_CLOSE[:4],
    )

    with pytest.raises(HTTPException) as refused:
        await refuse_unfoldable_quote(db_session, quote)

    assert refused.value.status_code == HTTPStatus.CONFLICT
    assert refused.value.detail == QUOTE_SOURCE_RESTRICTED


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [PromotedQuoteSourceKind.ENTRY, PromotedQuoteSourceKind.LETTER])
async def test_a_quote_missing_its_own_kinds_link_is_never_folded(
    async_client: AsyncClient, db_session: AsyncSession, kind: PromotedQuoteSourceKind
) -> None:
    """An entry quote with no source entry, or a letter quote with no note, vouches for nothing.

    A transient row: the kind/link CHECK keeps either out of the table, so it
    can reach the fold door only as a row read some other way.
    """
    _, user_id = await _signup(async_client, f"fold_unlinked_{kind.value}")
    quote = PromotedQuote(
        user_id=user_id,
        source_kind=kind,
        anchor_start=0,
        anchor_end=4,
        anchor_text=_KEPT_CLOSE[:4],
    )

    with pytest.raises(HTTPException) as refused:
        await refuse_unfoldable_quote(db_session, quote)

    assert refused.value.status_code == HTTPStatus.CONFLICT
    assert refused.value.detail == QUOTE_SOURCE_RESTRICTED
