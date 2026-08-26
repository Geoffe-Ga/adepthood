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

The third app, built by :func:`build_reference_leaky_app`, moves the same
mistake off the path and into a request body and a query string. ``POST /notes/``
and ``POST /attachments/`` take a gadget id from anybody and never ask who owns
it; ``POST /guardednotes/`` is the negative control, and ``GET /gadgets/``
applies its ``gadget_id`` filter after scoping to the caller, so a foreign id
there is answered 200-with-an-empty-list rather than denied. That last route is
the reason references are graded on evidence instead of on status.

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

One thing no stub can prove is that the identity bootstrap works against the
*real* application, so :func:`serve_real_app` at the end of this module serves
the production app in-process from a throwaway file-backed database. It is a
plain context manager rather than a fixture because the CLIs it exists to drive
own their own ``asyncio.run``.

``from __future__ import annotations`` is deliberately absent: the route
handlers below depend on locally-defined dependency callables, and stringised
annotations would leave FastAPI unable to resolve them from module globals.
"""

import asyncio
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http import HTTPStatus
from pathlib import Path
from typing import Annotated

import pytest
import pytest_asyncio
from fastapi import Depends, FastAPI, Header, HTTPException
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import NullPool
from sqlmodel import SQLModel

from conftest import _replace_array_columns
from database import get_session
from main import app as production_app
from scripts.dast.authz_matrix import HarnessOverrides, main
from scripts.dast.policy import AllowlistEntry
from scripts.dast.references import (
    EvidenceStrategy,
    EvidenceWitness,
    ObjectReference,
    ReferenceLocation,
    ReferenceProbe,
    ReferenceRegistry,
    WitnessCondition,
)
from scripts.dast.report import MatrixReport
from scripts.dast.runner import Bootstrap, Identity, MatrixConfig
from scripts.dast.seeds import SeedSpec
from scripts.dast.verdict import REFERENCE_CELL_ORDER, Cell, ReferenceCellResult

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

# The reference stub's routes. Only the first three carry a body reference; the
# listing is the query-carried one.
REFERENCE_LEAKY_NOTE_POST = ("POST", "/notes/")
REFERENCE_GUARDED_NOTE_POST = ("POST", "/guardednotes/")
REFERENCE_LEAKY_ATTACHMENT_POST = ("POST", "/attachments/")
REFERENCE_LEAKY_FOLD_POST = ("POST", "/folds/")
REFERENCE_GUARDED_FOLD_POST = ("POST", "/guardedfolds/")
REFERENCE_GADGET_LISTING_GET = ("GET", "/gadgets/")
REFERENCE_GADGET_ATTACHMENTS_GET = ("GET", "/gadgets/{gadget_id}/attachments")

# The reference stub's own auth probe: a listing that requires a credential.
REFERENCE_STUB_AUTH_PROBE_PATH = "/gadgets/"

# Six (route, reference) pairs, and one path-object-scoped route.
REFERENCE_STUB_REFERENCES = 6
REFERENCE_STUB_OBJECT_SCOPED_ROUTES = 1

# The masking stub's two routes, each of which persists a foreign reference and
# then renders the result exactly as it renders a reference that was never
# there. The gadget listing rides along because the stub publishes it and every
# published id has to be either probed or excused.
MASKED_NOTE_POST = ("POST", "/maskednotes/")
SCREENED_ATTACHMENT_POST = ("POST", "/screenedattachments/")
MASKED_STUB_REFERENCES = 3
MASKED_STUB_OBJECT_SCOPED_ROUTES = 1

# The stub whose read-back surface answers 5xx on exactly the cell that needed
# it, leaving the cross request with no observation to grade.
UNREADABLE_ATTACHMENT_POST = ("POST", "/unreadableattachments/")
UNREADABLE_STUB_REFERENCES = 2
UNREADABLE_STUB_OBJECT_SCOPED_ROUTES = 1

_BEARER_PREFIX = "Bearer "
_TOKEN_BYTES = 24
_PASSWORD_BYTES = 16
# Row ids start well above zero so a stray ``0``/``1`` in a URL cannot pass for
# a genuinely seeded object.
_FIRST_ID = 100

_UNAUTHORIZED = "unauthorized"
_UNRENDERABLE = "unrenderable"
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


class GadgetOut(BaseModel):
    """One gadget of the reference stub, as its listing renders it."""

    id: int
    owner: str


class NoteIn(BaseModel):
    """A note posted with an id referencing a gadget the caller may not own."""

    label: str
    gadget_id: int


class NoteOut(BaseModel):
    """A created note, echoing the gadget it named -- the echo evidence strategy."""

    id: int
    gadget_id: int


class AttachmentIn(BaseModel):
    """An attachment posted against a gadget, with no echo in the response."""

    gadget_id: int


class AttachmentOut(BaseModel):
    """One attachment as the read-back listing renders it."""

    id: int
    gadget_id: int


class MaskedNoteOut(BaseModel):
    """A created note whose reference is rendered through an owner-scoped lookup.

    ``gadget_id`` comes back ``None`` whenever the gadget belongs to somebody
    else -- while the row the handler wrote keeps the id verbatim. A response
    like this renders a persisted foreign reference exactly the way it renders
    no reference at all.
    """

    id: int
    gadget_id: int | None


class FoldIn(BaseModel):
    """A fold posted against a gadget, whose response names neither party."""

    gadget_id: int


class FoldOut(BaseModel):
    """The whole answer a fold route gives: whether the gadget is still unfolded.

    There is no id here to scan for and none to add: the boolean *is* the
    report of what happened, which is the shape a witness predicate exists to
    grade.
    """

    pending: bool


@dataclass
class StubStore:
    """In-memory state for one stub deployment: identities, tokens, and owned rows."""

    passwords: dict[str, str] = field(default_factory=dict)
    tokens: dict[str, str] = field(default_factory=dict)
    widgets: dict[int, str] = field(default_factory=dict)
    parts: dict[int, int] = field(default_factory=dict)
    items: dict[int, str] = field(default_factory=dict)
    deleted_by: dict[int, str] = field(default_factory=dict)
    # The reference stub's rows: gadgets somebody owns, notes that name one, and
    # attachments hung off one. ``notes`` records the caller as well as the
    # gadget, which is what lets a test prove B really referenced A's row.
    gadgets: dict[int, str] = field(default_factory=dict)
    notes: list[dict[str, object]] = field(default_factory=list)
    attachments: dict[int, list[int]] = field(default_factory=dict)
    # Who created each attachment, which a creator-scoped read surface filters
    # on and an owner-visible one ignores.
    attachment_authors: dict[int, str] = field(default_factory=dict)
    # Folds record the caller as well as the gadget, the same way notes do, so
    # a test can prove a write crossed an ownership boundary that no response
    # ever mentioned.
    folds: list[dict[str, object]] = field(default_factory=list)
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


def _mount_gadget_collection(app: FastAPI, store: StubStore, actor_dep: ActorDependency) -> None:
    """Mount the objects every reference stub names, and the listing that reads them.

    ``GET /gadgets/`` takes an optional ``gadget_id`` filter and applies it
    *after* scoping to the caller, which is the correct shape that a status-only
    grader gets wrong: a foreign id there returns 200 with an empty list rather
    than a denial. It doubles as the auth probe, so it is the one route every
    stub in this module mounts.
    """

    @app.get(REFERENCE_STUB_AUTH_PROBE_PATH)
    async def list_gadgets(
        actor: Annotated[str, Depends(actor_dep)],
        gadget_id: int | None = None,
    ) -> list[GadgetOut]:
        return [
            GadgetOut(id=identifier, owner=owner)
            for identifier, owner in store.gadgets.items()
            if owner == actor and gadget_id in (None, identifier)
        ]

    @app.post(REFERENCE_STUB_AUTH_PROBE_PATH, status_code=HTTPStatus.CREATED)
    async def create_gadget(
        actor: Annotated[str, Depends(actor_dep)],
        payload: LabelIn,
    ) -> IdOut:
        gadget_id = store.allocate_id()
        store.gadgets[gadget_id] = actor
        store.labels.append(payload.label)
        return IdOut(id=gadget_id)


def _mount_gadgets(app: FastAPI, store: StubStore, actor_dep: ActorDependency) -> None:
    """Mount the gadget collection plus the owner-visible read-back surface.

    ``GET /gadgets/{gadget_id}/attachments`` shows the owner every attachment
    hung off their gadget, whoever hung it there. That is the contract a
    ``READ_BACK`` reference depends on, and the reason this route rather than a
    creator-scoped one is what the strategy is exercised against.
    """
    _mount_gadget_collection(app, store, actor_dep)

    @app.get("/gadgets/{gadget_id}/attachments")
    async def list_attachments(
        gadget_id: int,
        actor: Annotated[str, Depends(actor_dep)],
    ) -> list[AttachmentOut]:
        if store.gadgets.get(gadget_id) != actor:
            raise HTTPException(status_code=HTTPStatus.FORBIDDEN, detail=_FORBIDDEN)
        return [
            AttachmentOut(id=attachment, gadget_id=gadget_id)
            for attachment in store.attachments.get(gadget_id, [])
        ]


def _mount_notes(app: FastAPI, store: StubStore, actor_dep: ActorDependency) -> None:
    """Mount the leaky body-reference route and its correctly guarded twin.

    Both echo the gadget they were handed, so both are graded on echo evidence.
    Only the second checks who owns it.
    """

    @app.post("/notes/", status_code=HTTPStatus.CREATED)
    async def create_note(
        actor: Annotated[str, Depends(actor_dep)],
        payload: NoteIn,
    ) -> NoteOut:
        note_id = store.allocate_id()
        store.notes.append({"id": note_id, "actor": actor, "gadget_id": payload.gadget_id})
        return NoteOut(id=note_id, gadget_id=payload.gadget_id)

    @app.post("/guardednotes/", status_code=HTTPStatus.CREATED)
    async def create_guarded_note(
        actor: Annotated[str, Depends(actor_dep)],
        payload: NoteIn,
    ) -> NoteOut:
        if store.gadgets.get(payload.gadget_id) != actor:
            raise HTTPException(status_code=HTTPStatus.FORBIDDEN, detail=_FORBIDDEN)
        note_id = store.allocate_id()
        store.notes.append({"id": note_id, "actor": actor, "gadget_id": payload.gadget_id})
        return NoteOut(id=note_id, gadget_id=payload.gadget_id)


def _mount_attachments(app: FastAPI, store: StubStore, actor_dep: ActorDependency) -> None:
    """Mount the leaky reference route whose response echoes nothing at all.

    The 201 carries only the new attachment's own id, so the injected gadget is
    invisible in it. The only way to tell whether the write landed on somebody
    else's row is to read that row back as its owner.
    """

    @app.post("/attachments/", status_code=HTTPStatus.CREATED)
    async def create_attachment(
        actor: Annotated[str, Depends(actor_dep)],
        payload: AttachmentIn,
    ) -> IdOut:
        attachment_id = store.allocate_id()
        store.attachments.setdefault(payload.gadget_id, []).append(attachment_id)
        store.notes.append({"id": attachment_id, "actor": actor, "gadget_id": payload.gadget_id})
        return IdOut(id=attachment_id)


def _mount_folds(app: FastAPI, store: StubStore, actor_dep: ActorDependency) -> None:
    """Mount the pair of routes whose whole answer is a boolean, not an id.

    Neither response can be scanned for the injected gadget, because neither
    mentions it. ``POST /folds/`` folds whatever it is handed and reports
    ``pending: false``; ``POST /guardedfolds/`` answers 200 either way and
    reports ``pending: true`` when it declined -- so a status-only grader calls
    the honest route a leak, and only the witness can tell the two apart.
    """

    @app.post("/folds/")
    async def fold(
        actor: Annotated[str, Depends(actor_dep)],
        payload: FoldIn,
    ) -> FoldOut:
        store.folds.append({"actor": actor, "gadget_id": payload.gadget_id})
        return FoldOut(pending=False)

    @app.post("/guardedfolds/")
    async def guarded_fold(
        actor: Annotated[str, Depends(actor_dep)],
        payload: FoldIn,
    ) -> FoldOut:
        if store.gadgets.get(payload.gadget_id) != actor:
            return FoldOut(pending=True)
        store.folds.append({"actor": actor, "gadget_id": payload.gadget_id})
        return FoldOut(pending=False)


def build_reference_leaky_app() -> StubDeployment:
    """Build the stub whose ids are carried in bodies and query strings, not paths.

    ``POST /notes/``, ``POST /attachments/`` and ``POST /folds/`` accept a gadget
    id from anybody and never ask who owns it -- the reference analogue of the
    widget BOLA. ``POST /guardednotes/`` and ``POST /guardedfolds/`` are the
    negative controls, and ``GET /gadgets/`` is the honest filtered listing whose
    foreign-id answer is an empty 200.
    """
    store = StubStore()
    app = FastAPI(title="dast-stub-reference")
    actor_dep = _make_actor_dependency(store)
    _mount_login(app, store)
    _mount_gadgets(app, store, actor_dep)
    _mount_notes(app, store, actor_dep)
    _mount_attachments(app, store, actor_dep)
    _mount_folds(app, store, actor_dep)
    owner, intruder = _register_identities(store)
    return StubDeployment(app=app, store=store, owner=owner, intruder=intruder)


def _mount_masked_notes(app: FastAPI, store: StubStore, actor_dep: ActorDependency) -> None:
    """Mount the route that persists a foreign reference and then hides it.

    There is no ownership check: the id arrives, the row is written, and the
    serializer resolves the reference through an owner-scoped lookup before
    rendering it. So a foreign gadget comes back ``null`` and an absent one
    comes back ``null``, and nothing in the response can tell them apart.
    """

    @app.post("/maskednotes/", status_code=HTTPStatus.CREATED)
    async def create_masked_note(
        actor: Annotated[str, Depends(actor_dep)],
        payload: NoteIn,
    ) -> MaskedNoteOut:
        note_id = store.allocate_id()
        store.notes.append({"id": note_id, "actor": actor, "gadget_id": payload.gadget_id})
        owned = store.gadgets.get(payload.gadget_id) == actor
        return MaskedNoteOut(id=note_id, gadget_id=payload.gadget_id if owned else None)


def _mount_screened_attachments(app: FastAPI, store: StubStore, actor_dep: ActorDependency) -> None:
    """Mount a silent write whose read-back surface lists only what the caller created.

    The write lands on the named gadget without asking who owns it, and the
    follow-up ``GET`` is scoped to the *creator* rather than to the object. An
    owner therefore cannot see a write somebody else made on their own row,
    which is the obligation a ``read_back_path`` is required to satisfy and this
    one deliberately does not.
    """

    @app.post("/screenedattachments/", status_code=HTTPStatus.CREATED)
    async def create_screened_attachment(
        actor: Annotated[str, Depends(actor_dep)],
        payload: AttachmentIn,
    ) -> IdOut:
        attachment_id = store.allocate_id()
        store.attachments.setdefault(payload.gadget_id, []).append(attachment_id)
        store.attachment_authors[attachment_id] = actor
        return IdOut(id=attachment_id)

    @app.get("/gadgets/{gadget_id}/screenedattachments")
    async def list_screened_attachments(
        gadget_id: int,
        actor: Annotated[str, Depends(actor_dep)],
    ) -> list[AttachmentOut]:
        if store.gadgets.get(gadget_id) != actor:
            raise HTTPException(status_code=HTTPStatus.FORBIDDEN, detail=_FORBIDDEN)
        return [
            AttachmentOut(id=attachment, gadget_id=gadget_id)
            for attachment in store.attachments.get(gadget_id, [])
            if store.attachment_authors.get(attachment) == actor
        ]


def _mount_unreadable_attachments(
    app: FastAPI,
    store: StubStore,
    actor_dep: ActorDependency,
) -> None:
    """Mount a silent write whose read-back surface fails on the row that matters.

    The listing renders each attachment's author and raises when it meets one it
    cannot attribute to the caller. An owner reading their own gadget back
    therefore gets a 500 exactly when somebody else has written to it -- the
    cell where the evidence was needed -- while the control's read-back, which
    never meets a foreign row, answers 200 and looks perfectly healthy.
    """

    @app.post("/unreadableattachments/", status_code=HTTPStatus.CREATED)
    async def create_unreadable_attachment(
        actor: Annotated[str, Depends(actor_dep)],
        payload: AttachmentIn,
    ) -> IdOut:
        attachment_id = store.allocate_id()
        store.attachments.setdefault(payload.gadget_id, []).append(attachment_id)
        store.attachment_authors[attachment_id] = actor
        return IdOut(id=attachment_id)

    @app.get("/gadgets/{gadget_id}/unreadableattachments")
    async def list_unreadable_attachments(
        gadget_id: int,
        actor: Annotated[str, Depends(actor_dep)],
    ) -> list[AttachmentOut]:
        if store.gadgets.get(gadget_id) != actor:
            raise HTTPException(status_code=HTTPStatus.FORBIDDEN, detail=_FORBIDDEN)
        rows = store.attachments.get(gadget_id, [])
        if any(store.attachment_authors.get(row) != actor for row in rows):
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail=_UNRENDERABLE,
            )
        return [AttachmentOut(id=row, gadget_id=gadget_id) for row in rows]


def build_masked_reference_app() -> StubDeployment:
    """Build the stub whose answers cannot distinguish a foreign reference from none.

    Both writes cross an ownership boundary and both are invisible in the
    evidence the harness reads, one because the serializer nulls the reference
    and one because the read surface is scoped to whoever created the row. The
    two shapes are mounted together because they are one gap seen from two
    sides: the grading rests on a response rendering a persisted foreign id the
    same way it would render the caller's own, and neither of these does.
    """
    store = StubStore()
    app = FastAPI(title="dast-stub-masked")
    actor_dep = _make_actor_dependency(store)
    _mount_login(app, store)
    _mount_gadget_collection(app, store, actor_dep)
    _mount_masked_notes(app, store, actor_dep)
    _mount_screened_attachments(app, store, actor_dep)
    owner, intruder = _register_identities(store)
    return StubDeployment(app=app, store=store, owner=owner, intruder=intruder)


def build_unreadable_evidence_app() -> StubDeployment:
    """Build the stub whose read-back fails on the cross cell and succeeds on the control."""
    store = StubStore()
    app = FastAPI(title="dast-stub-unreadable")
    actor_dep = _make_actor_dependency(store)
    _mount_login(app, store)
    _mount_gadget_collection(app, store, actor_dep)
    _mount_unreadable_attachments(app, store, actor_dep)
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

STUB_REFERENCE_SEED_REGISTRY: dict[str, SeedSpec] = {
    "gadget_id": SeedSpec(
        create_method="POST",
        create_path=REFERENCE_STUB_AUTH_PROBE_PATH,
        payload={"label": STUB_SEED_LABEL},
        id_pointer=("id",),
    ),
}

_GADGET_ECHO_REFERENCE = ObjectReference(
    field="gadget_id",
    location=ReferenceLocation.BODY,
    seed_key="gadget_id",
    evidence=EvidenceStrategy.ECHO,
)

# The fold routes answer with a flag and nothing else, so the id scan has
# nothing to find on either cell. ``pending`` going false is the whole evidence
# that the gadget was reached, and it is the only thing that separates the
# honest route's 200 from the leaky one's.
_GADGET_FOLD_REFERENCE = ObjectReference(
    field="gadget_id",
    location=ReferenceLocation.BODY,
    seed_key="gadget_id",
    evidence=EvidenceStrategy.ECHO,
    witness=EvidenceWitness(pointer=("pending",), condition=WitnessCondition.IS_FALSE),
)

_GADGET_LISTING_PROBE = ReferenceProbe(
    method="GET",
    path=REFERENCE_STUB_AUTH_PROBE_PATH,
    body={},
    references=(
        ObjectReference(
            field="gadget_id",
            location=ReferenceLocation.QUERY,
            seed_key="gadget_id",
            evidence=EvidenceStrategy.LISTING,
        ),
    ),
)

STUB_REFERENCE_REGISTRY: dict[tuple[str, str], ReferenceProbe] = {
    REFERENCE_LEAKY_NOTE_POST: ReferenceProbe(
        method="POST",
        path="/notes/",
        body={"label": STUB_REPLAY_LABEL},
        references=(_GADGET_ECHO_REFERENCE,),
    ),
    REFERENCE_GUARDED_NOTE_POST: ReferenceProbe(
        method="POST",
        path="/guardednotes/",
        body={"label": STUB_REPLAY_LABEL},
        references=(_GADGET_ECHO_REFERENCE,),
    ),
    REFERENCE_LEAKY_ATTACHMENT_POST: ReferenceProbe(
        method="POST",
        path="/attachments/",
        body={},
        references=(
            ObjectReference(
                field="gadget_id",
                location=ReferenceLocation.BODY,
                seed_key="gadget_id",
                evidence=EvidenceStrategy.READ_BACK,
                read_back_path="/gadgets/{gadget_id}/attachments",
            ),
        ),
    ),
    REFERENCE_LEAKY_FOLD_POST: ReferenceProbe(
        method="POST",
        path="/folds/",
        body={},
        references=(_GADGET_FOLD_REFERENCE,),
    ),
    REFERENCE_GUARDED_FOLD_POST: ReferenceProbe(
        method="POST",
        path="/guardedfolds/",
        body={},
        references=(_GADGET_FOLD_REFERENCE,),
    ),
    REFERENCE_GADGET_LISTING_GET: _GADGET_LISTING_PROBE,
}


MASKED_REFERENCE_REGISTRY: dict[tuple[str, str], ReferenceProbe] = {
    MASKED_NOTE_POST: ReferenceProbe(
        method="POST",
        path="/maskednotes/",
        body={"label": STUB_REPLAY_LABEL},
        references=(_GADGET_ECHO_REFERENCE,),
    ),
    SCREENED_ATTACHMENT_POST: ReferenceProbe(
        method="POST",
        path="/screenedattachments/",
        body={},
        references=(
            ObjectReference(
                field="gadget_id",
                location=ReferenceLocation.BODY,
                seed_key="gadget_id",
                evidence=EvidenceStrategy.READ_BACK,
                read_back_path="/gadgets/{gadget_id}/screenedattachments",
            ),
        ),
    ),
    REFERENCE_GADGET_LISTING_GET: _GADGET_LISTING_PROBE,
}

UNREADABLE_REFERENCE_REGISTRY: dict[tuple[str, str], ReferenceProbe] = {
    UNREADABLE_ATTACHMENT_POST: ReferenceProbe(
        method="POST",
        path="/unreadableattachments/",
        body={},
        references=(
            ObjectReference(
                field="gadget_id",
                location=ReferenceLocation.BODY,
                seed_key="gadget_id",
                evidence=EvidenceStrategy.READ_BACK,
                read_back_path="/gadgets/{gadget_id}/unreadableattachments",
            ),
        ),
    ),
    REFERENCE_GADGET_LISTING_GET: _GADGET_LISTING_PROBE,
}


def reference_cells_for(
    report: MatrixReport,
    route: tuple[str, str],
    field: str,
) -> dict[Cell, ReferenceCellResult]:
    """Return one reference's two cells, keyed by cell, asserting neither is missing."""
    method, path = route
    found = {
        result.cell: result
        for result in report.reference_results
        if result.route.method == method
        and result.route.path == path
        and result.reference.field == field
    }
    assert set(found) == set(REFERENCE_CELL_ORDER), (
        f"{method} {path} {field} was probed with cells {sorted(cell.name for cell in found)}; "
        f"every reference needs all of {sorted(cell.name for cell in REFERENCE_CELL_ORDER)}"
    )
    return found


