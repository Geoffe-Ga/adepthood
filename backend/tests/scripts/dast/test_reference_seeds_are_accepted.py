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
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient

from scripts.dast.references import REFERENCE_REGISTRY
from scripts.dast.seeds import SEED_REGISTRY, create_body, resolve_id

_UI_FLAGS = ("PATCH", "/ui-flags")


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
