"""Throwaway stub applications that give the authorization-matrix harness a real BOLA to find.

A DAST check is only worth having if it can be shown to *catch* something. The
whole point of this module is therefore a deliberately broken application: a
genuine ``FastAPI()`` instance whose ``GET /widgets/{widget_id}`` and
``DELETE /widgets/{widget_id}`` authenticate the caller and then ignore who that
caller is. Any harness change that stops flagging those two routes turns the
tests that use these fixtures red, which is the property the whole exercise
exists to buy.

The apps are real FastAPI apps rather than hand-written OpenAPI dictionaries on
purpose: discovery then runs against FastAPI's own ``/openapi.json`` generation,
so a shape change in the framework surfaces here instead of in production.

Alongside the leaky routes sit deliberately *correct* ones —
``GET /safeitems/{item_id}`` 404s for a foreign owner and
``GET /widgets/{widget_id}/parts/{part_id}`` 403s — as negative controls. A
harness that reports those as findings is crying wolf, which is just as useless
as one that reports nothing.

The second app, built by :func:`build_blind_app`, mints tokens happily and then
answers 401 to everything else. That is the exact shape of the false pass this
whole harness exists to forbid: no request ever reaches an ownership check, no
IDOR is found, and a naive check reports clean.

Containment: these apps live under ``backend/tests/`` and are only ever
constructed by a test. They are never imported by ``backend/src``, never mounted
on the production app, and define their own throwaway bearer scheme over an
in-memory dict. Nothing here imports, touches, or weakens the real auth stack.
Passwords are generated with ``secrets`` so there is no credential literal at
all.

``from __future__ import annotations`` is deliberately absent: the route
handlers below depend on locally-defined dependency callables, and stringised
annotations would leave FastAPI unable to resolve them from module globals.
"""

import asyncio
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import Annotated

import pytest
import pytest_asyncio
from fastapi import Depends, FastAPI, Header, HTTPException
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel

from scripts.dast.authz_matrix import HarnessOverrides, main
from scripts.dast.runner import Bootstrap, Identity, MatrixConfig
from scripts.dast.seeds import SeedSpec

# The stub is driven in-process through ASGITransport, so this URL is never
# dialled; it exists so the rendered curl repro looks like the real thing.
STUB_BASE_URL = "http://127.0.0.1:8000"

# Never connected: the injected bootstrap replaces the ORM identity insert, so
# the CLI builds an engine that is never asked for a connection.
UNUSED_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

# A list route that requires a token: the harness probes it with and without
# credentials to prove the auth layer is engaged before trusting any denial.
STUB_AUTH_PROBE_PATH = "/widgets/"

# Every templated route the stub exposes is object-scoped, so discovery,
# classification, and probing must all agree on this number.
STUB_OBJECT_SCOPED_ROUTES = 5

LEAKY_WIDGET_GET = ("GET", "/widgets/{widget_id}")
LEAKY_WIDGET_DELETE = ("DELETE", "/widgets/{widget_id}")
SAFE_ITEM_GET = ("GET", "/safeitems/{item_id}")
SAFE_PART_GET = ("GET", "/widgets/{widget_id}/parts/{part_id}")
SAFE_PART_POST = ("POST", "/widgets/{widget_id}/parts/")

_BEARER_PREFIX = "Bearer "
_TOKEN_BYTES = 24
_PASSWORD_BYTES = 16
# Row ids start well above zero so a stray ``0``/``1`` in a URL cannot pass for
# a genuinely seeded object.
_FIRST_ID = 100

_UNAUTHORIZED = "unauthorized"
_NOT_FOUND = "not_found"
_FORBIDDEN = "forbidden"

STUB_SEED_LABEL = "stub"
STUB_REPLAY_LABEL = "replay"

ActorDependency = Callable[..., Awaitable[str]]


class LoginRequest(BaseModel):
    """Credentials posted to the stub's ``/auth/login``."""

    email: str
    password: str


class TokenOut(BaseModel):
    """Bearer token minted by the stub's login route."""

    token: str


class LabelIn(BaseModel):
    """The only field any stub create route accepts."""

    label: str