@pytest.fixture
def leaky_deployment() -> StubDeployment:
    """Provide a freshly built leaky stub, isolated from every other test."""
    return build_leaky_app()


@pytest.fixture
def blind_deployment() -> StubDeployment:
    """Provide a freshly built "401s everything" stub."""
    return build_blind_app()


@pytest.fixture
def reference_deployment() -> StubDeployment:
    """Provide a freshly built stub whose ids ride in bodies and query strings."""
    return build_reference_leaky_app()


@pytest.fixture
def masked_deployment() -> StubDeployment:
    """Provide a freshly built stub whose responses mask the reference they persisted."""
    return build_masked_reference_app()


@pytest.fixture
def unreadable_deployment() -> StubDeployment:
    """Provide a freshly built stub whose read-back fails on the cell that needed it."""
    return build_unreadable_evidence_app()


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


@pytest_asyncio.fixture
async def reference_client(reference_deployment: StubDeployment) -> AsyncIterator[AsyncClient]:
    """Provide an ASGI-backed client for the body/query reference stub."""
    async with stub_client(reference_deployment) as client:
        yield client


@pytest_asyncio.fixture
async def masked_client(masked_deployment: StubDeployment) -> AsyncIterator[AsyncClient]:
    """Provide an ASGI-backed client for the reference-masking stub."""
    async with stub_client(masked_deployment) as client:
        yield client


