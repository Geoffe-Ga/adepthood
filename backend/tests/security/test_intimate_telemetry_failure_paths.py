"""An Intimate entry's words reach no telemetry sink when a real request fails (#3160, C12).

Claim C12 (#3069): Intimate content is absent from analytics, logging and
telemetry. ``test_telemetry_sentinels.py`` proves the *scrubber*: canaries
planted straight into an exception, an event or a record come out clean. This
file proves the *failure paths a real request takes*, starting from what the
writer actually stored -- an Intimate entry whose body and title are canaries --
and failing it four ways through the production app and its middleware stack:

* **validation** -- a ``PATCH /journal/{entry_id}`` carrying the canary body
  beside a field the schema rejects;
* **database** -- a real SQLite driver error (``RAISE(ABORT, ...)`` from a
  trigger) whose message carries the canary, raised on the commit that holds
  the canary body as a bound parameter;
* **provider** -- the provider SDK building its typed error from a canned 4xx
  or 5xx body that echoes the prompt (``tests/provider_transport.py``), on a
  *Personal* entry, since an Intimate one must never reach the provider at all
  -- which is asserted too;
* **middleware** -- an exception raised inside ``SecurityHeadersMiddleware``
  after the journal write has committed, so it escapes every inner layer,
  passes the access logger's ``except`` branch, reaches Starlette's
  ``ServerErrorMiddleware`` and is re-raised to the server.

Two sinks of their own are then driven on a failure path the same way:

* **vault** -- a connected Creek Vault whose journal ingest fails with the
  canary in the transport error and in an echoed 5xx body; the process tally
  (``telemetry.vault_telemetry``) and its one ``creek vault outcome`` record
  are read back;
* **usage row** -- a provider that answers with the canary as its model name
  and as an unreadable reflection, so the pass comes back empty; the stored
  ``LLMUsageLog`` rows (``db.llmusagelog``) and the settlement line are read
  back.

Every case reads the same four sinks of the sink registry
(``privacy.sinks``), each the way a deployment would write it:

* ``telemetry.sentry_envelope`` -- the production Sentry client over a capturing
  transport (``helpers.sentry_capture``);
* ``telemetry.root_log`` -- the deployed root handler ``configure_logging``
  installs, writing to a buffer instead of stderr;
* ``telemetry.access_log`` -- every ``adepthood.access`` record, message and
  structured fields;
* ``telemetry.uvicorn_error_log`` -- a handler on the ``uvicorn`` logger as
  uvicorn's own config installs one (hardened by ``configure_logging``, as at
  boot), fed by an ASGI wrapper that does what uvicorn's ``run_asgi`` does with
  an exception the app lets escape.

Absence is only evidence from a live sink, so every case asserts positively as
well: where the path reaches a sink, the request id, the route template and the
exception type are there; and every case ends by probing all four sinks, so a
sink that went silent fails the case rather than passing it.
"""

from __future__ import annotations

import io
import json
import logging
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import TYPE_CHECKING, Any, Final, NoReturn

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlmodel import col, select
from starlette.status import HTTP_422_UNPROCESSABLE_CONTENT

