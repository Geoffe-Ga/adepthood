"""The matrix can make an agent grant the way a person does, and probe its revoke (#3534).

``DELETE /vault/agents/{agent_id}`` names a grant by id, so the authorization
matrix has to seed one -- and a grant is written only by somebody pressing
Approve on the consent page (#3532). Its seed is therefore five ordinary
requests (connect a vault, register an agent, open its consent page, approve,
read the list back), two of which answer HTML and a redirect rather than JSON.

This replays the real seed chain in-process, through the same pure helpers the
runner uses, then runs the cells the matrix runs: the intruder's revoke is
refused and changes nothing, the owner's own revoke is a 204. A seed that drifts
from the routes it walks fails here in seconds instead of in the DAST job.

The id-source helpers are pinned on their own below, so a regression in reading
a ticket or a redirect is named directly rather than surfacing as an
unseedable route.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from models.agent_grant import AgentGrant
from scripts.dast.seeds import (
    SEED_REGISTRY,
    IdSource,
    SeedSpec,
    create_bodies,
    read_seed_id,
    render_text,
    seed_order,
    seed_succeeded,
)

_PASSWORD = "securepassword123"  # pragma: allowlist secret
_AGENT_SEED = "agent_id"


async def _signup(client: AsyncClient, name: str) -> dict[str, str]:
    """Create an account and return its bearer header."""
    response = await client.post(
        "/auth/signup", json={"email": f"{name}@example.com", "password": _PASSWORD}
    )
    assert response.status_code == HTTPStatus.OK, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _run_seed(
    client: AsyncClient, headers: dict[str, str], key: str, values: dict[str, object]
) -> str:
    """Send one seed spec exactly as the runner builds it, and return what it yields."""
    spec = SEED_REGISTRY[key]
    body, form = create_bodies(spec, values)
    response = await client.request(
        spec.create_method,
        render_text(spec.create_path, values),
        headers=headers,
        json=body,
        data=form,
    )
    assert seed_succeeded(spec, response.status_code), (key, response.status_code, response.text)
    seeded = read_seed_id(spec, text=response.text, location=response.headers.get("location"))
    assert seeded is not None, (key, response.text)
    return seeded


async def _seed_agent(client: AsyncClient, headers: dict[str, str]) -> int:
    """Walk the whole chain, dependencies first, and return the grant id."""
    values: dict[str, object] = {"unique": "control"}
    for key in seed_order([_AGENT_SEED], SEED_REGISTRY):
        values[key] = await _run_seed(client, headers, key, values)
    return int(str(values[_AGENT_SEED]))


def test_the_agent_seed_chain_walks_consent_in_order() -> None:
    """Vault and agent first, then the page, then Approve, then the list."""
    assert seed_order([_AGENT_SEED], SEED_REGISTRY) == (
        "agent_client",
        "agent_vault",
        "agent_consent_ticket",
        "agent_approval",
        "agent_id",
    )


@pytest.mark.asyncio
async def test_the_seeded_grant_passes_its_controls_and_refuses_the_intruder(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The cells the matrix runs: intruder refused and nothing changed; owner's revoke lands."""
    owner = await _signup(async_client, "dast_agent_owner")
    intruder = await _signup(async_client, "dast_agent_intruder")
    grant_id = await _seed_agent(async_client, owner)

    refused = await async_client.delete(f"/vault/agents/{grant_id}", headers=intruder)
    assert refused.status_code == HTTPStatus.NOT_FOUND
    grant = await db_session.get(AgentGrant, grant_id)
    assert grant is not None
    assert grant.grants == ["vault:read"]
    assert grant.revoked_at is None

    own = await async_client.delete(f"/vault/agents/{grant_id}", headers=owner)
    assert own.status_code == HTTPStatus.NO_CONTENT


@pytest.mark.asyncio
async def test_every_cell_seeds_a_fresh_grant_at_the_head_of_the_list(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A second cell's seed reads its own grant, not the first cell's."""
    owner = await _signup(async_client, "dast_agent_cells")

    first = await _seed_agent(async_client, owner)
    second = await _seed_agent(async_client, owner)

    assert first != second
    rows = (await db_session.execute(select(AgentGrant))).scalars().all()
    assert {row.id for row in rows} == {first, second}


# --- reading a value from wherever a create put it --------------------------------


def _spec(source: IdSource, pattern: str | None = None) -> SeedSpec:
    """A minimal spec reading its value from ``source``."""
    return SeedSpec(
        create_method="POST",
        create_path="/x",
        payload={},
        id_pointer=("id",),
        id_source=source,
        id_pattern=pattern,
    )


def test_a_json_source_reads_through_its_pointer_and_survives_a_non_json_body() -> None:
    """The default: the pointer into the parsed body, or nothing for a page."""
    spec = _spec(IdSource.JSON)

    assert read_seed_id(spec, text='{"id": 7}', location=None) == "7"
    assert read_seed_id(spec, text="<html></html>", location=None) is None


def test_a_text_source_reads_the_first_group_of_its_pattern() -> None:
    """A consent page carries its ticket in a hidden input."""
    spec = _spec(IdSource.BODY_TEXT, r'name="ticket" value="([^"]+)"')

    assert read_seed_id(spec, text='<input name="ticket" value="t.k">', location=None) == "t.k"
    assert read_seed_id(spec, text="<p>stopped</p>", location=None) is None


def test_a_redirect_source_reads_the_location_and_nothing_else() -> None:
    """Approve sends the browser back with a code; the body is never consulted."""
    spec = _spec(IdSource.LOCATION, r"[?&]code=([^&]+)")

    assert read_seed_id(spec, text="", location="http://127.0.0.1/cb?code=ac_1&state=s") == "ac_1"
    assert read_seed_id(spec, text="?code=body", location=None) is None


def test_a_form_spec_sends_its_payload_as_a_form_and_never_as_json() -> None:
    """Approve is an HTML form post; every other create stays JSON."""
    approval = SEED_REGISTRY["agent_approval"]
    vault = SEED_REGISTRY["agent_vault"]
    values = {"unique": "u", "agent_consent_ticket": "t.k"}

    assert create_bodies(approval, values) == (
        None,
        {
            "ticket": "t.k",
            "decision": "approve",
            "grant.vault:read": "on",
        },
    )
    json_body, form = create_bodies(vault, values)
    assert form is None
    assert json_body is not None
    assert json_body["api_key"] == "dast-vault-u"  # pragma: allowlist secret


def test_a_pattern_source_without_a_pattern_yields_nothing() -> None:
    """A misdeclared spec is unseedable rather than a crash."""
    assert read_seed_id(_spec(IdSource.BODY_TEXT), text="anything", location=None) is None


@pytest.mark.parametrize(
    ("source", "status", "expected"),
    [
        (IdSource.JSON, HTTPStatus.OK, True),
        (IdSource.JSON, HTTPStatus.CREATED, True),
        (IdSource.JSON, HTTPStatus.SEE_OTHER, False),
        (IdSource.BODY_TEXT, HTTPStatus.OK, True),
        (IdSource.BODY_TEXT, HTTPStatus.BAD_REQUEST, False),
        (IdSource.LOCATION, HTTPStatus.SEE_OTHER, True),
        (IdSource.LOCATION, HTTPStatus.OK, False),
        (IdSource.LOCATION, HTTPStatus.BAD_REQUEST, False),
    ],
)
def test_only_a_redirect_source_counts_a_redirect_as_success(
    source: IdSource, status: HTTPStatus, *, expected: bool
) -> None:
    """A consent page that answered 200 to Approve is a refusal, not a seed."""
    assert seed_succeeded(_spec(source, "x"), status) is expected
