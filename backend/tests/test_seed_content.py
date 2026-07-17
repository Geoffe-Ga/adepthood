"""Tests for the manifest-driven seed_content script.

``StageContent`` rows are now reconciled from the vendored content
manifest via :class:`ContentRepository` — not from the deleted
``STAGE_PLANS`` hardcode. Chapters carry a local ``content://<id>``
reference instead of a remote CMS URL.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.parse import urlparse

import pytest
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from content_config import CONTENT_REF_SCHEME, all_chapter_records, content_ref
from models.content_completion import ContentCompletion
from models.course_stage import CourseStage
from models.stage_content import StageContent
from models.user import User
from seed_content import desired_content_records, seed_content
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


def test_vendored_content_pin_lists_stage_intros() -> None:
    """The vendored content pin (course-cms-07, #723) carries stage_intros[].

    Guards the activation this issue is for: a pin from before the content
    repo shipped ``stage_intros[]`` (schema 1.0.0) would leave every stage's
    intro card 404ing. Checks all 10 stages (not just stage 1) so a future
    re-vendor that silently drops some stages' intros is caught, and
    exercises ``read_intro_body`` end-to-end against the real vendored
    Markdown, not a fixture.
    """
    repo = ContentRepository(_VENDORED_CONTENT_DIR)
    for stage in range(1, 11):
        intro = repo.get_stage_intro(stage)
        assert intro is not None, f"vendored manifest should expose a stage {stage} intro"
        body = repo.read_intro_body(stage)
        assert body.body, f"read_intro_body({stage}) should return non-empty Markdown"
        assert body.title == intro.title


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
async def test_seed_content_with_no_stage_rows_writes_nothing_and_warns(
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """No CourseStage rows at all: stays resilient, warns loudly, writes nothing."""
    set_content_repository_for_tests(ContentRepository(_VENDORED_CONTENT_DIR))
    try:
        with caplog.at_level(logging.WARNING, logger="seed_content"):
            inserted = await seed_content(db_session)
        assert inserted == 0
        rows = (await db_session.execute(select(StageContent))).scalars().all()
        assert rows == []
        warnings = [record.getMessage() for record in caplog.records]
        assert any("content_seed_partial" in message for message in warnings)
    finally:
        reset_content_repository_for_tests()


@pytest.mark.asyncio
async def test_seed_content_seeds_stage_one_even_when_higher_stages_unmapped(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A mapped stage seeds fully while an unmapped higher stage only draws a warning."""
    install_manifest(_MANIFEST)  # ships stages 1 and 4
    await _seed_stages(db_session, count=1)  # only stage 1 has a CourseStage row

    with caplog.at_level(logging.WARNING, logger="seed_content"):
        inserted = await seed_content(db_session)

    assert inserted == 2
    rows = (await db_session.execute(select(StageContent))).scalars().all()
    assert [r.title for r in rows] == ["Survival", "Breath as Anchor"]
    warnings = [record.getMessage() for record in caplog.records]
    assert any("4" in message for message in warnings)


@pytest.mark.asyncio
async def test_seed_content_preserves_stage_one_chapter_count_when_stage_four_unmapped(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """Unlocked stages must always show their content, even with higher stages unmapped."""
    install_manifest(_MANIFEST)  # ships stages 1 and 4
    await _seed_stages(db_session, count=1)  # only stage 1 has a CourseStage row

    await seed_content(db_session)

    expected_stage_one_chapters = sum(1 for c in _MANIFEST["chapters"] if c["stage"] == 1)
    result = await db_session.execute(
        select(StageContent).join(CourseStage).where(CourseStage.stage_number == 1)
    )
    rows = result.scalars().all()
    assert len(rows) == expected_stage_one_chapters


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
async def test_seed_content_no_stages_warns_for_manifest_coverage(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """No CourseStage rows at all means every manifest stage is unmapped -- warn, not raise."""
    install_manifest(_MANIFEST)  # ships stages 1 and 4

    with caplog.at_level(logging.WARNING, logger="seed_content"):
        inserted = await seed_content(db_session)

    assert inserted == 0
    rows = (await db_session.execute(select(StageContent))).scalars().all()
    assert rows == []
    warnings = [record.getMessage() for record in caplog.records]
    assert any("1" in message and "4" in message for message in warnings)


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
async def test_seed_content_reconciles_title_drift(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """A title edit on a stable content ref updates the row in place, not duplicated."""
    install_manifest(_MANIFEST)
    await _seed_stages(db_session, count=4)
    await seed_content(db_session)

    result = await db_session.execute(select(StageContent).where(StageContent.title == "Survival"))
    row = result.scalars().one()
    assert row.id is not None
    assert row.url == content_ref("beige-1")
    original_id = row.id

    moved = json.loads(json.dumps(_MANIFEST))
    moved["chapters"][0]["title"] = "Survival (revised)"
    install_manifest(moved)

    inserted = await seed_content(db_session)
    assert inserted == 0

    result = await db_session.execute(
        select(StageContent).where(StageContent.url == content_ref("beige-1"))
    )
    survivors = result.scalars().all()
    assert len(survivors) == 1
    assert survivors[0].title == "Survival (revised)"
    assert survivors[0].id == original_id


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


# ── pruning ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_seed_content_prunes_legacy_placeholder_row(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """A stale row from a retired manifest chapter is deleted on a reconciled stage."""
    await _seed_stages(db_session, count=1)
    stage_one = (await db_session.execute(select(CourseStage))).scalars().one()
    db_session.add(
        StageContent(
            course_stage_id=stage_one.id,
            title="Chapter 3",
            content_type="chapter",
            release_day=0,
            url="https://legacy.example.com/3",
        )
    )
    await db_session.commit()

    install_manifest(_MANIFEST)
    await seed_content(db_session)

    rows = (await db_session.execute(select(StageContent))).scalars().all()
    titles = {r.title for r in rows}
    assert "Chapter 3" not in titles
    assert {"Survival", "Breath as Anchor"} <= titles


@pytest.mark.asyncio
async def test_seed_content_prunes_duplicate_title_twin_repointing_completion(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """A stale twin sharing a claimed title is pruned and its read mark repointed."""
    install_manifest(_MANIFEST)
    await _seed_stages(db_session, count=1)
    await seed_content(db_session)

    survivor = (
        (await db_session.execute(select(StageContent).where(StageContent.title == "Survival")))
        .scalars()
        .one()
    )

    stale_twin = StageContent(
        course_stage_id=survivor.course_stage_id,
        title="Survival",
        content_type="chapter",
        release_day=0,
        url="https://legacy.example.com/survival",
    )
    db_session.add(stale_twin)
    await db_session.commit()
    assert stale_twin.id is not None

    user = User(email="twin-reader@example.com", password_hash="x")
    db_session.add(user)
    await db_session.commit()
    assert user.id is not None
    db_session.add(ContentCompletion(user_id=user.id, content_id=stale_twin.id))
    await db_session.commit()

    await seed_content(db_session)

    remaining_ids = {r.id for r in (await db_session.execute(select(StageContent))).scalars().all()}
    assert stale_twin.id not in remaining_ids
    assert survivor.id in remaining_ids

    completions = (await db_session.execute(select(ContentCompletion))).scalars().all()
    assert len(completions) == 1
    assert completions[0].content_id == survivor.id


@pytest.mark.asyncio
async def test_seed_content_prune_completion_collision_drops_stale_mark(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """A user with completions on both a stale twin and its survivor keeps only the survivor's."""
    install_manifest(_MANIFEST)
    await _seed_stages(db_session, count=1)
    await seed_content(db_session)

    survivor = (
        (await db_session.execute(select(StageContent).where(StageContent.title == "Survival")))
        .scalars()
        .one()
    )

    stale_twin = StageContent(
        course_stage_id=survivor.course_stage_id,
        title="Survival",
        content_type="chapter",
        release_day=0,
        url="https://legacy.example.com/survival",
    )
    db_session.add(stale_twin)
    await db_session.commit()
    assert stale_twin.id is not None

    user = User(email="collision-reader@example.com", password_hash="x")
    db_session.add(user)
    await db_session.commit()
    assert user.id is not None
    db_session.add(ContentCompletion(user_id=user.id, content_id=survivor.id))
    db_session.add(ContentCompletion(user_id=user.id, content_id=stale_twin.id))
    await db_session.commit()

    await seed_content(db_session)

    completions = (
        (
            await db_session.execute(
                select(ContentCompletion).where(ContentCompletion.user_id == user.id)
            )
        )
        .scalars()
        .all()
    )
    assert len(completions) == 1
    assert completions[0].content_id == survivor.id


@pytest.mark.asyncio
async def test_seed_content_prune_collapses_marks_across_multiple_twins(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """Two stale twins of one survivor with the same reader collapse to a single mark."""
    install_manifest(_MANIFEST)
    await _seed_stages(db_session, count=1)
    await seed_content(db_session)

    survivor = (
        (await db_session.execute(select(StageContent).where(StageContent.title == "Survival")))
        .scalars()
        .one()
    )

    twin_urls = ["https://legacy.example.com/survival-a", "https://legacy.example.com/survival-b"]
    twins = [
        StageContent(
            course_stage_id=survivor.course_stage_id,
            title="Survival",
            content_type="chapter",
            release_day=0,
            url=url,
        )
        for url in twin_urls
    ]
    for twin in twins:
        db_session.add(twin)
    await db_session.commit()

    user = User(email="multi-twin-reader@example.com", password_hash="x")
    db_session.add(user)
    await db_session.commit()
    assert user.id is not None
    for twin in twins:
        assert twin.id is not None
        db_session.add(ContentCompletion(user_id=user.id, content_id=twin.id))
    await db_session.commit()

    await seed_content(db_session)

    survivors = (
        (await db_session.execute(select(StageContent).where(StageContent.title == "Survival")))
        .scalars()
        .all()
    )
    assert [row.id for row in survivors] == [survivor.id]
    completions = (
        (
            await db_session.execute(
                select(ContentCompletion).where(ContentCompletion.user_id == user.id)
            )
        )
        .scalars()
        .all()
    )
    assert len(completions) == 1
    assert completions[0].content_id == survivor.id


@pytest.mark.asyncio
async def test_seed_content_prunes_nothing_on_fresh_manifest_db(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A first-ever seed with no stale rows prunes nothing and stays silent."""
    install_manifest(_MANIFEST)
    await _seed_stages(db_session, count=4)
    await seed_content(db_session)

    rows = (await db_session.execute(select(StageContent))).scalars().all()
    assert len(rows) == len(_MANIFEST["chapters"])

    with caplog.at_level(logging.WARNING, logger="seed_content"):
        second = await seed_content(db_session)

    assert second == 0
    rows_after = (await db_session.execute(select(StageContent))).scalars().all()
    assert len(rows_after) == len(_MANIFEST["chapters"])
    warnings = [record.getMessage() for record in caplog.records]
    assert not any("content_seed_pruned" in message for message in warnings)


@pytest.mark.asyncio
async def test_seed_content_prune_is_idempotent(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A second seed after a prune has already happened inserts and prunes nothing more."""
    await _seed_stages(db_session, count=1)
    stage_one = (await db_session.execute(select(CourseStage))).scalars().one()
    db_session.add(
        StageContent(
            course_stage_id=stage_one.id,
            title="Chapter 3",
            content_type="chapter",
            release_day=0,
            url="https://legacy.example.com/3",
        )
    )
    await db_session.commit()

    install_manifest(_MANIFEST)
    await seed_content(db_session)

    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="seed_content"):
        second = await seed_content(db_session)

    assert second == 0
    rows = (await db_session.execute(select(StageContent))).scalars().all()
    titles = {r.title for r in rows}
    assert "Chapter 3" not in titles
    warnings = [record.getMessage() for record in caplog.records]
    assert not any("content_seed_pruned" in message for message in warnings)


@pytest.mark.asyncio
async def test_seed_content_prune_scope_spares_unshipped_and_skipped_stages(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """Pruning only ever touches stages the current manifest reconciles this run."""
    install_manifest(_MANIFEST)
    await _seed_stages(db_session, count=4)
    await seed_content(db_session)

    stage_five = CourseStage(
        title="Stage 5",
        subtitle="Subtitle 5",
        stage_number=5,
        overview_url="https://example.com/stage-5",
        category="test",
        aspect="test-aspect",
        spiral_dynamics_color="beige",
        growing_up_stage="archaic",
        divine_gender_polarity="masculine",
        relationship_to_free_will="active",
        free_will_description="Active Yes-And-Ness",
    )
    db_session.add(stage_five)
    await db_session.commit()
    assert stage_five.id is not None
    db_session.add(
        StageContent(
            course_stage_id=stage_five.id,
            title="Unshipped Fossil",
            content_type="chapter",
            release_day=0,
            url="https://legacy.example.com/unshipped",
        )
    )
    await db_session.commit()

    install_manifest(_STAGE_ONE_ONLY_MANIFEST)
    await seed_content(db_session)

    titles = {r.title for r in (await db_session.execute(select(StageContent))).scalars().all()}
    assert "Systems Sight" in titles
    assert "Unshipped Fossil" in titles


@pytest.mark.asyncio
async def test_seed_content_prunes_fossil_and_drops_orphan_completion(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An unclaimed fossil with no survivor is deleted along with its orphaned read mark."""
    await _seed_stages(db_session, count=1)
    stage_one = (await db_session.execute(select(CourseStage))).scalars().one()
    fossil = StageContent(
        course_stage_id=stage_one.id,
        title="Chapter 1",
        content_type="chapter",
        release_day=0,
        url="https://legacy.example.com/1",
    )
    db_session.add(fossil)
    await db_session.commit()
    assert fossil.id is not None

    user = User(email="fossil-reader@example.com", password_hash="x")
    db_session.add(user)
    await db_session.commit()
    assert user.id is not None
    db_session.add(ContentCompletion(user_id=user.id, content_id=fossil.id))
    await db_session.commit()

    install_manifest(_MANIFEST)
    with caplog.at_level(logging.WARNING, logger="seed_content"):
        await seed_content(db_session)

    remaining_ids = {r.id for r in (await db_session.execute(select(StageContent))).scalars().all()}
    assert fossil.id not in remaining_ids
    completions = (await db_session.execute(select(ContentCompletion))).scalars().all()
    assert completions == []

    prune_records = [r for r in caplog.records if "content_seed_pruned" in r.getMessage()]
    assert len(prune_records) == 1
    match = re.search(
        r"rows=(\d+) completions_repointed=(\d+) completions_deleted=(\d+)",
        prune_records[0].getMessage(),
    )
    assert match is not None
    assert match.group(1) == "1"
    assert match.group(2) == "0"
    assert match.group(3) == "1"


async def _stage_fossil_prune(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
) -> None:
    """Seed a fossil in a reconciled stage so a prune pass is staged."""
    await _seed_stages(db_session, count=1)
    stage_one = (await db_session.execute(select(CourseStage))).scalars().one()
    db_session.add(
        StageContent(
            course_stage_id=stage_one.id,
            title="Chapter 1",
            content_type="chapter",
            release_day=0,
            url="https://legacy.example.com/1",
        )
    )
    await db_session.commit()
    install_manifest(_MANIFEST)


async def _lost_race(_session: AsyncSession) -> bool:
    return False


@pytest.mark.asyncio
async def test_seed_content_race_loser_skips_prune_warning(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A prune the losing worker rolls back must not be logged as persisted.

    Proves a negative; its positive control is the winner test below, which
    shares ``_stage_fossil_prune`` and asserts the same setup *does* warn.
    """
    await _stage_fossil_prune(db_session, install_manifest)

    with (
        patch("seed_content.try_commit_yielding_to_race_winner", new=_lost_race),
        caplog.at_level(logging.WARNING, logger="seed_content"),
    ):
        inserted = await seed_content(db_session)

    assert inserted == 0, "race loser reports no inserts"
    warnings = [record.getMessage() for record in caplog.records]
    assert not any("content_seed_pruned" in message for message in warnings)


@pytest.mark.asyncio
async def test_seed_content_race_winner_still_warns_on_prune(
    db_session: AsyncSession,
    install_manifest: Callable[[dict[str, Any]], None],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The winning worker whose prune persists still emits the summary WARNING."""
    await _stage_fossil_prune(db_session, install_manifest)

    with caplog.at_level(logging.WARNING, logger="seed_content"):
        await seed_content(db_session)

    prune_records = [r for r in caplog.records if "content_seed_pruned" in r.getMessage()]
    assert len(prune_records) == 1