class IdOut(BaseModel):
    """A bare row id, the flat ``id_pointer`` shape."""

    id: int


class PartCreated(BaseModel):
    """A created part, nested one level so the id pointer must traverse."""

    part: IdOut


class ItemCreated(BaseModel):
    """A created safe item, nested one level for the same reason."""

    item: IdOut


class WidgetOut(BaseModel):
    """A widget read, echoing both its owner and the caller who read it.

    ``viewer`` differing from ``owner`` in a 200 response is the leak made
    visible: the row was served to somebody who does not own it.
    """

    id: int
    owner: str
    viewer: str


class PartOut(BaseModel):
    """A part read, tied back to the widget that owns it."""

    id: int
    widget_id: int


@dataclass
class StubStore:
    """In-memory state for one stub deployment: identities, tokens, and owned rows."""

    passwords: dict[str, str] = field(default_factory=dict)
    tokens: dict[str, str] = field(default_factory=dict)
    widgets: dict[int, str] = field(default_factory=dict)
    parts: dict[int, int] = field(default_factory=dict)
    items: dict[int, str] = field(default_factory=dict)
    deleted_by: dict[int, str] = field(default_factory=dict)
    # Labels submitted to create routes: proof that a seed or replay body
    # arrived intact rather than being rejected as invalid before the handler.
    labels: list[str] = field(default_factory=list)
    # Credentials the blind app refused: proof the harness authenticated at all.
    rejected: list[str] = field(default_factory=list)
    next_id: int = _FIRST_ID

    def allocate_id(self) -> int:
        """Return a fresh row id."""
        self.next_id += 1
        return self.next_id


@dataclass(frozen=True)
class StubCredentials:
    """One throwaway identity the harness is expected to log in as."""

    label: str
    email: str
    password: str


@dataclass(frozen=True)
class StubDeployment:
    """A built stub app together with its store and its two pre-registered identities."""

    app: FastAPI
    store: StubStore
    owner: StubCredentials
    intruder: StubCredentials


def _unauthorized() -> HTTPException:
    """Return the stub's uniform 401."""
    return HTTPException(status_code=HTTPStatus.UNAUTHORIZED, detail=_UNAUTHORIZED)


def _resolve_actor(store: StubStore, authorization: str | None) -> str:
    """Return the email behind a bearer token, or raise 401.

    Args:
        store: The deployment's state.
        authorization: The raw ``Authorization`` header, if any.

    Returns:
        The authenticated caller's email address.

    Raises:
        HTTPException: 401 when the header is missing, malformed, or carries a
            token this deployment never minted (which is what the forged-JWT
            probe sends).
    """
    if authorization is None or not authorization.startswith(_BEARER_PREFIX):
        raise _unauthorized()
    email = store.tokens.get(authorization.removeprefix(_BEARER_PREFIX))
    if email is None:
        raise _unauthorized()
    return email


def _make_actor_dependency(store: StubStore) -> ActorDependency:
    """Build the stub's bearer dependency, bound to one store.

    The parameter is named ``authorization`` and declared as a plain header so
    the generated OpenAPI document carries the same authentication signal the
    production app emits.
    """

    async def current_actor(authorization: Annotated[str | None, Header()] = None) -> str:
        return _resolve_actor(store, authorization)

    return current_actor


def _mount_login(app: FastAPI, store: StubStore) -> None:
    """Mount a minimal ``POST /auth/login`` that mints a bearer token."""

    @app.post("/auth/login")
    async def login(payload: LoginRequest) -> TokenOut:
        expected = store.passwords.get(payload.email)
        if expected is None or not secrets.compare_digest(expected, payload.password):
            raise _unauthorized()
        token = secrets.token_urlsafe(_TOKEN_BYTES)
        store.tokens[token] = payload.email
        return TokenOut(token=token)