import sentry as error_monitoring
import telemetry_safety
from database import get_session
from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import CONTRACT_VERSION, CreekCapability
from main import app
from middleware import security_headers
from models.journal_entry import JournalEntry
from models.llm_usage_log import LLMUsageLog
from observability import (
    TRACE_ID_HEADER,
    ContentFreeFormatter,
    configure_logging,
    remove_app_log_handlers_for_tests,
)
from privacy.sinks import SinkId
from schemas.journal import ASPECT_MAX
from services import botmason, creek_vault_telemetry, llm_usage
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_telemetry import (
    VAULT_OUTCOME_EVENT,
    VaultTelemetryOutcome,
    reset_vault_telemetry_for_tests,
    vault_outcome_counts,
)
from tests.helpers.sentry_capture import CapturedEvent, capturing_sentry
from tests.helpers.telemetry_canaries import SHORT_CANARY, assert_no_canary
from tests.provider_transport import (
    ANTHROPIC_KEY,
    ANTHROPIC_MODEL,
    TransportStub,
    use_anthropic,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession
    from starlette.types import ASGIApp, Receive, Scope, Send

_PASSWORD: Final = "secret12345"  # pragma: allowlist secret

_ENTRY_ROUTE: Final = "/journal/{entry_id}"
_RESONANCE_ROUTE: Final = "/journal/{entry_id}/resonance"
_ACCESS_LOGGER: Final = "adepthood.access"
_SERVER_LOGGER: Final = "uvicorn"
_SERVER_ERROR_LOGGER: Final = "uvicorn.error"
#: The HTTP clients the provider SDKs dial through (``observability``'s own list).
_OUTBOUND_CLIENT_LOGGERS: Final = ("httpx", "httpx2")
#: What uvicorn's ``RequestResponseCycle.run_asgi`` logs for an escaped exception.
_SERVER_EXCEPTION_LINE: Final = "Exception in ASGI application\n"
#: A plain handler format, as uvicorn's handler has before ``configure_logging`` hardens it.
_SERVER_DEFAULT_FORMAT: Final = "%(levelname)s %(message)s"

#: The four sinks every case reads, by registry id.
SINKS_ASSERTED: Final = frozenset(
    {
        SinkId.SENTRY_ENVELOPE,
        SinkId.ROOT_LOG,
        SinkId.ACCESS_LOG,
        SinkId.UVICORN_ERROR_LOG,
        SinkId.OUTBOUND_CLIENT_LOG,
    }
)

_INTIMATE: Final = "intimate"
_PERSONAL: Final = "personal"

#: What a schema rejection answers.
_UNPROCESSABLE: Final = HTTP_422_UNPROCESSABLE_CONTENT
#: An aspect the schema's ``le`` bound rejects.
_ASPECT_OUT_OF_RANGE: Final = ASPECT_MAX + 1

#: The transient status a provider answers when it fails on its own side.
_PROVIDER_SERVER_ERROR: Final = HTTPStatus.INTERNAL_SERVER_ERROR
#: Anthropic's "credit balance" refusal, a permanent 400 logged with its traceback.
_PROVIDER_CREDIT_REFUSAL: Final = HTTPStatus.BAD_REQUEST
_CREDIT_PROSE: Final = "Your credit balance is too low to access the Anthropic API."

# Attributes every ``LogRecord`` carries; anything else on a record is an extra.
_STANDARD_RECORD_KEYS: Final = frozenset(
    {*logging.makeLogRecord({}).__dict__, "message", "asctime", "trace_id"}
)


# ── The sinks ────────────────────────────────────────────────────────────────


class _RecordList(logging.Handler):
    """Keep every record handed to it, for reading back after the flow."""

    def __init__(self) -> None:
        """Start with no records."""
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        """Keep ``record``."""
        self.records.append(record)


def _structured(record: logging.LogRecord) -> str:
    """A record's message and every extra field, as a log shipper would read them."""
    extras = {k: v for k, v in record.__dict__.items() if k not in _STANDARD_RECORD_KEYS}
    return f"{record.getMessage()} {json.dumps(extras, default=str, ensure_ascii=False)}"


@dataclass
class Sinks:
    """The four telemetry sinks a failing request can write to, as deployed."""

    sentry_events: list[CapturedEvent]
    root: io.StringIO
    server: io.StringIO
    access: _RecordList
    outbound: _RecordList

    def sentry_blob(self) -> str:
        """Every captured envelope, serialised both ways a vendor could store it."""
        dumped = json.dumps(self.sentry_events, ensure_ascii=False, default=str)
        return dumped + json.dumps(self.sentry_events, default=str)

    def access_blob(self) -> str:
        """Every access record, message and structured fields."""
        return "\n".join(_structured(record) for record in self.access.records)

    def blobs(self) -> dict[SinkId, str]:
        """What each sink holds, keyed by its registry id."""
        return {
            SinkId.SENTRY_ENVELOPE: self.sentry_blob(),
            SinkId.ROOT_LOG: self.root.getvalue(),
            SinkId.ACCESS_LOG: self.access_blob(),
            SinkId.UVICORN_ERROR_LOG: self.server.getvalue(),
            SinkId.OUTBOUND_CLIENT_LOG: "\n".join(
                _structured(record) for record in self.outbound.records
            ),
        }

    def assert_clean(self, *canaries: str) -> None:
        """No sink holds any fragment of any canary."""
        assert set(self.blobs()) == SINKS_ASSERTED
        for sink, blob in self.blobs().items():
            for canary in canaries:
                try:
                    assert_no_canary(blob, canary)
                except AssertionError as leak:
                    msg = f"{sink} carried an Intimate canary: {leak}"
                    raise AssertionError(msg) from None

    def access_records_for(self, route: str) -> list[logging.LogRecord]:
        """The access records naming ``route``'s template."""
        return [r for r in self.access.records if getattr(r, "http_path", None) == route]

    def only_event(self) -> CapturedEvent:
        """The single Sentry event the flow shipped."""
        assert len(self.sentry_events) == 1, self.sentry_events
        return self.sentry_events[0]

    def assert_live(self) -> None:
        """Probe every sink after the flow: an absence from a dead sink proves nothing."""
        probe = f"c12_probe_{uuid.uuid4().hex}"
        logging.getLogger("tests.c12").warning(probe)
        logging.getLogger(_ACCESS_LOGGER).warning(probe)
        logging.getLogger(_SERVER_ERROR_LOGGER).warning(probe)
        for name in _OUTBOUND_CLIENT_LOGGERS:
            logging.getLogger(name).warning(probe)
        error_monitoring.capture_exception(_ProbeError(), request_id=probe)
        for sink, blob in self.blobs().items():
            assert probe in blob, f"{sink} went silent"


class _ProbeError(Exception):
    """Raised nowhere: captured once per case to prove the Sentry client is live."""


@pytest.fixture
def sinks(monkeypatch: pytest.MonkeyPatch) -> Iterator[Sinks]:
    """Arm every telemetry sink the way a deployment arms it, and read each back.

    uvicorn configures its own loggers before it imports the app, and the app's
    lifespan then calls ``configure_logging``, which installs the root handler
    and hardens uvicorn's handlers; the order here is that order.
    """
    server = logging.getLogger(_SERVER_LOGGER)
    server_stream = io.StringIO()
    server_handler = logging.StreamHandler(server_stream)
    server_handler.setFormatter(logging.Formatter(_SERVER_DEFAULT_FORMAT))
    monkeypatch.setattr(server, "handlers", [*server.handlers, server_handler])
    access_logger = logging.getLogger(_ACCESS_LOGGER)
    access = _RecordList()
    monkeypatch.setattr(access_logger, "handlers", [*access_logger.handlers, access])
    outbound = _RecordList()
    for name in _OUTBOUND_CLIENT_LOGGERS:
        client_logger = logging.getLogger(name)
        monkeypatch.setattr(client_logger, "handlers", [*client_logger.handlers, outbound])
    # ``configure_logging`` moves the root's level and raises the clients' out of
    # INFO; ``setLevel`` on the way out also clears the logging level cache.
    previous_levels = {
        name: logging.getLogger(name).level for name in ("", *_OUTBOUND_CLIENT_LOGGERS)
    }
    access_disabled = logging.getLogger("uvicorn.access").disabled
    remove_app_log_handlers_for_tests()
    root_stream = io.StringIO()
    configure_logging(stream=root_stream)
    assert isinstance(server_handler.formatter, ContentFreeFormatter), "hardened as at boot"
    try:
        with capturing_sentry(monkeypatch) as events:
            yield Sinks(events, root_stream, server_stream, access, outbound)
    finally:
        remove_app_log_handlers_for_tests()
        for name, level in previous_levels.items():
            logging.getLogger(name).setLevel(level)
        logging.getLogger("uvicorn.access").disabled = access_disabled


class _ServerLayer:
    """The one thing uvicorn does with an exception the app lets escape: log it.

    Mirrors ``uvicorn.protocols.http.*_impl.RequestResponseCycle.run_asgi``,
    which catches what the ASGI app raised and writes
    ``"Exception in ASGI application"`` with the traceback to ``uvicorn.error``
    -- a logger whose records stop at uvicorn's own handler, never the root's.
    """

    def __init__(self, inner: ASGIApp) -> None:
        """Serve ``inner``."""
        self.inner = inner

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Run the app; log an escaped exception as the server does, then swallow it."""
        try:
            await self.inner(scope, receive, send)
        except Exception:  # the server's own catch-all, by design
            # ``exception`` is ``error`` with the active exception attached: the
            # record uvicorn writes with ``exc_info=exc``.
            logging.getLogger(_SERVER_ERROR_LOGGER).exception(_SERVER_EXCEPTION_LINE)


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    """The production app behind the server layer, on the test database."""

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session
    transport = ASGITransport(app=_ServerLayer(app), raise_app_exceptions=False)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as http:
            yield http
    finally:
        app.dependency_overrides.clear()


# ── The writer ───────────────────────────────────────────────────────────────


@dataclass
class Writer:
    """One account, its canaries, and the request id each of its calls carries."""

    http: AsyncClient
    session: AsyncSession
    tag: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    headers: dict[str, str] = field(default_factory=dict)
    user_id: int = 0

    @property
    def canary(self) -> str:
        """The body canary: unique to this writer."""
        return f"{SHORT_CANARY}_BODY_{self.tag}"

    @property
    def title_canary(self) -> str:
        """The title canary: unique to this writer."""
        return f"{SHORT_CANARY}_TITLE_{self.tag}"

    @property
    def request_id(self) -> str:
        """The ``X-Request-ID`` every call from this writer carries."""
        return f"c12-{self.tag}"

    def body(self) -> str:
        """What the entry says: the canary, and something a person might write."""
        return f"{self.canary} I sat with the river and did not look away."

    async def signup(self) -> Writer:
        """Create the account and keep its bearer headers."""
        response = await self.http.post(
            "/auth/signup", json={"email": f"c12-{self.tag}@example.com", "password": _PASSWORD}
        )
        assert response.status_code == HTTPStatus.OK, response.text
        payload = response.json()
        self.headers = {
            "Authorization": f"Bearer {payload['token']}",
            TRACE_ID_HEADER: self.request_id,
        }
        self.user_id = int(payload["user_id"])
        return self

    async def seed(self, tier: str) -> int:
        """Store one entry whose body and title are this writer's canaries."""
        entry = JournalEntry(
            sender="user",
            user_id=self.user_id,
            message=self.body(),
            title=self.title_canary,
            classification=tier,
        )
        self.session.add(entry)
        await self.session.commit()
        await self.session.refresh(entry)
        assert entry.id is not None
        return entry.id


@pytest_asyncio.fixture
async def writer(client: AsyncClient, db_session: AsyncSession) -> Writer:
    """A signed-up writer, made before any sink is read."""
    return await Writer(client, db_session).signup()


# ── Positive controls ────────────────────────────────────────────────────────


def _exception_types(event: CapturedEvent) -> list[str]:
    """The exception types an event reports, outermost last."""
    exception = event["exception"]
    assert isinstance(exception, dict)
    values = exception["values"]
    assert isinstance(values, list)
    return [str(entry["type"]) for entry in values]


def _request_context(event: CapturedEvent) -> dict[str, object]:
    """The allow-listed request context an event carries."""
    contexts = event["contexts"]
    assert isinstance(contexts, dict)
    context = contexts[error_monitoring.REQUEST_CONTEXT_KEY]
    assert isinstance(context, dict)
    return context


def _assert_diagnosable_event(
    event: CapturedEvent, *, request_id: str, route: str, exc_type: str
) -> None:
    """The event names the request, the route template and the exception type."""
    assert event["tags"] == {"request_id": request_id}
    assert _request_context(event)["request_path"] == route
    assert _request_context(event)["request_id"] == request_id
    assert exc_type in _exception_types(event)


def _withheld(exc_type: str) -> str:
    """How a log line names an exception: its type, never its message."""
    return f"{exc_type}: {telemetry_safety.MESSAGE_WITHHELD}"


# ── (a) Validation ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_rejected_patch_carrying_an_intimate_body_ships_no_canary(
    sinks: Sinks, writer: Writer
) -> None:
    """A schema rejection beside the canary body is a 422 every sink records without it."""
    entry_id = await writer.seed(_INTIMATE)

    response = await writer.http.patch(
        f"/journal/{entry_id}",
        json={
            "message": writer.body(),
            "title": writer.title_canary,
            "primary_aspect": _ASPECT_OUT_OF_RANGE,
        },
        headers=writer.headers,
    )

    assert response.status_code == _UNPROCESSABLE
    sinks.assert_clean(writer.canary, writer.title_canary)
    # Handled, so nothing is reported -- and the access line still names it.
    assert sinks.sentry_events == []
    (record,) = sinks.access_records_for(_ENTRY_ROUTE)
    assert getattr(record, "http_status", None) == _UNPROCESSABLE
    assert getattr(record, "http_method", None) == "PATCH"
    assert f"route={_ENTRY_ROUTE} status={_UNPROCESSABLE}" in sinks.root.getvalue()
    sinks.assert_live()


