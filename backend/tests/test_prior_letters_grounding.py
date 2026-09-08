"""The egress set behind the ``<prior_letters>`` block (issue #2574).

``_prior_letters_query`` decides which of the letters this app has already
written go back out to the language-model provider as anti-repetition context.
It is a *narrower* set than the Voice Drafts listing, and the difference is the
whole point of this module:

* The listing (``_expanded_drafts_query``) deliberately **includes** drafts
  whose parent entry is Intimate. That is retrieval to the owner of their own
  letter, not egress, and ``routers/journal.py`` says so at the listing route.
* Egress cannot include them. So the Intimate predicate is added **here**, on
  the derived query, and never migrated onto the shared one -- the same shape
  ``services/higher_self_grounding.py`` already uses for entry bodies.

The inheritance runs the other way and matters just as much: owner scope, the
soft-delete filter (BUG-JOURNAL-007) and ``essay IS NOT NULL`` are **not**
restated here, they are inherited by building on ``_expanded_drafts_query``.
:func:`test_the_egress_query_inherits_every_listing_predicate` is what makes
that structural rather than coincidental -- without it, a future rewrite that
re-derives the clauses by hand and drops one would ship silently.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import cast

import pytest
from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import BooleanClauseList

from domain.resonance import PRIOR_DRAFT_CHARS, PRIOR_DRAFT_LIMIT
from models.journal_entry import JournalClassification, JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from routers.journal import _expanded_drafts_query, _prior_letter_essays, _prior_letters_query

_BODY = "I walked by the river and the willow bent without breaking."
_BASE_TIME = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)


async def _seed_user(session: AsyncSession, email: str) -> int:
    """Persist one user and return their id."""
    user = User(email=email, password_hash="not-a-real-hash")
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


async def _seed_entry(
    session: AsyncSession,
    user_id: int,
    *,
    classification: JournalClassification = JournalClassification.PERSONAL,
    deleted: bool = False,
) -> int:
    """Persist one journal entry and return its id."""
    entry = JournalEntry(
        sender="user",
        user_id=user_id,
        message=_BODY,
        classification=classification,
        deleted_at=_BASE_TIME if deleted else None,
    )
    session.add(entry)
    await session.flush()
    assert entry.id is not None
    return entry.id


async def _seed_letter(
    session: AsyncSession, *, user_id: int, entry_id: int, essay: str, minutes: int = 0
) -> None:
    """Persist one expanded margin note carrying ``essay``.

    ``essay_generated_at`` is always set alongside ``essay``: the model carries a
    paired-nullability CHECK over the two, so setting one alone fails with an
    ``IntegrityError`` rather than the clean assertion failure a test wants.
    """
    session.add(
        Marginalia(
            journal_entry_id=entry_id,
            user_id=user_id,
            kind=MarginaliaKind.SYMBOL,
            anchor_start=0,
            anchor_end=6,
            anchor_text="I walk",
            note="A beginning.",
            essay=essay,
            essay_generated_at=_BASE_TIME.replace(minute=minutes),
        )
    )


_UID = 4321
_EXCLUDE = 99


def _where_clauses(query: Select[tuple[Marginalia]]) -> set[str]:
    """Render each top-level WHERE clause of ``query`` independently.

    Per clause rather than as one string: bind parameters are numbered
    positionally, so inserting a predicate ahead of an inherited one would
    change the rendered whole while changing nothing about what is selected.
    """
    whereclause = query.whereclause
    assert whereclause is not None, "the query carries no WHERE clause at all"
    return {str(clause) for clause in cast("BooleanClauseList", whereclause).clauses}


def test_the_egress_query_inherits_every_listing_predicate() -> None:
    """Egress is a strict superset of the Voice-Draft predicate, by construction.

    This is the only test here that fails when the provider stops *inheriting*.
    The behavioural tests below pin what today's implementation does; this one
    pins that it is built by narrowing the single source of truth, so a rewrite
    starting from a fresh ``select(Marginalia)`` with its own hand-copied
    clauses reddens here even when every one of them happens to be right.

    Compared per clause rather than as one rendered string: ``.where()`` appends
    and bind parameters are numbered positionally, so inserting an egress
    predicate ahead of an inherited one would break a substring comparison while
    changing nothing about what is selected.
    """
    listing = _where_clauses(_expanded_drafts_query(_UID))
    egress = _where_clauses(_prior_letters_query(_UID, _EXCLUDE))
    assert listing <= egress, f"egress lost: {sorted(listing - egress)}"


@pytest.mark.asyncio
async def test_a_letter_on_a_live_personal_entry_is_eligible(db_session: AsyncSession) -> None:
    """The ordinary case: the app's own letter about a live, non-Intimate entry."""
    user_id = await _seed_user(db_session, "eligible@example.com")
    entry_id = await _seed_entry(db_session, user_id)
    other_id = await _seed_entry(db_session, user_id)
    await _seed_letter(db_session, user_id=user_id, entry_id=other_id, essay="A warm letter.")
    await db_session.commit()

    assert await _prior_letter_essays(db_session, user_id=user_id, exclude_entry_id=entry_id) == [
        "A warm letter."
    ]


