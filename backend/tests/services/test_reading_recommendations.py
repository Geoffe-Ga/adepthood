"""Grounding uses current eligible sources and passive, read-only course access."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient
from sqlmodel import select

from dependencies.creek_vault import get_creek_vault_client
from domain.reading_recommendations import ReadingRecommendation, ReadingRequest
from main import app
from models.content_completion import ContentCompletion
from models.corpus_consent import CorpusConsentEvent
from models.course_stage import CourseStage
from models.invitation_signal import InvitationSignal
from models.journal_entry import JournalEntry
from models.stage_content import StageContent
from models.stage_progress import StageProgress
from models.user import User
from routers.auth import get_current_user
from routers.course import _listing_unlocked_count
from routers.invitations import _choose_reading
from services.content_repository import get_content_repository
from services.creek_vault_client import LocalFallbackCreekVaultClient
from services.reading_recommendations import available_readings, reading_invitation
from tests.support.outbound_boundary import assert_dialled_off_the_pool, observe_outbound_boundaries

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


async def seed(session: AsyncSession) -> tuple[int, JournalEntry, StageContent]:
    """Only synthetic writing enters fixtures; course material is canonical."""
    user = User(email="reading@example.com", password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    chapter = get_content_repository().list_chapters()[0]
    stage = CourseStage(
        stage_number=1,
        title="Stage",
        subtitle="Stage",
        overview_url="",
        category="",
        aspect="",
        spiral_dynamics_color="",
        growing_up_stage="",
        divine_gender_polarity="",
        relationship_to_free_will="",
        free_will_description="",
    )
    session.add(stage)
    await session.flush()
    assert stage.id is not None
    content = StageContent(
        course_stage_id=stage.id,
        title=chapter.title,
        content_type="essay",
        release_day=1,
        url=f"content://{chapter.id}",
    )
    entry = JournalEntry(
        user_id=user.id,
        sender="user",
        status="finished",
        classification="personal",
        title="A synthetic day",
        message="I noticed tension in my shoulders while walking.",
    )
    session.add_all(
        [content, entry, CorpusConsentEvent(user_id=user.id, source="journal", decision="granted")]
    )
    await session.commit()
    return user.id, entry, content


class ModelVault(LocalFallbackCreekVaultClient):
    """An optional extension that selects only supplied identities and text."""

    def __init__(self) -> None:
        """Track model calls and provide an interleaving test seam."""
        super().__init__()
        self.calls = 0
        self.after_send = AsyncMock()

    def is_available(self) -> bool:
        return True

    async def recommend_reading(self, request: ReadingRequest) -> ReadingRecommendation:
        self.calls += 1
        await self.after_send()
        return ReadingRecommendation(
            request.readings[0].content_id,
            request.sources[0].entry_id,
            "tension in my shoulders",
            "You describe bodily tension.",
            "A way to explore attention to physical sensations.",
        )


@pytest.mark.asyncio
async def test_grounded_offer_uses_real_source_and_specific_accessible_chapter(
    db_session: AsyncSession,
) -> None:
    user_id, entry, content = await seed(db_session)
    vault = ModelVault()
    result = await reading_invitation(db_session, user_id, 1, "UTC", vault)
    assert result is not None
    assert result.content_id == content.id
    assert result.entry_id == entry.id
    assert result.quote in entry.message
    assert result.entry_title == entry.title
    assert (await db_session.execute(select(StageProgress))).scalars().all() == []
    assert vault.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("classification", "intimate"),
        ("sender", "bot"),
        ("status", "draft"),
        ("deleted_at", datetime.now(UTC)),
    ],
)
async def test_ineligible_source_never_constructs_model(
    db_session: AsyncSession, field: str, value: object
) -> None:
    user_id, entry, _ = await seed(db_session)
    setattr(entry, field, value)
    await db_session.commit()
    vault = ModelVault()
    assert await reading_invitation(db_session, user_id, 1, "UTC", vault) is None
    assert vault.calls == 0


@pytest.mark.asyncio
async def test_revoked_consent_and_other_users_writing_do_not_egress(
    db_session: AsyncSession,
) -> None:
    user_id, _, _ = await seed(db_session)
    db_session.add(CorpusConsentEvent(user_id=user_id, source="journal", decision="revoked"))
    await db_session.commit()
    vault = ModelVault()
    assert await reading_invitation(db_session, user_id, 1, "UTC", vault) is None
    assert vault.calls == 0


@pytest.mark.asyncio
async def test_source_edit_while_model_runs_suppresses_stale_quote(
    db_session: AsyncSession,
) -> None:
    user_id, entry, _ = await seed(db_session)
    vault = ModelVault()

    async def edit() -> None:
        entry.message = "A different synthetic reflection."
        await db_session.commit()

    vault.after_send.side_effect = edit
    assert await reading_invitation(db_session, user_id, 1, "UTC", vault) is None
    assert vault.calls == 1


@pytest.mark.asyncio
async def test_completed_or_locked_reading_is_never_offered(db_session: AsyncSession) -> None:
    user_id, _, content = await seed(db_session)
    assert content.id is not None
    db_session.add(ContentCompletion(user_id=user_id, content_id=content.id))
    await db_session.commit()
    assert await available_readings(db_session, user_id, 1, "UTC") == []
    assert await available_readings(db_session, user_id, 2, "UTC") == []
    vault = ModelVault()
    assert await reading_invitation(db_session, user_id, 1, "UTC", vault) is None
    assert vault.calls == 0


@pytest.mark.asyncio
async def test_no_managed_model_means_no_generic_offer(db_session: AsyncSession) -> None:
    user_id, _, _ = await seed(db_session)
    assert (
        await reading_invitation(db_session, user_id, 1, "UTC", LocalFallbackCreekVaultClient())
        is None
    )


@pytest.mark.asyncio
async def test_other_account_sources_are_never_sent(db_session: AsyncSession) -> None:
    """Ownership is selected in SQL, including when a different account has matching prose."""
    user_id, entry, _ = await seed(db_session)
    other = User(email="other-reading@example.com", password_hash="x")  # pragma: allowlist secret
    db_session.add(other)
    await db_session.flush()
    assert other.id is not None
    entry.user_id = other.id
    await db_session.commit()
    vault = ModelVault()
    assert await reading_invitation(db_session, user_id, 1, "UTC", vault) is None
    assert vault.calls == 0


@pytest.mark.asyncio
async def test_passive_availability_matches_course_drip_without_recording_stage_entry(
    db_session: AsyncSession,
) -> None:
    """A calendar-open stage has identical chapters without advancing the progress record."""
    user_id, _, first = await seed(db_session)
    stage_one = await db_session.get(CourseStage, first.course_stage_id)
    assert stage_one is not None
    stage = CourseStage(
        **stage_one.model_dump(exclude={"id", "stage_key", "stage_number"}), stage_number=2
    )
    db_session.add(stage)
    await db_session.flush()
    assert stage.id is not None
    for day in range(1, 22):
        db_session.add(
            StageContent(
                course_stage_id=stage.id,
                title=f"Chapter {day}",
                release_day=day,
                content_type="essay",
                url=f"content://synthetic-{day}",
            )
        )
    anchor = datetime.now(UTC) - timedelta(days=28)
    progress = StageProgress(
        user_id=user_id, current_stage=1, stage_started_at=anchor, program_started_at=anchor
    )
    db_session.add(progress)
    await db_session.commit()
    available = await available_readings(db_session, user_id, 2, "UTC")
    assert progress.current_stage == 1
    actual = await _listing_unlocked_count(db_session, user_id, stage, 21, "UTC")
    assert len(available) == actual
    assert actual > 1


@pytest.mark.asyncio
async def test_public_source_uses_open_wire_tier(db_session: AsyncSession) -> None:
    """The app's public tier is translated before the closed request validator."""
    user_id, entry, _ = await seed(db_session)
    entry.classification = "public"
    await db_session.commit()
    vault = ModelVault()

    async def check(request: ReadingRequest) -> ReadingRecommendation:
        assert request.sources[0].tier == "open"
        assert request.wire_body()["sources"]
        return ReadingRecommendation(
            request.readings[0].content_id,
            entry.id or 0,
            "tension in my shoulders",
            "You describe tension.",
            "A way to notice it.",
        )

    vault.recommend_reading = check
    assert await reading_invitation(db_session, user_id, 1, "UTC", vault) is not None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "I noticed tension in my shoulders. "
        + "A synthetic walk. " * 100
        + "I want to kill myself.",
        "I am going to stop taking my medication.",
        "I am going to hurt someone.",
    ],
)
async def test_full_source_primary_care_guard_precedes_excerpts_and_model(
    db_session: AsyncSession, message: str
) -> None:
    """Acute writing outside the excerpt and primary guard categories quiet the offer."""
    user_id, entry, _ = await seed(db_session)
    entry.message = message
    await db_session.commit()
    vault = ModelVault()
    assert await reading_invitation(db_session, user_id, 1, "UTC", vault) is None
    assert vault.calls == 0


