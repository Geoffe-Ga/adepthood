"""Tests for the PATCH /user-practices/{id}/customize endpoint."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice
from models.practice_session import PracticeSession
from models.stage_progress import StageProgress
from models.user_practice import UserPractice


async def _signup(client: AsyncClient, username: str = "owner") -> tuple[dict[str, str], int]:
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


def _timer_cfg(duration_minutes: float = 10) -> dict[str, object]:
    return {
        "mode": "meditation_timer",
        "duration_minutes": duration_minutes,
        "start_bell": True,
        "halfway_bell": False,
        "end_bell": True,
    }


async def _seed_practice(db_session: AsyncSession, **overrides: object) -> Practice:
    fields: dict[str, object] = {
        "stage_number": 1,
        "name": "Catalog meditation",
        "description": "x",
        "instructions": "x",
        "default_duration_minutes": 10,
        "approved": True,
        "mode": "meditation_timer",
        "mode_config": _timer_cfg(10),
    }
    fields.update(overrides)
    practice = Practice(**fields)
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    return practice


async def _create_user_practice(
    client: AsyncClient,
    db_session: AsyncSession,
    headers: dict[str, str],
    user_id: int,
    practice: Practice,
) -> int:
    """Select a practice and return the resulting user_practice_id."""
    db_session.add(StageProgress(user_id=user_id, current_stage=practice.stage_number))
    await db_session.commit()
    resp = await client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": practice.stage_number},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    return int(resp.json()["id"])


# -- Happy paths ------------------------------------------------------------


@pytest.mark.asyncio
async def test_customize_sets_custom_name(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"custom_name": "My Morning Sit"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["effective_name"] == "My Morning Sit"

    # GET reflects the change.
    refetch = await async_client.get(f"/user-practices/{up_id}", headers=headers)
    assert refetch.json()["effective_name"] == "My Morning Sit"


@pytest.mark.asyncio
async def test_customize_sets_mode_config_override(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    override = {**_timer_cfg(25), "halfway_bell": True}
    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"mode_config_override": override},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    eff_cfg = resp.json()["effective_config"]
    assert eff_cfg["duration_minutes"] == 25
    assert eff_cfg["halfway_bell"] is True


@pytest.mark.asyncio
async def test_customize_clears_override_with_explicit_null(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    # Set an override first.
    await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"mode_config_override": {**_timer_cfg(25)}},
        headers=headers,
    )
    # Then clear it.
    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"mode_config_override": None},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    assert resp.json()["effective_config"]["duration_minutes"] == 10  # catalog default

    # And the underlying override column is null.
    persisted = await db_session.get(UserPractice, up_id)
    assert persisted is not None
    await db_session.refresh(persisted)
    assert persisted.mode_config_override is None


@pytest.mark.asyncio
async def test_customize_partial_patch_preserves_other_field(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A PATCH that touches only one field must not clobber the other.

    ``model_fields_set`` is what makes this work — without it Pydantic
    would deserialize an omitted field as ``None`` and the router would
    happily overwrite the existing override.
    """
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    # 1. Set both fields together.
    both = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"custom_name": "Original", "mode_config_override": _timer_cfg(33)},
        headers=headers,
    )
    assert both.status_code == HTTPStatus.OK

    # 2. PATCH only custom_name → mode_config_override must survive.
    only_name = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"custom_name": "Renamed"},
        headers=headers,
    )
    assert only_name.status_code == HTTPStatus.OK
    body = only_name.json()
    assert body["custom_name"] == "Renamed"
    assert body["mode_config_override"]["duration_minutes"] == 33

    # 3. PATCH only mode_config_override → custom_name must survive.
    only_cfg = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"mode_config_override": _timer_cfg(44)},
        headers=headers,
    )
    assert only_cfg.status_code == HTTPStatus.OK
    body = only_cfg.json()
    assert body["custom_name"] == "Renamed"
    assert body["mode_config_override"]["duration_minutes"] == 44


@pytest.mark.asyncio
async def test_customize_empty_body_is_idempotent_no_op(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """``PATCH {}`` returns 200 without changing anything.

    Pins the documented partial-PATCH contract — no fields set means no
    writes. A future regression that clobbered fields on an empty body
    would fail this test.
    """
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"custom_name": "Sticky", "mode_config_override": _timer_cfg(25)},
        headers=headers,
    )
    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["custom_name"] == "Sticky"
    assert body["mode_config_override"]["duration_minutes"] == 25