def _mount_widgets(app: FastAPI, store: StubStore, actor_dep: ActorDependency) -> None:
    """Mount the widget routes, two of which are deliberately broken.

    ``list_widgets`` and ``create_widget`` are sound. ``read_widget`` and
    ``delete_widget`` authenticate and then never consult the owner — the BOLA
    the harness must find.
    """

    @app.get(STUB_AUTH_PROBE_PATH)
    async def list_widgets(actor: Annotated[str, Depends(actor_dep)]) -> list[int]:
        return [widget_id for widget_id, owner in store.widgets.items() if owner == actor]

    @app.post(STUB_AUTH_PROBE_PATH, status_code=HTTPStatus.CREATED)
    async def create_widget(
        actor: Annotated[str, Depends(actor_dep)],
        payload: LabelIn,
    ) -> IdOut:
        widget_id = store.allocate_id()
        store.widgets[widget_id] = actor
        store.labels.append(payload.label)
        return IdOut(id=widget_id)

    @app.get("/widgets/{widget_id}")
    async def read_widget(
        widget_id: int,
        actor: Annotated[str, Depends(actor_dep)],
    ) -> WidgetOut:
        owner = store.widgets.get(widget_id)
        if owner is None:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=_NOT_FOUND)
        return WidgetOut(id=widget_id, owner=owner, viewer=actor)

    @app.delete("/widgets/{widget_id}", status_code=HTTPStatus.NO_CONTENT)
    async def delete_widget(
        widget_id: int,
        actor: Annotated[str, Depends(actor_dep)],
    ) -> None:
        if widget_id not in store.widgets:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=_NOT_FOUND)
        del store.widgets[widget_id]
        store.deleted_by[widget_id] = actor


def _mount_parts(app: FastAPI, store: StubStore, actor_dep: ActorDependency) -> None:
    """Mount the two-parameter part routes, both of which enforce ownership.

    These exist for two reasons: they are the negative control for a route whose
    denial is 403 rather than 404, and they force the seed resolver to fill one
    parameter from another (a part cannot be created without a widget).
    """

    @app.post("/widgets/{widget_id}/parts/", status_code=HTTPStatus.CREATED)
    async def create_part(
        widget_id: int,
        actor: Annotated[str, Depends(actor_dep)],
        payload: LabelIn,
    ) -> PartCreated:
        if store.widgets.get(widget_id) != actor:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=_NOT_FOUND)
        part_id = store.allocate_id()
        store.parts[part_id] = widget_id
        store.labels.append(payload.label)
        return PartCreated(part=IdOut(id=part_id))

    @app.get("/widgets/{widget_id}/parts/{part_id}")
    async def read_part(
        widget_id: int,
        part_id: int,
        actor: Annotated[str, Depends(actor_dep)],
    ) -> PartOut:
        if store.widgets.get(widget_id) != actor:
            raise HTTPException(status_code=HTTPStatus.FORBIDDEN, detail=_FORBIDDEN)
        if store.parts.get(part_id) != widget_id:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=_NOT_FOUND)
        return PartOut(id=part_id, widget_id=widget_id)


def _mount_safeitems(app: FastAPI, store: StubStore, actor_dep: ActorDependency) -> None:
    """Mount the correct, enumeration-safe item routes used as the negative control."""

    @app.post("/safeitems/", status_code=HTTPStatus.CREATED)
    async def create_item(
        actor: Annotated[str, Depends(actor_dep)],
        payload: LabelIn,
    ) -> ItemCreated:
        item_id = store.allocate_id()
        store.items[item_id] = actor
        store.labels.append(payload.label)
        return ItemCreated(item=IdOut(id=item_id))

    @app.get("/safeitems/{item_id}")
    async def read_item(
        item_id: int,
        actor: Annotated[str, Depends(actor_dep)],
    ) -> IdOut:
        if store.items.get(item_id) != actor:
            raise HTTPException(status_code=HTTPStatus.NOT_FOUND, detail=_NOT_FOUND)
        return IdOut(id=item_id)


def _register_identities(store: StubStore) -> tuple[StubCredentials, StubCredentials]:
    """Seed two identities into a store and return them, owner first."""
    owner = StubCredentials(
        label="A",
        email="dast-stub-a@example.com",
        password=secrets.token_urlsafe(_PASSWORD_BYTES),
    )
    intruder = StubCredentials(
        label="B",
        email="dast-stub-b@example.com",
        password=secrets.token_urlsafe(_PASSWORD_BYTES),
    )
    for credentials in (owner, intruder):
        store.passwords[credentials.email] = credentials.password
    return owner, intruder