# ── (b) Database ─────────────────────────────────────────────────────────────


async def _refuse_every_journal_update(session: AsyncSession, canary: str) -> None:
    """Make the driver itself refuse the next update, in a message carrying ``canary``.

    ``RAISE(ABORT, ...)`` in a trigger is SQLite's own constraint failure:
    ``sqlite3`` raises ``IntegrityError`` carrying the trigger's text, and
    SQLAlchemy wraps it with the statement and its bound parameters -- the
    canary body among them -- exactly as a real constraint violation would be.
    The trigger goes when the fixture drops the table.
    """
    await session.execute(
        text(
            "CREATE TRIGGER c12_refuse_update BEFORE UPDATE ON journalentry "
            f"BEGIN SELECT RAISE(ABORT, 'constraint failed for {canary}'); END"
        )
    )
    await session.commit()


@pytest.mark.asyncio
async def test_a_driver_error_carrying_an_intimate_body_ships_no_canary(
    sinks: Sinks, writer: Writer
) -> None:
    """A real ``IntegrityError`` on the commit that binds the canary is a clean 500."""
    entry_id = await writer.seed(_INTIMATE)
    await _refuse_every_journal_update(writer.session, writer.canary)

    response = await writer.http.patch(
        f"/journal/{entry_id}",
        json={"message": f"{writer.body()} And again.", "title": writer.title_canary},
        headers=writer.headers,
    )

    assert response.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    sinks.assert_clean(writer.canary, writer.title_canary)
    _assert_diagnosable_event(
        sinks.only_event(),
        request_id=writer.request_id,
        route=_ENTRY_ROUTE,
        exc_type="IntegrityError",
    )
    root = sinks.root.getvalue()
    assert f"[{writer.request_id}] unhandled_exception" in root
    assert _withheld("IntegrityError") in root
    (record,) = sinks.access_records_for(_ENTRY_ROUTE)
    assert getattr(record, "http_status", None) == HTTPStatus.INTERNAL_SERVER_ERROR
    sinks.assert_live()


