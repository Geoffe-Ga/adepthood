"""Tests for the manifest-driven seed_content script.

``StageContent`` rows are now reconciled from the vendored content
manifest via :class:`ContentRepository` — not from the deleted
``STAGE_PLANS`` hardcode. Chapters carry a local ``content://<id>``
reference instead of a remote CMS URL.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from content_config import CONTENT_REF_SCHEME, all_chapter_records, content_ref
from models.content_completion import ContentCompletion
from models.course_stage import CourseStage
from models.stage_content import StageContent
from models.user import User
from seed_content import (
    SeedContentStageMissingError,
    desired_content_records,
    seed_content,
)
from services.content_repository import (
    ContentRepository,
    reset_content_repository_for_tests,
    set_content_repository_for_tests,
)

# Resolved once at import (not inside async tests — pathlib in an async def trips
# ASYNC240) so the real vendored content dir is reusable across tests.
_VENDORED_CONTENT_DIR = Path(__file__).resolve().parent.parent / "content"

# Stage 1 (Beige) ships exactly 17 chapters in the vendored manifest.
_VENDORED_STAGE_ONE_CHAPTER_COUNT = 17


def _chapter(
    chapter_id: str,
    stage: int,
    title: str,
    release_day: int,
    content_type: str = "chapter",
) -> dict[str, Any]:
    """One manifest chapter entry; the number comes from the id suffix."""
    number = int(chapter_id.rsplit("-", 1)[1])
    return {
        "id": chapter_id,
        "stage": stage,
        "chapter": number,
        "slug": title.lower().replace(" ", "-"),
        "title": title,
        "content_type": content_type,
        "release_day": release_day,
        "order": number,
        "path": f"markdown/{stage:02d}/{number:02d}.md",
    }


_MANIFEST: dict[str, Any] = {
    "schema_version": "1.0.0",
    "chapters": [
        _chapter("beige-1", 1, "Survival", 0),
        _chapter("beige-2", 1, "Breath as Anchor", 3, content_type="essay"),
        _chapter("teal-1", 4, "Systems Sight", 0),
    ],
    "site_resources": [],
}

# Covers only stage 1 -- a partial manifest whose only stage has a CourseStage row.
_STAGE_ONE_ONLY_MANIFEST: dict[str, Any] = {
    "schema_version": "1.0.0",
    "chapters": [
        _chapter("beige-1", 1, "Survival", 0),
        _chapter("beige-2", 1, "Breath as Anchor", 3, content_type="essay"),
    ],
    "site_resources": [],
}


@pytest.fixture
def install_manifest(tmp_path: Path) -> Iterator[Callable[[dict[str, Any]], None]]:
    """Install a manifest into the process-wide ContentRepository singleton."""

    def install(manifest: dict[str, Any]) -> None:
        root = tmp_path / "content"
        root.mkdir(exist_ok=True)
        (root / "manifest.json").write_text(json.dumps(manifest))
        for chapter in manifest["chapters"]:
            md = root / chapter["path"]
            md.parent.mkdir(parents=True, exist_ok=True)
            md.write_text(f"# {chapter['title']}\n")
        set_content_repository_for_tests(ContentRepository(root))

    yield install
    reset_content_repository_for_tests()


async def _seed_stages(db_session: AsyncSession, count: int = 4) -> None:
    """Insert test stages into the DB."""
    for i in range(1, count + 1):
        stage = CourseStage(
            title=f"Stage {i}",
            subtitle=f"Subtitle {i}",
            stage_number=i,
            overview_url=f"https://example.com/stage-{i}",
            category="test",
            aspect="test-aspect",
            spiral_dynamics_color="beige",
            growing_up_stage="archaic",
            divine_gender_polarity="masculine",
            relationship_to_free_will="active",
            free_will_description="Active Yes-And-Ness",
        )
        db_session.add(stage)
    await db_session.commit()


# ── content_config: manifest-driven records ─────────────────────────────


def test_all_chapter_records_come_from_manifest(
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    install_manifest(_MANIFEST)
    records = all_chapter_records()
    assert [(r.stage_number, r.title) for r in records] == [
        (1, "Survival"),
        (1, "Breath as Anchor"),
        (4, "Systems Sight"),
    ]
    assert records[0].url == content_ref("beige-1")
    assert records[1].release_day == 3
    assert records[1].content_type == "essay"


def test_all_chapter_records_empty_without_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Bootstrap state — no vendored manifest yet — degrades to no records."""
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("CONTENT_DIR", str(empty))
    reset_content_repository_for_tests()
    try:
        assert all_chapter_records() == []
    finally:
        reset_content_repository_for_tests()