def build_leaky_app() -> StubDeployment:
    """Build the stub whose two widget-read/delete routes ignore ownership."""
    store = StubStore()
    app = FastAPI(title="dast-stub-leaky")
    actor_dep = _make_actor_dependency(store)
    _mount_login(app, store)
    _mount_widgets(app, store, actor_dep)
    _mount_parts(app, store, actor_dep)
    _mount_safeitems(app, store, actor_dep)
    owner, intruder = _register_identities(store)
    return StubDeployment(app=app, store=store, owner=owner, intruder=intruder)


def build_blind_app() -> StubDeployment:
    """Build the stub that logs anybody in and then answers 401 to everything.

    This is the false pass in its purest form: every probe is denied, so no IDOR
    can possibly be observed. A harness that reports this as clean has proven
    nothing at all, so it must instead report a tripped vacuity guard.
    """
    store = StubStore()
    app = FastAPI(title="dast-stub-blind")
    _mount_login(app, store)

    async def always_unauthorized(
        authorization: Annotated[str | None, Header()] = None,
    ) -> None:
        store.rejected.append(authorization or "")
        raise _unauthorized()

    blind = [Depends(always_unauthorized)]

    @app.get(STUB_AUTH_PROBE_PATH, dependencies=blind)
    async def list_widgets() -> list[int]:
        return []

    @app.post(STUB_AUTH_PROBE_PATH, status_code=HTTPStatus.CREATED, dependencies=blind)
    async def create_widget(payload: LabelIn) -> IdOut:
        return IdOut(id=len(payload.label))

    @app.get("/widgets/{widget_id}", dependencies=blind)
    async def read_widget(widget_id: int) -> IdOut:
        return IdOut(id=widget_id)

    owner, intruder = _register_identities(store)
    return StubDeployment(app=app, store=store, owner=owner, intruder=intruder)


def make_stub_bootstrap(
    deployment: StubDeployment,
) -> Callable[[AsyncClient], Awaitable[tuple[Identity, Identity]]]:
    """Build the identity-bootstrap seam the runner is handed for a stub.

    In production the runner inserts two user rows through the app's own ORM and
    then mints both tokens over the real ``POST /auth/login``. Against a stub
    there is no database, so this substitutes the same two-step shape: the
    identities already exist in the store, and both tokens come from a genuine
    login round-trip through the app.

    Args:
        deployment: The stub whose identities should be logged in.

    Returns:
        A coroutine function returning ``(owner, intruder)`` identities.
    """

    async def _login(client: AsyncClient, credentials: StubCredentials) -> Identity:
        response = await client.post(
            "/auth/login",
            json={"email": credentials.email, "password": credentials.password},
        )
        assert response.status_code == HTTPStatus.OK, (
            f"stub login for {credentials.label} failed: {response.status_code} {response.text}"
        )
        return Identity(
            label=credentials.label,
            email=credentials.email,
            token=str(response.json()["token"]),
        )

    async def _bootstrap(client: AsyncClient) -> tuple[Identity, Identity]:
        return (
            await _login(client, deployment.owner),
            await _login(client, deployment.intruder),
        )

    return _bootstrap


STUB_SEED_REGISTRY: dict[str, SeedSpec] = {
    "widget_id": SeedSpec(
        create_method="POST",
        create_path="/widgets/",
        payload={"label": STUB_SEED_LABEL},
        id_pointer=("id",),
    ),
    "part_id": SeedSpec(
        create_method="POST",
        create_path="/widgets/{widget_id}/parts/",
        payload={"label": STUB_SEED_LABEL},
        id_pointer=("part", "id"),
        depends_on=("widget_id",),
    ),
    "item_id": SeedSpec(
        create_method="POST",
        create_path="/safeitems/",
        payload={"label": STUB_SEED_LABEL},
        id_pointer=("item", "id"),
    ),
}

