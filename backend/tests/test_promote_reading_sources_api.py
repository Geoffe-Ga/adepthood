"""Promoting a passage of a Course chapter or of a Resonance Letter (#3658, epic #3655).

``POST /course/content/{content_id}/promote`` and
``POST /journal/marginalia/{marginalia_id}/letter/promote`` slice a span of what
the reader is reading server-side, exactly as ``POST /journal/{entry_id}/promote``
does for an entry, and the two ``GET .../promotions`` routes rehydrate a source's
highlights. Each route resolves its source through the gate the source's own
read route applies: the Course body gate (BUG-COURSE-004) for a chapter, the
margin-note scope and demo visibility for a letter.

A letter has no tier of its own: it inherits its parent entry's, so a letter on
an entry that may not egress refuses to become a quote. Course text is published,
so its quotes carry no tier at all.

Cross-tenant regressions for these routes live in ``tests/security/test_idor.py``.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from pathlib import Path
from typing import Final

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from content_config import content_ref
from domain.resonance import ESSAY_MAX
from models.course_stage import CourseStage
from models.journal_entry import JournalClassification, JournalEntry
from models.journal_withdrawal_obligation import (
    JournalWithdrawalObligation,
    JournalWithdrawalState,
)
from models.marginalia import Marginalia, MarginaliaSource
from models.promoted_quote import (
    PROMOTED_QUOTE_SOURCE_TITLE_MAX,
    PROMOTED_QUOTE_TEXT_MAX,
    PromotedQuote,
    PromotedQuoteSourceKind,
)
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from schemas.journal import JOURNAL_MESSAGE_MAX_LENGTH
from schemas.promotion import COURSE_CHAPTER_OFFSET_MAX
from services.content_repository import (
    ContentRepository,
    reset_content_repository_for_tests,
    set_content_repository_for_tests,
)
from services.folded_quote_privacy import QUOTE_SOURCE_RESTRICTED, refuse_unquotable_letter_span
from tests.test_promotions_api import _seed_entry, _seed_letter, _seed_quote, _seed_review, _signup
from tests.test_stored_demo_hidden import run_as_deployed

_VENDORED_CONTENT_DIR: Final = Path(__file__).resolve().parents[1] / "content"

# ── Course fixtures ──────────────────────────────────────────────────────

_CHAPTER_ID: Final = "red-1"
_CHAPTER_PATH: Final = "markdown/03-red/01-power.md"
_CHAPTER_TITLE: Final = "Self-Love as Power"
_CHAPTER_PROSE: Final = "Self-love is not selfishness. Power is a verb."
_CHAPTER_PHRASE: Final = "Power is a verb"

# Frontmatter the body endpoint strips; offsets index the body *after* it.
_FRONTMATTER: Final = "---\ntitle: Self-Love as Power\nstage: 3\n---\n"

# A stage the caller has not reached is locked; the chapter in it is masked.
_LOCKED_STAGE_NUMBER: Final = 2

_STAGE_FIELDS: Final[dict[str, str]] = {
    "subtitle": "Self-Love",
    "overview_url": "https://example.com/red",
    "category": "test",
    "aspect": "test-aspect",
    "spiral_dynamics_color": "red",
    "growing_up_stage": "magic",
    "divine_gender_polarity": "masculine",
    "relationship_to_free_will": "active",
    "free_will_description": "Self-Love",
}


@dataclass(frozen=True)
class _Shelf:
    """A vendored-content stand-in holding one chapter, wired into the repository."""

    root: Path

    def publish(self, markdown: str, *, title: str = _CHAPTER_TITLE) -> None:
        """Ship ``markdown`` as the one chapter :data:`_CHAPTER_ID` of the content pin."""
        self.root.mkdir(parents=True, exist_ok=True)
        manifest = {
            "schema_version": "1.1.0",
            "chapters": [
                {
                    "id": _CHAPTER_ID,
                    "stage": 1,
                    "chapter": 1,
                    "slug": "power",
                    "title": title,
                    "content_type": "chapter",
                    "release_day": 0,
                    "order": 1,
                    "path": _CHAPTER_PATH,
                }
            ],
            "site_resources": [],
        }
        (self.root / "manifest.json").write_text(json.dumps(manifest))
        chapter = self.root / _CHAPTER_PATH
        chapter.parent.mkdir(parents=True, exist_ok=True)
        chapter.write_text(markdown)
        set_content_repository_for_tests(ContentRepository(self.root))

    def tear(self) -> None:
        """Delete the chapter's Markdown file while the manifest still lists it."""
        (self.root / _CHAPTER_PATH).unlink()