# ── (c) Provider ─────────────────────────────────────────────────────────────


def _echoing_body(status: HTTPStatus, prompt_echo: str) -> dict[str, Any]:
    """An Anthropic error body that quotes the prompt back, as some vendors do."""
    if status == _PROVIDER_CREDIT_REFUSAL:
        error = {"type": "invalid_request_error", "message": f"{_CREDIT_PROSE} {prompt_echo}"}
    else:
        error = {"type": "api_error", "message": f"Internal error processing: {prompt_echo}"}
    return {"type": "error", "error": error, "echo": {"prompt": prompt_echo}}


#: Per canned failure: what the route answers, and the SDK error type it builds.
_PROVIDER_FAILURES: Final = {
    _PROVIDER_SERVER_ERROR: (HTTPStatus.BAD_GATEWAY, "InternalServerError"),
    _PROVIDER_CREDIT_REFUSAL: (HTTPStatus.PAYMENT_REQUIRED, "BadRequestError"),
}


def _arm_echoing_provider(
    monkeypatch: pytest.MonkeyPatch, status: HTTPStatus, echo: str
) -> TransportStub:
    """A writer-keyed Anthropic provider whose every answer is ``status`` echoing ``echo``."""
    stub = use_anthropic(monkeypatch, status, _echoing_body(status, echo))
    monkeypatch.delenv(botmason.STUB_SEAM_ENV_VAR, raising=False)
    # The retry loop's backoff, shortened: the case asserts what is logged, not when.
    monkeypatch.setattr(botmason, "_RETRY_BASE_DELAY", 0.0)
    return stub