def test_vendored_content_pin_lists_real_chapters_and_resources() -> None:
    """The vendored content pin (course-cms-06) carries real chapters + resources.

    Guards the activation: an empty ``backend/content`` (the pre-vendor state)
    would seed zero StageContent rows and leave the Course screen blank.
    """
    repo = ContentRepository(_VENDORED_CONTENT_DIR)
    chapters = repo.list_chapters()
    resources = repo.list_resources()
    assert chapters, "vendored manifest should list chapters"
    assert {c.stage for c in chapters}, "chapters should cover at least one stage"
    assert resources, "vendored manifest should list site resources"


@pytest.mark.asyncio
async def test_seed_content_populates_stage_one_from_vendored_manifest(
    db_session: AsyncSession,
) -> None:
    """Regression guard (#767): seeding the vendored manifest fills Stage 1.

    Before the content pin shipped, Stage 1 had neither placeholder rows nor
    manifest content, so the Course screen showed "No Content Yet" / "0/0". The
    vendored manifest now covers Stage 1; seeding must produce non-zero
    StageContent for it so the entry stage is never silently empty again.
    """
    set_content_repository_for_tests(ContentRepository(_VENDORED_CONTENT_DIR))
    try:
        await _seed_stages(db_session, count=10)
        await seed_content(db_session)
        stage_one = (
            (await db_session.execute(select(CourseStage).where(CourseStage.stage_number == 1)))
            .scalars()
            .one()
        )
        rows = (
            (
                await db_session.execute(
                    select(StageContent).where(StageContent.course_stage_id == stage_one.id)
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == _VENDORED_STAGE_ONE_CHAPTER_COUNT
    finally:
        reset_content_repository_for_tests()


@pytest.mark.asyncio
async def test_seed_content_raises_when_manifest_stage_has_no_course_stage_row(
    db_session: AsyncSession,
) -> None:
    """A manifest stage with no matching CourseStage row must fail loudly, not silently."""
    set_content_repository_for_tests(ContentRepository(_VENDORED_CONTENT_DIR))
    try:
        with pytest.raises(SeedContentStageMissingError, match=r"no CourseStage row: \[1"):
            await seed_content(db_session)
    finally:
        reset_content_repository_for_tests()


@pytest.mark.asyncio
async def test_seed_content_raises_naming_only_the_unmapped_manifest_stage(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """A partial seed raises for the missing manifest stage while mapped stages seed fine."""
    install_manifest(_MANIFEST)  # ships stages 1 and 4
    await _seed_stages(db_session, count=1)  # only stage 1 has a CourseStage row

    with pytest.raises(SeedContentStageMissingError, match=r"no CourseStage row: \[4\]"):
        await seed_content(db_session)

    # The raise fires before any write, so stage 1's mapped chapters never land.
    rows = (await db_session.execute(select(StageContent))).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_seed_content_partial_manifest_seeds_when_its_stages_are_mapped(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """A subset manifest seeds cleanly when its stages all have CourseStage rows."""
    install_manifest(_STAGE_ONE_ONLY_MANIFEST)
    await _seed_stages(db_session, count=1)

    inserted = await seed_content(db_session)

    assert inserted == len(_STAGE_ONE_ONLY_MANIFEST["chapters"])
    result = await db_session.execute(select(StageContent))
    rows = result.scalars().all()
    assert [r.title for r in rows] == ["Survival", "Breath as Anchor"]


def test_content_ref_format() -> None:
    assert content_ref("beige-1") == "content://beige-1"


# ── seeding ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_seed_content_inserts_manifest_chapters(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """Every manifest chapter is inserted as a StageContent row."""
    install_manifest(_MANIFEST)
    await _seed_stages(db_session, count=4)
    inserted = await seed_content(db_session)
    expected_total = len(_MANIFEST["chapters"])
    assert inserted == expected_total

    result = await db_session.execute(select(StageContent))
    assert len(result.scalars().all()) == expected_total


@pytest.mark.asyncio
async def test_seed_content_idempotent(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    install_manifest(_MANIFEST)
    await _seed_stages(db_session, count=4)
    first = await seed_content(db_session)
    second = await seed_content(db_session)
    assert first > 0
    assert second == 0


@pytest.mark.asyncio
async def test_seed_content_no_stages_raises_for_manifest_coverage(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """No CourseStage rows at all means every manifest stage is unmapped -- loud, not silent."""
    install_manifest(_MANIFEST)  # ships stages 1 and 4
    with pytest.raises(SeedContentStageMissingError, match=r"no CourseStage row: \[1, 4\]"):
        await seed_content(db_session)


@pytest.mark.asyncio
async def test_seeded_rows_carry_local_refs_not_urls(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """Manifest chapters land with content:// references; no remote URLs."""
    install_manifest(_MANIFEST)
    await _seed_stages(db_session, count=4)
    await seed_content(db_session)

    result = await db_session.execute(
        select(StageContent).join(CourseStage).where(CourseStage.stage_number == 1)
    )
    items = sorted(result.scalars().all(), key=lambda i: i.release_day)
    assert [i.title for i in items] == ["Survival", "Breath as Anchor"]
    assert [i.url for i in items] == [content_ref("beige-1"), content_ref("beige-2")]
    assert [i.release_day for i in items] == [0, 3]

    everything = (await db_session.execute(select(StageContent))).scalars().all()
    assert all(urlparse(row.url).scheme == CONTENT_REF_SCHEME for row in everything)


@pytest.mark.asyncio
async def test_seed_content_reconciles_ref_drift(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """A row whose reference drifted is updated in place, not duplicated."""
    install_manifest(_MANIFEST)
    await _seed_stages(db_session, count=4)
    await seed_content(db_session)

    result = await db_session.execute(select(StageContent).where(StageContent.title == "Survival"))
    row = result.scalars().one()
    row.url = "https://aptitude.guru/course/beige-1"
    await db_session.commit()

    inserted = await seed_content(db_session)
    assert inserted == 0
    await db_session.refresh(row)
    assert row.url == content_ref("beige-1")


@pytest.mark.asyncio
async def test_read_completions_survive_content_resync(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """Regression: a re-seed after a manifest change never orphans read marks."""
    install_manifest(_MANIFEST)
    await _seed_stages(db_session, count=4)
    await seed_content(db_session)

    result = await db_session.execute(select(StageContent).where(StageContent.title == "Survival"))
    row = result.scalars().one()
    assert row.id is not None
    user = User(email="reader@example.com", password_hash="x")
    db_session.add(user)
    await db_session.commit()
    assert user.id is not None
    db_session.add(ContentCompletion(user_id=user.id, content_id=row.id))
    await db_session.commit()

    # Content team moves Survival's drip day; the row must update in place.
    moved = json.loads(json.dumps(_MANIFEST))
    moved["chapters"][0]["release_day"] = 1
    install_manifest(moved)
    inserted = await seed_content(db_session)
    assert inserted == 0

    await db_session.refresh(row)
    assert row.release_day == 1
    completions = (await db_session.execute(select(ContentCompletion))).scalars().all()
    assert len(completions) == 1
    assert completions[0].content_id == row.id


def test_desired_content_records_counts(
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    install_manifest(_MANIFEST)
    records = desired_content_records()
    assert len(records) == len(_MANIFEST["chapters"])
    assert {r.url for r in records} == {content_ref(c["id"]) for c in _MANIFEST["chapters"]}