@pytest.mark.asyncio
async def test_a_letter_about_a_deleted_entry_never_goes_out(db_session: AsyncSession) -> None:
    """Soft deletion withholds the letter, not only the entry (BUG-JOURNAL-007).

    Deletion stamps the entry alone -- marginalia rows survive it -- so a set
    scoped by ``Marginalia.user_id`` would send back out a letter quoting
    writing the account asked to be rid of. The filter is inherited from
    ``_expanded_drafts_query``, which is why it cannot be forgotten here.
    """
    user_id = await _seed_user(db_session, "deleted@example.com")
    entry_id = await _seed_entry(db_session, user_id)
    gone_id = await _seed_entry(db_session, user_id, deleted=True)
    await _seed_letter(db_session, user_id=user_id, entry_id=gone_id, essay="About deleted.")
    await db_session.commit()

    assert await _prior_letter_essays(db_session, user_id=user_id, exclude_entry_id=entry_id) == []


@pytest.mark.asyncio
async def test_a_letter_about_an_intimate_entry_never_goes_out(db_session: AsyncSession) -> None:
    """Reclassifying an entry to Intimate withholds its letter from every later prompt.

    An Intimate entry never has an essay generated, so the pair exists only
    where the entry was reclassified after the fact. That reclassification is
    the account withdrawing this text from the cloud, and it must take effect
    for the letter as well as the body -- the guarantee issue #895 closed for
    entry bodies, evaluated here against the *persisted* tier at query time.
    """
    user_id = await _seed_user(db_session, "intimate@example.com")
    entry_id = await _seed_entry(db_session, user_id)
    private_id = await _seed_entry(
        db_session, user_id, classification=JournalClassification.INTIMATE
    )
    await _seed_letter(db_session, user_id=user_id, entry_id=private_id, essay="About intimate.")
    await db_session.commit()

    assert await _prior_letter_essays(db_session, user_id=user_id, exclude_entry_id=entry_id) == []


@pytest.mark.asyncio
async def test_the_letter_about_the_entry_being_read_is_excluded(
    db_session: AsyncSession,
) -> None:
    """The page in hand is not its own prior context.

    Grounding a fresh reading of an entry against a letter already written about
    that same entry is the one case where anti-repetition context would most
    strongly pull the model into restating itself.
    """
    user_id = await _seed_user(db_session, "exclude@example.com")
    entry_id = await _seed_entry(db_session, user_id)
    await _seed_letter(db_session, user_id=user_id, entry_id=entry_id, essay="About this page.")
    await db_session.commit()

    assert await _prior_letter_essays(db_session, user_id=user_id, exclude_entry_id=entry_id) == []