@pytest.fixture
def shelf(tmp_path: Path) -> Iterator[_Shelf]:
    """An empty shelf; the repository singleton is reset afterwards."""
    yield _Shelf(tmp_path / "content")
    reset_content_repository_for_tests()


async def _seed_chapter(
    db_session: AsyncSession,
    user_id: int,
    *,
    title: str = _CHAPTER_TITLE,
    stage_number: int = 1,
    url: str = content_ref(_CHAPTER_ID),
) -> StageContent:
    """A chapter row released to ``user_id`` unless its stage is one they have not reached."""
    stage = CourseStage(title="Stage", stage_number=stage_number, **_STAGE_FIELDS)
    db_session.add(stage)
    await db_session.flush()
    assert stage.id is not None
    chapter = StageContent(
        course_stage_id=stage.id,
        title=title,
        content_type="chapter",
        release_day=0,
        url=url,
    )
    db_session.add(chapter)
    db_session.add(
        StageProgress(
            user_id=user_id,
            current_stage=1,
            completed_stages=[],
            stage_started_at=datetime.now(UTC) - timedelta(days=1),
        )
    )
    await db_session.commit()
    await db_session.refresh(chapter)
    return chapter


def _course_promote(content_id: int | None) -> str:
    return f"/course/content/{content_id}/promote"


def _course_promotions(content_id: int | None) -> str:
    return f"/course/content/{content_id}/promotions"


def _letter_promote(marginalia_id: int | None) -> str:
    return f"/journal/marginalia/{marginalia_id}/letter/promote"


def _letter_promotions(marginalia_id: int | None) -> str:
    return f"/journal/marginalia/{marginalia_id}/letter/promotions"


def _span(body: str, phrase: str) -> dict[str, int]:
    """The code-point offsets of ``phrase``'s first occurrence in ``body``."""
    start = body.index(phrase)
    return {"anchor_start": start, "anchor_end": start + len(phrase)}


async def _quote_count(db_session: AsyncSession) -> int:
    """Every ``promotedquote`` row, read from storage rather than the identity map."""
    query = select(func.count()).select_from(PromotedQuote)
    return int((await db_session.execute(query)).scalar_one())


async def _stored_quote(db_session: AsyncSession, quote_id: int) -> PromotedQuote:
    """The persisted row behind a response, read from storage."""
    result = await db_session.execute(
        select(PromotedQuote)
        .where(col(PromotedQuote.id) == quote_id)
        .execution_options(populate_existing=True)
    )
    return result.scalars().one()


# ── POST /course/content/{content_id}/promote ────────────────────────────