@pytest_asyncio.fixture
async def unreadable_client(unreadable_deployment: StubDeployment) -> AsyncIterator[AsyncClient]:
    """Provide an ASGI-backed client for the unreadable-evidence stub."""
    async with stub_client(unreadable_deployment) as client:
        yield client


def stub_config(
    *,
    min_routes: int = STUB_OBJECT_SCOPED_ROUTES,
    min_references: int = 0,
) -> MatrixConfig:
    """Return the matrix configuration that points the harness at a stub app.

    The widget stubs carry no body or query references at all, so the reference
    registry is empty and the reference floor is zero unless a caller raises it
    on purpose.
    """
    return MatrixConfig(
        seed_registry=STUB_SEED_REGISTRY,
        replay_bodies=STUB_REPLAY_BODIES,
        reference_registry={},
        auth_probe_path=STUB_AUTH_PROBE_PATH,
        min_routes=min_routes,
        min_references=min_references,
    )


def reference_stub_config(
    *,
    min_routes: int = REFERENCE_STUB_OBJECT_SCOPED_ROUTES,
    min_references: int = REFERENCE_STUB_REFERENCES,
    allowlist: tuple[AllowlistEntry, ...] = (),
    reference_registry: ReferenceRegistry | None = None,
) -> MatrixConfig:
    """Return the configuration that points the harness at the reference stub.

    The allow-list and the registry are parameters because the guards that
    bound this dimension can only be exercised by handing the run a file that
    excuses too much, or a registry declaring something the target no longer
    publishes.
    """
    return MatrixConfig(
        seed_registry=STUB_REFERENCE_SEED_REGISTRY,
        replay_bodies={},
        reference_registry=(
            STUB_REFERENCE_REGISTRY if reference_registry is None else reference_registry
        ),
        allowlist=allowlist,
        auth_probe_path=REFERENCE_STUB_AUTH_PROBE_PATH,
        min_routes=min_routes,
        min_references=min_references,
    )