@pytest.mark.asyncio
async def test_multiple_pending_stages_make_only_one_generation_attempt(
    db_session: AsyncSession,
) -> None:
    """A negative model result cannot fan one passive listing into many pool turns."""
    user_id, _, _ = await seed(db_session)
    signals = [
        InvitationSignal(
            id=index, user_id=user_id, target_type="course", target_id=index, kind="readiness"
        )
        for index in range(1, 11)
    ]
    vault = ModelVault()
    vault.recommend_reading = AsyncMock(return_value=None)
    assert await _choose_reading(signals, db_session, user_id, "UTC", vault) is None
    vault.recommend_reading.assert_awaited_once()


@pytest.mark.asyncio
async def test_recommendation_dials_with_no_request_connection_held(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """The content-bearing invitation path releases its transaction before inference."""
    user_id, _, content = await seed(db_session)
    db_session.add(
        InvitationSignal(user_id=user_id, target_type="course", target_id=1, kind="readiness")
    )
    await db_session.commit()
    vault = ModelVault()
    with observe_outbound_boundaries(app) as observer:
        app.dependency_overrides[get_current_user] = lambda: user_id
        app.dependency_overrides[get_creek_vault_client] = lambda: vault
        try:
            response = await async_client.get("/invitations")
            assert response.status_code == 200, response.text
            assert response.json()[0]["reading"]["content_id"] == content.id
            calls = [
                record
                for record in observer.observations
                if record.leaf == "CreekVaultClient.recommend_reading"
            ]
            assert len(calls) == 1
            assert_dialled_off_the_pool(calls, what="the grounded reading model call")
        finally:
            app.dependency_overrides.pop(get_current_user, None)
            app.dependency_overrides.pop(get_creek_vault_client, None)