@pytest.mark.asyncio
async def test_course_promote_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.post(_course_promote(1), json={"anchor_start": 0, "anchor_end": 4})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_course_promote_slices_the_body_the_body_endpoint_returns(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """Offsets index ``body_markdown`` exactly as ``GET .../body`` serves it: frontmatter gone."""
    headers, user_id = await _signup(async_client, db_session)
    shelf.publish(f"{_FRONTMATTER}# Power\n\n{_CHAPTER_PROSE}\n")
    chapter = await _seed_chapter(db_session, user_id)
    body = await async_client.get(f"/course/content/{chapter.id}/body", headers=headers)
    assert body.status_code == HTTPStatus.OK, body.text
    markdown = body.json()["body_markdown"]
    assert "title:" not in markdown

    resp = await async_client.post(
        _course_promote(chapter.id), json=_span(markdown, _CHAPTER_PHRASE), headers=headers
    )

    assert resp.status_code == HTTPStatus.CREATED, resp.text
    data = resp.json()
    assert data["anchor_text"] == _CHAPTER_PHRASE
    assert data["source_kind"] == PromotedQuoteSourceKind.COURSE.value
    assert data["source_content_id"] == chapter.id
    assert data["source_entry_id"] is None
    assert data["source_marginalia_id"] is None
    assert data["pending"] is True
    assert data["stale"] is False
    assert "user_id" not in data
    stored = await _stored_quote(db_session, data["id"])
    assert stored.user_id == user_id
    assert stored.source_title == _CHAPTER_TITLE


@pytest.mark.asyncio
async def test_course_promote_offsets_are_code_points(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """An emoji before the phrase counts as one offset, as it does for an entry."""
    headers, user_id = await _signup(async_client, db_session)
    shelf.publish(f"🔥 {_CHAPTER_PROSE}")
    chapter = await _seed_chapter(db_session, user_id)

    resp = await async_client.post(
        _course_promote(chapter.id),
        json=_span(f"🔥 {_CHAPTER_PROSE}", "Self-love"),
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.CREATED, resp.text
    assert resp.json()["anchor_start"] == len("🔥 ")
    assert resp.json()["anchor_text"] == "Self-love"


@pytest.mark.asyncio
async def test_course_promote_reaches_past_the_journal_entry_bound(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """A chapter longer than any entry can hold is quotable to its end (the course bound)."""
    headers, user_id = await _signup(async_client, db_session)
    markdown = f"{'a' * (JOURNAL_MESSAGE_MAX_LENGTH + 2_000)} {_CHAPTER_PHRASE}"
    shelf.publish(markdown)
    chapter = await _seed_chapter(db_session, user_id)
    span = _span(markdown, _CHAPTER_PHRASE)
    assert span["anchor_start"] > JOURNAL_MESSAGE_MAX_LENGTH

    resp = await async_client.post(_course_promote(chapter.id), json=span, headers=headers)

    assert resp.status_code == HTTPStatus.CREATED, resp.text
    assert resp.json()["anchor_text"] == _CHAPTER_PHRASE


@pytest.mark.asyncio
async def test_course_promote_rejects_an_offset_past_the_course_bound_422(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """The schema bounds a chapter offset by the course bound, before any read."""
    headers, user_id = await _signup(async_client, db_session)
    shelf.publish(_CHAPTER_PROSE)
    chapter = await _seed_chapter(db_session, user_id)

    resp = await async_client.post(
        _course_promote(chapter.id),
        json={"anchor_start": 0, "anchor_end": COURSE_CHAPTER_OFFSET_MAX + 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert await _quote_count(db_session) == 0


def test_every_vendored_chapter_fits_the_course_offset_bound() -> None:
    """Every chapter the content pin ships can be quoted to its last code point.

    The journal-entry bound does not cover them (the longest vendored chapter
    runs past it), which is why a chapter offset has a bound of its own. A
    content pin that ships a chapter longer than that bound fails here first.
    """
    repository = ContentRepository(_VENDORED_CONTENT_DIR)
    lengths = {
        chapter.id: len(repository.read_body(chapter.id).body)
        for chapter in repository.list_chapters()
    }
    assert lengths, "no vendored chapters were read -- this guard is vacuous"
    too_long = {
        chapter: length for chapter, length in lengths.items() if length > COURSE_CHAPTER_OFFSET_MAX
    }
    assert not too_long


def test_the_letter_offset_bound_covers_the_longest_letter() -> None:
    """A letter is capped at ``ESSAY_MAX``, so the entry bound the letter route reuses covers it."""
    assert ESSAY_MAX <= JOURNAL_MESSAGE_MAX_LENGTH


@pytest.mark.asyncio
async def test_course_promote_truncates_the_title_snapshot_to_its_column(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """``StageContent.title`` is unbounded; the snapshot keeps what its column holds."""
    headers, user_id = await _signup(async_client, db_session)
    long_title = "T" * (PROMOTED_QUOTE_SOURCE_TITLE_MAX + 50)
    shelf.publish(_CHAPTER_PROSE, title=long_title)
    chapter = await _seed_chapter(db_session, user_id, title=long_title)

    resp = await async_client.post(
        _course_promote(chapter.id), json=_span(_CHAPTER_PROSE, "Power"), headers=headers
    )

    assert resp.status_code == HTTPStatus.CREATED, resp.text
    stored = await _stored_quote(db_session, resp.json()["id"])
    assert stored.source_title == long_title[:PROMOTED_QUOTE_SOURCE_TITLE_MAX]


@pytest.mark.asyncio
async def test_course_promote_rejects_a_span_past_the_body_422(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """An end past the served body is ``anchor_out_of_range`` and stores nothing."""
    headers, user_id = await _signup(async_client, db_session)
    shelf.publish(_CHAPTER_PROSE)
    chapter = await _seed_chapter(db_session, user_id)

    resp = await async_client.post(
        _course_promote(chapter.id),
        json={"anchor_start": 0, "anchor_end": len(_CHAPTER_PROSE) + 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "anchor_out_of_range"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_course_promote_rejects_a_span_over_the_quote_cap_422(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """A span longer than a quote may hold is ``quote_too_long`` and stores nothing."""
    headers, user_id = await _signup(async_client, db_session)
    markdown = "w" * (PROMOTED_QUOTE_TEXT_MAX + 10)
    shelf.publish(markdown)
    chapter = await _seed_chapter(db_session, user_id)

    resp = await async_client.post(
        _course_promote(chapter.id),
        json={"anchor_start": 0, "anchor_end": PROMOTED_QUOTE_TEXT_MAX + 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "quote_too_long"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_course_promote_masks_a_locked_chapter_as_missing_404(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """A chapter in a stage not yet reached reads exactly like one that never existed."""
    headers, user_id = await _signup(async_client, db_session)
    shelf.publish(_CHAPTER_PROSE)
    locked = await _seed_chapter(db_session, user_id, stage_number=_LOCKED_STAGE_NUMBER)
    span = _span(_CHAPTER_PROSE, "Power")

    locked_resp = await async_client.post(_course_promote(locked.id), json=span, headers=headers)
    missing_resp = await async_client.post(_course_promote(999_999), json=span, headers=headers)

    assert locked_resp.status_code == missing_resp.status_code == HTTPStatus.NOT_FOUND
    assert locked_resp.json() == missing_resp.json() == {"detail": "content_not_found"}
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_course_promote_masks_a_row_with_no_local_body_404(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """A legacy row whose url is not a ``content://`` reference has no body to quote."""
    headers, user_id = await _signup(async_client, db_session)
    shelf.publish(_CHAPTER_PROSE)
    legacy = await _seed_chapter(db_session, user_id, url="https://cms.example.com/red-1")

    resp = await async_client.post(
        _course_promote(legacy.id), json=_span(_CHAPTER_PROSE, "Power"), headers=headers
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "content_not_found"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_course_promote_502_when_the_chapter_file_is_missing(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """A manifest-listed chapter with no file is a server fault, as on the body route."""
    headers, user_id = await _signup(async_client, db_session)
    shelf.publish(_CHAPTER_PROSE)
    chapter = await _seed_chapter(db_session, user_id)
    shelf.tear()

    resp = await async_client.post(
        _course_promote(chapter.id), json=_span(_CHAPTER_PROSE, "Power"), headers=headers
    )

    assert resp.status_code == HTTPStatus.BAD_GATEWAY
    assert resp.json()["detail"] == "content_unavailable"
    assert await _quote_count(db_session) == 0


# ── GET /course/content/{content_id}/promotions ─────────────────────────


@pytest.mark.asyncio
async def test_course_promotions_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.get(_course_promotions(1))
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_course_promotions_lists_the_callers_quotes_of_that_chapter_in_anchor_order(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """Every status, by ``(anchor_start, id)``; other chapters' and readers' quotes stay out."""
    headers, user_id = await _signup(async_client, db_session)
    _other_headers, other_id = await _signup(async_client, db_session, username="bob")
    shelf.publish(_CHAPTER_PROSE)
    chapter = await _seed_chapter(db_session, user_id)
    other_chapter = StageContent(
        course_stage_id=chapter.course_stage_id,
        title="Another chapter",
        content_type="chapter",
        release_day=0,
        url=content_ref("red-2"),
    )
    db_session.add(other_chapter)
    await db_session.commit()
    review = await _seed_review(db_session, user_id, "My week")
    course = {"source_kind": PromotedQuoteSourceKind.COURSE, "source_title": _CHAPTER_TITLE}
    later = await _seed_quote(
        db_session,
        user_id,
        None,
        "verb",
        anchor_start=40,
        anchor_end=44,
        source_content_id=chapter.id,
        **course,
    )
    folded = await _seed_quote(
        db_session,
        user_id,
        None,
        "Self",
        anchor_start=0,
        anchor_end=4,
        source_content_id=chapter.id,
        included_in_entry_id=review.id,
        **course,
    )
    tied = await _seed_quote(
        db_session,
        user_id,
        None,
        "Self-love",
        anchor_start=0,
        anchor_end=9,
        source_content_id=chapter.id,
        **course,
    )
    await _seed_quote(
        db_session, user_id, None, "other", source_content_id=other_chapter.id, **course
    )
    await _seed_quote(db_session, other_id, None, "Self", source_content_id=chapter.id, **course)

    resp = await async_client.get(_course_promotions(chapter.id), headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    items = resp.json()
    assert [item["id"] for item in items] == [folded.id, tied.id, later.id]
    assert [item["pending"] for item in items] == [False, True, True]
    assert all(item["source_kind"] == "course" for item in items)
    assert all("user_id" not in item for item in items)


@pytest.mark.asyncio
async def test_course_promotions_masks_a_locked_chapter_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The list rides the same release gate as the write: locked reads as missing."""
    headers, user_id = await _signup(async_client, db_session)
    locked = await _seed_chapter(db_session, user_id, stage_number=_LOCKED_STAGE_NUMBER)

    locked_resp = await async_client.get(_course_promotions(locked.id), headers=headers)
    missing_resp = await async_client.get(_course_promotions(999_999), headers=headers)

    assert locked_resp.status_code == missing_resp.status_code == HTTPStatus.NOT_FOUND
    assert locked_resp.json() == missing_resp.json() == {"detail": "content_not_found"}


# ── POST /journal/marginalia/{marginalia_id}/letter/promote ──────────────

_LETTER: Final = "Dear writer, the river you named keeps moving, and so do you."
_LETTER_PHRASE: Final = "the river you named"


async def _seed_lettered_note(
    db_session: AsyncSession,
    user_id: int,
    *,
    letter: str | None = _LETTER,
    classification: JournalClassification = JournalClassification.PERSONAL,
    **overrides: object,
) -> tuple[JournalEntry, Marginalia]:
    """An entry of ``user_id``'s with one margin note carrying ``letter`` (or none)."""
    entry = await _seed_entry(db_session, user_id, "A river page", classification=classification)
    generated = None if letter is None else datetime.now(UTC)
    note = await _seed_letter(
        db_session, user_id, entry, essay=letter, essay_generated_at=generated, **overrides
    )
    return entry, note


@pytest.mark.asyncio
async def test_letter_promote_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.post(_letter_promote(1), json={"anchor_start": 0, "anchor_end": 4})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_letter_promote_slices_the_letter_server_side(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Offsets index ``Marginalia.essay``; the quote names the note and carries no title."""
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _seed_lettered_note(db_session, user_id)

    resp = await async_client.post(
        _letter_promote(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )

    assert resp.status_code == HTTPStatus.CREATED, resp.text
    data = resp.json()
    assert data["anchor_text"] == _LETTER_PHRASE
    assert data["source_kind"] == PromotedQuoteSourceKind.LETTER.value
    assert data["source_marginalia_id"] == note.id
    assert data["source_entry_id"] is None
    assert data["source_content_id"] is None
    assert data["pending"] is True
    assert "user_id" not in data
    stored = await _stored_quote(db_session, data["id"])
    assert stored.user_id == user_id
    # A letter's provenance is the writer's own and encrypted where it lives:
    # the plaintext title snapshot is for published chapters only.
    assert stored.source_title is None


@pytest.mark.asyncio
async def test_letter_promote_404_for_a_missing_note(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A note id that names nothing is ``marginalia_not_found``."""
    headers, _user_id = await _signup(async_client, db_session)

    resp = await async_client.post(
        _letter_promote(999_999), json={"anchor_start": 0, "anchor_end": 4}, headers=headers
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "marginalia_not_found"


@pytest.mark.asyncio
async def test_letter_promote_404_when_the_note_has_no_letter(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A note nobody has written a letter for has nothing to quote: ``letter_not_found``."""
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _seed_lettered_note(db_session, user_id, letter=None)

    resp = await async_client.post(
        _letter_promote(note.id), json={"anchor_start": 0, "anchor_end": 4}, headers=headers
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "letter_not_found"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_letter_promote_404_for_a_withheld_demo_letter(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Outside the stub seam a stored demo letter is no letter, so it is not promotable."""
    run_as_deployed(monkeypatch)
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _seed_lettered_note(
        db_session,
        user_id,
        source=MarginaliaSource.APP_PROVIDER.value,
        essay_source=MarginaliaSource.DEMO.value,
    )

    resp = await async_client.post(
        _letter_promote(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "letter_not_found"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_letter_promote_404_for_a_hidden_demo_note(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A stored demo note is absent by id outside the seam, as in the note listing."""
    run_as_deployed(monkeypatch)
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _seed_lettered_note(
        db_session, user_id, source=MarginaliaSource.DEMO.value
    )

    resp = await async_client.post(
        _letter_promote(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "marginalia_not_found"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_letter_promote_404_when_the_parent_entry_was_deleted(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A note on a soft-deleted page is gone with it."""
    headers, user_id = await _signup(async_client, db_session)
    entry, note = await _seed_lettered_note(db_session, user_id)
    entry.deleted_at = datetime.now(UTC)
    db_session.add(entry)
    await db_session.commit()

    resp = await async_client.post(
        _letter_promote(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "journal_entry_not_found"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_letter_promote_409_while_the_parent_entry_awaits_deletion(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A new derived copy of a page whose deletion is in progress is refused (#3098)."""
    headers, user_id = await _signup(async_client, db_session)
    entry, note = await _seed_lettered_note(db_session, user_id)
    assert entry.id is not None
    db_session.add(
        JournalWithdrawalObligation(
            user_id=user_id,
            journal_entry_id=entry.id,
            state=JournalWithdrawalState.PENDING_DELETE.value,
        )
    )
    await db_session.commit()

    resp = await async_client.post(
        _letter_promote(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "journal_entry_deletion_pending"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_letter_promote_409_when_the_parent_entry_may_not_egress(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A letter inherits its entry's tier: on an Intimate page it may not become a quote."""
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _seed_lettered_note(
        db_session, user_id, classification=JournalClassification.INTIMATE
    )

    resp = await async_client.post(
        _letter_promote(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "quote_source_restricted"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_letter_promote_409_for_a_span_carrying_a_restricted_fold(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A letter repeating a passage its entry holds from an Intimate source may not lift it."""
    headers, user_id = await _signup(async_client, db_session)
    intimate = await _seed_entry(
        db_session, user_id, f"I {_LETTER_PHRASE}", classification=JournalClassification.INTIMATE
    )
    entry, note = await _seed_lettered_note(db_session, user_id)
    await _seed_quote(
        db_session,
        user_id,
        intimate.id,
        _LETTER_PHRASE,
        anchor_start=2,
        anchor_end=2 + len(_LETTER_PHRASE),
        included_in_entry_id=entry.id,
    )
    before = await _quote_count(db_session)

    resp = await async_client.post(
        _letter_promote(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "quote_source_restricted"
    assert await _quote_count(db_session) == before


@pytest.mark.asyncio
async def test_letter_promote_rejects_a_span_past_the_letter_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An end past the letter is ``anchor_out_of_range`` and stores nothing."""
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _seed_lettered_note(db_session, user_id)

    resp = await async_client.post(
        _letter_promote(note.id),
        json={"anchor_start": 0, "anchor_end": len(_LETTER) + 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "anchor_out_of_range"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_letter_promote_rejects_a_span_over_the_quote_cap_422(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A span longer than a quote may hold is ``quote_too_long`` and stores nothing."""
    headers, user_id = await _signup(async_client, db_session)
    long_letter = "Dear writer, " + "y" * PROMOTED_QUOTE_TEXT_MAX
    _entry, note = await _seed_lettered_note(db_session, user_id, letter=long_letter)

    resp = await async_client.post(
        _letter_promote(note.id),
        json={"anchor_start": 0, "anchor_end": PROMOTED_QUOTE_TEXT_MAX + 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "quote_too_long"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_letter_span_refusal_reads_only_the_tier_of_an_unsaved_entry(
    db_session: AsyncSession,
) -> None:
    """An entry never stored holds no folds, so its tier is the whole question."""
    personal = JournalEntry(user_id=1, sender="user", message=_LETTER)
    intimate = JournalEntry(
        user_id=1, sender="user", message=_LETTER, classification=JournalClassification.INTIMATE
    )

    await refuse_unquotable_letter_span(db_session, personal, _LETTER_PHRASE)
    with pytest.raises(HTTPException) as refused:
        await refuse_unquotable_letter_span(db_session, intimate, _LETTER_PHRASE)

    assert refused.value.status_code == HTTPStatus.CONFLICT
    assert refused.value.detail == QUOTE_SOURCE_RESTRICTED


# ── GET /journal/marginalia/{marginalia_id}/letter/promotions ────────────


@pytest.mark.asyncio
async def test_letter_promotions_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.get(_letter_promotions(1))
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_letter_promotions_lists_the_callers_quotes_of_that_letter_in_anchor_order(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Every status, ordered ``(anchor_start, id)``; another letter's quotes stay out."""
    headers, user_id = await _signup(async_client, db_session)
    entry, note = await _seed_lettered_note(db_session, user_id)
    other_note = await _seed_letter(db_session, user_id, entry)
    review = await _seed_review(db_session, user_id, "My week")
    letter = {"source_kind": PromotedQuoteSourceKind.LETTER}
    later = await _seed_quote(
        db_session,
        user_id,
        None,
        "river",
        anchor_start=17,
        anchor_end=22,
        source_marginalia_id=note.id,
        **letter,
    )
    folded = await _seed_quote(
        db_session,
        user_id,
        None,
        "Dear",
        source_marginalia_id=note.id,
        included_in_entry_id=review.id,
        **letter,
    )
    await _seed_quote(
        db_session, user_id, None, "Dear", source_marginalia_id=other_note.id, **letter
    )

    resp = await async_client.get(_letter_promotions(note.id), headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    items = resp.json()
    assert [item["id"] for item in items] == [folded.id, later.id]
    assert [item["pending"] for item in items] == [False, True]
    assert all(item["source_marginalia_id"] == note.id for item in items)


@pytest.mark.asyncio
async def test_letter_promotions_404_when_the_parent_entry_was_deleted(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The list rides the same gate as the write: a deleted page's letter is gone."""
    headers, user_id = await _signup(async_client, db_session)
    entry, note = await _seed_lettered_note(db_session, user_id)
    entry.deleted_at = datetime.now(UTC)
    db_session.add(entry)
    await db_session.commit()

    resp = await async_client.get(_letter_promotions(note.id), headers=headers)

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "journal_entry_not_found"


@pytest.mark.asyncio
async def test_letter_promotions_404_when_the_note_has_no_letter(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """No letter, nothing to rehydrate highlights on: ``letter_not_found``."""
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _seed_lettered_note(db_session, user_id, letter=None)

    resp = await async_client.get(_letter_promotions(note.id), headers=headers)

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "letter_not_found"


# ── DELETE / PATCH /promotions/{id} for the new kinds ───────────────────


async def _promote_course_quote(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> tuple[dict[str, str], int, int]:
    """Sign up, publish a chapter and promote a passage of it: headers, user id, quote id."""
    headers, user_id = await _signup(async_client, db_session)
    shelf.publish(_CHAPTER_PROSE)
    chapter = await _seed_chapter(db_session, user_id)
    resp = await async_client.post(
        _course_promote(chapter.id), json=_span(_CHAPTER_PROSE, _CHAPTER_PHRASE), headers=headers
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    return headers, user_id, int(resp.json()["id"])


async def _promote_letter_quote(
    async_client: AsyncClient, db_session: AsyncSession
) -> tuple[dict[str, str], int, int]:
    """Sign up, write a letter and promote a passage of it: headers, user id, quote id."""
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _seed_lettered_note(db_session, user_id)
    resp = await async_client.post(
        _letter_promote(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    return headers, user_id, int(resp.json()["id"])


@pytest.mark.asyncio
async def test_delete_removes_a_course_quote(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """``DELETE /promotions/{id}`` removes a Course quote like any other; a second one 404s."""
    headers, _user_id, quote_id = await _promote_course_quote(async_client, db_session, shelf)

    resp = await async_client.delete(f"/promotions/{quote_id}", headers=headers)
    again = await async_client.delete(f"/promotions/{quote_id}", headers=headers)

    assert resp.status_code == HTTPStatus.NO_CONTENT
    assert again.status_code == HTTPStatus.NOT_FOUND
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_delete_removes_a_letter_quote(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``DELETE /promotions/{id}`` removes a letter quote like any other."""
    headers, _user_id, quote_id = await _promote_letter_quote(async_client, db_session)

    resp = await async_client.delete(f"/promotions/{quote_id}", headers=headers)

    assert resp.status_code == HTTPStatus.NO_CONTENT
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_patch_returns_a_course_quote_to_pending(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """Clearing the inclusion of a Course quote is always allowed."""
    headers, _user_id, quote_id = await _promote_course_quote(async_client, db_session, shelf)

    resp = await async_client.patch(
        f"/promotions/{quote_id}", json={"included_in_entry_id": None}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["pending"] is True
    assert resp.json()["source_kind"] == "course"


@pytest.mark.asyncio
async def test_patch_returns_a_letter_quote_to_pending(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Clearing the inclusion of a letter quote is always allowed."""
    headers, _user_id, quote_id = await _promote_letter_quote(async_client, db_session)

    resp = await async_client.patch(
        f"/promotions/{quote_id}", json={"included_in_entry_id": None}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["pending"] is True
    assert resp.json()["source_kind"] == "letter"


# ── Folding a Course or letter quote into a live review (needs #3657) ────


@pytest.mark.asyncio
async def test_patch_folds_a_course_quote_into_a_live_reflection(
    async_client: AsyncClient, db_session: AsyncSession, shelf: _Shelf
) -> None:
    """A Course quote is published text: it folds into the caller's live review unchanged."""
    headers, user_id, quote_id = await _promote_course_quote(async_client, db_session, shelf)
    review = await _seed_review(db_session, user_id, "My week")

    resp = await async_client.patch(
        f"/promotions/{quote_id}", json={"included_in_entry_id": review.id}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["pending"] is False
    assert resp.json()["source_kind"] == "course"
    stored = await _stored_quote(db_session, quote_id)
    assert stored.included_in_entry_id == review.id


@pytest.mark.asyncio
async def test_patch_folds_a_letter_quote_into_a_live_reflection(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A letter quote on a Personal page folds into the caller's live review unchanged."""
    headers, user_id, quote_id = await _promote_letter_quote(async_client, db_session)
    review = await _seed_review(db_session, user_id, "My week")

    resp = await async_client.patch(
        f"/promotions/{quote_id}", json={"included_in_entry_id": review.id}, headers=headers
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["pending"] is False
    assert resp.json()["source_kind"] == "letter"
    stored = await _stored_quote(db_session, quote_id)
    assert stored.included_in_entry_id == review.id
