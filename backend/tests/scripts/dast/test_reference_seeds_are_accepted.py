"""Every body-reference seed creates an object its route accepts from its owner.

The authorization matrix grades a body reference by first sending the caller's
*own* seeded id -- the positive control -- and requires a 2xx before a
cross-tenant refusal means anything. A seed the route refuses on domain
grounds (not ownership) therefore fails the whole job as a harness error.

``PATCH /ui-flags`` is the case that motivated this (#3150): the writing timer
may only link a habit whose goals count minutes or sessions, so the habit the
matrix seeds for that reference must be created with timer goals. This test
replays the real seed and the real positive control in-process, so a seed that
drifts from the route's rules fails here in seconds instead of in the DAST job.

``PATCH /user-practices/{user_practice_id}/habit`` (#3151) applies the same
rule to a practice's link, and its body field is required, so the path matrix's
replay body is checked here too: a replay the route refuses with 422 would be
a positive control that never reaches the ownership check.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice
from scripts.dast.references import REFERENCE_REGISTRY
from scripts.dast.seeds import REPLAY_BODIES, SEED_REGISTRY, create_body, resolve_id

_UI_FLAGS = ("PATCH", "/ui-flags")
_PRACTICE_LINK = ("PATCH", "/user-practices/{user_practice_id}/habit")

# A stage-1 catalog practice, standing in for the one the startup seeder
# provides the live instance (the test app runs without the seeder).
_CATALOG_PRACTICE: dict[str, object] = {
    "stage_number": 1,
    "name": "DAST catalog sit",
    "description": "Sit quietly",
    "instructions": "Close your eyes and breathe",
    "default_duration_minutes": 10,
    "approved": True,
    "mode": "meditation_timer",
    "mode_config": {
        "mode": "meditation_timer",
        "duration_minutes": 10,
        "start_bell": True,
        "halfway_bell": False,
        "end_bell": True,
    },
}


async def _signup(client: AsyncClient) -> dict[str, str]:
    """Create a user and return auth headers."""
    resp = await client.post(
        "/auth/signup",
        json={
            "email": "dast_positive_control@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}


@pytest.mark.asyncio
async def test_ui_flags_writing_link_seed_passes_its_positive_control(
    async_client: AsyncClient,
) -> None:
    """The seeded habit links: the owner's own id draws a 2xx echoing that id."""
    headers = await _signup(async_client)
    (reference,) = REFERENCE_REGISTRY[_UI_FLAGS].references
    spec = SEED_REGISTRY[reference.seed_key]
    assert spec.create_method == "POST"
    assert spec.depends_on == ()

    created = await async_client.post(
        spec.create_path, json=create_body(spec, {"unique": "control"}), headers=headers
    )
    assert created.status_code == HTTPStatus.OK, created.text
    habit_id = resolve_id(created.json(), spec.id_pointer)
    assert habit_id is not None

    linked = await async_client.patch(
        _UI_FLAGS[1], json={reference.field: int(habit_id)}, headers=headers
    )

    assert linked.status_code == HTTPStatus.OK, linked.text
    assert linked.json()[reference.field] == int(habit_id)


async def _seed(
    client: AsyncClient, headers: dict[str, str], seed_key: str, values: dict[str, object]
) -> int:
    """Run one real seed spec as the caller and return the id it yields."""
    spec = SEED_REGISTRY[seed_key]
    assert spec.create_method == "POST"
    created = await client.post(spec.create_path, json=create_body(spec, values), headers=headers)
    assert created.status_code in {HTTPStatus.OK, HTTPStatus.CREATED}, created.text
    seeded = resolve_id(created.json(), spec.id_pointer)
    assert seeded is not None
    return int(seeded)


async def _seed_user_practice(
    client: AsyncClient, db_session: AsyncSession, headers: dict[str, str]
) -> int:
    """Seed the path's selection through its real spec, over a stand-in catalog row."""
    practice = Practice(**_CATALOG_PRACTICE)
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    assert SEED_REGISTRY["user_practice_id"].depends_on == ("practice_id",)
    return await _seed(
        client, headers, "user_practice_id", {"practice_id": practice.id, "unique": "control"}
    )


@pytest.mark.asyncio
async def test_practice_habit_link_seed_passes_its_positive_control(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The seeded habit links to the owner's own seeded practice; the answer echoes it."""
    headers = await _signup(async_client)
    probe = REFERENCE_REGISTRY[_PRACTICE_LINK]
    (reference,) = probe.references
    assert probe.path_seeds == ("user_practice_id",)
    assert SEED_REGISTRY[reference.seed_key].depends_on == ()
    user_practice_id = await _seed_user_practice(async_client, db_session, headers)
    habit_id = await _seed(async_client, headers, reference.seed_key, {"unique": "control"})

    linked = await async_client.patch(
        f"/user-practices/{user_practice_id}/habit",
        json={**probe.body, reference.field: habit_id},
        headers=headers,
    )

    assert linked.status_code == HTTPStatus.OK, linked.text
    assert linked.json()[reference.field] == habit_id


@pytest.mark.asyncio
async def test_practice_habit_link_replay_body_passes_the_path_control(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The path matrix's replay body is one the owner's own selection accepts."""
    headers = await _signup(async_client)
    user_practice_id = await _seed_user_practice(async_client, db_session, headers)

    replayed = await async_client.patch(
        f"/user-practices/{user_practice_id}/habit",
        json=dict(REPLAY_BODIES[_PRACTICE_LINK]),
        headers=headers,
    )

    assert replayed.status_code == HTTPStatus.OK, replayed.text