def masked_stub_config() -> MatrixConfig:
    """Return the configuration that points the harness at the masking stub."""
    return MatrixConfig(
        seed_registry=STUB_REFERENCE_SEED_REGISTRY,
        replay_bodies={},
        reference_registry=MASKED_REFERENCE_REGISTRY,
        auth_probe_path=REFERENCE_STUB_AUTH_PROBE_PATH,
        min_routes=MASKED_STUB_OBJECT_SCOPED_ROUTES,
        min_references=MASKED_STUB_REFERENCES,
    )


def unreadable_stub_config() -> MatrixConfig:
    """Return the configuration that points the harness at the unreadable-evidence stub."""
    return MatrixConfig(
        seed_registry=STUB_REFERENCE_SEED_REGISTRY,
        replay_bodies={},
        reference_registry=UNREADABLE_REFERENCE_REGISTRY,
        auth_probe_path=REFERENCE_STUB_AUTH_PROBE_PATH,
        min_routes=UNREADABLE_STUB_OBJECT_SCOPED_ROUTES,
        min_references=UNREADABLE_STUB_REFERENCES,
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
        reference_registry={},
        auth_probe_path=STUB_AUTH_PROBE_PATH,
    )


def reference_stub_overrides(
    client: AsyncClient,
    *,
    bootstrap: Bootstrap | None,
) -> HarnessOverrides:
    """Bundle the seams that point the CLI at the reference stub."""
    return HarnessOverrides(
        client=client,
        bootstrap=bootstrap,
        seed_registry=STUB_REFERENCE_SEED_REGISTRY,
        replay_bodies={},
        reference_registry=STUB_REFERENCE_REGISTRY,
        auth_probe_path=REFERENCE_STUB_AUTH_PROBE_PATH,
    )