@pytest.mark.asyncio
@pytest.mark.parametrize("status", list(_PROVIDER_FAILURES), ids=["5xx", "4xx"])
async def test_a_provider_error_echoing_the_prompt_ships_no_canary(
    sinks: Sinks, writer: Writer, monkeypatch: pytest.MonkeyPatch, status: HTTPStatus
) -> None:
    """On a Personal entry the SDK builds its error from a body quoting the prompt.

    The Personal entry is the only way to reach that path: the stub's recorded
    request body proves the prompt really carried the canary out, so the echo
    is the vendor's, and every sink still holds none of it.
    """
    stub = _arm_echoing_provider(monkeypatch, status, writer.body())
    entry_id = await writer.seed(_PERSONAL)

    response = await writer.http.post(
        f"/journal/{entry_id}/resonance",
        headers={**writer.headers, "X-LLM-API-Key": ANTHROPIC_KEY},
    )

    answered, sdk_error = _PROVIDER_FAILURES[status]
    assert response.status_code == answered, response.text
    assert stub.request_count >= 1
    assert any(writer.canary in json.dumps(body) for body in stub.bodies), "the prompt went out"
    sinks.assert_clean(writer.canary)
    assert _withheld(sdk_error) in sinks.root.getvalue()
    assert f"[{writer.request_id}]" in sinks.root.getvalue()
    (record,) = sinks.access_records_for(_RESONANCE_ROUTE)
    assert getattr(record, "http_status", None) == answered
    sinks.assert_live()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", list(_PROVIDER_FAILURES), ids=["5xx", "4xx"])
