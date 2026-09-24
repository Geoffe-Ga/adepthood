"""A triage row's primary key is read through one helper that refuses to guess.

``report.id or 0`` turned a row that was never flushed into report ``0``: a
cycle check over the wrong node, a draft that quietly lists no notes, a detail
page with nobody's history. :func:`persisted_id` raises instead, so the
impossible case is loud rather than plausible.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from models.feedback_triage import FeedbackNote
from services.feedback_triage import PersistedIdMissingError, persisted_id
from tests.helpers.feedback_triage import make_account, seed_report


def test_a_row_that_was_never_flushed_is_refused_not_read_as_zero() -> None:
    """No id means an error, never ``0``."""
    note = FeedbackNote(report_id=1, author_admin_id=1, body="unsaved")

    with pytest.raises(PersistedIdMissingError, match="FeedbackNote"):
        persisted_id(note)


@pytest.mark.asyncio
async def test_a_stored_row_yields_its_own_key(db_session: AsyncSession) -> None:
    """A flushed row gives back exactly the key the database assigned."""
    account = await make_account(db_session, "persisted-id@example.com")
    report = await seed_report(db_session, account.user_id)

    assert report.id is not None
    assert persisted_id(report) == report.id