STUB_REPLAY_BODIES: dict[tuple[str, str], dict[str, object]] = {
    SAFE_PART_POST: {"label": STUB_REPLAY_LABEL},
}


@pytest.fixture
def leaky_deployment() -> StubDeployment:
    """Provide a freshly built leaky stub, isolated from every other test."""
    return build_leaky_app()


@pytest.fixture
def blind_deployment() -> StubDeployment:
    """Provide a freshly built "401s everything" stub."""
    return build_blind_app()


def stub_client(deployment: StubDeployment) -> AsyncClient:
    """Return an httpx client wired straight into a stub app, no socket involved."""
    return AsyncClient(
        transport=ASGITransport(app=deployment.app),
        base_url=STUB_BASE_URL,
    )


@pytest_asyncio.fixture
async def leaky_client(leaky_deployment: StubDeployment) -> AsyncIterator[AsyncClient]:
    """Provide an ASGI-backed client for the leaky stub."""
    async with stub_client(leaky_deployment) as client:
        yield client


@pytest_asyncio.fixture
async def blind_client(blind_deployment: StubDeployment) -> AsyncIterator[AsyncClient]:
    """Provide an ASGI-backed client for the "401s everything" stub."""
    async with stub_client(blind_deployment) as client:
        yield client


def stub_config(*, min_routes: int = STUB_OBJECT_SCOPED_ROUTES) -> MatrixConfig:
    """Return the matrix configuration that points the harness at a stub app."""
    return MatrixConfig(
        seed_registry=STUB_SEED_REGISTRY,
        replay_bodies=STUB_REPLAY_BODIES,
        auth_probe_path=STUB_AUTH_PROBE_PATH,
        min_routes=min_routes,
    )


def stub_overrides(client: AsyncClient, *, bootstrap: Bootstrap | None) -> HarnessOverrides:
    """Bundle the seams that point the CLI at a stub app.

    Args:
        client: The client the run should use.
        bootstrap: The identity bootstrap to inject, or ``None`` to leave the
            production one in place -- which is how a test drives the real ORM
            insert against a deliberately unusable database URL.
    """
    return HarnessOverrides(
        client=client,
        bootstrap=bootstrap,
        seed_registry=STUB_SEED_REGISTRY,
        replay_bodies=STUB_REPLAY_BODIES,
        auth_probe_path=STUB_AUTH_PROBE_PATH,
    )


def close_client(client: AsyncClient) -> None:
    """Close a client from synchronous test code, which owns no event loop."""
    asyncio.run(client.aclose())


def drive_main_with(
    overrides: HarnessOverrides,
    *,
    min_routes: int,
    database_url: str = UNUSED_DATABASE_URL,
) -> int:
    """Run the CLI end to end with one set of injected seams.

    ``main`` owns the event loop, so this is deliberately synchronous: an async
    test could not call it without nesting ``asyncio.run`` inside a running loop.
    """
    return main(
        [
            "--base-url",
            STUB_BASE_URL,
            "--database-url",
            database_url,
            "--min-routes",
            str(min_routes),
        ],
        overrides=overrides,
    )


def drive_main(
    deployment: StubDeployment,
    *,
    min_routes: int,
    client: AsyncClient | None = None,
    bootstrap: Bootstrap | None = None,
) -> int:
    """Run the CLI end to end against a stub app and return its exit code.

    Args:
        deployment: The stub to probe.
        min_routes: The coverage floor this run is given.
        client: A client to use instead of a plain one onto the stub, for tests
            that need one live stage to fail while the others keep working.
        bootstrap: An identity bootstrap to use instead of the stub's own.

    Returns:
        The exit code. The client is closed here because nothing that injects a
        client should also be expected to own its lifetime.
    """
    session_client = client if client is not None else stub_client(deployment)
    try:
        return drive_main_with(
            stub_overrides(
                session_client,
                bootstrap=bootstrap if bootstrap is not None else make_stub_bootstrap(deployment),
            ),
            min_routes=min_routes,
        )
    finally:
        close_client(session_client)
