"""Promoting a passage of a Course chapter or of a Resonance Letter (#3658).

``POST /course/content/{content_id}/promote`` and
``POST /journal/marginalia/{marginalia_id}/letter/promote`` slice their quote
server-side from offsets, exactly as ``POST /journal/{entry_id}/promote`` does,
and their ``GET …/promotions`` siblings rehydrate a source's highlights. Each
route answers through the gate its source's own read uses: a chapter through
the Course body gate (BUG-COURSE-004), a letter through the caller's own,
visible margin note on a live entry. ``PATCH`` and ``DELETE /promotions/{id}``
need no change for the new kinds; the tests below pin that they work.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from pathlib import Path
from typing import Any, Final

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from content_config import content_ref
from domain.resonance import ESSAY_MAX
from models.course_stage import CourseStage
from models.journal_entry import JournalClassification, JournalEntry
from models.marginalia import (
    MARGINALIA_ESSAY_MAX,
    Marginalia,
    MarginaliaKind,
    MarginaliaSource,
)
from models.promoted_quote import PROMOTED_QUOTE_TEXT_MAX, PromotedQuote, PromotedQuoteSourceKind
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from schemas.journal import JOURNAL_MESSAGE_MAX_LENGTH
from schemas.promotion import COURSE_CHAPTER_MAX_LENGTH
from services import botmason
from services.content_repository import (
    ContentRepository,
    get_content_repository,
    reset_content_repository_for_tests,
    set_content_repository_for_tests,
)
from tests.support.lineage_canaries import LINEAGE_SENTINEL, seed_folded_lineage
from tests.test_promotions_api import _seed_entry, _seed_review, _signup

# ── Course fixtures ──────────────────────────────────────────────────────

_CHAPTER_ID: Final = "beige-1"
_LONG_CHAPTER_ID: Final = "beige-2"
_CHAPTER_TITLE: Final = "Survival"
_LONG_CHAPTER_TITLE: Final = "A Long Chapter"
# What ``read_body`` serves once the frontmatter below is stripped: offsets
# count from here, never from the file's first byte.
_CHAPTER_BODY: Final = "# Survival\n\nThe body remembers what the mind forgets.\n"
_CHAPTER_FILE: Final = f"---\ntitle: {_CHAPTER_TITLE}\n---\n{_CHAPTER_BODY}"
_PHRASE: Final = "remembers"
# A chapter longer than any journal entry may be, with a phrase past that bound.
_LONG_PREFIX: Final = "x" * (JOURNAL_MESSAGE_MAX_LENGTH + 500)
_LONG_PHRASE: Final = "deep in the chapter"
_LONG_CHAPTER_BODY: Final = f"{_LONG_PREFIX}{_LONG_PHRASE}\n"

_MANIFEST: Final[dict[str, Any]] = {
    "schema_version": "1.1.0",
    "chapters": [
        {
            "id": _CHAPTER_ID,
            "stage": 1,
            "chapter": 1,
            "slug": "survival",
            "title": _CHAPTER_TITLE,
            "content_type": "chapter",
            "release_day": 0,
            "order": 1,
            "path": "markdown/01-beige/01-survival.md",
        },
        {
            "id": _LONG_CHAPTER_ID,
            "stage": 1,
            "chapter": 2,
            "slug": "long",
            "title": _LONG_CHAPTER_TITLE,
            "content_type": "chapter",
            "release_day": 0,
            "order": 2,
            "path": "markdown/01-beige/02-long.md",
        },
    ],
    "site_resources": [],
}


@pytest.fixture
def content_dir(tmp_path: Path) -> Iterator[Path]:
    """Vendored-content stand-in wired into the repository singleton."""
    root = tmp_path / "content"
    root.mkdir()
    (root / "manifest.json").write_text(json.dumps(_MANIFEST))
    bodies = {_CHAPTER_ID: _CHAPTER_FILE, _LONG_CHAPTER_ID: _LONG_CHAPTER_BODY}
    for chapter in _MANIFEST["chapters"]:
        md = root / chapter["path"]
        md.parent.mkdir(parents=True, exist_ok=True)
        md.write_text(bodies[chapter["id"]])
    set_content_repository_for_tests(ContentRepository(root))
    yield root
    reset_content_repository_for_tests()


def _stage(stage_number: int) -> CourseStage:
    """A Course stage row; only ``stage_number`` matters to the gate."""
    return CourseStage(
        title=f"Stage {stage_number}",
        subtitle=f"Subtitle {stage_number}",
        stage_number=stage_number,
        overview_url=f"https://example.com/stage-{stage_number}",
        category="test",
        aspect="test-aspect",
        spiral_dynamics_color="beige",
        growing_up_stage="archaic",
        divine_gender_polarity="masculine",
        relationship_to_free_will="active",
        free_will_description="Active Yes-And-Ness",
    )


async def _seed_chapter(
    db_session: AsyncSession,
    *,
    stage_number: int = 1,
    chapter_id: str = _CHAPTER_ID,
    title: str = _CHAPTER_TITLE,
    url: str | None = None,
) -> StageContent:
    """A released chapter row pointing at the vendored ``chapter_id``."""
    stage = _stage(stage_number)
    db_session.add(stage)
    await db_session.flush()
    item = StageContent(
        course_stage_id=stage.id,
        title=title,
        content_type="chapter",
        release_day=0,
        url=url if url is not None else content_ref(chapter_id),
    )
    db_session.add(item)
    await db_session.commit()
    await db_session.refresh(item)
    return item


async def _open_stage(db_session: AsyncSession, user_id: int, stage_number: int = 1) -> None:
    """Put ``user_id`` a day into ``stage_number``, so its first chapters are released."""
    db_session.add(
        StageProgress(
            user_id=user_id,
            current_stage=stage_number,
            completed_stages=list(range(1, stage_number)),
            stage_started_at=datetime.now(UTC) - timedelta(days=1),
        )
    )
    await db_session.commit()


async def _quote_count(db_session: AsyncSession) -> int:
    """Every ``promotedquote`` row, whoever owns it."""
    return (await db_session.execute(select(func.count()).select_from(PromotedQuote))).scalar_one()


def _span(text: str, phrase: str) -> dict[str, int]:
    """The offsets of ``phrase`` in ``text``, as a promote payload."""
    start = text.index(phrase)
    return {"anchor_start": start, "anchor_end": start + len(phrase)}


def _course_url(content_id: int | None, suffix: str = "promote") -> str:
    return f"/course/content/{content_id}/{suffix}"


# ── Letter fixtures ──────────────────────────────────────────────────────

_LETTER: Final = "Dear writer, the river you named keeps moving, and so do you."
_LETTER_PHRASE: Final = "keeps moving"


async def _seed_note(
    db_session: AsyncSession, user_id: int, entry: JournalEntry, **overrides: object
) -> Marginalia:
    """A margin note on ``entry`` carrying :data:`_LETTER` as its Resonance Letter."""
    defaults: dict[str, object] = {
        "journal_entry_id": entry.id,
        "user_id": user_id,
        "kind": MarginaliaKind.THEME,
        "anchor_start": 0,
        "anchor_end": 4,
        "anchor_text": entry.message[:4],
        "note": "A note in the margin.",
        "essay": _LETTER,
        "essay_generated_at": datetime.now(UTC),
    }
    defaults.update(overrides)
    note = Marginalia(**defaults)
    db_session.add(note)
    await db_session.commit()
    await db_session.refresh(note)
    return note


async def _lettered_entry(
    db_session: AsyncSession, user_id: int, **entry_overrides: object
) -> tuple[JournalEntry, Marginalia]:
    """A Personal entry and a margin note on it carrying a letter."""
    entry = await _seed_entry(db_session, user_id, "A river page", **entry_overrides)
    return entry, await _seed_note(db_session, user_id, entry)


def _letter_url(marginalia_id: int | None, suffix: str = "promote") -> str:
    return f"/journal/marginalia/{marginalia_id}/letter/{suffix}"


# ── POST /course/content/{content_id}/promote ────────────────────────────


@pytest.mark.asyncio
async def test_course_promote_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.post(_course_url(1), json={"anchor_start": 0, "anchor_end": 5})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_course_promote_slices_the_body_the_reader_was_served(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Offsets index the body endpoint's Markdown, frontmatter already stripped."""
    headers, user_id = await _signup(async_client, db_session)
    chapter = await _seed_chapter(db_session)
    await _open_stage(db_session, user_id)
    served = await async_client.get(_course_url(chapter.id, "body"), headers=headers)
    assert served.json()["body_markdown"] == _CHAPTER_BODY

    resp = await async_client.post(
        _course_url(chapter.id), json=_span(_CHAPTER_BODY, _PHRASE), headers=headers
    )

    assert resp.status_code == HTTPStatus.CREATED, resp.text
    data = resp.json()
    assert data["anchor_text"] == _PHRASE
    assert data["source_kind"] == "course"
    assert data["source_content_id"] == chapter.id
    assert data["source_entry_id"] is None
    assert data["source_marginalia_id"] is None
    assert data["pending"] is True
    assert "user_id" not in data
    stored = await db_session.get(PromotedQuote, data["id"])
    assert stored is not None
    assert stored.user_id == user_id
    assert stored.source_kind == PromotedQuoteSourceKind.COURSE
    assert stored.source_title == _CHAPTER_TITLE


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_course_promote_reaches_past_the_journal_length_bound(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A chapter may be longer than any entry, so its offsets are bounded by the chapter cap."""
    headers, user_id = await _signup(async_client, db_session)
    chapter = await _seed_chapter(
        db_session, chapter_id=_LONG_CHAPTER_ID, title=_LONG_CHAPTER_TITLE
    )
    await _open_stage(db_session, user_id)
    span = _span(_LONG_CHAPTER_BODY, _LONG_PHRASE)
    assert span["anchor_start"] > JOURNAL_MESSAGE_MAX_LENGTH

    resp = await async_client.post(_course_url(chapter.id), json=span, headers=headers)

    assert resp.status_code == HTTPStatus.CREATED, resp.text
    assert resp.json()["anchor_text"] == _LONG_PHRASE


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_course_promote_rejects_offsets_past_the_chapter_cap(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An offset past :data:`COURSE_CHAPTER_MAX_LENGTH` is a validation error, before any read."""
    headers, user_id = await _signup(async_client, db_session)
    chapter = await _seed_chapter(db_session)
    await _open_stage(db_session, user_id)

    resp = await async_client.post(
        _course_url(chapter.id),
        json={"anchor_start": 0, "anchor_end": COURSE_CHAPTER_MAX_LENGTH + 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_course_promote_rejects_a_span_past_the_body(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An end past the served body is 422 ``anchor_out_of_range``, and stores nothing."""
    headers, user_id = await _signup(async_client, db_session)
    chapter = await _seed_chapter(db_session)
    await _open_stage(db_session, user_id)

    resp = await async_client.post(
        _course_url(chapter.id),
        json={"anchor_start": 0, "anchor_end": len(_CHAPTER_BODY) + 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "anchor_out_of_range"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_course_promote_rejects_an_overlong_quote(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A span longer than the quote cap is 422 ``quote_too_long``, and stores nothing."""
    headers, user_id = await _signup(async_client, db_session)
    chapter = await _seed_chapter(
        db_session, chapter_id=_LONG_CHAPTER_ID, title=_LONG_CHAPTER_TITLE
    )
    await _open_stage(db_session, user_id)

    resp = await async_client.post(
        _course_url(chapter.id),
        json={"anchor_start": 0, "anchor_end": PROMOTED_QUOTE_TEXT_MAX + 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "quote_too_long"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_course_promote_masks_every_unreadable_chapter_alike(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Locked, reference-less and missing chapters are one 404 ``content_not_found``."""
    headers, user_id = await _signup(async_client, db_session)
    locked = await _seed_chapter(db_session, stage_number=2)
    legacy = await _seed_chapter(db_session, stage_number=1, url="https://example.com/legacy")
    await _open_stage(db_session, user_id)
    payload = {"anchor_start": 0, "anchor_end": 4}

    answers = [
        await async_client.post(_course_url(content_id), json=payload, headers=headers)
        for content_id in (locked.id, legacy.id, 999_999)
    ]

    assert {resp.status_code for resp in answers} == {HTTPStatus.NOT_FOUND}
    assert {resp.json()["detail"] for resp in answers} == {"content_not_found"}
    assert await _quote_count(db_session) == 0


# ── GET /course/content/{content_id}/promotions ──────────────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_course_promotions_list_the_callers_quotes_of_that_chapter_in_order(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Every status, ordered by ``(anchor_start, id)``; no other chapter's, no other reader's."""
    headers, user_id = await _signup(async_client, db_session)
    other_headers, other_id = await _signup(async_client, db_session, username="bob")
    chapter = await _seed_chapter(db_session)
    await _open_stage(db_session, user_id)
    await _open_stage(db_session, other_id)
    late = _span(_CHAPTER_BODY, "forgets")
    early = _span(_CHAPTER_BODY, _PHRASE)
    created = [
        (await async_client.post(_course_url(chapter.id), json=span, headers=headers)).json()
        for span in (late, early, early)
    ]
    review = await _seed_review(db_session, user_id, "Looking back")
    folded = await async_client.patch(
        f"/promotions/{created[0]['id']}",
        json={"included_in_entry_id": review.id},
        headers=headers,
    )
    assert folded.status_code == HTTPStatus.OK
    await async_client.post(_course_url(chapter.id), json=early, headers=other_headers)

    resp = await async_client.get(_course_url(chapter.id, "promotions"), headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    listed = resp.json()
    assert [item["id"] for item in listed] == [
        created[1]["id"],
        created[2]["id"],
        created[0]["id"],
    ]
    assert [item["pending"] for item in listed] == [True, True, False]
    assert {item["source_kind"] for item in listed} == {"course"}


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_course_promotions_of_a_locked_chapter_are_404(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The list answers through the body gate too: a locked chapter is ``content_not_found``."""
    headers, _user_id = await _signup(async_client, db_session)
    locked = await _seed_chapter(db_session, stage_number=2)

    resp = await async_client.get(_course_url(locked.id, "promotions"), headers=headers)

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "content_not_found"


# ── PATCH / DELETE /promotions/{id} for a course quote ───────────────────


@pytest.mark.asyncio
@pytest.mark.usefixtures("content_dir")
async def test_a_course_quote_folds_into_a_live_reflection_and_back(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Published text folds, returns to pending, and deletes like any quote."""
    headers, user_id = await _signup(async_client, db_session)
    chapter = await _seed_chapter(db_session)
    await _open_stage(db_session, user_id)
    quote = (
        await async_client.post(
            _course_url(chapter.id), json=_span(_CHAPTER_BODY, _PHRASE), headers=headers
        )
    ).json()
    review = await _seed_review(db_session, user_id, "Looking back")

    folded = await async_client.patch(
        f"/promotions/{quote['id']}", json={"included_in_entry_id": review.id}, headers=headers
    )
    assert folded.status_code == HTTPStatus.OK, folded.text
    assert folded.json()["pending"] is False
    assert folded.json()["source_kind"] == "course"

    unfolded = await async_client.patch(
        f"/promotions/{quote['id']}", json={"included_in_entry_id": None}, headers=headers
    )
    assert unfolded.json()["pending"] is True

    deleted = await async_client.delete(f"/promotions/{quote['id']}", headers=headers)
    assert deleted.status_code == HTTPStatus.NO_CONTENT
    assert await _quote_count(db_session) == 0


# ── The chapter bound holds for the vendored Course ──────────────────────


def test_every_vendored_chapter_fits_the_chapter_offset_bound() -> None:
    """A passage anywhere in any shipped chapter can be promoted.

    ``PromoteChapterQuoteCreate`` bounds offsets by :data:`COURSE_CHAPTER_MAX_LENGTH`,
    not by the journal's own bound, because chapters run longer than any entry.
    A content pin that ships a longer chapter fails here, not at a reader.
    """
    repository = get_content_repository()
    lengths = {
        chapter.id: len(repository.read_body(chapter.id).body)
        for chapter in repository.list_chapters()
    }
    assert lengths, "the vendored Course should ship chapters"
    longest = max(lengths, key=lambda chapter_id: lengths[chapter_id])
    assert lengths[longest] <= COURSE_CHAPTER_MAX_LENGTH, longest
    # The reason the bound exists: the journal's own would cut some chapters short.
    assert lengths[longest] > JOURNAL_MESSAGE_MAX_LENGTH


def test_every_letter_fits_the_letter_offset_bound() -> None:
    """A letter is capped no longer than an entry, so the entry payload's bound reaches its end."""
    assert max(MARGINALIA_ESSAY_MAX, ESSAY_MAX) <= JOURNAL_MESSAGE_MAX_LENGTH


# ── POST /journal/marginalia/{marginalia_id}/letter/promote ──────────────


@pytest.mark.asyncio
async def test_letter_promote_requires_auth(async_client: AsyncClient) -> None:
    """Unauthenticated callers get 401."""
    resp = await async_client.post(_letter_url(1), json={"anchor_start": 0, "anchor_end": 5})
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
async def test_letter_promote_slices_the_letter(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Offsets index ``Marginalia.essay``; the quote names the note it came from."""
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _lettered_entry(db_session, user_id)

    resp = await async_client.post(
        _letter_url(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )

    assert resp.status_code == HTTPStatus.CREATED, resp.text
    data = resp.json()
    assert data["anchor_text"] == _LETTER_PHRASE
    assert data["source_kind"] == "letter"
    assert data["source_marginalia_id"] == note.id
    assert data["source_entry_id"] is None
    assert data["source_content_id"] is None
    assert data["pending"] is True
    stored = await db_session.get(PromotedQuote, data["id"])
    assert stored is not None
    assert stored.user_id == user_id
    assert stored.source_title is None


@pytest.mark.asyncio
async def test_letter_promote_without_a_letter_is_letter_not_found(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A note never expanded into a letter has nothing to quote: 404, nothing stored."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "A river page")
    note = await _seed_note(db_session, user_id, entry, essay=None, essay_generated_at=None)

    resp = await async_client.post(
        _letter_url(note.id), json={"anchor_start": 0, "anchor_end": 4}, headers=headers
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "letter_not_found"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_a_withheld_demo_letter_is_not_promotable(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Outside the stub seam a stored demo letter is no letter (#3096): 404 ``letter_not_found``."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "A river page")
    note = await _seed_note(db_session, user_id, entry, essay_source=MarginaliaSource.DEMO.value)
    monkeypatch.delenv(botmason.STUB_SEAM_ENV_VAR, raising=False)

    promote = await async_client.post(
        _letter_url(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )
    listing = await async_client.get(_letter_url(note.id, "promotions"), headers=headers)

    assert promote.status_code == listing.status_code == HTTPStatus.NOT_FOUND
    assert promote.json()["detail"] == listing.json()["detail"] == "letter_not_found"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_a_hidden_demo_note_is_not_found(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A demo note hidden from the listing is absent by id here too."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "A river page")
    note = await _seed_note(db_session, user_id, entry, source=MarginaliaSource.DEMO.value)
    monkeypatch.delenv(botmason.STUB_SEAM_ENV_VAR, raising=False)

    resp = await async_client.post(
        _letter_url(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )

    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "marginalia_not_found"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_a_letter_on_a_deleted_entry_is_not_found(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The parent entry must be live, for the write and the list alike."""
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _lettered_entry(db_session, user_id, deleted_at=datetime.now(UTC))

    promote = await async_client.post(
        _letter_url(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )
    listing = await async_client.get(_letter_url(note.id, "promotions"), headers=headers)

    assert promote.status_code == listing.status_code == HTTPStatus.NOT_FOUND
    assert promote.json()["detail"] == listing.json()["detail"] == "journal_entry_not_found"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_a_letter_answering_an_intimate_entry_is_restricted(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A letter inherits its entry's tier: an Intimate parent is 409, nothing stored."""
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _lettered_entry(
        db_session, user_id, classification=JournalClassification.INTIMATE
    )

    resp = await async_client.post(
        _letter_url(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
    )

    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "quote_source_restricted"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_a_letter_line_carrying_a_restricted_passage_is_refused(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Defence in depth: a letter quoting a passage its entry holds from an Intimate fold.

    The quote could never be folded (the fold door refuses it), so it is not
    stored either; the letter's other words still promote.
    """
    headers, user_id = await _signup(async_client, db_session)
    chain = await seed_folded_lineage(db_session, user_id=user_id)
    review = await db_session.get(JournalEntry, chain.review_id)
    assert review is not None
    letter = f"Dear writer, you wrote {LINEAGE_SENTINEL} and then you kept going."
    note = await _seed_note(db_session, user_id, review, essay=letter)
    before = await _quote_count(db_session)

    carrying = await async_client.post(
        _letter_url(note.id), json=_span(letter, LINEAGE_SENTINEL), headers=headers
    )
    clean = await async_client.post(
        _letter_url(note.id), json=_span(letter, "kept going"), headers=headers
    )

    assert carrying.status_code == HTTPStatus.CONFLICT
    assert carrying.json()["detail"] == "quote_source_restricted"
    assert clean.status_code == HTTPStatus.CREATED, clean.text
    assert await _quote_count(db_session) == before + 1


@pytest.mark.asyncio
async def test_letter_promote_rejects_a_span_past_the_letter(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An end past the letter is 422 ``anchor_out_of_range``, and stores nothing."""
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _lettered_entry(db_session, user_id)

    resp = await async_client.post(
        _letter_url(note.id),
        json={"anchor_start": 0, "anchor_end": len(_LETTER) + 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "anchor_out_of_range"
    assert await _quote_count(db_session) == 0


@pytest.mark.asyncio
async def test_letter_promote_rejects_an_overlong_quote(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A span longer than the quote cap is 422 ``quote_too_long``, and stores nothing."""
    headers, user_id = await _signup(async_client, db_session)
    entry = await _seed_entry(db_session, user_id, "A river page")
    long_letter = "y" * (PROMOTED_QUOTE_TEXT_MAX + 10)
    note = await _seed_note(db_session, user_id, entry, essay=long_letter)

    resp = await async_client.post(
        _letter_url(note.id),
        json={"anchor_start": 0, "anchor_end": PROMOTED_QUOTE_TEXT_MAX + 1},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == "quote_too_long"
    assert await _quote_count(db_session) == 0


# ── GET /journal/marginalia/{marginalia_id}/letter/promotions ────────────


@pytest.mark.asyncio
async def test_letter_promotions_list_the_callers_quotes_of_that_letter_in_order(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Every status, ordered by ``(anchor_start, id)``; no other letter's quotes."""
    headers, user_id = await _signup(async_client, db_session)
    entry, note = await _lettered_entry(db_session, user_id)
    sibling = await _seed_note(db_session, user_id, entry)
    late = _span(_LETTER, "so do you")
    early = _span(_LETTER, _LETTER_PHRASE)
    created = [
        (await async_client.post(_letter_url(note.id), json=span, headers=headers)).json()
        for span in (late, early)
    ]
    await async_client.post(_letter_url(sibling.id), json=early, headers=headers)
    review = await _seed_review(db_session, user_id, "Looking back")
    folded = await async_client.patch(
        f"/promotions/{created[1]['id']}",
        json={"included_in_entry_id": review.id},
        headers=headers,
    )
    assert folded.status_code == HTTPStatus.OK, folded.text

    resp = await async_client.get(_letter_url(note.id, "promotions"), headers=headers)

    assert resp.status_code == HTTPStatus.OK, resp.text
    listed = resp.json()
    assert [item["id"] for item in listed] == [created[1]["id"], created[0]["id"]]
    assert [item["pending"] for item in listed] == [False, True]
    assert {item["source_marginalia_id"] for item in listed} == {note.id}


@pytest.mark.asyncio
async def test_a_letter_quote_deletes_like_any_quote(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``DELETE /promotions/{id}`` removes a letter quote, and a second delete is 404."""
    headers, user_id = await _signup(async_client, db_session)
    _entry, note = await _lettered_entry(db_session, user_id)
    quote = (
        await async_client.post(
            _letter_url(note.id), json=_span(_LETTER, _LETTER_PHRASE), headers=headers
        )
    ).json()

    first = await async_client.delete(f"/promotions/{quote['id']}", headers=headers)
    second = await async_client.delete(f"/promotions/{quote['id']}", headers=headers)

    assert first.status_code == HTTPStatus.NO_CONTENT
    assert second.status_code == HTTPStatus.NOT_FOUND
    remaining = (
        await db_session.execute(
            select(func.count())
            .select_from(PromotedQuote)
            .where(col(PromotedQuote.source_marginalia_id) == note.id)
        )
    ).scalar_one()
    assert remaining == 0
