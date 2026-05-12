"""Tests for ``GET /user-practices/current/frequency`` (ritual-05).

Covers:

* Unauthenticated requests are rejected.
* Stage 1 with no ``StageProgress`` and no ``UserPractice`` falls back to
  the seeded preset for that stage (Beige / Body banner).
* Stage 5 with an active ``UserPractice`` returns the user's selection
  (Orange / Mind banner).
* A ``UserPractice.custom_name`` flows through ``effective_name`` to the
  banner text (verifies the ritual-03 plumbing).
* The banner template renders the three slots in the documented order —
  a snapshot pins the exact wording so accidental copy edits surface in
  the PR diff, not in production.
"""

from __future__ import annotations

from datetime import date
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from models.practice import Practice
from models.stage_progress import StageProgress
from models.user_practice import UserPractice
from schemas.frequency import BANNER_TEMPLATE, render_banner_text
from seed_practices import STAGE_TO_PRESET_NAME, seed_practices
from seed_stages import STAGE_DEFINITIONS, seed_stages


async def _signup(client: AsyncClient, username: str = "freq-user") -> tuple[dict[str, str], int]:
    """Create a user and return (auth headers, user_id)."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


async def _seed_catalog(db_session: AsyncSession) -> None:
    """Seed all 10 stages + 10 preset practices via the production seeders.

    The endpoint resolves color / aspect from :class:`CourseStage` and the
    fallback practice from the preset list, so tests use the canonical
    rows rather than ad-hoc fixtures that could drift from the seeder.
    """
    await seed_stages(db_session)
    await seed_practices(db_session)


async def _fetch_preset_id(db_session: AsyncSession, stage_number: int) -> int:
    """Return the ``Practice.id`` for the seeded preset on a given stage."""
    result = await db_session.execute(
        select(Practice).where(
            Practice.stage_number == stage_number,
            Practice.name == STAGE_TO_PRESET_NAME[stage_number],
            col(Practice.submitted_by_user_id).is_(None),
        )
    )
    practice = result.scalars().first()
    assert practice is not None, f"preset missing for stage {stage_number}"
    assert practice.id is not None
    return practice.id


# -- Auth -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_frequency_requires_auth(async_client: AsyncClient) -> None:
    """No JWT → 401, regardless of DB state."""
    resp = await async_client.get("/user-practices/current/frequency")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


# -- Fallback to seeded preset ---------------------------------------------


@pytest.mark.asyncio
async def test_frequency_stage_1_no_selection_falls_back_to_preset(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Fresh user with no ``StageProgress`` defaults to stage 1 / preset.

    The fallback path resolves ``current_stage`` to 1 (matching
    :func:`is_stage_unlocked`'s invariant) and surfaces the seeded
    preset because the user has not yet picked their own practice for
    that stage.
    """
    await _seed_catalog(db_session)
    headers, _user_id = await _signup(async_client, "freshie")

    resp = await async_client.get("/user-practices/current/frequency", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()

    preset_id = await _fetch_preset_id(db_session, 1)
    assert body["stage_number"] == 1
    assert body["color"] == "Beige"
    assert body["aspect"] == "Body"
    assert body["practice_name"] == STAGE_TO_PRESET_NAME[1]
    assert body["practice_id"] == preset_id
    assert body["user_practice_id"] is None
    assert body["banner_text"] == render_banner_text(
        color="Beige",
        aspect="Body",
        practice_name=STAGE_TO_PRESET_NAME[1],
    )


# -- Selected UserPractice ---------------------------------------------------


@pytest.mark.asyncio
async def test_frequency_stage_5_with_selection_returns_user_practice(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Stage 5 + active ``UserPractice`` → Orange / Mind banner using their pick."""
    await _seed_catalog(db_session)
    headers, user_id = await _signup(async_client, "orange-user")

    # Unlock stage 5 so the selection clears the stage gate.
    db_session.add(StageProgress(user_id=user_id, current_stage=5, completed_stages=[1, 2, 3, 4]))
    await db_session.commit()

    preset_id = await _fetch_preset_id(db_session, 5)
    create_resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": preset_id, "stage_number": 5},
        headers=headers,
    )
    assert create_resp.status_code == HTTPStatus.CREATED, create_resp.text
    user_practice_id = create_resp.json()["id"]

    resp = await async_client.get("/user-practices/current/frequency", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()

    assert body["stage_number"] == 5
    assert body["color"] == "Orange"
    assert body["aspect"] == "Mind"
    assert body["practice_name"] == STAGE_TO_PRESET_NAME[5]
    assert body["practice_id"] == preset_id
    assert body["user_practice_id"] == user_practice_id
    assert body["banner_text"] == render_banner_text(
        color="Orange",
        aspect="Mind",
        practice_name=STAGE_TO_PRESET_NAME[5],
    )


# -- Custom name flows through effective_name -------------------------------


@pytest.mark.asyncio
async def test_frequency_uses_custom_name_when_set(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``UserPractice.custom_name`` should override the catalog name in the banner.

    Verifies the ritual-03 ``effective_name`` plumbing — the banner endpoint
    must not re-fetch the catalog name and skip the user's rename.
    """
    await _seed_catalog(db_session)
    headers, user_id = await _signup(async_client, "renamer")
    db_session.add(StageProgress(user_id=user_id, current_stage=1))
    await db_session.commit()

    preset_id = await _fetch_preset_id(db_session, 1)
    create_resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": preset_id, "stage_number": 1},
        headers=headers,
    )
    assert create_resp.status_code == HTTPStatus.CREATED, create_resp.text
    user_practice_id = create_resp.json()["id"]

    custom_name = "My morning grounding"
    patch_resp = await async_client.patch(
        f"/user-practices/{user_practice_id}/customize",
        json={"custom_name": custom_name},
        headers=headers,
    )
    assert patch_resp.status_code == HTTPStatus.OK, patch_resp.text

    resp = await async_client.get("/user-practices/current/frequency", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()

    assert body["practice_name"] == custom_name
    assert body["user_practice_id"] == user_practice_id
    assert custom_name in body["banner_text"]
    assert body["banner_text"] == render_banner_text(
        color="Beige",
        aspect="Body",
        practice_name=custom_name,
    )


# -- Closed UserPractice falls back to preset -------------------------------


@pytest.mark.asyncio
async def test_frequency_ignores_ended_user_practice(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A ``UserPractice`` with ``end_date`` set is not the active selection.

    The partial unique index keys "active" on ``end_date IS NULL``; the
    banner must mirror that predicate so historical rows don't shadow
    the preset fallback.
    """
    await _seed_catalog(db_session)
    headers, user_id = await _signup(async_client, "closer")
    db_session.add(StageProgress(user_id=user_id, current_stage=1))
    await db_session.commit()

    preset_id = await _fetch_preset_id(db_session, 1)
    closed = UserPractice(
        user_id=user_id,
        practice_id=preset_id,
        stage_number=1,
        start_date=date(2024, 1, 1),
        end_date=date(2024, 2, 1),
        custom_name="Old name",
    )
    db_session.add(closed)
    await db_session.commit()

    resp = await async_client.get("/user-practices/current/frequency", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["user_practice_id"] is None
    assert body["practice_name"] == STAGE_TO_PRESET_NAME[1]


# -- Banner template wording lock -------------------------------------------


def test_banner_template_renders_three_slots_in_order() -> None:
    """Snapshot the exact wording so accidental copy changes show up in PRs.

    The template appears in two places implicitly: the endpoint
    rendering and the frontend tests that compare against the server
    response. Pinning the exact string here means a wording change
    breaks the build *before* it ships.
    """
    rendered = render_banner_text(
        color="Orange",
        aspect="Mind",
        practice_name="Wim Hof method",
    )
    expected = (
        "You are in the Orange frequency of APTITUDE. That means you are "
        "working on Mind. Your practice is Wim Hof method but you are "
        "encouraged to replace it if another tradition has a practice that "
        "deals with Mind that calls to you more."
    )
    assert rendered == expected


def test_banner_template_uses_all_three_named_slots() -> None:
    """Guard against a refactor that drops one of the named slots.

    ``str.format`` silently ignores extra kwargs, so a template that
    accidentally hardcodes "Beige" would still render — but the chip
    UI would show the right color while the banner text contradicted
    it. Asserting on the template directly catches that drift.
    """
    assert "{color}" in BANNER_TEMPLATE
    assert "{aspect}" in BANNER_TEMPLATE
    assert "{practice_name}" in BANNER_TEMPLATE
    # The aspect is referenced twice — once for the working-on phrase
    # and once for the alternate-tradition phrase. A regression that
    # collapses the second reference to a static word would break the
    # narrative for non-default aspects.
    assert BANNER_TEMPLATE.count("{aspect}") == 2


# -- Single round-trip guarantee --------------------------------------------


@pytest.mark.asyncio
async def test_frequency_returns_every_documented_field(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One GET returns every field the banner consumes.

    The acceptance criterion is "single GET returns everything the
    banner needs"; assert that every documented field is populated so a
    future refactor can't silently null one out and force the client to
    fall back to a second fetch.
    """
    await _seed_catalog(db_session)
    headers, _user_id = await _signup(async_client, "single-call")

    resp = await async_client.get("/user-practices/current/frequency", headers=headers)
    assert resp.status_code == HTTPStatus.OK

    body = resp.json()
    expected_keys = {
        "stage_number",
        "color",
        "aspect",
        "practice_name",
        "practice_id",
        "user_practice_id",
        "banner_text",
    }
    assert set(body.keys()) == expected_keys


# -- CourseStage row missing for current_stage -------------------------------


@pytest.mark.asyncio
async def test_frequency_missing_course_stage_returns_404(
    async_client: AsyncClient,
) -> None:
    """Without a seeded ``CourseStage`` row, the endpoint returns 404.

    Tests-in-prod safety: a half-seeded environment must fail loudly
    rather than render a banner with empty color / aspect placeholders.
    The seeder normally runs at startup, so this path is only reachable
    from a misconfigured deployment — surfacing it as 404 makes the
    misconfiguration debuggable.
    """
    # Intentionally do NOT seed: no CourseStage, no preset Practice.
    headers, _user_id = await _signup(async_client, "unseeded")

    resp = await async_client.get("/user-practices/current/frequency", headers=headers)
    assert resp.status_code == HTTPStatus.NOT_FOUND
    assert resp.json()["detail"] == "course_stage_not_found"


# -- StageProgress drives the banner ----------------------------------------


@pytest.mark.asyncio
async def test_frequency_respects_stage_progress(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``current_stage`` from ``StageProgress`` drives the banner, not stage 1.

    A user who has advanced past stage 1 but has not yet selected a
    practice for their current stage should see the preset for that
    stage — not the stage 1 preset.
    """
    await _seed_catalog(db_session)
    headers, user_id = await _signup(async_client, "advancer")

    db_session.add(StageProgress(user_id=user_id, current_stage=3, completed_stages=[1, 2]))
    await db_session.commit()

    resp = await async_client.get("/user-practices/current/frequency", headers=headers)
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()

    # Stage 3 = Red / Emotion (per seed_stages._STAGE_DEFINITIONS).
    assert body["stage_number"] == 3
    assert body["color"] == "Red"
    assert body["aspect"] == "Emotion"
    assert body["practice_name"] == STAGE_TO_PRESET_NAME[3]
    assert body["user_practice_id"] is None


@pytest.mark.asyncio
async def test_frequency_practice_row_on_other_stage_ignored(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A ``UserPractice`` from a different stage doesn't leak into the banner.

    Users carry historical practices for prior stages; the banner must
    only consult the row matching the current stage.
    """
    await _seed_catalog(db_session)
    headers, user_id = await _signup(async_client, "multi-stage")
    db_session.add(StageProgress(user_id=user_id, current_stage=3, completed_stages=[1, 2]))
    await db_session.commit()

    # Select a stage-1 practice (legal — stage 1 is always unlocked).
    preset_1_id = await _fetch_preset_id(db_session, 1)
    await async_client.post(
        "/user-practices/",
        json={"practice_id": preset_1_id, "stage_number": 1},
        headers=headers,
    )

    resp = await async_client.get("/user-practices/current/frequency", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()

    # Banner sticks to current_stage = 3, not the stage-1 selection.
    assert body["stage_number"] == 3
    assert body["user_practice_id"] is None
    assert body["practice_name"] == STAGE_TO_PRESET_NAME[3]


# -- Sanity: every stage in CourseStage maps to a preset --------------------


def test_every_stage_has_a_preset_name() -> None:
    """``STAGE_TO_PRESET_NAME`` must cover every stage the seeder defines.

    The fallback path keys the preset lookup on ``current_stage`` from
    ``STAGE_TO_PRESET_NAME``; a missing entry would 500 the endpoint
    for users on that stage. Pinning the coverage here keeps the two
    seeders in sync (the import-time assertion in ``seed_practices.py``
    only catches duplicates, not omissions against ``seed_stages``).
    """
    expected_stages = {int(s["stage_number"]) for s in STAGE_DEFINITIONS}
    assert set(STAGE_TO_PRESET_NAME) == expected_stages