@pytest.mark.asyncio
async def test_another_accounts_letter_never_goes_out(db_session: AsyncSession) -> None:
    """Tenancy is asserted on the entry's owner as well as the denormalized column."""
    user_id = await _seed_user(db_session, "mine@example.com")
    stranger_id = await _seed_user(db_session, "theirs@example.com")
    entry_id = await _seed_entry(db_session, user_id)
    their_entry = await _seed_entry(db_session, stranger_id)
    await _seed_letter(
        db_session, user_id=stranger_id, entry_id=their_entry, essay="Someone else's letter."
    )
    await db_session.commit()

    assert await _prior_letter_essays(db_session, user_id=user_id, exclude_entry_id=entry_id) == []


@pytest.mark.asyncio
async def test_a_letter_denormalized_to_me_but_hanging_off_anothers_entry_never_goes_out(
    db_session: AsyncSession,
) -> None:
    """The parent entry's owner is authoritative, not the denormalized column.

    ``Marginalia.user_id`` is a denormalized copy whose correctness the model
    explicitly defers to the endpoint layer, so it is the half that can be
    wrong. This is the row that proves the second ownership clause earns its
    place: denormalized to *me*, but hanging off an entry somebody else wrote.
    Scoping on the denormalized column alone would hand a stranger's entry --
    and the letter quoting it -- to my reflection's prompt.

    The sibling test above, where both columns say "stranger", cannot show this:
    the denormalized filter excludes that row on its own, so dropping
    ``JournalEntry.user_id == user_id`` leaves it green.
    """
    user_id = await _seed_user(db_session, "denorm-me@example.com")
    stranger_id = await _seed_user(db_session, "denorm-them@example.com")
    entry_id = await _seed_entry(db_session, user_id)
    their_entry = await _seed_entry(db_session, stranger_id)
    await _seed_letter(
        db_session, user_id=user_id, entry_id=their_entry, essay="Their page, my label."
    )
    await db_session.commit()

    assert await _prior_letter_essays(db_session, user_id=user_id, exclude_entry_id=entry_id) == []


@pytest.mark.asyncio
async def test_only_the_newest_letters_go_out_and_only_that_many(
    db_session: AsyncSession,
) -> None:
    """The bound is the newest ``PRIOR_DRAFT_LIMIT`` letters, newest first.

    The same constant bounds this ``LIMIT`` and the prompt's own slice, so the
    number a reader is promised in the privacy policy is the number that leaves
    on both counts.
    """
    user_id = await _seed_user(db_session, "ordering@example.com")
    entry_id = await _seed_entry(db_session, user_id)
    for index in range(PRIOR_DRAFT_LIMIT + 2):
        other_id = await _seed_entry(db_session, user_id)
        await _seed_letter(
            db_session,
            user_id=user_id,
            entry_id=other_id,
            essay=f"letter-{index}",
            minutes=index,
        )
    await db_session.commit()

    essays = await _prior_letter_essays(db_session, user_id=user_id, exclude_entry_id=entry_id)
    newest = PRIOR_DRAFT_LIMIT + 1
    assert essays == [f"letter-{newest - offset}" for offset in range(PRIOR_DRAFT_LIMIT)]


@pytest.mark.asyncio
async def test_a_long_letter_is_truncated_before_it_leaves(db_session: AsyncSession) -> None:
    """Each letter is capped at ``PRIOR_DRAFT_CHARS`` so the row bound bounds tokens too."""
    user_id = await _seed_user(db_session, "long@example.com")
    entry_id = await _seed_entry(db_session, user_id)
    other_id = await _seed_entry(db_session, user_id)
    await _seed_letter(
        db_session,
        user_id=user_id,
        entry_id=other_id,
        essay="y" * PRIOR_DRAFT_CHARS + "OVERCAP",
    )
    await db_session.commit()

    essays = await _prior_letter_essays(db_session, user_id=user_id, exclude_entry_id=entry_id)
    assert essays == ["y" * PRIOR_DRAFT_CHARS]
