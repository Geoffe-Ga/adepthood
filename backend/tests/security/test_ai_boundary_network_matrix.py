"""A vault-bound writer's AI operations dial only their vault, at the socket (B15, C13/C23).

The socket-level AI boundary matrix of #3161, with each dependency down in turn.

:mod:`tests.security.test_vault_boundary_no_fallback` proves the boundary at the
``generate_response`` seam. This suite proves it one layer lower, where it is a
claim about the network rather than about a function: a recorder replaces
``AsyncHTTPTransport.handle_async_request`` on **both** httpx stacks -- ``httpx``
(the vault client, Anthropic) and ``httpx2`` (OpenAI) -- which is the last call
before a socket opens. Every SDK, the real :class:`HttpCreekVaultClient` and
the real destination-pinning transport run above it unmodified, so a dial a
seam stub would have hidden is still seen here.

Nothing about the boundary is overridden. The writer's vault is a stored
connection row, resolved by the production dependency, and its host resolves
(through the patched resolver the pin consults) to a public address. The
recorder serves a scripted Creek ``/v1`` vault for that one name, a canned
provider for the two provider hosts, and refuses everything else, recording
each request's *name* (the TLS server name the pin carries) and *address*.

The matrix is operation x dependency condition x BYOK header:

* **operations** -- resonance, completion detection inside reflection,
  standalone detection, essay expansion, corpus classification and page
  transcription;
* **conditions** -- healthy, vault down, vault timing out, malformed
  capability, vault replaced mid-request (#3078), provider unreachable.

For a ``VAULT_BOUND`` writer the dialed names must be a subset of
``{their vault host}`` and the addresses a subset of ``{its pinned address}``,
and the answer a success or a closed-vocabulary refusal. An ``APP_PROVIDER``
writer carrying a key is the positive control: the same recorder records
their provider dials, so a recorder that saw nothing is evidence.

Declared gaps, so none hides behind a green row:

* **#3156 at the socket.** Essay expansion still builds the app-provider
  adapter under ``VAULT_BOUND``, so a key-carrying vault-bound essay dials
  the provider. Those rows are strict xfails naming #3156.
* **#3156 at the seam.** Corpus classification and page transcription never
  forward a key, and under ADR 0009 phase (a) a keyless request reaches no
  cloud provider, so neither dials off-box today and their socket rows pass.
  They still reach ``generate_response`` under ``VAULT_BOUND`` -- answered by
  the armed stub here, by a refusal in production -- which is the leak #3156
  closes. :func:`test_a_vault_bound_writer_never_reaches_the_app_provider_seam`
  pins that, strict-xfail, beside a live control for the same spy.
* **A condition an operation never meets is vacuous for it.** Standalone
  detection under ``VAULT_BOUND`` never dials the vault, so "replaced
  mid-request" cannot fire there; the row still asserts the dial set.
* **The Creek half of C13** -- that the vault's own model is local, pinned and
  serving -- is out of this repository (Geoffe-Ga/Creek-Vault#1849, #2871).
  This suite proves only the routing half: which destinations adepthood dials.
"""

from __future__ import annotations

import enum
import json
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import date
from http import HTTPStatus
from pathlib import Path
from typing import Final

import httpx
import httpx2
import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from domain.creek_vault import CONTRACT_VERSION
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from routers import transcription as transcription_router
from services import botmason, creek_vault_url_resolution
from services import frequency_classification as frequency_classification_service
from services import marginalia as marginalia_service
from services.botmason import ImagePayload, LLMResponse
from services.reflection_boundary import REFLECTION_SOURCE_UNAVAILABLE
from services.user_vault_config import store_vault_config
from tests.provider_transport import OPENAI_KEY, OPENAI_MODEL
from tests.transcription_helpers import JPEG_BYTES, payload

# ── The writer, their vault, and the hosts nobody else may be ─────────────────

_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_BODY: Final = "I meditated for twenty minutes by the river and the willow bent without breaking."
_QUOTE: Final = "the willow bent without breaking"
_VAULT_NOTE: Final = "The vault reads: you bend and return."
_BYOK_HEADER: Final = "X-LLM-API-Key"
_VAULT_KEY: Final = "creek-vault-matrix-key"  # pragma: allowlist secret

