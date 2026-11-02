"""The matrix can seed a margin note carrying a Resonance Letter, and probe its routes (#3658).

``/journal/marginalia/{marginalia_id}/...`` names a margin note by id, and only a
model writes one, so the seed walks the real routes a writer's client walks: an
entry, a resonance pass, a first letter. This replays that chain in-process
through the same pure helpers the runner uses, under the test suite's armed stub
seam -- the seam the DAST instance runs with -- and then runs the cells the
matrix runs on all three routes: the intruder is refused and nothing is stored,
the owner's own call succeeds. A chain that drifts from the routes it walks
fails here in seconds instead of in the DAST job.

Two harness rules ride on this seed and are pinned here as well: the two
creates that spend a generation are the paced ones, and only routes that cannot
destroy their object may share one seeded object across their cells.
"""

from __future__ import annotations

from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from main import app
from models.marginalia import Marginalia
from models.promoted_quote import PromotedQuote
from scripts.dast.discovery import discover_routes
from scripts.dast.seeds import (
    REPLAY_BODIES,
    SEED_REGISTRY,
    SHARED_SEED_ROUTES,
    create_bodies,
    read_seed_id,
    render_text,
    replay_body,
    seed_order,
    seed_succeeded,
)

_PASSWORD = "securepassword123"  # pragma: allowlist secret
_NOTE_SEED = "marginalia_id"
_ESSAY = ("POST", "/journal/marginalia/{marginalia_id}/essay")
_LETTER_PROMOTE = ("POST", "/journal/marginalia/{marginalia_id}/letter/promote")
_LETTER_PROMOTIONS = ("GET", "/journal/marginalia/{marginalia_id}/letter/promotions")
_DESTRUCTIVE_METHODS = frozenset({"DELETE"})


async def _signup(client: AsyncClient, name: str) -> dict[str, str]:
    """Create an account and return its bearer header."""
    response = await client.post(
        "/auth/signup", json={"email": f"{name}@example.com", "password": _PASSWORD}
    )
    assert response.status_code == HTTPStatus.OK, response.text
    return {"Authorization": f"Bearer {response.json()['token']}"}


async def _seed_note(client: AsyncClient, headers: dict[str, str]) -> int:
    """Walk the whole chain exactly as the runner builds it, and return the note id."""
    values: dict[str, object] = {"unique": "control"}
    for key in seed_order([_NOTE_SEED], SEED_REGISTRY):
        spec = SEED_REGISTRY[key]
        body, form = create_bodies(spec, values)
        response = await client.request(
            spec.create_method,
            render_text(spec.create_path, values),
            headers=headers,
            json=body,
            data=form,
        )
        assert seed_succeeded(spec, response.status_code), (key, response.text)
        seeded = read_seed_id(spec, text=response.text, location=None)
        assert seeded is not None, (key, response.text)
        values[key] = seeded
    return int(str(values[_NOTE_SEED]))


async def _probe(
    client: AsyncClient, route: tuple[str, str], note_id: int, headers: dict[str, str]
) -> int:
    """Send one route's replay as the matrix does, and return the status."""
    method, path = route
    (spec,) = (spec for spec in discover_routes(app.openapi()) if (spec.method, spec.path) == route)
    response = await client.request(
        method,
        path.format(marginalia_id=note_id),
        headers=headers,
        json=replay_body(spec, REPLAY_BODIES),
    )
    return response.status_code


async def _quote_count(db_session: AsyncSession) -> int:
    """Every ``promotedquote`` row in storage."""
    count = select(func.count()).select_from(PromotedQuote)
    return int((await db_session.execute(count)).scalar_one())


def test_the_note_seed_chain_writes_the_page_then_the_note_then_the_letter() -> None:
    """Entry first, then the resonance pass, then the first letter."""
    assert seed_order([_NOTE_SEED], SEED_REGISTRY) == (
        "lettered_entry_id",
        "lettered_note_id",
        _NOTE_SEED,
    )


def test_exactly_the_creates_that_spend_a_generation_are_paced() -> None:
    """The resonance pass and the first letter spend one each; nothing else is paced."""
    paced = {key for key, spec in SEED_REGISTRY.items() if spec.paced}

    assert paced == {"lettered_note_id", _NOTE_SEED}


@pytest.mark.asyncio
async def test_the_seeded_note_carries_a_letter_and_its_routes_refuse_the_intruder(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The cells the matrix runs, on every route the seed opens to it.

    The intruder is refused on all three and stores nothing; the owner's own
    calls succeed -- the essay reopens the cached letter, the promote stores a
    quote, the list reads it back.
    """
    owner = await _signup(async_client, "dast_letter_owner")
    intruder = await _signup(async_client, "dast_letter_intruder")
    note_id = await _seed_note(async_client, owner)
    note = await db_session.get(Marginalia, note_id)
    assert note is not None
    assert note.essay

    for route in (_ESSAY, _LETTER_PROMOTE, _LETTER_PROMOTIONS):
        assert await _probe(async_client, route, note_id, intruder) == HTTPStatus.NOT_FOUND
    assert await _quote_count(db_session) == 0

    assert await _probe(async_client, _ESSAY, note_id, owner) == HTTPStatus.OK
    assert await _probe(async_client, _LETTER_PROMOTE, note_id, owner) == HTTPStatus.CREATED
    assert await _probe(async_client, _LETTER_PROMOTIONS, note_id, owner) == HTTPStatus.OK
    assert await _quote_count(db_session) == 1


def test_every_shared_seed_route_is_live_and_cannot_destroy_its_object() -> None:
    """A route may share one object across its cells only when no cell can delete it.

    It must also be a route of this app -- a renamed path would otherwise drop
    back to per-cell seeding unnoticed and spend four times the generations --
    and it must name an object made through a paced seed, the only reason the
    exception exists.
    """
    live = {(spec.method, spec.path): spec for spec in discover_routes(app.openapi())}

    for route in sorted(SHARED_SEED_ROUTES):
        assert route in live, f"{route} is not a route of this app"
        assert route[0] not in _DESTRUCTIVE_METHODS, f"{route} can destroy its object"
        chain = seed_order(live[route].params, SEED_REGISTRY)
        assert any(SEED_REGISTRY[key].paced for key in chain), f"{route} spends no generation"