async def test_an_intimate_entry_never_reaches_the_failing_provider(
    sinks: Sinks, writer: Writer, monkeypatch: pytest.MonkeyPatch, status: HTTPStatus
) -> None:
    """The same armed provider, an Intimate entry: zero transport requests, zero canaries."""
    stub = _arm_echoing_provider(monkeypatch, status, writer.body())
    entry_id = await writer.seed(_INTIMATE)

    response = await writer.http.post(
        f"/journal/{entry_id}/resonance",
        headers={**writer.headers, "X-LLM-API-Key": ANTHROPIC_KEY},
    )

    assert response.status_code == HTTPStatus.OK, response.text
    assert stub.request_count == 0
    assert stub.bodies == []
    sinks.assert_clean(writer.canary, writer.title_canary)
    (record,) = sinks.access_records_for(_RESONANCE_ROUTE)
    assert getattr(record, "http_status", None) == HTTPStatus.OK
    sinks.assert_live()


# ── (d) Middleware ───────────────────────────────────────────────────────────


def _raise(exc: BaseException) -> NoReturn:
    """Raise ``exc``; called inside a ``try`` so the chain gets a real traceback."""
    raise exc


class _HeaderPolicyError(RuntimeError):
    """A failure inside the security-header layer, authored with the user's words."""


class _ExplodingEnviron:
    """Stands in for ``os`` inside the security-header layer; its env lookup fails."""

    def __init__(self, canary: str, title_canary: str) -> None:
        """Fail with both canaries: one in the message, one in the cause."""
        self.canary = canary
        self.title_canary = title_canary

    def getenv(self, _name: str, _default: str | None = None) -> str:
        """Raise mid-response, chained from a cause that carries the title."""
        try:
            _raise(KeyError(self.title_canary))
        except KeyError as cause:
            msg = f"could not apply header policy while saving {self.canary}"
            raise _HeaderPolicyError(msg) from cause