_VAULT_HOST: Final = "vault-own.example.test"
_REPLACEMENT_HOST: Final = "vault-replacement.example.test"
#: Public answers, so the real pin admits both; distinct, so an address alone
#: tells which vault a socket went to.
_ADDRESSES: Final = {_VAULT_HOST: "93.184.216.34", _REPLACEMENT_HOST: "93.184.216.35"}
_OPENAI_HOST: Final = "api.openai.com"
_ANTHROPIC_HOST: Final = "api.anthropic.com"
_PROVIDER_HOSTS: Final = frozenset({_OPENAI_HOST, _ANTHROPIC_HOST})

# ── The scripted Creek /v1 vault ──────────────────────────────────────────────

_CAPABILITIES_PATH: Final = "/v1/capabilities"
_JOURNAL_PATH: Final = "/v1/journal-entries/"
_REFLECTIONS_PATH: Final = "/v1/reflections"
_MINOR_COMPONENTS: Final = 2
_CONTRACT_MINOR: Final = ".".join(CONTRACT_VERSION.split(".")[:_MINOR_COMPONENTS])
_FIXTURES: Final = Path(__file__).resolve().parents[1] / "fixtures" / "creek_v1" / "examples"


def _fixture(capability: str, state: str) -> dict[str, object]:
    """One published Creek contract example."""
    text = (_FIXTURES / capability / f"{state}.json").read_text(encoding="utf-8")
    loaded: dict[str, object] = json.loads(text)
    return loaded


_HANDSHAKE: Final[dict[str, object]] = {
    "vault": {"available": True},
    "capabilities": ["journal-upsert", "reflections"],
    "contract_version": CONTRACT_VERSION,
    "contract_minor": _CONTRACT_MINOR,
    "supported_contract_minors": [_CONTRACT_MINOR],
    "ontology_version": "1.0.0",
    "attestation": None,
}
_REFLECTION: Final[dict[str, object]] = {
    "status": "ok",
    "notes": [{"kind": "pattern", "quote": _QUOTE, "note": _VAULT_NOTE}],
    "essay": None,
    "essay_grounded": False,
    "routed_tier": "personal",
    "tier_ceiling": "personal",
}
_UNAVAILABLE: Final = _fixture("reflections", "unavailable-service")
#: What a healthy vault answers, by path prefix: the journal upsert is keyed by
#: the entry's id under its collection path.
_SERVED: Final[tuple[tuple[str, dict[str, object]], ...]] = (
    (_JOURNAL_PATH, _fixture("journal-upsert", "success")),
    (_REFLECTIONS_PATH, _REFLECTION),
)


def _served(path: str) -> dict[str, object] | None:
    """The healthy vault's answer at ``path``, or ``None`` for a path it does not serve."""
    return next((body for prefix, body in _SERVED if path.startswith(prefix)), None)


# ── The canned provider ───────────────────────────────────────────────────────