@pytest.mark.asyncio
async def test_customize_does_not_mutate_catalog_practice(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Customization must never touch the shared :class:`Practice` row."""
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    catalog_name_before = practice.name
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"custom_name": "Renamed", "mode_config_override": _timer_cfg(60)},
        headers=headers,
    )
    await db_session.refresh(practice)
    assert practice.name == catalog_name_before
    assert practice.mode_config["duration_minutes"] == 10  # unchanged


# -- Error paths ------------------------------------------------------------


@pytest.mark.asyncio
async def test_customize_rejects_mode_mismatch(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"mode_config_override": {"mode": "count_up"}},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert "mode_mismatch" in resp.text


@pytest.mark.asyncio
async def test_customize_rejects_invalid_mode_config(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    bad = {**_timer_cfg(10), "duration_minutes": 0.0}  # below 0.5 minimum
    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"mode_config_override": bad},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_customize_rejects_oversize_mode_config_override(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """An override payload past the size cap is rejected at the schema layer.

    Mitigates payload bloat / DoS via the unbounded JSON column noted in the
    ritual-practice backlog. The cap is generous (8 KiB after JSON encoding)
    so any legitimate ModeConfig — even with the worst-case
    sense_grounding prompt list — fits comfortably.
    """
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    # ~10 KiB payload: the dict has a single oversized junk key. The Pydantic
    # discriminated union would reject this on shape, but the size cap fires
    # first so we get a 413/422 with a clear "too large" message rather than
    # a noisy validation diff.
    huge_override = {**_timer_cfg(10), "_junk": "x" * 10_000}
    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"mode_config_override": huge_override},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    body = resp.json()
    # The message must clearly identify the SIZE guard — not a structural
    # error from the discriminated union or any other validator that happens
    # to mention "size". The literal "too large" is what
    # ``UserPracticeCustomize._cap_override_size`` emits and only what that
    # guard emits, so a regression that re-orders validators or removes the
    # size cap fails this assertion immediately.
    flattened = repr(body).lower()
    assert "too large" in flattened


@pytest.mark.asyncio
async def test_customize_403_on_other_user(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    owner_headers, owner_id = await _signup(async_client, username="owner")
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, owner_headers, owner_id, practice)

    intruder_headers, _ = await _signup(async_client, username="intruder")
    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"custom_name": "stolen"},
        headers=intruder_headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN


@pytest.mark.asyncio
async def test_customize_404_on_missing_id(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.patch(
        "/user-practices/9999/customize",
        json={"custom_name": "ghost"},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_customize_requires_auth(async_client: AsyncClient) -> None:
    resp = await async_client.patch(
        "/user-practices/1/customize",
        json={"custom_name": "x"},
    )
    assert resp.status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
async def test_customize_rejects_blank_custom_name(
    async_client: AsyncClient,
    db_session: AsyncSession,
    blank: str,
) -> None:
    """Empty / whitespace-only custom_name must 422.

    Without this guard the value would persist, then ``effective_name``'s
    falsy check would silently fall back to the catalog name — yielding a
    contradictory response (``custom_name=""`` alongside ``effective_name=
    "<catalog>"``).
    """
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"custom_name": blank},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_customize_strips_surrounding_whitespace_on_custom_name(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Surrounding whitespace on a non-blank custom_name is stripped.

    Keeps ``effective_name`` well-formed for display while preserving
    the user's intent (the leading/trailing spaces are noise).
    """
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"custom_name": "  My Sit  "},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK
    assert resp.json()["custom_name"] == "My Sit"
    assert resp.json()["effective_name"] == "My Sit"


# -- List endpoint coverage -------------------------------------------------


async def _force_corrupt_override(db_session: AsyncSession, user_practice_id: int) -> None:
    """Plant a mode-mismatched override directly via the ORM.

    Pre-flight validation at the PATCH edge prevents this through the
    API, but corrupt rows can arrive via direct DB tooling or a catalog
    mode being edited after users stored overrides. The read paths must
    tolerate them.
    """
    persisted = await db_session.get(UserPractice, user_practice_id)
    assert persisted is not None
    persisted.mode_config_override = {"mode": "count_up"}  # catalog mode is meditation_timer
    db_session.add(persisted)
    await db_session.commit()


@pytest.mark.asyncio
async def test_list_falls_back_when_override_is_corrupt(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A row with a corrupt stored override returns 200 with effective_config=null.

    Regression: a single bad row used to crash the entire user's list
    with a 500 because ``effective_config()`` propagated its
    ``ValueError``. The read path now logs a warning and falls through.
    """
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)
    await _force_corrupt_override(db_session, up_id)

    resp = await async_client.get("/user-practices/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    items = resp.json()
    assert len(items) == 1
    assert items[0]["effective_config"] is None
    # ``effective_name`` is unaffected — the corrupt field is only the config.
    assert items[0]["effective_name"] == practice.name


@pytest.mark.asyncio
async def test_get_one_falls_back_when_override_is_corrupt(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Detail endpoint mirrors the list endpoint's safe-resolution behavior."""
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)
    await _force_corrupt_override(db_session, up_id)

    resp = await async_client.get(f"/user-practices/{up_id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert body["effective_config"] is None
    assert body["effective_name"] == practice.name


@pytest.mark.asyncio
async def test_list_user_practices_populates_effective_fields(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """List endpoint populates effective_* on every row.

    Mirrors the GET-one shape so frontend code never has to merge by
    hand. Pins the cross-endpoint consistency contract.
    """
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)
    await async_client.patch(
        f"/user-practices/{up_id}/customize",
        json={"custom_name": "List Test"},
        headers=headers,
    )

    resp = await async_client.get("/user-practices/", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    items = resp.json()
    assert len(items) == 1
    item = items[0]
    assert item["effective_name"] == "List Test"
    assert item["effective_config"] is not None
    assert item["effective_config"]["mode"] == "meditation_timer"
    assert item["effective_config"]["duration_minutes"] == 10


@pytest.mark.asyncio
async def test_customize_caps_embedded_sessions(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The customize response embeds at most the capped, newest-first sessions (issue #474)."""
    headers, user_id = await _signup(async_client)
    practice = await _seed_practice(db_session)
    up_id = await _create_user_practice(async_client, db_session, headers, user_id, practice)

    base = datetime(2026, 1, 1, 12, 0, tzinfo=UTC)
    for i in range(5):
        db_session.add(
            PracticeSession(
                user_id=user_id,
                user_practice_id=up_id,
                duration_minutes=10.0,
                timestamp=base + timedelta(minutes=i),
            )
        )
    await db_session.commit()

    resp = await async_client.patch(
        f"/user-practices/{up_id}/customize?sessions_limit=2",
        json={"custom_name": "Capped"},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    data = resp.json()
    assert len(data["sessions"]) == 2
    assert data["sessions_total"] == 5
    assert data["sessions_has_more"] is True
    timestamps = [s["timestamp"] for s in data["sessions"]]
    assert timestamps == sorted(timestamps, reverse=True)