@pytest.mark.asyncio
async def test_a_middleware_failure_during_an_intimate_write_ships_no_canary(
    sinks: Sinks, writer: Writer, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An exception raised in middleware after the write committed reaches every sink, clean.

    ``SecurityHeadersMiddleware`` sits above ``UnhandledExceptionMiddleware``, so
    its failure escapes to the access logger's ``except`` branch, then to
    Starlette's ``ServerErrorMiddleware`` (Sentry and the root log), which
    re-raises it to the server (uvicorn's handler).
    """
    entry_id = await writer.seed(_INTIMATE)
    monkeypatch.setattr(
        security_headers, "os", _ExplodingEnviron(writer.canary, writer.title_canary)
    )

    response = await writer.http.patch(
        f"/journal/{entry_id}",
        json={"message": f"{writer.body()} Written again.", "title": writer.title_canary},
        headers=writer.headers,
    )

    assert response.status_code == HTTPStatus.INTERNAL_SERVER_ERROR
    sinks.assert_clean(writer.canary, writer.title_canary)
    _assert_diagnosable_event(
        sinks.only_event(),
        request_id=writer.request_id,
        route=_ENTRY_ROUTE,
        exc_type="_HeaderPolicyError",
    )
    assert _exception_types(sinks.only_event()) == ["KeyError", "_HeaderPolicyError"]
    root = sinks.root.getvalue()
    assert "unhandled_exception" in root
    assert _withheld("_HeaderPolicyError") in root
    (failed,) = sinks.access_records_for(_ENTRY_ROUTE)
    assert failed.getMessage() == "request_failed"
    assert failed.exc_info is not None
    server = sinks.server.getvalue()
    assert "Exception in ASGI application" in server
    assert _withheld("_HeaderPolicyError") in server
    assert _withheld("KeyError") in server
    sinks.assert_live()


# ── (e) Vault telemetry ──────────────────────────────────────────────────────

_VAULT_URL: Final = "https://vault.c12.example.test"
_VAULT_CREDENTIAL: Final = "c12-vault-credential"  # pragma: allowlist secret
_VAULT_CAPABILITIES_PATH: Final = "/v1/capabilities"
_VAULT_TELEMETRY_LOGGER: Final = creek_vault_telemetry.__name__
#: The two ways a failing vault can hand the canary back: in the exception the
#: transport raises, and in the body of a 5xx it answers.
_VAULT_RAISES: Final = "transport"
_VAULT_ECHOES: Final = "5xx"


class _FailingVault:
    """A connected Creek Vault that handshakes cleanly and then fails every ingest.

    Its failure carries ``canary`` -- in the transport error it raises, or in
    the 5xx body it answers -- exactly as a vault that quoted the entry back
    would. Every request body it is sent is kept, so a case can prove the
    canary really went out and the echo is the vault's.
    """

    def __init__(self, canary: str, failure: str) -> None:
        """Fail with ``canary`` in the way ``failure`` names."""
        self.canary = canary
        self.failure = failure
        self.bodies: list[str] = []

    @staticmethod
    def _capabilities() -> httpx.Response:
        """The capability document of a healthy vault that accepts journal upserts."""
        minor = ".".join(CONTRACT_VERSION.split(".")[:2])
        return httpx.Response(
            HTTPStatus.OK,
            json={
                "vault": {"available": True},
                "capabilities": ["journal-upsert"],
                "contract_version": CONTRACT_VERSION,
                "contract_minor": minor,
                "supported_contract_minors": [minor],
                "ontology_version": "aptitude-wavelength/2026-05-23",
                "attestation": None,
            },
        )

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer the handshake; fail everything else with the canary."""
        if request.url.path == _VAULT_CAPABILITIES_PATH:
            return self._capabilities()
        self.bodies.append(request.content.decode())
        if self.failure == _VAULT_RAISES:
            msg = f"vault dropped the write of {self.canary}"
            raise httpx.ConnectError(msg, request=request)
        return httpx.Response(
            HTTPStatus.INTERNAL_SERVER_ERROR,
            json={"detail": f"could not store {self.canary}", "echo": {"body": self.canary}},
        )


@pytest.fixture
def vault_records(monkeypatch: pytest.MonkeyPatch) -> Iterator[_RecordList]:
    """Every record the vault telemetry logger writes, structured fields included."""
    records = _RecordList()
    telemetry_logger = logging.getLogger(_VAULT_TELEMETRY_LOGGER)
    monkeypatch.setattr(telemetry_logger, "handlers", [*telemetry_logger.handlers, records])
    reset_vault_telemetry_for_tests()
    yield records
    reset_vault_telemetry_for_tests()


@pytest_asyncio.fixture
async def failing_vault(
    writer: Writer, request: pytest.FixtureRequest
) -> AsyncIterator[_FailingVault]:
    """A handshaken vault client over a :class:`_FailingVault`, wired into the app."""
    double = _FailingVault(writer.canary, request.param)
    async with httpx.AsyncClient(transport=httpx.MockTransport(double)) as http:
        vault = HttpCreekVaultClient(_VAULT_URL, _VAULT_CREDENTIAL, http_client=http)
        assert (await vault.handshake()).available is True
        app.dependency_overrides[get_creek_vault_client] = lambda: vault
        yield double


def _assert_tally_clean(canary: str) -> None:
    """The tally's one failure is the journal ingest, under closed-enum keys only.

    The handshakes that preceded it are counted as the successes they were.
    """
    counts = vault_outcome_counts()
    failures = {key: n for key, n in counts.items() if key[0] is not VaultTelemetryOutcome.SUCCESS}
    assert failures == {(VaultTelemetryOutcome.UNAVAILABLE, CreekCapability.JOURNAL): 1}
    for outcome, capability in counts:
        assert isinstance(outcome, VaultTelemetryOutcome)
        assert isinstance(capability, CreekCapability)
        assert_no_canary(f"{outcome!r} {capability!r}", canary)


@pytest.mark.asyncio
@pytest.mark.parametrize("failing_vault", [_VAULT_RAISES, _VAULT_ECHOES], indirect=True)
async def test_a_failing_vault_echoing_the_entry_ships_no_canary(
    sinks: Sinks, writer: Writer, vault_records: _RecordList, failing_vault: _FailingVault
) -> None:
    """A vault that fails a Personal ingest with the body in its error is a clean tally.

    The entry is saved whatever the vault does, so the write still answers
    201; the one ``creek vault outcome`` record and the per-capability tally
    name the failure by closed-enum members, and no sink holds the words the
    vault handed back.
    """
    response = await writer.http.post(
        "/journal/",
        json={"message": writer.body(), "title": writer.title_canary, "classification": _PERSONAL},
        headers=writer.headers,
    )

    assert response.status_code == HTTPStatus.CREATED, response.text
    assert any(writer.canary in body for body in failing_vault.bodies), "the body went out"
    _assert_tally_clean(writer.canary)
    (failed,) = [
        record
        for record in vault_records.records
        if record.getMessage() == VAULT_OUTCOME_EVENT
        and getattr(record, "outcome", None) != VaultTelemetryOutcome.SUCCESS.value
    ]
    assert getattr(failed, "outcome", None) == VaultTelemetryOutcome.UNAVAILABLE.value
    assert getattr(failed, "capability", None) == CreekCapability.JOURNAL.value
    assert failed.levelno == logging.WARNING
    for record in vault_records.records:
        assert_no_canary(_structured(record), writer.canary)
        assert record.exc_info is None
    assert VAULT_OUTCOME_EVENT in sinks.root.getvalue()
    sinks.assert_clean(writer.canary, writer.title_canary)
    sinks.assert_live()


# ── (f) The usage row ────────────────────────────────────────────────────────

_USAGE_INPUT_TOKENS: Final = 7
_USAGE_OUTPUT_TOKENS: Final = 3
#: The one line a settled generation writes, ids and counts only.
_SETTLEMENT_EVENT: Final = "llm_generation_settled"


def _echoing_message(echo: str) -> dict[str, Any]:
    """An Anthropic 200 that names ``echo`` as its model and answers it as prose.

    The prose is no reflection the parser can read, so the pass -- corrective
    retry and all -- comes back empty: a failed generation that was still
    dialled, and so still metered.
    """
    return {
        "id": "msg_c12",
        "type": "message",
        "role": "assistant",
        "model": f"{echo}-model",
        "content": [{"type": "text", "text": f"I cannot reflect on {echo}"}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": _USAGE_INPUT_TOKENS, "output_tokens": _USAGE_OUTPUT_TOKENS},
    }


def _usage_row_text(row: LLMUsageLog) -> str:
    """Every column of a usage row, rendered as a reader of the table would see it."""
    return json.dumps(row.model_dump(), default=str, ensure_ascii=False)


@pytest.mark.asyncio
async def test_a_provider_echoing_the_prompt_as_its_model_ships_no_canary_to_the_usage_row(
    sinks: Sinks, writer: Writer, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The model a usage row stores is the one adepthood asked for, never the vendor's echo.

    ``model`` is the row's only free-text column, so a provider that answered
    with the prompt as its model name is the one way user words could reach
    ``llmusagelog``. Every row the failed pass metered names the configured
    model, and neither the row nor the settlement line nor any sink carries
    the canary the provider handed back.
    """
    stub = use_anthropic(monkeypatch, HTTPStatus.OK, _echoing_message(writer.canary))
    monkeypatch.delenv(botmason.STUB_SEAM_ENV_VAR, raising=False)
    usage_records = _RecordList()
    usage_logger = logging.getLogger(llm_usage.__name__)
    monkeypatch.setattr(usage_logger, "handlers", [*usage_logger.handlers, usage_records])
    entry_id = await writer.seed(_PERSONAL)

    response = await writer.http.post(
        _RESONANCE_ROUTE.format(entry_id=entry_id),
        headers={**writer.headers, "X-LLM-API-Key": ANTHROPIC_KEY},
    )

    assert response.status_code == HTTPStatus.OK, response.text
    assert stub.request_count >= 1
    assert any(writer.canary in json.dumps(body) for body in stub.bodies), "the prompt went out"
    result = await writer.session.execute(
        select(LLMUsageLog).where(col(LLMUsageLog.user_id) == writer.user_id)
    )
    rows = list(result.scalars())
    assert len(rows) == stub.request_count, "every dial is metered"
    for row in rows:
        assert_no_canary(_usage_row_text(row), writer.canary)
        assert row.model == ANTHROPIC_MODEL
        assert row.journal_entry_id == entry_id
        assert row.prompt_tokens == _USAGE_INPUT_TOKENS
    (settled,) = [
        record
        for record in usage_records.records
        if record.getMessage().startswith(_SETTLEMENT_EVENT)
    ]
    assert_no_canary(_structured(settled), writer.canary)
    assert getattr(settled, "model", None) == ANTHROPIC_MODEL
    assert getattr(settled, "calls", None) == len(rows)
    assert _SETTLEMENT_EVENT in sinks.root.getvalue()
    sinks.assert_clean(writer.canary, writer.title_canary)
    sinks.assert_live()