_PROVIDER_REPLY: Final = json.dumps(
    {"notes": [{"kind": "theme", "quote": _QUOTE, "note": "It holds."}], "hits": []}
)
_OPENAI_OK: Final[dict[str, object]] = {
    "id": "chatcmpl-matrix",
    "object": "chat.completion",
    "created": 0,
    "model": OPENAI_MODEL,
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": _PROVIDER_REPLY},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}


class Condition(enum.StrEnum):
    """One dependency stopped in turn, or none."""

    HEALTHY = "healthy"
    VAULT_DOWN = "vault_down"
    VAULT_TIMEOUT = "vault_timeout"
    MALFORMED_CAPABILITY = "malformed_capability"
    VAULT_REPLACED = "vault_replaced"
    PROVIDER_UNREACHABLE = "provider_unreachable"


@dataclass(frozen=True, slots=True)
class Dial:
    """One request that reached the last call before a socket."""

    name: str
    address: str
    path: str


class _Refused(enum.Enum):
    """How a scripted dependency fails on the wire."""

    CONNECT = "connect"
    TIMEOUT = "timeout"


@dataclass(frozen=True, slots=True)
class _Answer:
    """What the wire says back: a JSON body, raw text, or a transport failure."""

    status: int = HTTPStatus.OK
    body: object = None
    text: str | None = None
    refused: _Refused | None = None


_CONNECT_REFUSED: Final = _Answer(refused=_Refused.CONNECT)


@dataclass
class NetworkEdge:
    """The recorder at ``AsyncHTTPTransport.handle_async_request``, both stacks.

    ``condition`` is read per request, so a test arranges under a healthy
    network and stops a dependency only for the operation it drives.
    ``replace`` is the writer's own reconnect, run through the real route the
    first time the vault is asked for anything but its capabilities while the
    condition is :attr:`Condition.VAULT_REPLACED`.
    """

    condition: Condition = Condition.HEALTHY
    dials: list[Dial] = field(default_factory=list)
    replace: Callable[[], Awaitable[httpx.Response]] | None = None
    replaced_status: int | None = None

    def names(self) -> set[str]:
        """Every destination name dialed."""
        return {dial.name for dial in self.dials}

    def addresses(self) -> set[str]:
        """Every address a socket would have opened to."""
        return {dial.address for dial in self.dials}

    def forget(self) -> None:
        """Drop what arrangement dialed, so only the operation under test is judged."""
        self.dials.clear()

    async def answer(self, name: str, address: str, path: str) -> _Answer:
        """Record the request, then answer it as the scripted network would."""
        self.dials.append(Dial(name=name, address=address, path=path))
        if name in _PROVIDER_HOSTS:
            return self._provider()
        if name in _ADDRESSES:
            return await self._vault(path)
        return _CONNECT_REFUSED

    def _provider(self) -> _Answer:
        if self.condition is Condition.PROVIDER_UNREACHABLE:
            return _CONNECT_REFUSED
        return _Answer(body=_OPENAI_OK)

    async def _vault(self, path: str) -> _Answer:
        if self.condition is Condition.VAULT_DOWN:
            return _CONNECT_REFUSED
        if path == _CAPABILITIES_PATH:
            return self._capabilities()
        if self.condition is Condition.VAULT_TIMEOUT:
            return _Answer(refused=_Refused.TIMEOUT)
        if self.condition is Condition.VAULT_REPLACED:
            return await self._replaced()
        served = _served(path)
        if served is None:
            return _Answer(status=HTTPStatus.SERVICE_UNAVAILABLE, body=_UNAVAILABLE)
        return _Answer(body=served)

    def _capabilities(self) -> _Answer:
        if self.condition is Condition.MALFORMED_CAPABILITY:
            return _Answer(text="<html>not a capability document</html>")
        return _Answer(body=_HANDSHAKE)

    async def _replaced(self) -> _Answer:
        """The writer reconnects while this call is in flight, then the old vault drops it."""
        if self.replace is not None and self.replaced_status is None:
            self.replaced_status = (await self.replace()).status_code
        return _CONNECT_REFUSED


def _dial_identity(url_host: str, extensions: dict[str, object]) -> tuple[str, str]:
    """The name a request is for and the address it would open, from either stack.

    The pin rewrites the URL host to the checked address and carries the name as
    the TLS server name; an unpinned client leaves the name in the URL, so its
    "address" is that name. A vault dial that slipped past the pin would
    therefore fail the address assertion even though its name is right.
    """
    sni = extensions.get("sni_hostname")
    name = sni if isinstance(sni, str) else url_host
    return name, url_host


def _httpx_response(answer: _Answer, request: httpx.Request) -> httpx.Response:
    if answer.refused is _Refused.CONNECT:
        raise httpx.ConnectError("refused by the network edge", request=request)
    if answer.refused is _Refused.TIMEOUT:
        raise httpx.ReadTimeout("timed out at the network edge", request=request)
    if answer.text is not None:
        return httpx.Response(answer.status, text=answer.text, request=request)
    return httpx.Response(answer.status, json=answer.body, request=request)


def _httpx2_response(answer: _Answer, request: httpx2.Request) -> httpx2.Response:
    if answer.refused is _Refused.CONNECT:
        raise httpx2.ConnectError("refused by the network edge", request=request)
    if answer.refused is _Refused.TIMEOUT:
        raise httpx2.ReadTimeout("timed out at the network edge", request=request)
    if answer.text is not None:
        return httpx2.Response(answer.status, text=answer.text, request=request)
    return httpx2.Response(answer.status, json=answer.body, request=request)


@pytest_asyncio.fixture
async def network_edge(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[NetworkEdge]:
    """Install the recorder below every SDK and the vault client, on both httpx stacks."""
    edge = NetworkEdge()

    async def _httpx(_transport: object, request: httpx.Request) -> httpx.Response:
        name, address = _dial_identity(request.url.host, dict(request.extensions))
        return _httpx_response(await edge.answer(name, address, request.url.path), request)

    async def _httpx2(_transport: object, request: httpx2.Request) -> httpx2.Response:
        name, address = _dial_identity(request.url.host, dict(request.extensions))
        return _httpx2_response(await edge.answer(name, address, request.url.path), request)

    async def _resolve(host: str) -> tuple[str, ...]:
        return (_ADDRESSES[host],) if host in _ADDRESSES else ()

    async def _no_backoff(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _httpx)
    monkeypatch.setattr(httpx2.AsyncHTTPTransport, "handle_async_request", _httpx2)
    monkeypatch.setattr(creek_vault_url_resolution, "resolve_host_addresses", _resolve)
    monkeypatch.setattr(botmason.asyncio, "sleep", _no_backoff)
    monkeypatch.setenv("LLM_MODEL", OPENAI_MODEL)
    yield edge


@dataclass(frozen=True, slots=True)
class Harness:
    """The app client, the test's session, and the network edge under them."""

    client: AsyncClient
    session: AsyncSession
    edge: NetworkEdge


@pytest.fixture
def harness(
    async_client: AsyncClient, db_session: AsyncSession, network_edge: NetworkEdge
) -> Harness:
    """Everything a row drives, behind one name."""
    return Harness(async_client, db_session, network_edge)


# ── Writers ───────────────────────────────────────────────────────────────────


@dataclass
class Writer:
    """One signed-up writer, and whatever the operation under test arranged."""

    headers: dict[str, str]
    user_id: int
    target: int = 0

    def with_key(self, *, byok: bool) -> dict[str, str]:
        """The writer's headers, carrying their own provider key when ``byok``."""
        return {**self.headers, _BYOK_HEADER: OPENAI_KEY} if byok else self.headers


async def _signup(client: AsyncClient, session: AsyncSession, username: str) -> Writer:
    resp = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert resp.status_code == HTTPStatus.OK
    user = (
        await session.execute(select(User).where(col(User.email) == f"{username}@example.com"))
    ).scalar_one()
    assert user.id is not None
    return Writer({"Authorization": f"Bearer {resp.json()['token']}"}, user.id)


def _vault_url(host: str) -> str:
    return f"https://{host}"


async def _connect_vault(session: AsyncSession, writer: Writer) -> None:
    """A stored connection row: the production resolver makes this writer vault-bound."""
    await store_vault_config(
        session, writer.user_id, vault_url=_vault_url(_VAULT_HOST), api_key=_VAULT_KEY
    )


# ── Operations ────────────────────────────────────────────────────────────────


async def _create_entry(client: AsyncClient, writer: Writer) -> httpx.Response:
    return await client.post(
        "/journal/", json={"message": _BODY, "classification": "personal"}, headers=writer.headers
    )


async def _arrange_entry(client: AsyncClient, _session: AsyncSession, writer: Writer) -> None:
    resp = await _create_entry(client, writer)
    assert resp.status_code == HTTPStatus.CREATED
    writer.target = int(resp.json()["id"])


async def _arrange_entry_with_candidate(
    client: AsyncClient, session: AsyncSession, writer: Writer
) -> None:
    """An entry plus one active habit, so detection has a candidate to send."""
    habit = Habit(
        name="Meditation",
        icon="🧘",
        start_date=date(2025, 1, 1),
        energy_cost=1,
        energy_return=2,
        user_id=writer.user_id,
    )
    session.add(habit)
    await session.commit()
    await session.refresh(habit)
    session.add(
        Goal(
            habit_id=habit.id,
            title="clear",
            tier="clear",
            target=20.0,
            target_unit="minutes",
            frequency=1.0,
            frequency_unit="per_day",
            is_additive=True,
        )
    )
    await session.commit()
    await _arrange_entry(client, session, writer)


async def _arrange_note(_client: AsyncClient, session: AsyncSession, writer: Writer) -> None:
    """A margin note on the writer's own entry, so its letter can be asked for."""
    entry = JournalEntry(sender="user", user_id=writer.user_id, message=_BODY)
    session.add(entry)
    await session.flush()
    note = Marginalia(
        journal_entry_id=entry.id,
        user_id=writer.user_id,
        kind=MarginaliaKind.SYMBOL,
        anchor_start=0,
        anchor_end=6,
        anchor_text=_BODY[:6],
        note="A beginning.",
    )
    session.add(note)
    await session.commit()
    await session.refresh(note)
    assert note.id is not None
    writer.target = note.id


async def _arrange_corpus_consent(
    client: AsyncClient, _session: AsyncSession, writer: Writer
) -> None:
    """Consent first, so the entry the operation writes is classified for the corpus."""
    resp = await client.put(
        "/corpus/consent/journal", json={"granted": True}, headers=writer.headers
    )
    assert resp.status_code == HTTPStatus.OK


async def _nothing(_client: AsyncClient, _session: AsyncSession, _writer: Writer) -> None:
    return None


async def _resonance(client: AsyncClient, writer: Writer, *, byok: bool) -> httpx.Response:
    return await client.post(
        f"/journal/{writer.target}/resonance", headers=writer.with_key(byok=byok)
    )


async def _detect(client: AsyncClient, writer: Writer, *, byok: bool) -> httpx.Response:
    return await client.post(
        f"/journal/{writer.target}/suggestions/detect", headers=writer.with_key(byok=byok)
    )


async def _essay(client: AsyncClient, writer: Writer, *, byok: bool) -> httpx.Response:
    return await client.post(
        f"/journal/marginalia/{writer.target}/essay",
        json={"price_acknowledged": True},
        headers=writer.with_key(byok=byok),
    )


async def _classify(client: AsyncClient, writer: Writer, *, byok: bool) -> httpx.Response:
    return await client.post(
        "/journal/",
        json={"message": _BODY, "classification": "personal"},
        headers=writer.with_key(byok=byok),
    )


async def _transcribe(client: AsyncClient, writer: Writer, *, byok: bool) -> httpx.Response:
    return await client.post(
        "/journal/transcribe-page", json=payload(JPEG_BYTES), headers=writer.with_key(byok=byok)
    )


_Arrange = Callable[[AsyncClient, AsyncSession, Writer], Awaitable[None]]
_Drive = Callable[..., Awaitable[httpx.Response]]


@dataclass(frozen=True, slots=True)
class Operation:
    """One AI operation: how to arrange it and how a writer asks for it.

    ``relays_key`` says whether the server forwards the writer's key to a
    provider on this route; a route that does not can reach no cloud provider
    under ADR 0009 phase (a), so its positive control is the seam spy instead.
    ``asks_vault`` says whether a vault-bound pass asks the vault for more than
    its capabilities -- the only operations a mid-call reconnect can land
    inside, and the ones a healthy row must show reaching the vault at all.
    ``vault_answer`` is text only the healthy vault's answer carries.
    """

    name: str
    arrange: _Arrange
    drive: _Drive
    relays_key: bool
    asks_vault: bool = False
    vault_answer: str | None = None


_OPERATIONS: Final = (
    Operation(
        "resonance",
        _arrange_entry,
        _resonance,
        relays_key=True,
        asks_vault=True,
        vault_answer=_VAULT_NOTE,
    ),
    Operation(
        "reflection_detection",
        _arrange_entry_with_candidate,
        _resonance,
        relays_key=True,
        asks_vault=True,
        vault_answer=_VAULT_NOTE,
    ),
    Operation("standalone_detect", _arrange_entry_with_candidate, _detect, relays_key=True),
    Operation("essay", _arrange_note, _essay, relays_key=True),
    Operation(
        "corpus_classification",
        _arrange_corpus_consent,
        _classify,
        relays_key=False,
        asks_vault=True,
    ),
    Operation("transcription", _nothing, _transcribe, relays_key=False),
)
_BY_NAME: Final = {operation.name: operation for operation in _OPERATIONS}

#: The refusals a writer may see instead of a result: closed-vocabulary codes,
#: each naming a retryable or unavailable state rather than anything the
#: dependency said.
_CLOSED_REFUSALS: Final = frozenset({REFLECTION_SOURCE_UNAVAILABLE})
_SUCCESS: Final = frozenset({HTTPStatus.OK, HTTPStatus.CREATED})


def _assert_result_or_closed_refusal(resp: httpx.Response) -> None:
    """A result, or a refusal whose detail is one of the closed codes -- never a raw error."""
    if resp.status_code in _SUCCESS:
        return
    assert resp.status_code == HTTPStatus.SERVICE_UNAVAILABLE, resp.text
    assert resp.json()["detail"] in _CLOSED_REFUSALS


# ── The matrix ────────────────────────────────────────────────────────────────

_ISSUE_3156_SOCKET: Final = (
    "#3156: essay expansion builds the app-provider adapter under VAULT_BOUND, "
    "so a key-carrying vault-bound essay dials the provider"
)


def _vault_bound_case(operation: Operation, condition: Condition, *, byok: bool) -> object:
    marks = (
        [pytest.mark.xfail(strict=True, raises=AssertionError, reason=_ISSUE_3156_SOCKET)]
        if operation.name == "essay" and byok
        else []
    )
    key = "byok" if byok else "keyless"
    return pytest.param(
        operation.name, condition, byok, marks=marks, id=f"{operation.name}-{condition}-{key}"
    )


_VAULT_BOUND_MATRIX: Final = [
    _vault_bound_case(operation, condition, byok=byok)
    for operation in _OPERATIONS
    for condition in Condition
    for byok in (False, True)
]


async def _vault_bound_writer(harness: Harness, username: str) -> Writer:
    """Sign up, connect a vault, and wire the mid-request reconnect to the real route."""
    writer = await _signup(harness.client, harness.session, username)
    await _connect_vault(harness.session, writer)

    async def _reconnect() -> httpx.Response:
        return await harness.client.put(
            "/vault/connection",
            json={"vault_url": _vault_url(_REPLACEMENT_HOST), "api_key": _VAULT_KEY},
            headers=writer.headers,
        )

    harness.edge.replace = _reconnect
    return writer


@pytest.mark.asyncio
@pytest.mark.parametrize(("operation", "condition", "byok"), _VAULT_BOUND_MATRIX)
async def test_vault_bound_operation_dials_only_its_vault(
    harness: Harness,
    operation: str,
    condition: Condition,
    byok: bool,
) -> None:
    """Dialed names stay within the writer's vault host, with each dependency stopped in turn.

    The vault-replaced rows are #3078's: the reconnect lands through the real
    route mid-call, and the pass in flight must neither dial the newly stored
    vault nor anything else. A BYOK header pays for calls; it never permits a
    destination the boundary does not.
    """
    op = _BY_NAME[operation]
    writer = await _vault_bound_writer(harness, f"net_{operation}_{condition}_{int(byok)}")
    await op.arrange(harness.client, harness.session, writer)
    harness.edge.forget()
    harness.edge.condition = condition

    resp = await op.drive(harness.client, writer, byok=byok)

    assert harness.edge.names() <= {_VAULT_HOST}, harness.edge.dials
    assert harness.edge.addresses() <= {_ADDRESSES[_VAULT_HOST]}, harness.edge.dials
    _assert_result_or_closed_refusal(resp)
    _assert_the_row_is_not_vacuous(op, condition, harness.edge, resp)


def _assert_the_row_is_not_vacuous(
    op: Operation, condition: Condition, edge: NetworkEdge, resp: httpx.Response
) -> None:
    """A row passes for the right reason: the vault was asked, the reconnect landed.

    A healthy row of an operation that asks its vault must show the vault
    asked and its answer served, or a recorder that saw nothing would pass it.
    A replaced row of the same operations must show the writer's reconnect
    really landed mid-call, or the row would prove nothing about #3078. With
    the vault itself healthy their writer gets a result. (The operations that
    never ask the vault may answer a healthy row with the closed refusal: that
    is exactly what #3156 makes them do.)
    """
    if not op.asks_vault:
        return
    if condition in {Condition.HEALTHY, Condition.PROVIDER_UNREACHABLE}:
        assert resp.status_code in _SUCCESS, resp.text
    if condition is Condition.HEALTHY:
        assert edge.names() == {_VAULT_HOST}
        assert op.vault_answer is None or op.vault_answer in resp.text
    if condition is Condition.VAULT_REPLACED:
        assert edge.replaced_status == HTTPStatus.OK


# ── The positive control: the same recorder sees an app-provider writer's dials ──

_KEY_RELAYING: Final = [operation for operation in _OPERATIONS if operation.relays_key]


@pytest.mark.asyncio
@pytest.mark.parametrize("condition", [Condition.HEALTHY, Condition.PROVIDER_UNREACHABLE], ids=str)
@pytest.mark.parametrize("operation", [op.name for op in _KEY_RELAYING])
async def test_app_provider_writer_dials_are_recorded(
    harness: Harness,
    operation: str,
    condition: Condition,
) -> None:
    """No vault, a key of their own: the recorder sees the provider, and only the provider.

    The proof the recorder is live. An unreachable provider is still recorded --
    the dial was attempted -- and still nothing else is dialed in its place.
    """
    op = _BY_NAME[operation]
    writer = await _signup(harness.client, harness.session, f"net_app_{operation}_{condition}")
    await op.arrange(harness.client, harness.session, writer)
    harness.edge.forget()
    harness.edge.condition = condition

    await op.drive(harness.client, writer, byok=True)

    assert harness.edge.names() == {_OPENAI_HOST}, harness.edge.dials


# ── Below the socket's reach: the app-provider seam ───────────────────────────

#: Every module whose binding of the app-provider dial an operation here calls.
_SEAM_MODULES: Final = (marginalia_service, frequency_classification_service, transcription_router)
_ISSUE_3156_SEAM: Final = (
    "#3156: essay, corpus classification and transcription reach generate_response "
    "under VAULT_BOUND"
)
_SEAM_OPERATIONS: Final = ("essay", "corpus_classification", "transcription")


@dataclass
class _SeamSpy:
    """Counts calls to the app-provider dial, then lets the real one answer."""

    calls: int = 0


def _spy_on_the_seam(monkeypatch: pytest.MonkeyPatch) -> _SeamSpy:
    """Wrap each module's binding of ``generate_response``; the real function still runs."""
    spy = _SeamSpy()
    real = botmason.generate_response

    async def _counting(
        user_message: str,
        conversation_history: list[dict[str, str]],
        system_prompt: str | None = None,
        api_key: str | None = None,
        images: Sequence[ImagePayload] | None = None,
    ) -> LLMResponse:
        spy.calls += 1
        return await real(user_message, conversation_history, system_prompt, api_key, images)

    for module in _SEAM_MODULES:
        assert module.generate_response is real, module.__name__
        monkeypatch.setattr(module, "generate_response", _counting)
    return spy


@pytest.mark.asyncio
@pytest.mark.parametrize("byok", [False, True], ids=["keyless", "byok"])
@pytest.mark.parametrize(
    "operation",
    [
        pytest.param(
            name,
            marks=pytest.mark.xfail(strict=True, raises=AssertionError, reason=_ISSUE_3156_SEAM),
        )
        for name in _SEAM_OPERATIONS
    ],
)
async def test_a_vault_bound_writer_never_reaches_the_app_provider_seam(
    harness: Harness,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
    byok: bool,
) -> None:
    """The leak the socket cannot always see: an app-provider call under ``VAULT_BOUND``.

    With or without a key, each of these operations reaches the app-provider
    dial for a vault-bound writer today. Strict xfails until #3156 binds them
    to the boundary; they flip the day it lands.
    """
    op = _BY_NAME[operation]
    writer = await _vault_bound_writer(harness, f"seam_{operation}_{int(byok)}")
    await op.arrange(harness.client, harness.session, writer)
    spy = _spy_on_the_seam(monkeypatch)

    await op.drive(harness.client, writer, byok=byok)

    assert spy.calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", _SEAM_OPERATIONS)
async def test_the_seam_spy_sees_an_app_provider_writer(
    harness: Harness,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    """The same spy, no vault: each of those operations reaches the seam, so silence is evidence."""
    op = _BY_NAME[operation]
    writer = await _signup(harness.client, harness.session, f"seam_app_{operation}")
    await op.arrange(harness.client, harness.session, writer)
    spy = _spy_on_the_seam(monkeypatch)

    await op.drive(harness.client, writer, byok=False)

    assert spy.calls > 0
    # Keyless, so no cloud provider is reached (ADR 0009 phase (a)): the seam,
    # not the socket, is the only place these calls can be seen.
    assert harness.edge.names() == set()