def close_client(client: AsyncClient) -> None:
    """Close a client from synchronous test code, which owns no event loop."""
    asyncio.run(client.aclose())


def drive_main_with(
    overrides: HarnessOverrides,
    *,
    min_routes: int,
    min_references: int = 0,
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
            "--min-references",
            str(min_references),
        ],
        overrides=overrides,
    )


def drive_main(
    deployment: StubDeployment,
    *,
    min_routes: int,
    min_references: int = 0,
    client: AsyncClient | None = None,
    bootstrap: Bootstrap | None = None,
) -> int:
    """Run the CLI end to end against a stub app and return its exit code.

    Args:
        deployment: The stub to probe.
        min_routes: The coverage floor this run is given.
        min_references: The reference-coverage floor this run is given.
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
            min_references=min_references,
        )
    finally:
        close_client(session_client)


def drive_reference_main(
    deployment: StubDeployment,
    *,
    min_routes: int = REFERENCE_STUB_OBJECT_SCOPED_ROUTES,
    min_references: int = REFERENCE_STUB_REFERENCES,
) -> int:
    """Run the CLI end to end against the reference stub and return its exit code."""
    session_client = stub_client(deployment)
    try:
        return drive_main_with(
            reference_stub_overrides(
                session_client,
                bootstrap=make_stub_bootstrap(deployment),
            ),
            min_routes=min_routes,
            min_references=min_references,
        )
    finally:
        close_client(session_client)


# --- The production application, served in-process from a throwaway database ---
#
# Every stub above proves the harness *grades* correctly. This last section is
# for the one thing no stub can prove: that the token bootstrap works against
# the real application. It is a synchronous context manager rather than a
# ``pytest_asyncio`` fixture because the thing under test is a CLI entry point
# that owns its own ``asyncio.run``; an async fixture would already hold the
# only loop the process is allowed to have.


REAL_APP_BASE_URL = "http://dast-contract-target"

# A route that requires a token and touches the database, so a probe against it
# proves both the credential and the session wiring.
REAL_APP_PROBE_PATH = "/habits/"


@dataclass(frozen=True)
class RealAppTarget:
    """The production application together with the database URL it is serving from."""

    client: AsyncClient
    database_url: str


async def _create_schema(engine: AsyncEngine) -> None:
    """Create every table the application declares on a fresh database."""
    async with engine.begin() as connection:
        await connection.run_sync(SQLModel.metadata.create_all)


@contextmanager
def serve_real_app(tmp_path: Path) -> Iterator[RealAppTarget]:
    """Serve the real application from a throwaway file-backed SQLite database.

    File-backed rather than in-memory because the identity bootstrap opens an
    engine of its own against the URL it is handed, exactly as it does in
    production; two engines onto ``:memory:`` would see two different databases
    and the login would 401 for reasons unrelated to the code under test.

    ``NullPool`` because the caller runs its own event loop: a pooled aiosqlite
    connection opened while building the schema would be handed back out inside
    a *different* loop once the CLI starts one, which is a hang rather than an
    assertion failure.

    Args:
        tmp_path: A directory to put the throwaway database file in.

    Yields:
        A client wired straight into the application, plus that database's URL.
    """
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'dast-contract.db'}"
    engine = create_async_engine(database_url, poolclass=NullPool)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    _replace_array_columns()
    asyncio.run(_create_schema(engine))

    async def _per_request_session() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            yield session

    production_app.dependency_overrides[get_session] = _per_request_session
    client = AsyncClient(transport=ASGITransport(app=production_app), base_url=REAL_APP_BASE_URL)
    try:
        yield RealAppTarget(client=client, database_url=database_url)
    finally:
        close_client(client)
        production_app.dependency_overrides.clear()
        asyncio.run(engine.dispose())
